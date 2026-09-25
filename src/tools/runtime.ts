/** 并发工具运行时：限流、独立超时、故障隔离、事件上报。 */

import type { EventBus } from "../core/events.js";
import { makeEvent, EventType, toolScopeStorage } from "../core/events.js";
import type { ToolCall, ToolResult } from "../core/types.js";
import type { ToolRegistry } from "./registry.js";
import { Semaphore } from "./semaphore.js";

export type BatchResult = [string, ToolResult];

export class ToolRuntime {
  private readonly semaphore: Semaphore;

  constructor(
    private readonly registry: ToolRegistry,
    maxConcurrency = 8,
    private readonly defaultTimeout = 30,
  ) {
    this.semaphore = new Semaphore(maxConcurrency);
  }

  /** 并发执行同一批工具调用，返回结果顺序与调用顺序一致 */
  async executeBatch(
    calls: ToolCall[],
    runId: string,
    bus: EventBus,
    signal: AbortSignal,
  ): Promise<BatchResult[]> {
    return Promise.all(calls.map((call) => this.runOne(call, runId, bus, signal)));
  }

  private async runOne(
    call: ToolCall,
    runId: string,
    bus: EventBus,
    signal: AbortSignal,
  ): Promise<BatchResult> {
    const release = await this.semaphore.acquire();
    try {
      await bus.publish(
        makeEvent(
          EventType.ToolStart,
          // call_id 用于把 start/end 精确配对：同一批里同名工具可能并发跑多次
          { call_id: call.id, name: call.name, arguments: call.arguments },
          runId,
        ),
      );
      const start = performance.now();

      let result: ToolResult;
      if (!this.registry.has(call.name)) {
        result = { ok: false, error: `工具 '${call.name}' 不存在` };
      } else {
        const tool = this.registry.get(call.name);
        // 把当次总线与 runId 放进作用域：工具内部（典型是子 agent）据此把事件发回父轨迹，
        // 否则子 agent 只能自建一条无人订阅的总线，中间步骤全丢
        result = await toolScopeStorage.run({ bus, runId }, () =>
          this.withTimeout(
            tool.run(call.arguments, signal),
            // 工具可自带超时（如子 agent 要跑很多轮），否则用运行时默认值
            tool.timeoutSeconds ?? this.defaultTimeout,
            call.name,
            signal,
          ),
        );
      }

      const latency = (performance.now() - start) / 1000;
      await bus.publish(
        makeEvent(
          EventType.ToolEnd,
          {
            call_id: call.id,
            name: call.name,
            ok: result.ok,
            error: result.error,
            latency,
            // 完整产出与入参一并上报，供 UI 展开查看与轨迹落盘
            input: call.arguments,
            output: result.data,
          },
          runId,
        ),
      );
      return [call.id, result];
    } finally {
      release();
    }
  }

  /** 单个工具超时或外部取消只影响自身，结果转为模型可见的错误 */
  private async withTimeout(
    task: Promise<ToolResult>,
    timeout: number,
    name: string,
    externalSignal: AbortSignal,
  ): Promise<ToolResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`工具 '${name}' 执行超过 ${timeout}s 超时`)),
        timeout * 1000,
      );
    });
    // 外部取消作为第三个竞速源
    const abortPromise = new Promise<never>((_, reject) => {
      if (externalSignal.aborted) {
        reject(new Error(`工具 '${name}' 已被取消`));
        return;
      }
      externalSignal.addEventListener(
        "abort",
        () => reject(new Error(`工具 '${name}' 已被取消`)),
        { once: true },
      );
    });
    try {
      // 注：超时后底层任务不会被取消（JS 无协作式取消），但其结果会被丢弃；
      // 支持 signal 的工具内部已随 abort 真正中断请求
      return await Promise.race([task, timeoutPromise, abortPromise]);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
