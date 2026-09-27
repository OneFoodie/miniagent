/**
 * 循环的走向决策（借鉴 LangGraph 的 conditional edges）。
 *
 * 为什么单独抽成纯函数：原先这些分支散在 `loop` 的 while / if 里，读代码时要自己
 * 把「什么情况下会结束、什么时候会收尾作答」拼出来。集中之后：
 *   - 决策可穷举、可单测（不需要真跑一次 Agent）；
 *   - 循环体只剩「按决策执行」，节点职责一眼可见。
 *
 * **为什么没有 `routeAfterAct`**：act 之后的两个分支（挂起 / 取消）确实也有优先级，
 * 但它们必须写在 `outcome.kind` 的类型收窄里——一旦抽成独立函数，调用点就得再补一次
 * 不变量检查（"路由说挂起时 outcome 一定是挂起"），反而更绕。取舍记在这里，避免
 * 后来者以为漏了。
 */

/** 进入一轮之前：还能继续吗 */
export type LoopControl = "continue" | "wrap-up" | "cancelled";

export function routeAtLoopStart(input: {
  step: number;
  maxSteps: number;
  cancelled: boolean;
}): LoopControl {
  if (input.cancelled) return "cancelled";
  // 余量用尽 → 去收尾作答，而不是抛错走人：
  // 已经做了若干轮、手里有一堆中间结论，却因为「没轮次了」什么都拿不到，是最差的结局。
  return input.step >= input.maxSteps ? "wrap-up" : "continue";
}

/** reason 之后：模型给的是最终答案，还是要动手 */
export type AfterReason = "act" | "finish";

export function routeAfterReason(input: { toolCallCount: number }): AfterReason {
  return input.toolCallCount === 0 ? "finish" : "act";
}
