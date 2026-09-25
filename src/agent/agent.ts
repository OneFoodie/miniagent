/** Agent 门面：组装 LLM、工具运行时、事件总线，驱动 ReAct 主循环。 */

import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { Settings } from "../core/config.js";
import {
  AgentCancelledError,
  AgentLimitError,
  ApprovalRequiredError,
  MiniAgentError,
} from "../core/errors.js";
import { makeEvent, EventBus, EventType } from "../core/events.js";
import { getLogger, runIdStorage } from "../core/logging.js";
import type { LLMResponse, Message, ToolCall, ToolResult } from "../core/types.js";
import type { BaseLLM } from "../llm/base.js";
import type { LongTermMemory } from "../memory/base.js";
import { estimateTokens, messagesTokens } from "../memory/base.js";
import type { SummaryMemory } from "../memory/summary.js";
import type { PromptBuilder } from "../prompts/builder.js";
import { promptBuilderForRole, type RolePreset } from "../prompts/roles.js";
import type { SkillRegistry } from "../skills/loader.js";
import type { ToolRegistry } from "../tools/registry.js";
import { ToolRuntime } from "../tools/runtime.js";
import {
  loadCheckpoint,
  recordApproval,
  removeCheckpoint,
  saveCheckpoint,
} from "./checkpoint.js";
import { AgentContext, type ToolFact } from "./context.js";

const logger = getLogger("miniagent.agent");

/** 一次完整 Agent 运行的产出 */
export interface RunResult {
  answer: string;
  messages: Message[];
  context: AgentContext;
  latency: number;
  /** 本次使用的系统提示词各段版本号，便于 eval 归因 */
  promptVersions: string[];
}

/** Agent 的可选能力：技能目录、记忆、长期召回 */
export interface AgentOptions {
  /** 提示词构建器；不传则使用默认分段提示词（有 role 时按角色组装） */
  promptBuilder?: PromptBuilder;
  /** 角色预设：给同一个 Agent 换上"调研员/分析员/复核员"的身份与工具约束 */
  role?: RolePreset;
  /** 技能注册表：提供技能目录，供提示词渐进式披露 */
  skills?: SkillRegistry;
  /** 摘要记忆：负责滑窗裁剪与超阈值压缩 */
  memory?: SummaryMemory;
  /** 长期记忆：按当前问题召回相关历史片段 */
  longTerm?: LongTermMemory;
  /**
   * 上一轮实际执行过的工具（运行期写入，非模型输出）。
   * 由调用方从会话历史里取出传进来——它会被渲染进系统提示词的证据小节，
   * 用来回答「我上一轮到底做过什么」这个问题。
   */
  executionLedger?: ToolFact[];
}

/** 写存档所需的运行级信息（不进消息序列，但恢复时要能原样还原） */
interface RunMeta {
  input: string;
  createdAt: number;
  promptVersions: string[];
}

/** 续跑时的现场：待执行的工具调用（可能没有）+ 已做出的审批决定 */
interface ResumeState {
  toolCalls?: ToolCall[];
  approvals: Record<string, boolean>;
}

/** act 的两种结局：要么跑完了一批，要么撞上需要审批的调用 */
type ActOutcome =
  | { kind: "ran"; resultById: Map<string, ToolResult> }
  | { kind: "needs-approval"; call: ToolCall };

/** 用户拒绝执行时回灌给模型的内容：必须说清「是被人拒了」，而不是「工具坏了」 */
const APPROVAL_DENIED = "用户拒绝执行该工具调用，请换一种方式或直接说明无法完成";

export class Agent {
  private readonly runtime: ToolRuntime;
  private readonly promptBuilder: PromptBuilder;
  private readonly skills?: SkillRegistry;
  private readonly memory?: SummaryMemory;
  private readonly longTerm?: LongTermMemory;
  private readonly executionLedger?: ToolFact[];

  constructor(
    private readonly llm: BaseLLM,
    private readonly registry: ToolRegistry,
    private readonly settings: Settings,
    private readonly bus: EventBus = new EventBus(),
    options: AgentOptions = {},
  ) {
    this.runtime = new ToolRuntime(
      registry,
      settings.maxConcurrency,
      settings.toolTimeout,
    );
    this.promptBuilder =
      options.promptBuilder ?? promptBuilderForRole(options.role);
    this.skills = options.skills;
    this.memory = options.memory;
    this.longTerm = options.longTerm;
    this.executionLedger = options.executionLedger;
  }

  async run(
    userInput: string,
    history: Message[] = [],
    context: AgentContext = new AgentContext(),
  ): Promise<RunResult> {
    const start = performance.now();

    // 1. 记忆裁剪：滑窗 + 超阈值摘要压缩（裁剪后仍不超上下文预算）
    const trimmed = this.memory
      ? await this.memory.prepare(history, context.signal)
      : history;

    // 2. 长期记忆召回：按当前问题检索相关历史片段
    const recalled = await this.recall(userInput, context);

    // 3. 组装系统提示词：技能目录 + 记忆摘要 + 召回片段在此注入
    const prompt = this.promptBuilder.build({
      skills: this.skills?.catalog() ?? [],
      memorySummary: this.memory?.currentSummary ?? "",
      recalledMemory: recalled,
      toolNames: this.registry.all().map((tool) => tool.name),
      executionLedger: this.executionLedger,
    });

    // system 消息始终置顶，其后是历史与本轮输入
    const messages: Message[] = [
      { role: "system", content: prompt.text },
      ...trimmed,
      { role: "user", content: userInput },
    ];

    // AsyncLocalStorage：本次运行的所有结构化日志都带上 runId
    const meta: RunMeta = {
      input: userInput,
      createdAt: Date.now(),
      promptVersions: prompt.versions,
    };
    const execute = () => this.loop(messages, context, meta);
    let answer: string;
    try {
      // 清理历史卸载产物：它按 run 累积且只增不减，不清理会一直占着磁盘
      await pruneOffloadDir(this.settings.workspace, this.settings.offloadKeepRuns);
      await this.bus.publish(
        makeEvent(
          EventType.RunStart,
          { input: userInput, prompt_versions: prompt.versions },
          context.runId,
        ),
      );
      answer = await runIdStorage.run(context.runId, execute);
    } catch (error) {
      await this.bus.publish(
        makeEvent(
          EventType.RunEnd,
          { ok: false, iterations: context.iterations },
          context.runId,
        ),
      );
      // 失败时**保留**存档：它正是「哪里断的、从哪能接着跑」的唯一线索
      throw error;
    }

    const latency = (performance.now() - start) / 1000;
    await this.bus.publish(
      makeEvent(
        EventType.RunEnd,
        {
          ok: true,
          iterations: context.iterations,
          answer,
          latency,
        },
        context.runId,
      ),
    );
    // 成功即清掉存档：磁盘上只留「确实需要人看一眼」的运行
    if (this.settings.checkpointEnabled) {
      await removeCheckpoint(this.settings.checkpointDir, context.runId);
    }
    return { answer, messages, context, latency, promptVersions: prompt.versions };
  }

  /**
   * 续跑一次被打断或挂起的运行。
   *
   * 恢复点是 checkpoint 里那份完整消息序列：
   *  - 若最后一条是 assistant 的 tool_calls（挂起在审批上）→ 先把那批工具接着执行完
   *  - 若最后一条已是 tool 结果（进程被杀）→ 直接进入下一轮 reason
   *
   * **不重新裁剪历史**：消息序列是原样存下来的，重新裁剪会改变模型看到的上下文，
   * 让恢复后的行为与中断前不一致。
   */
  async resume(
    runId: string,
    decision?: { approved: boolean },
    /** 复用调用方已有的上下文（server 需要拿它做取消登记），不传则新建 */
    providedContext?: AgentContext,
  ): Promise<RunResult> {
    if (!this.settings.checkpointEnabled) {
      throw new MiniAgentError("未启用运行存档（MINIAGENT_CHECKPOINT_ENABLED），无法续跑");
    }
    // 先落决定再读：两次请求之间进程可能重启，决定必须持久化
    if (decision) {
      await recordApproval(this.settings.checkpointDir, runId, decision.approved);
    }

    const checkpoint = await loadCheckpoint(this.settings.checkpointDir, runId);
    if (!checkpoint) {
      throw new MiniAgentError(`找不到可续跑的运行存档: ${runId}`);
    }

    const context = providedContext ?? new AgentContext(runId);
    context.iterations = checkpoint.iterations;
    context.usage.promptTokens = checkpoint.usage.promptTokens;
    context.usage.completionTokens = checkpoint.usage.completionTokens;
    // 挂起前已经执行过的工具事实要接着往下传，否则续跑出来的那一轮会丢掉它们
    context.tools.push(...(checkpoint.tools ?? []));

    const messages = [...checkpoint.messages];
    const last = messages.at(-1);
    const pending: ResumeState = {
      toolCalls:
        last?.role === "assistant" && last.toolCalls?.length ? last.toolCalls : undefined,
      approvals: checkpoint.approvals ?? {},
    };

    const meta: RunMeta = {
      input: checkpoint.input,
      createdAt: checkpoint.createdAt,
      promptVersions: checkpoint.promptVersions,
    };

    const start = performance.now();
    logger.info(
      `续跑运行 ${runId}：从第 ${context.iterations} 轮之后继续` +
        (pending.toolCalls ? `（接着执行 ${pending.toolCalls.length} 个待批工具）` : ""),
    );
    await this.bus.publish(
      makeEvent(
        EventType.RunStart,
        {
          input: checkpoint.input,
          prompt_versions: checkpoint.promptVersions,
          resumed: true,
          from_iteration: checkpoint.iterations,
        },
        runId,
      ),
    );

    let answer: string;
    try {
      answer = await runIdStorage.run(runId, () =>
        this.loop(messages, context, meta, pending),
      );
    } catch (error) {
      await this.bus.publish(
        makeEvent(EventType.RunEnd, { ok: false, iterations: context.iterations }, runId),
      );
      throw error;
    }

    const latency = (performance.now() - start) / 1000;
    await this.bus.publish(
      makeEvent(
        EventType.RunEnd,
        { ok: true, iterations: context.iterations, answer, latency },
        runId,
      ),
    );
    await removeCheckpoint(this.settings.checkpointDir, runId);
    return { answer, messages, context, latency, promptVersions: checkpoint.promptVersions };
  }

  /** 检索长期记忆；检索失败只记警告，不阻断本轮对话 */
  private async recall(query: string, ctx: AgentContext): Promise<string[]> {
    if (!this.longTerm) return [];
    try {
      const records = await this.longTerm.search(query, 3);
      // 召回明细进轨迹：lifecycle 后端会带上 kind / score / confidence / memoryId，
      // 便于在"查看原始轨迹"里核对某轮到底召回了什么、为什么排在这个位置
      await this.bus.publish(
        makeEvent(
          EventType.MemoryRecall,
          {
            query,
            count: records.length,
            memories: records.map((record) => ({
              ...(record.meta ?? {}),
              text: record.text,
              ts: record.ts,
            })),
          },
          ctx.runId,
        ),
      );
      return records.map((record) => record.text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warning(`长期记忆检索失败，本轮跳过召回: ${message}`);
      return [];
    }
  }

  /** ReAct 主循环：reason（LLM）→ act（并发工具）→ observe（结果回灌） */
  private async loop(
    messages: Message[],
    ctx: AgentContext,
    meta: RunMeta,
    resume?: ResumeState,
  ): Promise<string> {
    // 恢复时可能已经有一批工具调用在等执行：挂起前 LLM 已经把它们给出来了
    let awaiting: ToolCall[] | undefined = resume?.toolCalls;
    const approvals: Record<string, boolean> = { ...resume?.approvals };

    while (ctx.iterations < this.settings.maxIterations) {
      if (ctx.cancelled) {
        throw new AgentCancelledError("Agent 已被取消");
      }

      if (!awaiting) {
        const response = await this.reason(messages, ctx);
        // 没有工具调用 → 模型给出最终答案，循环结束
        if (response.toolCalls.length === 0) return response.content;
        awaiting = response.toolCalls;
      }

      const outcome = await this.act(awaiting, ctx, approvals);
      if (outcome.kind === "needs-approval") {
        // 挂起：把现场与待批调用一起落盘，外部给出决定后再续跑
        await this.saveCheckpoint(messages, ctx, meta, {
          approvals,
          pending: outcome.call,
        });
        throw new ApprovalRequiredError(
          `工具 ${outcome.call.name} 需要人工审批后才会执行`,
          ctx.runId,
          outcome.call,
        );
      }

      // 工具执行期间被取消 → 不再把结果回灌，直接结束
      if (ctx.signal.aborted) {
        throw new AgentCancelledError("Agent 已被取消");
      }

      await this.observe(messages, awaiting, outcome.resultById, ctx);
      await this.foldAndReport(messages, ctx, awaiting.length);
      // 先记轮次再存档：存档里的 iterations 表示「已完成的轮数」，恢复时直接沿用
      ctx.iterations++;
      // 存档必须在「消息序列完整」时写：assistant 的 tool_calls 与随后的 tool 结果都齐了
      await this.saveCheckpoint(messages, ctx, meta, { approvals });

      awaiting = undefined;
    }

    throw new AgentLimitError(
      `已达到最大迭代次数 ${this.settings.maxIterations}，仍未得到最终答案`,
    );
  }

  /**
   * 调一次模型：开启流式且后端支持时逐段透出，否则退回一次性返回。
   *
   * 增量只用于「让用户早点看到」，不参与决策——决策永远基于拼装完整的 response。
   */
  private async callModel(messages: Message[], ctx: AgentContext): Promise<LLMResponse> {
    const tools = this.registry.toolPayload();
    const stream = this.llm.chatStream?.bind(this.llm);
    if (!this.settings.streamEnabled || !stream) {
      return this.llm.chat(messages, tools, ctx.signal);
    }
    return stream(messages, tools, ctx.signal, (delta) => {
      // 不 await：事件推送不该拖慢流式读取；EventBus 内部已各自捕获异常
      void this.bus.publish(
        makeEvent(
          EventType.LLMDelta,
          {
            text: delta.text,
            tool_index: delta.toolIndex,
            tool_name: delta.toolName,
          },
          ctx.runId,
        ),
      );
    });
  }

  /** reason：调一次模型，把 assistant 消息追加进消息序列 */
  private async reason(messages: Message[], ctx: AgentContext): Promise<LLMResponse> {
    await this.bus.publish(
      makeEvent(EventType.LLMStart, { iteration: ctx.iterations }, ctx.runId),
    );
    const llmStart = performance.now();
    let response: LLMResponse;
    try {
      response = await this.callModel(messages, ctx);
    } catch (error) {
      // 等待 LLM 期间被取消 → 统一转成取消异常
      if (ctx.signal.aborted) {
        throw new AgentCancelledError("Agent 已被取消");
      }
      // 能走到这里说明客户端内部的重试已经耗尽，属于「模型自身的失败」。
      // 单独发一个事件，让 /metrics 的失败率不至于把这类错误混进工具错误里。
      const message = error instanceof Error ? error.message : String(error);
      await this.bus.publish(
        makeEvent(
          EventType.LLMError,
          { message, iteration: ctx.iterations, latency: (performance.now() - llmStart) / 1000 },
          ctx.runId,
        ),
      );
      throw error;
    }
    const llmLatency = (performance.now() - llmStart) / 1000;

    ctx.usage.promptTokens += response.usage.promptTokens;
    ctx.usage.completionTokens += response.usage.completionTokens;

    await this.bus.publish(
      makeEvent(
        EventType.LLMEnd,
        {
          iteration: ctx.iterations,
          latency: llmLatency,
          prompt_tokens: response.usage.promptTokens,
          completion_tokens: response.usage.completionTokens,
          finish_reason: response.finishReason,
          // 本轮模型的推理/思考文本（伴随工具调用时即为它的"想法"）
          content: response.content,
          tool_calls: response.toolCalls.map((call) => call.name),
        },
        ctx.runId,
      ),
    );

    messages.push({
      role: "assistant",
      content: response.content,
      toolCalls: response.toolCalls.length > 0 ? response.toolCalls : undefined,
    });
    return response;
  }

  /**
   * act：执行这批工具调用。
   *
   * 需要审批而未决的调用会让整批先停下——**不能**只跳过它执行其余的：
   * 同一批工具往往是模型基于同一份判断一起发起的，批准其中一个而偷跑另一个没有意义。
   */
  private async act(
    calls: ToolCall[],
    ctx: AgentContext,
    approvals: Record<string, boolean>,
  ): Promise<ActOutcome> {
    const undecided = calls.find(
      (call) => this.needsApproval(call.name) && approvals[call.id] === undefined,
    );
    if (undecided) return { kind: "needs-approval", call: undecided };

    // 被拒的调用不执行，直接把「用户拒绝」作为工具结果回灌——模型据此改走别的路子
    const denied = calls.filter((call) => approvals[call.id] === false);
    const toRun = calls.filter((call) => approvals[call.id] !== false);
    const batch = await this.runtime.executeBatch(toRun, ctx.runId, this.bus, ctx.signal);

    const resultById = new Map(batch);
    for (const call of denied) {
      resultById.set(call.id, { ok: false, error: APPROVAL_DENIED });
    }
    return { kind: "ran", resultById };
  }

  /** observe：把工具结果回灌进消息序列 */
  private async observe(
    messages: Message[],
    calls: ToolCall[],
    resultById: Map<string, ToolResult>,
    ctx: AgentContext,
  ): Promise<void> {
    for (const call of calls) {
      const toolResult = resultById.get(call.id)!;
      // 落一条「执行事实」：下一轮靠它知道这步真的发生过（见 ToolFact 的注释）
      ctx.tools.push({ name: call.name, ok: toolResult.ok });
      const raw = toolResult.ok
        ? JSON.stringify(toolResult.data)
        : `工具执行失败: ${toolResult.error}`;
      messages.push({
        role: "tool",
        // 回灌的结果在滑窗之外，必须单独设闸；超限时卸载到文件而非丢弃
        content: await offloadToolResult(raw, {
          maxChars: this.settings.toolResultMaxChars,
          toolName: call.name,
          callId: call.id,
          runId: ctx.runId,
          workspace: this.settings.workspace,
        }),
        toolCallId: call.id,
        name: call.name,
      });
    }
  }

  /** 回灌完这批结果后收紧一次：单条有闸，整体也得有。本批不折叠（模型还没看过） */
  private async foldAndReport(
    messages: Message[],
    ctx: AgentContext,
    batchSize: number,
  ): Promise<void> {
    const folding = foldOldToolResults(messages, this.settings.memoryMaxTokens, batchSize);
    if (folding.folded === 0) return;

    await this.bus.publish(
      makeEvent(
        EventType.ContextTrim,
        {
          folded: folding.folded,
          budget_tokens: this.settings.memoryMaxTokens,
          tokens_before: folding.tokensBefore,
          tokens_after: folding.tokensAfter,
        },
        ctx.runId,
      ),
    );
    logger.info(
      `循环内上下文收紧: 折叠 ${folding.folded} 条早期工具结果，` +
        `估算 token ${folding.tokensBefore} → ${folding.tokensAfter}`,
    );
  }

  /** 该工具是否需要人工审批 */
  private needsApproval(toolName: string): boolean {
    return this.settings.approvalTools.includes(toolName);
  }

  /** 落一次运行存档；未启用存档时是空操作 */
  private async saveCheckpoint(
    messages: Message[],
    ctx: AgentContext,
    meta: RunMeta,
    state: { approvals: Record<string, boolean>; pending?: ToolCall },
  ): Promise<void> {
    if (!this.settings.checkpointEnabled) return;
    try {
      await saveCheckpoint(this.settings.checkpointDir, {
        runId: ctx.runId,
        input: meta.input,
        createdAt: meta.createdAt,
        updatedAt: Date.now(),
        iterations: ctx.iterations,
        usage: {
          promptTokens: ctx.usage.promptTokens,
          completionTokens: ctx.usage.completionTokens,
        },
        messages,
        promptVersions: meta.promptVersions,
        tools: [...ctx.tools],
        approvals: state.approvals,
        pendingApproval: state.pending
          ? {
              callId: state.pending.id,
              tool: state.pending.name,
              arguments: state.pending.arguments,
            }
          : undefined,
      });
    } catch (error) {
      // 存档失败不该让正在跑的对话失败
      const reason = error instanceof Error ? error.message : String(error);
      logger.warning(`写入运行存档失败: ${reason}`);
    }
  }
}

/** 折叠后的占位符：说明发生了什么 + 给出补救路径，而不是留一段空白让模型以为工具返回了空 */
const FOLDED_PLACEHOLDER =
  "（早期工具结果已折叠以控制上下文长度；需要该内容请重新调用工具，或从 trace 中查看）";

/** 折叠结果，供调用方记录到轨迹 */
export interface FoldResult {
  folded: number;
  tokensBefore: number;
  tokensAfter: number;
}

/**
 * 循环内上下文收紧：工具结果**整体**超预算时，把最早的若干条折叠成占位符。
 *
 * 为什么必须有它：滑窗只在 `run()` 起始执行，而循环里每一步回灌的工具结果都落在窗外，
 * 此前只受「单条 4000 字」约束——8 轮 × 3 个工具就能累积到远超预算的体量，
 * 而且是在**已经发出去之后**才膨胀，模型看到的上下文会一路涨到窗口上限。
 *
 * 为什么是折叠而不是删除：OpenAI 兼容协议要求 assistant 的 `tool_calls` 与随后的 `tool` 消息成对出现，
 * 删掉 `tool` 消息会让下一次请求直接报错。折叠只改正文、不动结构，因此始终合法。
 *
 * 为什么折叠而不是再摘要一次：循环内再调一次 LLM 会拖慢每一步，
 * 而且会把工具返回值这份「原始证据」改写成二手描述——排查时最需要的恰恰是原文。
 *
 * 预算沿用 `memoryMaxTokens`（窗口 × 比例）：它与历史滑窗是同一把尺子，
 * 于是整轮上下文大致被约束在「固定部分 + 2 × 预算」以内。
 *
 * `keepRecent` 传本批工具结果的数量：**刚回灌的这一批永不折叠**，
 * 模型还没看过它们，折叠等于把这一轮的行动依据直接抽走。
 * 单批体量本身有界（并发上限 × 单条上限），所以「保证最新一批可见」不会破坏预算的量级。
 *
 * @returns 折叠了几条、以及折叠前后整份消息的估算 token（供轨迹记录）
 */
export function foldOldToolResults(
  messages: Message[],
  budgetTokens: number,
  keepRecent = 0,
): FoldResult {
  const tokensBefore = messagesTokens(messages);
  if (budgetTokens <= 0) return { folded: 0, tokensBefore, tokensAfter: tokensBefore };

  const toolMessages = messages.filter((message) => message.role === "tool");
  const candidates = Math.max(0, toolMessages.length - keepRecent);
  let toolTokens = messagesTokens(toolMessages);
  if (toolTokens <= budgetTokens || candidates === 0) {
    return { folded: 0, tokensBefore, tokensAfter: tokensBefore };
  }

  const placeholderCost = estimateTokens(FOLDED_PLACEHOLDER) + 4;
  let folded = 0;
  // 从最早的一条开始折叠：越早的结果越可能已经被后续推理消化掉了
  for (const message of toolMessages.slice(0, candidates)) {
    if (toolTokens <= budgetTokens) break;
    if (message.content === FOLDED_PLACEHOLDER) continue;
    toolTokens -= estimateTokens(message.content) + 4;
    message.content = FOLDED_PLACEHOLDER;
    toolTokens += placeholderCost;
    folded += 1;
  }
  return { folded, tokensBefore, tokensAfter: messagesTokens(messages) };
}

/** 卸载目录名（相对 workspace），需与文件沙箱根保持一致才能被 read_file 读回 */
const OFFLOAD_DIR = "offload";

/**
 * 清理历史卸载产物：保留最近 `keep` 个 run 目录，其余删掉。
 *
 * `workspace/offload/<runId>/` 是「按 run 累积、只增不减」的目录，不清理就一直占着磁盘。
 * 保留最近若干个而不是全删：刚跑完的那次，卸载文件还有可能被 read_file 取回
 * （模型看到预览后想让 agent 去读原文）。
 *
 * `keep <= 0` 表示不清理——与 `toolResultMaxChars` 的 0 语义保持一致（0 = 不限制）。
 *
 * @returns 删掉了几个 run 目录
 */
export async function pruneOffloadDir(workspace: string, keep: number): Promise<number> {
  if (keep <= 0) return 0;

  const root = resolve(workspace, OFFLOAD_DIR);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    // 目录不存在 = 还没卸载过任何东西
    return 0;
  }

  const dirs = entries.filter((entry) => entry.isDirectory());
  if (dirs.length <= keep) return 0;

  const stamped = await Promise.all(
    dirs.map(async (entry) => {
      const info = await stat(join(root, entry.name)).catch(() => undefined);
      return { name: entry.name, mtimeMs: info?.mtimeMs ?? 0 };
    }),
  );
  // 按修改时间倒序，保留最近的 keep 个
  stamped.sort((a, b) => b.mtimeMs - a.mtimeMs);

  let removed = 0;
  for (const item of stamped.slice(keep)) {
    try {
      await rm(join(root, item.name), { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warning(`清理卸载产物失败（${item.name}）: ${reason}`);
    }
  }
  if (removed > 0) {
    logger.info(`清理卸载产物: 删除 ${removed} 个历史 run 目录（保留最近 ${keep} 个）`);
  }
  return removed;
}

export interface OffloadOptions {
  /** 内联预览的字符上限；0 表示不限制 */
  maxChars: number;
  toolName: string;
  callId: string;
  runId: string;
  /** 文件沙箱根目录；卸载产物写在这里才有机会被 read_file 取回 */
  workspace: string;
}

/**
 * 工具结果过长的处理：**卸载，而不是丢弃**。
 *
 * 纯截断会把超出的内容永久丢掉；这里改成写入 `workspace/offload/<runId>/`，
 * 上下文里只留预览 + 提示，agent 需要细节时能自己用 read_file 取回
 * （文件沙箱的根就是 workspace，所以这个路径天然可达）。
 *
 * 写盘失败时退化为纯截断——卸载只是优化，不该成为对话的故障点。
 */
export async function offloadToolResult(
  content: string,
  options: OffloadOptions,
): Promise<string> {
  if (options.maxChars <= 0 || content.length <= options.maxChars) return content;

  const relativePath = [
    OFFLOAD_DIR,
    safeSegment(options.runId),
    `${safeSegment(options.toolName)}-${safeSegment(options.callId)}.txt`,
  ].join("/");

  try {
    const target = resolve(options.workspace, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf-8");
    return (
      `${content.slice(0, options.maxChars)}\n` +
      `…（结果共 ${content.length} 字符，已超过内联上限；` +
      `完整内容保存在 ${relativePath}，需要细节时用 read_file 读取）`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warning(`工具结果卸载失败，退化为截断: ${message}`);
    return truncateToolResult(content, options.maxChars);
  }
}

/** 路径片段只保留安全字符，避免工具名/runId 里的怪字符影响路径 */
function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * 纯截断：卸载不可用时的兜底。
 * 截断处必须附加明确说明，否则模型会把半截内容当成完整内容而误判。
 */
export function truncateToolResult(content: string, maxChars: number): string {
  if (maxChars <= 0 || content.length <= maxChars) return content;
  return `${content.slice(0, maxChars)}\n…（结果过长已截断，原始长度 ${content.length} 字符）`;
}
