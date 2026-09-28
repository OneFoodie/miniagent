/** Agent 门面：组装 LLM、工具运行时、事件总线，驱动 ReAct 主循环。 */

import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { Settings } from "../core/config.js";
import {
  AgentCancelledError,
  AgentLimitError,
  ApprovalRequiredError,
  MiniAgentError,
  QuestionRequiredError,
} from "../core/errors.js";
import { makeEvent, EventBus, EventType } from "../core/events.js";
import { getLogger, runIdStorage } from "../core/logging.js";
import type { AllowlistLookup, PermissionMode, ToolApprover } from "../core/permission.js";
import type { LLMResponse, Message, ToolCall, ToolResult } from "../core/types.js";
import type { BaseLLM } from "../llm/base.js";
import type { LongTermMemory } from "../memory/base.js";
import { estimateTokens, messagesTokens } from "../memory/base.js";
import type { SummaryMemory } from "../memory/summary.js";
import type { PromptBuilder } from "../prompts/builder.js";
import { promptBuilderForRole, type RolePreset } from "../prompts/roles.js";
import type { SkillRegistry } from "../skills/loader.js";
import { ASK_USER_TOOL_NAME, parseAskQuestions, type AskQuestion } from "../tools/builtins/askUser.js";
import type { ToolRegistry } from "../tools/registry.js";
import { ToolRuntime } from "../tools/runtime.js";
import {
  loadCheckpoint,
  recordApproval,
  removeCheckpoint,
  saveCheckpoint,
  type AskAnswer,
} from "./checkpoint.js";
import { AgentContext, type ToolFact } from "./context.js";
import { routeAfterReason, routeAtLoopStart } from "./routing.js";
import {
  createRunState,
  rebuildRunState,
  recordToolResults,
  renderProgress,
  setPlan,
  type RunState,
} from "./state.js";

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
   * 本次运行所属的会话 id。
   *
   * 长期记忆落在**一个全局共用**的文件里，若不限定范围，召回会把别的会话的历史带进本轮
   * ——现象就是「每个会话都带进了所有会话的历史」。给出会话 id 后召回只在该会话内进行。
   * 不传（CLI / 评测等没有会话概念的场景）则退回旧行为：不按会话过滤。
   */
  sessionId?: string;
  /**
   * 上一轮实际执行过的工具（运行期写入，非模型输出）。
   * 由调用方从会话历史里取出传进来——它会被渲染进系统提示词的证据小节，
   * 用来回答「我上一轮到底做过什么」这个问题。
   */
  executionLedger?: ToolFact[];
  /**
   * 权限档位：决定敏感工具由谁裁决。缺省 manual（与旧行为一致），
   * 因此不传它时框架的行为与加这个字段之前完全相同。
   */
  permissionMode?: PermissionMode;
  /** AI 审批器：仅 permissionMode==="ai" 时被调用；缺省则该档无从裁决，等同于不启用 */
  aiApprover?: ToolApprover;
  /**
   * 命令级放行白名单：命中即免问（连 AI 都不调用）。
   * 传同一个实例给 subagent，才能让子 agent 也认这份已放行清单。
   */
  allowlist?: AllowlistLookup;
}

/** 写存档所需的运行级信息（不进消息序列，但恢复时要能原样还原） */
interface RunMeta {
  input: string;
  createdAt: number;
  promptVersions: string[];
}

/** 续跑时的现场：待执行的工具调用（可能没有）+ 已做出的审批决定 + 已收到的回答 */
interface ResumeState {
  toolCalls?: ToolCall[];
  approvals: Record<string, boolean>;
  answers: Record<string, AskAnswer>;
}

/** act 的三种结局：跑完了一批、撞上需要审批的调用、撞上需要用户回答的调用 */
type ActOutcome =
  | { kind: "ran"; resultById: Map<string, ToolResult> }
  | { kind: "needs-approval"; call: ToolCall }
  | { kind: "needs-answer"; call: ToolCall };

/**
 * 一次工具调用的审批裁决：
 *  - `allow`     直接执行（完全访问档、已放行、非敏感工具、或已有人工决定）
 *  - `ask-human` 挂起等人工（手动审批档 + 敏感工具）
 *  - `ask-ai`    交 AI 裁决（自动 AI 审批档 + 敏感工具）
 */
type ApprovalDecision = "allow" | "ask-human" | "ask-ai";

/** 用户拒绝执行时回灌给模型的内容：必须说清「是被人拒了」，而不是「工具坏了」 */
const APPROVAL_DENIED = "用户拒绝执行该工具调用，请换一种方式或直接说明无法完成";

/**
 * 用户跳过提问时回灌给模型的内容。
 *
 * 那句「不要重复追问」不能省：否则模型常常把同一个问题再问一遍，
 * 而用户刚刚明确表示不想回答——于是变成一次反复打扰。
 */
const QUESTION_SKIPPED =
  "用户选择跳过这个问题。不要重复追问同一问题，按你已有的判断继续，或说明这一项无法确定。";

/** 把用户回答整理成工具结果：跳过与作答是两种截然不同的形状，模型一眼能区分 */
function askResult(answer: AskAnswer): Record<string, unknown> {
  if (answer.skipped) return { skipped: true, note: QUESTION_SKIPPED };
  return { answers: answer.answers };
}

/**
 * ToolCall → 存档里的「待决调用」。
 * 待批与待问在存档里是同一个形状（PendingApproval / PendingQuestion），因此共用一个转换。
 */
function toPendingCall(
  call: ToolCall | undefined,
): { callId: string; tool: string; arguments: Record<string, unknown> } | undefined {
  if (!call) return undefined;
  return { callId: call.id, tool: call.name, arguments: call.arguments };
}

export class Agent {
  private readonly runtime: ToolRuntime;
  private readonly promptBuilder: PromptBuilder;
  private readonly skills?: SkillRegistry;
  private readonly memory?: SummaryMemory;
  private readonly longTerm?: LongTermMemory;
  private readonly sessionId?: string;
  private readonly executionLedger?: ToolFact[];
  private readonly permissionMode: PermissionMode;
  private readonly aiApprover?: ToolApprover;
  private readonly allowlist?: AllowlistLookup;

  constructor(
    private readonly llm: BaseLLM,
    private readonly registry: ToolRegistry,
    private readonly settings: Settings,
    private readonly bus: EventBus = new EventBus(),
    options: AgentOptions = {},
  ) {
    this.permissionMode = options.permissionMode ?? "manual";
    this.aiApprover = options.aiApprover;
    this.allowlist = options.allowlist;
    this.runtime = new ToolRuntime(
      registry,
      settings.maxConcurrency,
      settings.toolTimeout,
      // 档位、审批器与白名单随工具作用域下传：子 agent 据此沿用父 run 的档位（见 subagent.ts）
      {
        permissionMode: this.permissionMode,
        aiApprover: this.aiApprover,
        allowlist: this.allowlist,
      },
    );
    this.promptBuilder =
      options.promptBuilder ?? promptBuilderForRole(options.role);
    this.skills = options.skills;
    this.memory = options.memory;
    this.longTerm = options.longTerm;
    this.sessionId = options.sessionId;
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

    // 3. 组装系统提示词：技能目录 + 记忆摘要 + 召回片段 + 当前进度
    //    本次运行的显式状态（计划 / 失败计数）从这里开始累积，见 state.ts
    const state = createRunState();
    const prompt = this.buildPrompt(context, state, recalled);

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
    const execute = () => this.loop(messages, context, meta, state, recalled);
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
    // 状态：优先用存档里的；旧存档没有该字段时从已执行工具反推失败计数（见 rebuildRunState）
    const state = rebuildRunState(checkpoint.state, context.tools);

    const messages = [...checkpoint.messages];
    const last = messages.at(-1);
    const pending: ResumeState = {
      toolCalls:
        last?.role === "assistant" && last.toolCalls?.length ? last.toolCalls : undefined,
      approvals: checkpoint.approvals ?? {},
      answers: checkpoint.answers ?? {},
    };

    const meta: RunMeta = {
      input: checkpoint.input,
      createdAt: checkpoint.createdAt,
      promptVersions: checkpoint.promptVersions,
    };

    const start = performance.now();
    logger.info(
      `续跑运行 ${runId}：从第 ${context.iterations} 轮之后继续` +
        (pending.toolCalls ? `（接着处理 ${pending.toolCalls.length} 个待决工具）` : ""),
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
        // 续跑不做长期召回（与中断前保持一致），因此 recalled 传空
        this.loop(messages, context, meta, state, [], pending),
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
      // 条数可配（MINIAGENT_MEMORY_RECALL_LIMIT）：召回内容每轮随 system 消息重发，
      // 条数直接决定每轮的固定输入成本，所以不该写死在代码里。
      // 同时限定在本会话内召回：长期记忆是全局共用的，不限定就会把别的会话的历史带进本轮。
      const records = await this.longTerm.search(query, this.settings.memoryRecallLimit, {
        sessionId: this.sessionId,
      });
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

  /**
   * ReAct 主循环，由路由驱动：reason（LLM）→ act（并发工具）→ observe（结果回灌）。
   *
   * 分支不再散在 while / if 里，而是交给 `routing.ts` 的三个纯函数决定走向，
   * 循环体只负责「按决策执行」。于是「什么时候结束、什么时候挂起、什么时候收尾作答」
   * 都可以单独测试，读代码时也不必自己去拼。
   */
  private async loop(
    messages: Message[],
    ctx: AgentContext,
    meta: RunMeta,
    state: RunState,
    recalled: string[],
    resume?: ResumeState,
  ): Promise<string> {
    // 恢复时可能已经有一批工具调用在等执行：挂起前 LLM 已经把它们给出来了
    let awaiting: ToolCall[] | undefined = resume?.toolCalls;
    const approvals: Record<string, boolean> = { ...resume?.approvals };
    const answers: Record<string, AskAnswer> = { ...resume?.answers };

    for (;;) {
      const control = routeAtLoopStart({
        step: ctx.iterations,
        maxSteps: this.settings.maxIterations,
        cancelled: ctx.cancelled,
      });
      if (control === "cancelled") throw new AgentCancelledError("Agent 已被取消");
      // 步数用尽 → 收尾作答，而不是抛错走人
      if (control === "wrap-up") return this.wrapUp(messages, ctx, state, recalled);

      // 每轮刷新 system 消息：进度、计划、失败、技能目录都可能是新的（见 refreshSystemPrompt）
      this.refreshSystemPrompt(messages, ctx, state, recalled);

      if (!awaiting) {
        const response = await this.reason(messages, ctx);
        if (routeAfterReason({ toolCallCount: response.toolCalls.length }) === "finish") {
          return response.content;
        }
        // 首轮若在发起工具调用的同时给了计划文字，记下来当锚点（只认第一次）
        if (this.settings.planMode) state = setPlan(state, parsePlan(response.content));
        awaiting = response.toolCalls;
      }

      const outcome = await this.act(awaiting, ctx, approvals, answers, meta.input);
      if (outcome.kind === "needs-approval") {
        // 挂起：把现场、状态与待批调用一起落盘，外部给出决定后再续跑。
        // 这一步优先于下面的取消判断：待批现场是攒出来的，不能因为此刻收到取消就丢掉
        await this.saveCheckpoint(messages, ctx, meta, {
          approvals,
          answers,
          pendingApproval: outcome.call,
          state,
        });
        throw new ApprovalRequiredError(
          `工具 ${outcome.call.name} 需要人工审批后才会执行`,
          ctx.runId,
          outcome.call,
        );
      }
      if (outcome.kind === "needs-answer") {
        // 同上，只是等的是「回答」而不是「批准」。现场照常落盘：用户可能过一会儿才答，
        // 期间进程重启也得能把这次提问原样取回来。
        await this.saveCheckpoint(messages, ctx, meta, {
          approvals,
          answers,
          pendingQuestion: outcome.call,
          state,
        });
        throw new QuestionRequiredError(
          `工具 ${outcome.call.name} 需要用户回答后才会继续`,
          ctx.runId,
          outcome.call,
        );
      }
      // 工具执行期间被取消 → 不再把结果回灌，直接结束
      if (ctx.signal.aborted) throw new AgentCancelledError("Agent 已被取消");

      await this.observe(messages, awaiting, outcome.resultById, ctx);
      await this.foldAndReport(messages, ctx, awaiting.length);

      // 状态归并：本批的工具事实已进 ctx.tools，取尾部这一段并入状态（纯函数，见 state.ts）
      state = recordToolResults(state, ctx.tools.slice(-awaiting.length));

      // 先记步数再存档：存档里的 iterations 表示「已完成的步数」，恢复时直接沿用
      ctx.iterations++;
      // 存档必须在「消息序列完整」时写：assistant 的 tool_calls 与随后的 tool 结果都齐了
      await this.saveCheckpoint(messages, ctx, meta, { approvals, answers, state });

      awaiting = undefined;
    }
  }

  /**
   * 收尾节点：步数用尽时不再直接抛错，而是给模型一次「用手头信息作答」的机会。
   *
   * 原来到上限就抛 AgentLimitError——跑了若干步、手里一堆中间结论，用户却只拿到一个报错。
   * 现在补一次调用（明确不许再调工具）；连这次都给不出回答才抛错兜底。
   * 这次调用照常计入 token 统计与轨迹，不隐藏成本。
   */
  private async wrapUp(
    messages: Message[],
    ctx: AgentContext,
    state: RunState,
    recalled: string[],
  ): Promise<string> {
    logger.info(`已达步数上限（${this.settings.maxIterations}），转入收尾作答`);
    this.refreshSystemPrompt(messages, ctx, state, recalled);
    messages.push({ role: "user", content: WRAP_UP_INSTRUCTION });

    const response = await this.reason(messages, ctx);
    const answer = response.content.trim();
    if (answer) return answer;

    throw new AgentLimitError(
      `已达到最大迭代次数 ${this.settings.maxIterations}，且模型未能给出收尾回答`,
    );
  }

  /**
   * 每轮覆盖 system 消息的内容。
   *
   * 为什么值得每轮重算：循环内发生的事（进度、失败、新技能）原本对模型完全不可见——
   * 系统提示词在 run 开头冻结，模型只能从工具输出里反推自己做到哪了。
   * 代价是服务商的提示词前缀缓存会失效（多付一点输入费用），换来「模型始终知道当下状态」。
   * 单机、每轮几百字符的量级，这笔交换是划算的。
   */
  private refreshSystemPrompt(
    messages: Message[],
    ctx: AgentContext,
    state: RunState,
    recalled: string[],
  ): void {
    const first = messages[0];
    if (first?.role !== "system") return;
    // 替换成新对象而不是原地改 content：FakeLLM/轨迹拿到的是消息数组的浅拷贝，
    // 原地改会让「每一轮当时看到的 system 内容」都变成最后一次的值，无从核对。
    messages[0] = { ...first, content: this.buildPrompt(ctx, state, recalled).text };
  }

  /** 组装系统提示词：技能目录、记忆摘要、召回片段、执行台账与当前进度都在这里注入 */
  private buildPrompt(
    ctx: AgentContext,
    state: RunState,
    recalled: string[],
  ): ReturnType<PromptBuilder["build"]> {
    return this.promptBuilder.build({
      skills: this.skills?.catalog() ?? [],
      memorySummary: this.memory?.currentSummary ?? "",
      recalledMemory: recalled,
      toolNames: this.registry.all().map((tool) => tool.name),
      executionLedger: this.executionLedger,
      progress: renderProgress({
        step: ctx.iterations,
        maxSteps: this.settings.maxIterations,
        tools: ctx.tools,
        state,
      }),
      planMode: this.settings.planMode,
    });
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
   * 需要人工审批而未决的调用会让整批先停下——**不能**只跳过它执行其余的：
   * 同一批工具往往是模型基于同一份判断一起发起的，批准其中一个而偷跑另一个没有意义。
   *
   * 自动 AI 审批档不同：AI 就地裁决、**不挂起**。因此它不写 checkpoint，
   * 也不抛 ApprovalRequiredError；拒绝时把理由作为工具结果回灌，让模型知道可以换路。
   *
   * `ask_user` 是第三类：它既不需要审批（不执行外部动作），也不能真的被执行
   * （「执行」它等于没有人的回答）。没回答就挂起等回答，有回答就**用回答构造结果**，
   * 因此它永远不进 `toRun`。
   */
  private async act(
    calls: ToolCall[],
    ctx: AgentContext,
    approvals: Record<string, boolean>,
    answers: Record<string, AskAnswer>,
    question: string,
  ): Promise<ActOutcome> {
    // AI 拒绝的调用：callId → 理由。与人工拒绝统一按「不执行」处理，但轨迹里能区分
    // （人工拒绝走 approvals，AI 拒绝走 approval_ai_verdict 事件）
    const aiDenied = new Map<string, string>();
    for (const call of calls) {
      if (this.decideApproval(call, approvals) !== "ask-ai") continue;
      // 走到这里 permissionMode 必为 "ai"；缺审批器时按拒绝处理更保守
      const judgeStart = performance.now();
      const verdict = this.aiApprover
        ? await this.aiApprover.judge(call, question, ctx.signal)
        : { verdict: "deny" as const, reason: "未配置 AI 审批器" };
      await this.bus.publish(
        makeEvent(
          EventType.ApprovalAiVerdict,
          {
            tool: call.name,
            arguments: call.arguments,
            verdict: verdict.verdict,
            reason: verdict.reason,
            // 裁决耗时进轨迹：AI 审批是额外一次 LLM 调用，成本要能被看到
            latency: (performance.now() - judgeStart) / 1000,
          },
          ctx.runId,
        ),
      );
      if (verdict.verdict === "deny") aiDenied.set(call.id, verdict.reason);
    }

    const undecided = calls.find(
      (call) => this.decideApproval(call, approvals) === "ask-human",
    );
    if (undecided) return { kind: "needs-approval", call: undecided };

    // 待问的调用：参数先校验，不合格的当普通错误回灌——否则会挂起一张没有选项的空卡片，
    // 用户点不动、运行也回不来。同一批里若有两个待问的，先挂起第一个，第二个下一轮再说。
    const askErrors = new Map<string, string>();
    let pendingAsk: { call: ToolCall; questions: AskQuestion[] } | undefined;
    for (const call of calls) {
      if (call.name !== ASK_USER_TOOL_NAME || answers[call.id] !== undefined) continue;
      let questions: AskQuestion[];
      try {
        questions = parseAskQuestions(call.arguments);
      } catch (error) {
        askErrors.set(call.id, error instanceof Error ? error.message : String(error));
        continue;
      }
      if (!pendingAsk) pendingAsk = { call, questions };
    }
    if (pendingAsk) {
      await this.bus.publish(
        makeEvent(
          EventType.QuestionAsked,
          { call_id: pendingAsk.call.id, questions: pendingAsk.questions },
          ctx.runId,
        ),
      );
      return { kind: "needs-answer", call: pendingAsk.call };
    }

    // 被拒的调用不执行，直接把「被拒绝」作为工具结果回灌——模型据此改走别的路子
    const denied = calls.filter((call) => approvals[call.id] === false);
    // ask_user 一律不交给运行时：有回答的由下面的 answers 分支构造结果，没回答的上面已返回
    const toRun = calls.filter(
      (call) =>
        approvals[call.id] !== false &&
        !aiDenied.has(call.id) &&
        call.name !== ASK_USER_TOOL_NAME,
    );
    const batch = await this.runtime.executeBatch(toRun, ctx.runId, this.bus, ctx.signal);

    const resultById = new Map(batch);
    for (const call of denied) {
      resultById.set(call.id, { ok: false, error: APPROVAL_DENIED });
    }
    for (const [callId, reason] of aiDenied) {
      resultById.set(callId, { ok: false, error: `${APPROVAL_DENIED}（AI 审批：${reason}）` });
    }
    for (const [callId, reason] of askErrors) {
      resultById.set(callId, { ok: false, error: reason });
    }
    // 用户的回答直接成为工具结果。走这里而不是走运行时，因此轨迹里不会有 tool_start/tool_end——
    // 它确实没有「被执行」，而是「被回答」，这一点从事件名上一眼可辨。
    for (const call of calls) {
      if (call.name !== ASK_USER_TOOL_NAME) continue;
      const answer = answers[call.id];
      if (!answer) continue;
      await this.bus.publish(
        makeEvent(
          EventType.QuestionAnswered,
          {
            call_id: call.id,
            answers: answer.answers,
            skipped: answer.skipped === true,
          },
          ctx.runId,
        ),
      );
      resultById.set(call.id, { ok: true, data: askResult(answer) });
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

  /**
   * 裁决一条工具调用由谁放行。判定顺序（先宽后严，白名单优先于一切）：
   *  1. 档位 = 完全访问           → 直接放行（即使工具在审批名单里）
   *  2. 工具 = ask_user           → 直接放行（它不执行动作，见下）
   *  3. 白名单命中 (tool, 参数)   → 直接放行（人工放行过，连 AI 都不调用）
   *  4. 审批名单不含该工具         → 直接放行（本来就不是敏感工具）
   *  5. 已有人工决定               → 放行（true 走执行、false 在上层按拒绝处理）
   *  6. 手动审批档                 → 挂起等人工
   *  7. 否则（自动 AI 审批档）     → 交 AI 裁决
   *
   * 第 2 步放在名单判断**之前**是刻意的：ask_user 的结果只能来自人的回答，
   * 「批准它」是一句没有意义的话。若有人把它误写进 MINIAGENT_APPROVAL_TOOLS，
   * 让它变成「等批准」会是一个没人看得懂的挂起——所以这里无条件把它排除在审批之外。
   *
   * 第 5 步不写进设计文档的顺序，但 act() 必须认它：续跑时挂起的那次调用已被决定过，
   * 不能再问第二遍。判定所需的信息都在内存里，全程同步——这正是白名单要常驻内存的原因。
   */
  private decideApproval(
    call: ToolCall,
    approvals: Record<string, boolean>,
  ): ApprovalDecision {
    if (this.permissionMode === "full") return "allow";
    if (call.name === ASK_USER_TOOL_NAME) return "allow";
    if (this.allowlist?.has(call.name, call.arguments)) return "allow";
    if (!this.settings.approvalTools.includes(call.name)) return "allow";
    if (approvals[call.id] !== undefined) return "allow";
    return this.permissionMode === "ai" ? "ask-ai" : "ask-human";
  }

  /** 落一次运行存档；未启用存档时是空操作 */
  private async saveCheckpoint(
    messages: Message[],
    ctx: AgentContext,
    meta: RunMeta,
    // 参数刻意不叫 state：函数体里的 state 专指 RunState，两个名字混用容易读错
    control: {
      approvals: Record<string, boolean>;
      answers: Record<string, AskAnswer>;
      pendingApproval?: ToolCall;
      pendingQuestion?: ToolCall;
      state: RunState;
    },
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
        // 显式状态一并入档：续跑时不必再从工具列表反推计划与失败计数
        state: control.state,
        approvals: control.approvals,
        // 回答与审批决定同样每次入档（不只在挂起时写）：一批里可能先答一个、再挂起问第二个
        answers: control.answers,
        // 这里不传就是 undefined，JSON 序列化后该字段消失——正常续跑点因此不会残留「待决」标记
        pendingApproval: toPendingCall(control.pendingApproval),
        pendingQuestion: toPendingCall(control.pendingQuestion),
      });
    } catch (error) {
      // 存档失败不该让正在跑的对话失败
      const reason = error instanceof Error ? error.message : String(error);
      logger.warning(`写入运行存档失败: ${reason}`);
    }
  }
}

/**
 * 收尾指令（步数用尽时追加）。
 *
 * 措辞刻意不提「步数用尽」：这条消息会留在消息序列里（下一次提问时它是历史的一部分），
 * 对用户而言它应该读起来像一次自然的追问，而不是一条系统报错。
 */
const WRAP_UP_INSTRUCTION =
  "请基于目前已经获得的信息给出最终回答：说明确认了什么、哪些尚未验证、结论的适用范围。";

/** 计划最多记几条、每条多少字：它是锚点而非全文，长了只会挤占上下文 */
const MAX_PLAN_ITEMS = 5;
const MAX_PLAN_ITEM_CHARS = 60;

/**
 * 从模型首轮的 content 里提取计划。
 *
 * 形态不固定（可能带序号、也可能是一句话），所以按换行/分号切开后逐条清洗，
 * 不追求精确解析——它只是给后续轮次一个锚点。提取不到就返回 undefined，
 * 不会为了「有东西可存」而编一条计划出来。
 */
function parsePlan(content: string): string[] | undefined {
  const items = content
    .split(/[\n；;]/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, "").trim())
    .filter(Boolean)
    .slice(0, MAX_PLAN_ITEMS)
    .map((line) =>
      line.length > MAX_PLAN_ITEM_CHARS ? `${line.slice(0, MAX_PLAN_ITEM_CHARS)}…` : line,
    );
  return items.length > 0 ? items : undefined;
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
