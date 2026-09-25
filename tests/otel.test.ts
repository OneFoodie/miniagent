/**
 * OTLP/HTTP 导出测试。
 *
 * 校验两件事：**映射对不对**（内部事件 → GenAI 语义约定的 span，父子关系与属性）
 * 和 **协议对不对**（OTLP JSON 的字段名与取值编码）。这两块都不能靠肉眼保证。
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadSettings, type Settings } from "../src/core/config.js";
import { EventBus, EventType, makeEvent } from "../src/core/events.js";
import { OtelExporter } from "../src/observability/otel.js";

interface Attribute {
  key: string;
  value: Record<string, unknown>;
}

interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Attribute[];
  status: { code: number; message?: string };
}

interface RecordedRequest {
  url: string;
  init: RequestInit;
}

const ENV_KEYS = [
  "MINIAGENT_OTEL_ENABLED",
  "MINIAGENT_OTEL_ENDPOINT",
  "MINIAGENT_OTEL_SERVICE_NAME",
  "MINIAGENT_OTEL_HEADERS",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_SERVICE_NAME",
];

function withEnv(values: Record<string, string>): void {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, values);
}

function otelSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    ...loadSettings(),
    otelEnabled: true,
    otelEndpoint: "http://collector.test:4318",
    otelServiceName: "miniagent-test",
    otelHeaders: { "x-api-key": "secret" },
    model: "test-model",
    // 测试里不跑定时器：上报时机由 close() 显式触发，避免留下游离的 interval
    otelMetricsInterval: 0,
    ...overrides,
  };
}

function stubFetch(handler?: () => Response): RecordedRequest[] {
  const calls: RecordedRequest[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return handler ? handler() : new Response("{}", { status: 200 });
  });
  return calls;
}

/** 只看 /v1/traces 的请求：close() 还会顺带上报一次指标 */
function traceCalls(calls: RecordedRequest[]): RecordedRequest[] {
  return calls.filter((call) => call.url.endsWith("/v1/traces"));
}

/** 只看 /v1/metrics 的请求 */
function metricCalls(calls: RecordedRequest[]): RecordedRequest[] {
  return calls.filter((call) => call.url.endsWith("/v1/metrics"));
}

/** 取第 index 次请求里的 span 列表 */
function spansOf(call: RecordedRequest): Span[] {
  const body = JSON.parse(String(call.init.body)) as {
    resourceSpans: Array<{ scopeSpans: Array<{ spans: Span[] }> }>;
  };
  return body.resourceSpans[0]!.scopeSpans[0]!.spans;
}

function attrs(span: Span): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const { key, value } of span.attributes) {
    result[key] = value.stringValue ?? value.intValue ?? value.boolValue ?? value.doubleValue;
  }
  return result;
}

function spanNamed(spans: Span[], name: string): Span | undefined {
  return spans.find((span) => span.name === name);
}

/** 走完一个「LLM → 工具 → 收尾」的完整 run */
async function publishRun(bus: EventBus, runId = "run-1"): Promise<void> {
  await bus.publish(makeEvent(EventType.RunStart, { input: "算一下" }, runId));
  await bus.publish(makeEvent(EventType.LLMStart, { iteration: 1 }, runId));
  await bus.publish(
    makeEvent(
      EventType.LLMEnd,
      {
        iteration: 1,
        latency: 0.3,
        prompt_tokens: 120,
        completion_tokens: 30,
        finish_reason: "tool_calls",
        content: "",
        tool_calls: ["calculator"],
      },
      runId,
    ),
  );
  await bus.publish(
    makeEvent(
      EventType.ToolStart,
      { call_id: "call_1", name: "calculator", arguments: { expression: "1+1" } },
      runId,
    ),
  );
  await bus.publish(
    makeEvent(
      EventType.ToolEnd,
      { call_id: "call_1", name: "calculator", ok: true, latency: 0.01 },
      runId,
    ),
  );
  await bus.publish(
    makeEvent(EventType.RunEnd, { ok: true, iterations: 2, answer: "2" }, runId),
  );
}

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  vi.unstubAllGlobals();
});

describe("OTLP 导出协议", () => {
  it("按 OTLP/HTTP JSON POST 到 {endpoint}/v1/traces，带自定义请求头", async () => {
    const calls = stubFetch();
    const exporter = new OtelExporter(otelSettings());
    const bus = new EventBus();
    exporter.attach(bus);

    await publishRun(bus);
    await exporter.close();

    const traces = traceCalls(calls);
    expect(traces).toHaveLength(1);
    expect(traces[0]!.url).toBe("http://collector.test:4318/v1/traces");
    const headers = traces[0]!.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["x-api-key"]).toBe("secret");
  });

  it("resource 与 scope 带上服务身份", async () => {
    const calls = stubFetch();
    const exporter = new OtelExporter(otelSettings());
    const bus = new EventBus();
    exporter.attach(bus);
    await publishRun(bus);
    await exporter.close();

    const body = JSON.parse(String(traceCalls(calls)[0]!.init.body)) as {
      resourceSpans: Array<{
        resource: { attributes: Attribute[] };
        scopeSpans: Array<{ scope: { name: string } }>;
      }>;
    };
    const resource = body.resourceSpans[0]!.resource.attributes;
    const service = resource.find((item) => item.key === "service.name");
    expect(service?.value.stringValue).toBe("miniagent-test");
    expect(body.resourceSpans[0]!.scopeSpans[0]!.scope.name).toBe(
      "miniagent.observability",
    );
  });

  it("run 收尾即整批导出，一次 run 一条 trace", async () => {
    const calls = stubFetch();
    const exporter = new OtelExporter(otelSettings());
    const bus = new EventBus();
    exporter.attach(bus);

    await publishRun(bus, "run-a");
    await publishRun(bus, "run-b");

    const traces = traceCalls(calls);
    expect(traces).toHaveLength(2);
    const traceIds = traces.map((call) => spansOf(call)[0]!.traceId);
    // 不同 run 必须落在不同 trace 上
    expect(traceIds[0]).not.toBe(traceIds[1]);
    // traceId 是 32 位十六进制，spanId 是 16 位
    expect(traceIds[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(spansOf(traces[0]!)[0]!.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("同一 run 内所有 span 共享 traceId，chat/execute_tool 挂在 run span 下", async () => {
    const calls = stubFetch();
    const exporter = new OtelExporter(otelSettings());
    const bus = new EventBus();
    exporter.attach(bus);
    await publishRun(bus);
    await exporter.close();

    const spans = spansOf(calls[0]!);
    const runSpan = spans.find((span) => span.name.startsWith("invoke_agent"));
    const chatSpan = spanNamed(spans, "chat test-model");
    const toolSpan = spanNamed(spans, "execute_tool calculator");

    expect(runSpan).toBeDefined();
    expect(chatSpan).toBeDefined();
    expect(toolSpan).toBeDefined();
    expect(new Set(spans.map((span) => span.traceId)).size).toBe(1);
    expect(chatSpan!.parentSpanId).toBe(runSpan!.spanId);
    expect(toolSpan!.parentSpanId).toBe(runSpan!.spanId);
    // 根 span 没有父
    expect(runSpan!.parentSpanId).toBeUndefined();
  });
});

describe("GenAI 语义约定", () => {
  it("chat span 带上模型、token 用量、结束原因与迭代轮次", async () => {
    const calls = stubFetch();
    const exporter = new OtelExporter(otelSettings({ provider: "moonshot", model: "kimi" }));
    const bus = new EventBus();
    exporter.attach(bus);
    await publishRun(bus);
    await exporter.close();

    const chatSpan = spanNamed(spansOf(calls[0]!), "chat kimi")!;
    const attributes = attrs(chatSpan);
    expect(attributes["gen_ai.operation.name"]).toBe("chat");
    expect(attributes["gen_ai.provider.name"]).toBe("moonshot");
    expect(attributes["gen_ai.request.model"]).toBe("kimi");
    expect(attributes["gen_ai.response.model"]).toBe("kimi");
    expect(attributes["gen_ai.usage.input_tokens"]).toBe("120");
    expect(attributes["gen_ai.usage.output_tokens"]).toBe("30");
    expect(attributes["gen_ai.response.finish_reasons"]).toBe("tool_calls");
    expect(attributes["miniagent.iteration"]).toBe("1");
  });

  it("execute_tool span 带工具名与 call id", async () => {
    const calls = stubFetch();
    const exporter = new OtelExporter(otelSettings());
    const bus = new EventBus();
    exporter.attach(bus);
    await publishRun(bus);
    await exporter.close();

    const toolSpan = spanNamed(spansOf(calls[0]!), "execute_tool calculator")!;
    const attributes = attrs(toolSpan);
    expect(attributes["gen_ai.operation.name"]).toBe("execute_tool");
    expect(attributes["gen_ai.tool.name"]).toBe("calculator");
    expect(attributes["gen_ai.tool.type"]).toBe("function");
    expect(attributes["gen_ai.tool.call.id"]).toBe("call_1");
    expect(toolSpan.status.code).toBe(1);
    expect(attributes["error.type"]).toBeUndefined();
  });

  it("整型走 intValue 字符串、小数走 doubleValue（OTLP 取值编码）", async () => {
    const calls = stubFetch();
    const exporter = new OtelExporter(otelSettings());
    const bus = new EventBus();
    exporter.attach(bus);
    await bus.publish(makeEvent(EventType.RunStart, {}, "run-x"));
    await bus.publish(
      makeEvent(
        EventType.RunEnd,
        { ok: true, iterations: 3, latency: 1.5 },
        "run-x",
      ),
    );
    await exporter.close();

    const runSpan = spansOf(calls[0]!)[0]!;
    const iterations = runSpan.attributes.find(
      (item) => item.key === "miniagent.iterations",
    );
    expect(iterations?.value).toEqual({ intValue: "3" });
    // 纳秒时间戳必须是无小数点的整型字符串
    expect(runSpan.startTimeUnixNano).toMatch(/^\d+$/);
  });
});

describe("子 agent 中继", () => {
  /** 中继事件的公共标记：runId 是父的，靠 from_subagent 与 sub_run_id 区分 */
  function relayed(payload: Record<string, unknown>): Record<string, unknown> {
    return { ...payload, from_subagent: true, sub_run_id: "sub-1", sub_role: "critic" };
  }

  it("子 agent 的 run_start/run_end 不顶掉父的根 span", async () => {
    const calls = stubFetch();
    const exporter = new OtelExporter(otelSettings());
    const bus = new EventBus();
    exporter.attach(bus);

    await bus.publish(makeEvent(EventType.RunStart, {}, "run-parent"));
    await bus.publish(makeEvent(EventType.RunStart, relayed({}), "run-parent"));
    await bus.publish(
      makeEvent(EventType.LLMStart, relayed({ iteration: 1 }), "run-parent"),
    );
    await bus.publish(
      makeEvent(
        EventType.LLMEnd,
        relayed({ iteration: 1, prompt_tokens: 4, completion_tokens: 2 }),
        "run-parent",
      ),
    );
    // 子 agent 先结束：这里不该触发导出，也不该写根 span
    await bus.publish(makeEvent(EventType.RunEnd, relayed({ ok: true }), "run-parent"));
    expect(calls).toHaveLength(0);

    await bus.publish(
      makeEvent(EventType.RunEnd, { ok: true, iterations: 1 }, "run-parent"),
    );
    await exporter.close();

    const spans = spansOf(calls[0]!);
    const roots = spans.filter((span) => span.name.startsWith("invoke_agent"));
    expect(roots).toHaveLength(1);
    // 子 agent 的模型调用挂在父根 span 下，并标出是哪个角色做的
    const childChat = spanNamed(spans, "chat test-model")!;
    expect(childChat.parentSpanId).toBe(roots[0]!.spanId);
    expect(attrs(childChat)["miniagent.sub_role"]).toBe("critic");
    expect(attrs(childChat)["miniagent.sub_run_id"]).toBe("sub-1");
  });

  it("同批并发的两个子 agent 的 chat span 各自独立，不会互相顶掉", async () => {
    const calls = stubFetch();
    const exporter = new OtelExporter(otelSettings());
    const bus = new EventBus();
    exporter.attach(bus);

    const child = (subId: string, role: string) => ({
      from_subagent: true,
      sub_run_id: subId,
      sub_role: role,
    });

    await bus.publish(makeEvent(EventType.RunStart, {}, "run-p"));
    await bus.publish(
      makeEvent(EventType.LLMStart, { iteration: 1, ...child("sub-a", "researcher") }, "run-p"),
    );
    await bus.publish(
      makeEvent(EventType.LLMStart, { iteration: 1, ...child("sub-b", "analyst") }, "run-p"),
    );
    await bus.publish(
      makeEvent(
        EventType.LLMEnd,
        { iteration: 1, prompt_tokens: 1, completion_tokens: 1, ...child("sub-a", "researcher") },
        "run-p",
      ),
    );
    await bus.publish(
      makeEvent(
        EventType.LLMEnd,
        { iteration: 1, prompt_tokens: 2, completion_tokens: 2, ...child("sub-b", "analyst") },
        "run-p",
      ),
    );
    await bus.publish(makeEvent(EventType.RunEnd, { ok: true }, "run-p"));
    await exporter.close();

    const chats = spansOf(calls[0]!).filter((span) => span.name.startsWith("chat "));
    expect(chats).toHaveLength(2);
    expect(new Set(chats.map((span) => attrs(span)["miniagent.sub_role"]))).toEqual(
      new Set(["researcher", "analyst"]),
    );
    expect(new Set(chats.map((span) => span.spanId)).size).toBe(2);
  });
});

describe("指标上报（GenAI 约定）", () => {
  interface MetricPoint {
    attributes: Attribute[];
    count?: number;
    sum?: number;
    bucketCounts?: number[];
    explicitBounds?: number[];
    asInt?: string;
  }

  interface Metric {
    name: string;
    unit: string;
    histogram?: { aggregationTemporality: number; dataPoints: MetricPoint[] };
    sum?: { aggregationTemporality: number; isMonotonic: boolean; dataPoints: MetricPoint[] };
  }

  function metricsOf(call: RecordedRequest): Metric[] {
    const body = JSON.parse(String(call.init.body)) as {
      resourceMetrics: Array<{ scopeMetrics: Array<{ metrics: Metric[] }> }>;
    };
    return body.resourceMetrics[0]!.scopeMetrics[0]!.metrics;
  }

  function pointAttrs(point: MetricPoint): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const { key, value } of point.attributes) {
      result[key] = value.stringValue ?? value.intValue ?? value.doubleValue;
    }
    return result;
  }

  it("close() 把累计指标发到 /v1/metrics，并带上资源属性", async () => {
    const calls = stubFetch();
    const exporter = new OtelExporter(otelSettings());
    const bus = new EventBus();
    exporter.attach(bus);

    await publishRun(bus);
    await exporter.close();

    const metrics = metricCalls(calls);
    expect(metrics).toHaveLength(1);
    expect(metrics[0]!.url).toBe("http://collector.test:4318/v1/metrics");
  });

  it("token 用量按 input/output 两个数据点上报，属性带 provider 与模型", async () => {
    const calls = stubFetch();
    const exporter = new OtelExporter(otelSettings());
    const bus = new EventBus();
    exporter.attach(bus);
    await publishRun(bus);
    await exporter.close();

    const metric = metricsOf(metricCalls(calls)[0]!).find(
      (item) => item.name === "gen_ai.client.token.usage",
    )!;
    expect(metric.unit).toBe("{token}");
    expect(metric.histogram!.aggregationTemporality).toBe(2);

    const input = metric.histogram!.dataPoints.find(
      (point) => pointAttrs(point)["gen_ai.token.type"] === "input",
    )!;
    expect(input.sum).toBe(120);
    expect(input.count).toBe(1);
    expect(pointAttrs(input)["gen_ai.provider.name"]).toBe("deepseek");
    expect(pointAttrs(input)["gen_ai.request.model"]).toBe("test-model");

    const output = metric.histogram!.dataPoints.find(
      (point) => pointAttrs(point)["gen_ai.token.type"] === "output",
    )!;
    expect(output.sum).toBe(30);
  });

  it("时延直方图按显式边界分桶，桶数比边界多一个（+Inf）", async () => {
    const calls = stubFetch();
    const exporter = new OtelExporter(otelSettings());
    const bus = new EventBus();
    exporter.attach(bus);
    await publishRun(bus);
    await exporter.close();

    const metric = metricsOf(metricCalls(calls)[0]!).find(
      (item) => item.name === "gen_ai.client.operation.duration",
    )!;
    const point = metric.histogram!.dataPoints[0]!;
    expect(point.explicitBounds).toHaveLength(point.bucketCounts!.length - 1);
    // LLM 耗时 0.3s → 落在 0.5 那个桶里
    const bucketIndex = point.explicitBounds!.findIndex((bound) => 0.3 <= bound);
    expect(point.bucketCounts![bucketIndex]).toBe(1);
    expect(point.count).toBe(1);
    expect(pointAttrs(point)["gen_ai.operation.name"]).toBe("chat");
  });

  it("run 次数按成功/失败分开累计，多实例汇总后即整体成功率", async () => {
    const calls = stubFetch();
    const exporter = new OtelExporter(otelSettings());
    const bus = new EventBus();
    exporter.attach(bus);

    await publishRun(bus, "run-ok");
    await bus.publish(makeEvent(EventType.RunEnd, { ok: false }, "run-bad"));
    await exporter.close();

    const metric = metricsOf(metricCalls(calls)[0]!).find(
      (item) => item.name === "miniagent.agent.runs",
    )!;
    expect(metric.sum!.isMonotonic).toBe(true);
    const byOutcome = new Map(
      metric.sum!.dataPoints.map((point) => [
        pointAttrs(point)["miniagent.outcome"],
        point.asInt,
      ]),
    );
    expect(byOutcome.get("ok")).toBe("1");
    expect(byOutcome.get("failed")).toBe("1");
  });

  it("模型调用失败也计入时延直方图，并带 error.type", async () => {
    const calls = stubFetch();
    const exporter = new OtelExporter(otelSettings());
    const bus = new EventBus();
    exporter.attach(bus);
    await bus.publish(
      makeEvent(EventType.LLMError, { message: "HTTP 503", latency: 2 }, "run-x"),
    );
    await exporter.close();

    const metric = metricsOf(metricCalls(calls)[0]!).find(
      (item) => item.name === "gen_ai.client.operation.duration",
    )!;
    expect(pointAttrs(metric.histogram!.dataPoints[0]!)["error.type"]).toBe("llm_error");
  });

  it("没有任何事件时不上报指标，避免空请求", async () => {
    const calls = stubFetch();
    const exporter = new OtelExporter(otelSettings());
    exporter.attach(new EventBus());
    await exporter.close();

    expect(metricCalls(calls)).toHaveLength(0);
  });
});

describe("失败路径", () => {
  it("run 失败 → 根 span 标记 error", async () => {
    const calls = stubFetch();
    const exporter = new OtelExporter(otelSettings());
    const bus = new EventBus();
    exporter.attach(bus);
    await bus.publish(makeEvent(EventType.RunStart, {}, "run-fail"));
    await bus.publish(
      makeEvent(EventType.RunEnd, { ok: false, iterations: 1 }, "run-fail"),
    );
    await exporter.close();

    const runSpan = spansOf(calls[0]!)[0]!;
    expect(runSpan.status.code).toBe(2);
  });

  it("模型调用失败 → chat span 标 error 且带 error.type", async () => {
    const calls = stubFetch();
    const exporter = new OtelExporter(otelSettings());
    const bus = new EventBus();
    exporter.attach(bus);
    await bus.publish(makeEvent(EventType.RunStart, {}, "run-llm-err"));
    await bus.publish(makeEvent(EventType.LLMStart, { iteration: 1 }, "run-llm-err"));
    await bus.publish(
      makeEvent(
        EventType.LLMError,
        { message: "HTTP 503", iteration: 1, latency: 0.2 },
        "run-llm-err",
      ),
    );
    await bus.publish(makeEvent(EventType.RunEnd, { ok: false }, "run-llm-err"));
    await exporter.close();

    const chatSpan = spanNamed(spansOf(calls[0]!), "chat test-model")!;
    expect(chatSpan.status.code).toBe(2);
    expect(chatSpan.status.message).toBe("HTTP 503");
    expect(attrs(chatSpan)["error.type"]).toBe("llm_error");
  });

  it("工具失败 → execute_tool span 标 error", async () => {
    const calls = stubFetch();
    const exporter = new OtelExporter(otelSettings());
    const bus = new EventBus();
    exporter.attach(bus);
    await bus.publish(makeEvent(EventType.ToolStart, { call_id: "c1", name: "boom" }, "r"));
    await bus.publish(
      makeEvent(
        EventType.ToolEnd,
        { call_id: "c1", name: "boom", ok: false, error: "炸了", latency: 0.1 },
        "r",
      ),
    );
    await exporter.close();

    const toolSpan = spanNamed(spansOf(calls[0]!), "execute_tool boom")!;
    expect(toolSpan.status).toEqual({ code: 2, message: "炸了" });
    expect(attrs(toolSpan)["error.type"]).toBe("tool_error");
  });

  it("导出失败只记警告，不把异常抛回主流程", async () => {
    stubFetch(() => new Response("collector down", { status: 502 }));
    const exporter = new OtelExporter(otelSettings());
    const bus = new EventBus();
    exporter.attach(bus);

    await expect(publishRun(bus)).resolves.toBeUndefined();
    await expect(exporter.close()).resolves.toBeUndefined();
  });

  it("网络异常同样被吞掉", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });
    const exporter = new OtelExporter(otelSettings());
    const bus = new EventBus();
    exporter.attach(bus);
    await bus.publish(makeEvent(EventType.RunStart, {}, "r"));
    await bus.publish(makeEvent(EventType.RunEnd, { ok: true }, "r"));

    await expect(exporter.close()).resolves.toBeUndefined();
  });
});

describe("配置", () => {
  it("未启用时不发任何请求，也不订阅总线开销", async () => {
    withEnv({});
    const calls = stubFetch();
    const settings = loadSettings();
    expect(settings.otelEnabled).toBe(false);
    expect(settings.otelEndpoint).toBe("http://localhost:4318");
    expect(calls).toHaveLength(0);
  });

  it("端点与请求头支持 OTel 官方变量名，且尾部斜杠会被归一化", () => {
    withEnv({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/",
      OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer%20token",
      OTEL_SERVICE_NAME: "prod-agent",
    });
    const settings = loadSettings();
    expect(settings.otelEndpoint).toBe("http://collector:4318");
    expect(settings.otelServiceName).toBe("prod-agent");
    expect(settings.otelHeaders).toEqual({ authorization: "Bearer%20token" });
  });

  it("MINIAGENT_ 变量优先于 OTEL_ 变量", () => {
    withEnv({
      MINIAGENT_OTEL_ENDPOINT: "http://internal:4318",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://official:4318",
    });
    expect(loadSettings().otelEndpoint).toBe("http://internal:4318");
  });
});
