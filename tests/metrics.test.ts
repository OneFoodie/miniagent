/** 指标聚合：attach 模式、跨总线累计、错误率口径、Prometheus 导出。 */

import { describe, expect, it } from "vitest";

import { EventBus, EventType, makeEvent } from "../src/core/events.js";
import { Metrics, percentile } from "../src/observability/metrics.js";

describe("Metrics", () => {
  it("可跨多个总线累计（server 是每请求一个 bus）", async () => {
    const metrics = new Metrics();
    const first = new EventBus();
    const second = new EventBus();
    metrics.attach(first);
    metrics.attach(second);

    await first.publish(
      makeEvent(EventType.RunEnd, { ok: true, iterations: 1, latency: 2 }, "r1"),
    );
    await second.publish(
      makeEvent(EventType.RunEnd, { ok: true, iterations: 3, latency: 4 }, "r2"),
    );

    const snapshot = metrics.snapshot();
    expect(snapshot.counters.runs).toBe(2);
    expect(snapshot.histograms["run.iterations"]!.count).toBe(2);
    expect(snapshot.histograms["run.iterations"]!.max).toBe(3);
  });

  it("同一个总线重复 attach 不会重复计数", async () => {
    const metrics = new Metrics();
    const bus = new EventBus();
    metrics.attach(bus);
    metrics.attach(bus);

    await bus.publish(makeEvent(EventType.RunEnd, { ok: true, iterations: 1 }, "r1"));
    expect(metrics.snapshot().counters.runs).toBe(1);
  });

  it("run 失败与工具失败分别计入错误率", async () => {
    const metrics = new Metrics();
    const bus = new EventBus();
    metrics.attach(bus);

    await bus.publish(makeEvent(EventType.RunEnd, { ok: false, iterations: 8 }, "r1"));
    await bus.publish(
      makeEvent(EventType.ToolEnd, { name: "web_search", ok: false, latency: 1 }, "r1"),
    );
    await bus.publish(
      makeEvent(EventType.ToolEnd, { name: "web_search", ok: true, latency: 2 }, "r1"),
    );

    const { counters } = metrics.snapshot();
    expect(counters["runs.failed"]).toBe(1);
    // 汇总口径：算总错误率
    expect(counters["tool.calls"]).toBe(2);
    expect(counters["tool.errors"]).toBe(1);
    // 分工具口径：定位是哪个工具在失败
    expect(counters["tool.web_search.errors"]).toBe(1);
  });

  it("模型重试耗尽单独计入，不混进工具错误", async () => {
    const metrics = new Metrics();
    const bus = new EventBus();
    metrics.attach(bus);

    await bus.publish(
      makeEvent(EventType.LLMError, { message: "429 重试耗尽", latency: 6 }, "r1"),
    );

    const { counters, histograms } = metrics.snapshot();
    expect(counters["llm.errors"]).toBe(1);
    // 关键：不能被算成工具错误，否则「哪位工具在失败」的判断会被污染
    expect(counters["tool.errors"]).toBeUndefined();
    expect(histograms["llm_error.latency"]!.max).toBe(6);
  });

  it("toPrometheus 输出 counter 与 summary，且指标名不含点", async () => {
    const metrics = new Metrics();
    const bus = new EventBus();
    metrics.attach(bus);

    await bus.publish(
      makeEvent(
        EventType.LLMEnd,
        { latency: 1, prompt_tokens: 10, completion_tokens: 2 },
        "r1",
      ),
    );
    await bus.publish(
      makeEvent(EventType.ToolEnd, { name: "web_search", ok: false, latency: 0.5 }, "r1"),
    );

    const text = metrics.toPrometheus();
    expect(text).toContain("# TYPE llm_calls counter");
    expect(text).toContain("llm_calls 1");
    expect(text).toContain("llm_prompt_tokens 10");
    expect(text).toContain('llm_latency{quantile="0.5"}');
    expect(text).toContain("llm_latency_count 1");
    // `tool.web_search.errors` 必须转成下划线形式，否则是非法指标名
    expect(text).toContain("tool_web_search_errors 1");
    expect(text).not.toMatch(/^[a-z_]+[a-z0-9_]*\.[a-z]/m);
  });

  it("percentile 处理空数组与边界", () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([1], 0.95)).toBe(1);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(3);
  });
});
