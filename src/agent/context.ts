/** 单次 Agent 运行的上下文：runId、取消信号、用量与迭代计数。 */

import { randomUUID } from "node:crypto";

import type { TokenUsage } from "../core/types.js";
import { emptyUsage } from "../core/types.js";

/**
 * 一次工具调用的事实记录：**只记「调了什么、成没成」**。
 *
 * 为什么不记工具输出：它已经落在 `traces/` 里，重复存一份只会让每轮上下文变大，
 * 而且记下来的文本同样可能被后续轮次引用成"本轮结果"。这里要解决的只有一个问题——
 * 让下一轮知道「上一轮真的调用过什么」，不至于把当前工具清单当成历史事实。
 */
export interface ToolFact {
  name: string;
  ok: boolean;
}

export class AgentContext {
  readonly runId: string;
  /** 取消控制器：abort 后进行中的 LLM/工具请求会立即中断 */
  readonly controller = new AbortController();
  cancelled = false;
  iterations = 0;
  readonly usage: TokenUsage = emptyUsage();
  /** 本次运行实际执行过的工具调用（含被拒/失败的），供会话历史持久化 */
  readonly tools: ToolFact[] = [];

  constructor(runId?: string) {
    this.runId = runId ?? randomUUID().replace(/-/g, "");
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** 请求取消当前运行：立即 abort 进行中的请求，并标记迭代边界退出 */
  requestCancel(): void {
    this.cancelled = true;
    if (!this.controller.signal.aborted) this.controller.abort();
  }
}
