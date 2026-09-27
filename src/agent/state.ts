/**
 * 一次运行的显式状态（借鉴 LangGraph 的 state + reducer）。
 *
 * 为什么要显式：原先「跑到第几步、什么失败过、有没有计划」散落在 `AgentContext`
 * （iterations / tools）与消息序列里，循环内没有任何一处能一眼看全，模型更看不到——
 * 系统提示词在整个 run 内是冻结的。把状态提出来之后，它有三处用处：
 *   1. 渲染成提示词里的「当前进度」段，**每轮刷新**（模型因此知道自己做到哪、还剩几步）；
 *   2. 作为存档的一部分，续跑时不必从消息序列里反推；
 *   3. 被 `routing.ts` 的纯函数读取，于是路由决策可穷举、可单测。
 *
 * 刻意**不存** step 与已执行工具：它们已由 `AgentContext`（iterations / tools）持有，
 * 复制一份就会有两个真相。状态只装 AgentContext 没有的东西——计划与失败计数。
 */

import type { ToolFact } from "./context.js";

/** 同一工具连续失败到这个次数，就值得让模型先解释原因再换路子 */
export const REPEATED_FAILURE_THRESHOLD = 2;

export interface RunState {
  /** 首轮产出的计划（模型在发起工具调用的同时给出的那几句话）；未启用或没给时为 undefined */
  plan?: string[];
  /** 工具失败累计次数：工具名 → 次数 */
  failures: Record<string, number>;
  /** 最近一次失败的工具名；用于判断「是不是同一个工具在反复失败」 */
  lastFailedTool?: string;
  /** 同一工具连续失败的次数（出现一次成功即清零） */
  consecutiveFailures: number;
}

export function createRunState(): RunState {
  return { failures: {}, consecutiveFailures: 0 };
}

/**
 * 把一批工具结果并进状态（纯函数，返回新状态）。
 *
 * 连续失败的判定按「批内顺序」推进：同一批里 A 成功、B 失败，则以 B 为最新状态——
 * 这与模型看到的顺序一致，不会把先成功的 A 当成"已恢复"。
 */
export function recordToolResults(state: RunState, facts: ToolFact[]): RunState {
  if (facts.length === 0) return state;

  const failures = { ...state.failures };
  let lastFailedTool = state.lastFailedTool;
  let consecutive = state.consecutiveFailures;

  for (const fact of facts) {
    if (fact.ok) {
      consecutive = 0;
      continue;
    }
    failures[fact.name] = (failures[fact.name] ?? 0) + 1;
    consecutive = lastFailedTool === fact.name ? consecutive + 1 : 1;
    lastFailedTool = fact.name;
  }

  return { ...state, failures, lastFailedTool, consecutiveFailures: consecutive };
}

/** 记下首轮计划。只认第一次：后续轮次可能只是复述或改口，反复改写会让计划失去锚点作用 */
export function setPlan(state: RunState, plan: string[] | undefined): RunState {
  if (state.plan || !plan || plan.length === 0) return state;
  return { ...state, plan };
}

/** 是否已有同一工具反复失败，值得提示模型换路子（对应系统的「失败驱动反思」） */
export function hasRepeatedFailure(state: RunState): boolean {
  return state.consecutiveFailures >= REPEATED_FAILURE_THRESHOLD;
}

/**
 * 从存档重建状态。
 *
 * 为什么需要：`state` 是后加的字段，加它之前写下的存档没有它。缺了就**从已执行工具反推**
 * 失败计数——否则续跑出来的那一轮会丢掉「什么反复失败过」，而失败计数正是决定要不要
 * 提示模型换路子的依据。计划反推不出来（旧存档没落过），这是可接受的损失：它只是锚点。
 */
export function rebuildRunState(saved: RunState | undefined, tools: ToolFact[]): RunState {
  if (saved && typeof saved === "object" && saved.failures) {
    // consecutiveFailures 单独兜底：手工构造或更早写下的状态可能没有它
    return { ...saved, consecutiveFailures: saved.consecutiveFailures ?? 0 };
  }
  return recordToolResults(createRunState(), tools);
}

export interface ProgressInput {
  /** 已完成的步数（= AgentContext.iterations） */
  step: number;
  maxSteps: number;
  /** 本次运行已执行过的工具（= AgentContext.tools） */
  tools: ToolFact[];
  state: RunState;
}

/**
 * 渲染成提示词的「当前进度」段。每轮进上下文，所以刻意写得短。
 * 空内容返回空串，由 PromptBuilder 按「空段不出现」处理。
 */
export function renderProgress(input: ProgressInput): string {
  const { step, maxSteps, tools, state } = input;
  const lines = [`已用 ${step}/${maxSteps} 步。`];

  if (state.plan?.length) {
    lines.push(`计划：${state.plan.map((item, index) => `${index + 1}) ${item}`).join("；")}`);
  }

  const executed = summarizeTools(tools);
  if (executed) lines.push(`已执行：${executed}`);

  if (hasRepeatedFailure(state) && state.lastFailedTool) {
    lines.push(
      `注意：${state.lastFailedTool} 已连续失败 ${state.consecutiveFailures} 次，` +
        "先说明失败原因再换思路，不要用相同参数重试。",
    );
  }

  return lines.join("\n");
}

/** 工具执行情况压成一行：同名合并计数，成败分开 */
function summarizeTools(tools: ToolFact[]): string {
  if (tools.length === 0) return "";

  const ok = new Map<string, number>();
  const failed = new Map<string, number>();
  for (const fact of tools) {
    const bucket = fact.ok ? ok : failed;
    bucket.set(fact.name, (bucket.get(fact.name) ?? 0) + 1);
  }

  const parts: string[] = [];
  for (const [name, count] of ok) parts.push(count > 1 ? `${name}×${count} 成功` : `${name} 成功`);
  for (const [name, count] of failed) {
    parts.push(count > 1 ? `${name}×${count} 失败` : `${name} 失败`);
  }
  return parts.join("；");
}
