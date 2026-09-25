/**
 * 子 agent 工具：把一次「要翻很多资料才能得出结论」的探索隔离出去。
 *
 * 对应业界上下文工程里的 **Isolate** 一族：父 agent 只拿到子 agent 的最终结论，
 * 中间的几十次检索与读文件都留在子 agent 自己的上下文里。工具往返正是上下文膨胀的主因，
 * 隔离之后主窗口能一直保持干净。
 *
 * 两个工具：
 *  - `run_subagent`：派一个子 agent（可指定角色）
 *  - `run_subagents`：并行派 2-5 个互不依赖的子任务，等全部完成再一次性回传
 *
 * **角色化**（见 prompts/roles.ts）：角色既改提示词也裁工具集——复核员拿不到写文件权限，
 * 这是"换个身份"与"换个语气"的区别所在。
 *
 * 深度天然限制为 1：子 agent 用的是「不含这两个工具」的注册表副本（见 childRegistryOf）。
 * 子 agent 不挂记忆与长期召回——独立干净的上下文正是它的意义所在。
 *
 * **轨迹是打通的**：子 agent 有自己的总线（它需要一条独立总线来做内部事件流），
 * 但这条总线的事件会被**中继到父总线**（见下方 bridgeToParent），
 * 所以中间步骤会一并进父的 JSONL 轨迹、进 `/metrics`、也会实时推到前端。
 * 中继时给 payload 加 `sub_run_id` 标记，轨迹回放时能认出「这一步来自子 agent」；
 * 并行时还会带 `sub_role` / `sub_label`，用来分辨交错到达的事件各自属于哪个子 agent。
 * 事件必须带**父的 runId** 发布：Tracer 按 `event.runId` 决定写哪个文件，
 * 沿用子 runId 只会多出一个孤立的轨迹文件，等于没打通。
 *
 * 上下文隔离与可观测是两件事：前者靠工具集副本，后者靠中继，互不冲突。
 */

import { z } from "zod";

import { Agent } from "../../agent/agent.js";
import { AgentContext } from "../../agent/context.js";
import type { Settings } from "../../core/config.js";
import { currentToolScope, EventBus, makeEvent, WILDCARD } from "../../core/events.js";
import type { BaseLLM } from "../../llm/base.js";
import { describeRoles, findRole, knownRoles, type RolePreset } from "../../prompts/roles.js";
import { defineTool } from "../base.js";
import { ToolRegistry } from "../registry.js";

export const SUBAGENT_TOOL_NAME = "run_subagent";
export const SUBAGENT_PARALLEL_TOOL_NAME = "run_subagents";

/** 派子 agent 的工具全部在此：子注册表要把它们都摘掉，递归深度才是 1 */
const SUBAGENT_TOOL_NAMES: readonly string[] = [
  SUBAGENT_TOOL_NAME,
  SUBAGENT_PARALLEL_TOOL_NAME,
];

/** 工具运行时给本工具预留的余量：让协作式取消先生效，避免硬超时把子 agent 丢在后台继续跑 */
const TIMEOUT_HEADROOM_SECONDS = 30;

/** 并行派发的数量上限：再多就该让子 agent 自己再分层，而不是让模型一口气发十几个请求 */
const MAX_PARALLEL_TASKS = 5;

export interface SubagentDeps {
  llm: BaseLLM;
  settings: Settings;
  /**
   * 取一份不含子 agent 工具的工具集。
   * 用工厂而非直接传注册表，是为了绕开「注册自己时需要注册表、而注册表此时还没有自己」的循环。
   * 传 role 时按角色的工具白名单再过滤一次。
   */
  childRegistry: (role?: RolePreset) => ToolRegistry;
}

/**
 * 复制一份不含子 agent 工具的工具集——递归深度由此天然为 1。
 * 给了 role.tools 就再按白名单裁剪，**严格生效**：白名单以外的一律不给。
 *
 * 刻意不做"白名单一个都不匹配就退回全量"的兜底：那等于在配置错位时悄悄把写权限
 * 交回给一个本该只读的角色，宁可让它没有工具，也不能让角色约束失效。
 */
export function childRegistryOf(
  registry: ToolRegistry,
  role?: RolePreset,
): ToolRegistry {
  const child = new ToolRegistry();
  for (const tool of registry.all()) {
    if (SUBAGENT_TOOL_NAMES.includes(tool.name)) continue;
    if (role?.tools && !role.tools.includes(tool.name)) continue;
    child.register(tool);
  }
  return child;
}

/**
 * 把子总线上的一切事件中继到父总线，让子 agent 的中间步骤进父的轨迹与指标。
 *
 * 沿用一个**新的 runId** 会打不通：Tracer / Metrics / SSE 都挂在父总线上按父 runId 工作，
 * 所以中继时必须用父的 runId 发布，子 runId 只作为 payload 里的标记保留。
 * 中继出去的 payload 带 `sub_run_id`，回放时能一眼看出这步来自子 agent。
 *
 * `label` 用于并行场景：同批多个子 agent 的事件会交错到达，`sub_role` / `sub_label`
 * 是区分「这一步是谁做的」的唯一线索。
 */
function bridgeToParent(
  childBus: EventBus,
  parentBus: EventBus,
  parentRunId: string,
  label: Record<string, unknown>,
): void {
  childBus.subscribe(WILDCARD, async (event) => {
    await parentBus.publish(
      makeEvent(
        event.type,
        { ...event.payload, ...label, sub_run_id: event.runId, from_subagent: true },
        parentRunId,
      ),
    );
  });
}

/** 一次子 agent 调用的入参（单发与并发的公共形状） */
interface SubagentCall {
  task: string;
  /** 角色名；未指定则用通用提示词 */
  role?: string;
  maxIterations: number;
  /** 并行时用于标注事件来源，单发时为空 */
  label?: string;
}

interface SubagentOutcome {
  role: string;
  answer: string;
  iterations: number;
  tokens: number;
}

/**
 * 跑一个子 agent。
 *
 * 三件事必须做对：
 *  1. **上下文隔离**：独立 AgentContext + 独立总线，父只拿结论；
 *  2. **可观测打通**：子总线事件中继到父总线（见 bridgeToParent）；
 *  3. **取消与超时**：父被取消或超时 → 协作式取消，绝不留后台孤儿。
 */
async function runSubagentOnce(
  deps: SubagentDeps,
  call: SubagentCall,
  signal: AbortSignal,
): Promise<SubagentOutcome> {
  const role = call.role ? findRole(call.role) : undefined;
  if (call.role && !role) {
    throw new Error(`未知角色 '${call.role}'；可选: ${knownRoles()}`);
  }

  const timeoutSeconds = deps.settings.subagentTimeout;
  const context = new AgentContext();

  // 父被取消 → 子也停；超时也走同一条协作式取消，否则子 agent 会变成后台孤儿
  const forwardAbort = (): void => context.requestCancel();
  signal.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(() => context.requestCancel(), timeoutSeconds * 1000);

  try {
    // 子 agent 用独立总线做内部事件流，再中继到父总线——这样上下文隔离与轨迹可见兼得
    const bus = new EventBus();
    const scope = currentToolScope();
    if (scope) {
      bridgeToParent(bus, scope.bus, scope.runId, {
        ...(role ? { sub_role: role.name } : {}),
        ...(call.label ? { sub_label: call.label } : {}),
      });
    }

    const agent = new Agent(
      deps.llm,
      deps.childRegistry(role),
      { ...deps.settings, maxIterations: call.maxIterations },
      bus,
      { role },
    );
    const result = await agent.run(call.task, [], context);
    return {
      role: role?.name ?? "general",
      answer: result.answer,
      iterations: result.context.iterations,
      tokens: result.context.usage.promptTokens + result.context.usage.completionTokens,
    };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", forwardAbort);
  }
}

const roleArg = z
  .string()
  .optional()
  .describe(`子 agent 的角色，可选 ${knownRoles()}；不填用通用助手`);

const maxIterationsArg = z
  .number()
  .int()
  .min(1)
  .max(12)
  .optional()
  .describe("子 agent 的最大迭代轮数，默认取配置值");

export function registerSubagent(registry: ToolRegistry, deps: SubagentDeps): void {
  // 比协作式取消的时限略长，保证先由「取消」而不是「硬超时」收尾
  const timeoutSeconds = deps.settings.subagentTimeout + TIMEOUT_HEADROOM_SECONDS;

  registry.register(
    defineTool({
      name: SUBAGENT_TOOL_NAME,
      description:
        "把一段需要大量探索的子任务交给独立的子 agent 执行，只返回它的最终结论。" +
        "子 agent 有自己完整的工具和独立上下文，中间的检索、读文件过程不会占用你的上下文。" +
        "适合：需要翻阅多个文件、或多次检索才能得出一个结论的子任务。" +
        "不适合：一两步就能答完的问题（自己直接做更快，派子 agent 反而更贵）。" +
        `可用角色：${describeRoles()}。`,
      args: z.object({
        task: z
          .string()
          .min(1)
          .describe("交给子 agent 的完整任务描述。它看不到你的对话历史，任务必须自包含"),
        role: roleArg,
        max_iterations: maxIterationsArg,
      }),
      timeoutSeconds,
      handler: async ({ task, role, max_iterations }, signal) => {
        const outcome = await runSubagentOnce(
          deps,
          {
            task,
            role,
            maxIterations: max_iterations ?? deps.settings.subagentMaxIterations,
          },
          signal,
        );
        return {
          answer: outcome.answer,
          role: outcome.role,
          iterations: outcome.iterations,
          tokens: outcome.tokens,
        };
      },
    }),
  );

  registry.register(
    defineTool({
      name: SUBAGENT_PARALLEL_TOOL_NAME,
      description:
        "并行派发多个互不依赖的子任务，等全部完成后一次性拿到各自结论。" +
        "适合：几个方向的资料调研、同一批对象的横向对比这类「彼此无依赖、只是量大」的工作。" +
        "不适合：后一步要用前一步结果的串行任务（那应该分多次 run_subagent）。" +
        `可用角色：${describeRoles()}。`,
      args: z.object({
        tasks: z
          .array(
            z.object({
              task: z.string().min(1).describe("该子任务的完整描述，必须自包含"),
              role: roleArg,
              max_iterations: maxIterationsArg,
            }),
          )
          .min(2)
          .max(MAX_PARALLEL_TASKS)
          .describe(`2-${MAX_PARALLEL_TASKS} 个互不依赖的子任务`),
      }),
      timeoutSeconds,
      handler: async ({ tasks }, signal) => {
        // 全部一起发出：工具运行时本身已有并发上限，这里不再自建信号量
        const settled = await Promise.all(
          tasks.map(async (item) => {
            const label = item.task.slice(0, 24);
            try {
              const outcome = await runSubagentOnce(
                deps,
                {
                  task: item.task,
                  role: item.role,
                  maxIterations: item.max_iterations ?? deps.settings.subagentMaxIterations,
                  label,
                },
                signal,
              );
              return { task: item.task, ok: true, ...outcome };
            } catch (error) {
              // 一个子任务失败不该吞掉其他子任务的产出
              return {
                task: item.task,
                ok: false,
                role: item.role ?? "general",
                error: error instanceof Error ? error.message : String(error),
              };
            }
          }),
        );
        return {
          results: settled,
          succeeded: settled.filter((item) => item.ok).length,
          total: settled.length,
        };
      },
    }),
  );
}
