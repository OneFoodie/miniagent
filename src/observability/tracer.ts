/** JSONL 运行轨迹：每个 run 一个文件，逐条事件落盘，可用于回放与离线分析。 */

import { appendFile, mkdir } from "node:fs/promises";

import type { Event, EventBus } from "../core/events.js";
import { EventType, WILDCARD } from "../core/events.js";

export class Tracer {
  constructor(
    bus: EventBus,
    private readonly traceDir: string,
  ) {
    void mkdir(traceDir, { recursive: true });
    // 通配订阅：接收全部事件
    bus.subscribe(WILDCARD, (event) => this.onEvent(event));
  }

  private async onEvent(event: Event): Promise<void> {
    // 流式增量逐 token 到达，落盘会让轨迹膨胀几个数量级，而它对回放没有价值
    // （完整文本在随后的 llm_end 里已有）。实时性由 SSE 承担，落盘只留结论。
    if (event.type === EventType.LLMDelta) return;

    const record = {
      ts: event.ts,
      run_id: event.runId,
      type: event.type,
      payload: event.payload,
    };
    const path = `${this.traceDir}/${event.runId}.jsonl`;
    // 追加写并立即落盘，保证异常退出时轨迹也不丢
    await appendFile(
      path,
      `${JSON.stringify(record)}\n`,
      "utf-8",
    );
  }
}
