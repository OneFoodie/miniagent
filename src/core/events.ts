/** 轻量异步事件总线：业务动作发事件，可观测组件订阅，二者完全解耦。 */

import { AsyncLocalStorage } from "node:async_hooks";

import type { LLMError } from "./errors.js";

/** 通配订阅：接收所有事件 */
export const WILDCARD = "*";

/** 框架内置事件类型，集中定义避免拼写不一致 */
export const EventType = {
  RunStart: "run_start",
  RunEnd: "run_end",
  LLMStart: "llm_start",
  /** 流式增量：模型逐段吐出的文本（或工具调用开始） */
  LLMDelta: "llm_delta",
  LLMEnd: "llm_end",
  /** 模型调用失败且重试已耗尽（区别于工具错误） */
  LLMError: "llm_error",
  ToolStart: "tool_start",
  ToolEnd: "tool_end",
  /** 长期记忆检索：本轮按问题召回了哪些片段 */
  MemoryRecall: "memory_recall",
  /** 长期记忆写入：本轮往长期记忆里放了什么 */
  MemoryWrite: "memory_write",
  /** 循环内上下文收紧：把早期工具结果折叠掉了多少 */
  ContextTrim: "context_trim",
} as const;

export interface Event {
  type: string;
  payload: Record<string, unknown>;
  runId: string;
  ts: number;
}

export type EventHandler = (event: Event) => Promise<void>;

export function makeEvent(
  type: string,
  payload: Record<string, unknown>,
  runId: string,
): Event {
  return { type, payload, runId, ts: Date.now() / 1000 };
}

export class EventBus {
  private handlers = new Map<string, EventHandler[]>();

  /** 订阅指定事件；eventType='*' 订阅全部事件 */
  subscribe(eventType: string, handler: EventHandler): void {
    const list = this.handlers.get(eventType) ?? [];
    list.push(handler);
    this.handlers.set(eventType, list);
  }

  /** 通知所有相关订阅者。订阅者自身异常只记录，不影响主流程 */
  async publish(event: Event): Promise<void> {
    const specific = this.handlers.get(event.type) ?? [];
    const wildcard = this.handlers.get(WILDCARD) ?? [];
    if (specific.length + wildcard.length === 0) return;

    const results = await Promise.allSettled(
      [...specific, ...wildcard].map((handler) => handler(event)),
    );
    for (const result of results) {
      if (result.status === "rejected") {
        // 延迟引入 logger，避免与 logging 模块产生循环依赖
        const reason = result.reason as LLMError;
        // eslint-disable-next-line no-console -- 同上：这里不能用 logger，否则循环依赖
        console.warn(`事件订阅者执行失败: ${reason?.message ?? result.reason}`);
      }
    }
  }
}

/** 工具执行期的作用域：把「当次请求的事件总线与 runId」传进工具内部 */
export interface ToolScope {
  bus: EventBus;
  runId: string;
}

/**
 * 为什么需要它：`ToolRegistry` 在**进程启动时**就构建好了，而 server 的事件总线是**按请求创建**的，
 * 所以工具的闭包里捕获不到当次请求的总线。子 agent 因此只能自建一条无人订阅的总线，
 * 中间步骤就进不了父轨迹。运行时在执行工具前把作用域放进这里，工具内部按需取用。
 */
export const toolScopeStorage = new AsyncLocalStorage<ToolScope>();

/** 取当前工具执行期的作用域；不在工具执行期（如单测直接调 tool.run）时返回 undefined */
export function currentToolScope(): ToolScope | undefined {
  return toolScopeStorage.getStore();
}
