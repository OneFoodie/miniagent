/**
 * OpenTelemetry 导出：把内部事件映射成 GenAI 语义约定的 span，用 OTLP/HTTP(JSON) 发出。
 *
 * 为什么手写而不用 @opentelemetry/sdk-*：本项目的核心依赖只有 zod 一个，
 * 引一整套 SDK 会拖进十几个包（含 gRPC 相关），而我们要的东西很小——
 * 「把已经有的结构化事件转成 span，POST 到 /v1/traces」。OTLP/JSON 是公开协议，
 * 一个 fetch 就能发，所以这里只实现协议本身，不引入运行时依赖。
 *
 * 语义约定遵从 OTel GenAI 规范（`gen_ai.*`）。注意 `gen_ai.system` 已更名为
 * `gen_ai.provider.name`，这里只发新名，避免同一含义出现两个键。
 *
 * 设计取舍：**观测失败绝不能影响主流程**——导出异常只记警告；
 * 每个 run 结束（含失败）时导出该 run 的全部 span，进程被杀则这一段丢失。
 */

import { createHash, randomBytes } from "node:crypto";

import type { Settings } from "../core/config.js";
import type { Event, EventBus } from "../core/events.js";
import { EventType, WILDCARD } from "../core/events.js";
import { getLogger } from "../core/logging.js";

const logger = getLogger("miniagent.otel");

/** OTLP span kind（枚举值来自 opentelemetry-proto） */
const SPAN_KIND_INTERNAL = 1;
const SPAN_KIND_CLIENT = 3;
/** OTLP status code */
const STATUS_OK = 1;
const STATUS_ERROR = 2;

/** 一次导出的 span 上限：防止长跑进程把内存里的缓冲堆爆 */
const MAX_BUFFERED_SPANS = 512;

/** 与 package.json 的 version 保持一致（导出器不去读 package.json，避免打包后路径失效） */
const SERVICE_VERSION = "0.1.0";

/** agent 名，对应 GenAI 约定的 gen_ai.agent.name */
const AGENT_NAME = "miniagent";

interface Attribute {
  key: string;
  value: Record<string, unknown>;
}

/** 属性取值只支持这里列出的四种 OTLP 类型 */
export type AttributeValue = string | number | boolean | undefined;

/**
 * 直方图分桶边界（OTLP 的 explicitBounds）。
 * 时延按秒分桶，覆盖「本地模型 50ms」到「长任务 1 分钟」；
 * token 数按 4 的幂分桶，覆盖短回答到长文档。
 */
const DURATION_BOUNDS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];
const TOKEN_BOUNDS = [1, 4, 16, 64, 256, 1024, 4096, 16384, 65536];

interface OtlpSpan {
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

/** 把内部属性表转成 OTLP 的 key/value 数组，顺带丢掉 undefined */
function toAttributes(attrs: Record<string, AttributeValue>): Attribute[] {
  const result: Attribute[] = [];
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    if (typeof value === "boolean") {
      result.push({ key, value: { boolValue: value } });
    } else if (typeof value === "number") {
      // 整数走 intValue（OTLP 要求以字符串承载 64 位整数），小数走 doubleValue
      result.push(
        Number.isInteger(value)
          ? { key, value: { intValue: String(value) } }
          : { key, value: { doubleValue: value } },
      );
    } else {
      result.push({ key, value: { stringValue: value } });
    }
  }
  return result;
}

/** 秒（浮点，来自 event.ts）→ 纳秒字符串 */
function toNanos(seconds: number): string {
  return String(Math.round(seconds * 1e9));
}

/** runId → 16 字节 traceId：同一个 run 的所有 span 天然落在同一条 trace 上 */
function traceIdOf(runId: string): string {
  return createHash("sha256").update(runId).digest("hex").slice(0, 32);
}

/** 一个直方图数据点（按属性集聚合） */
interface HistogramPoint {
  attributes: Record<string, AttributeValue>;
  count: number;
  sum: number;
  bucketCounts: number[];
}

/** 一个计数器数据点 */
interface SumPoint {
  attributes: Record<string, AttributeValue>;
  value: number;
}

/** 属性集 → 唯一键：同样的属性必须落进同一个数据点 */
function attributeKey(attributes: Record<string, AttributeValue>): string {
  return JSON.stringify(
    Object.entries(attributes)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

/**
 * GenAI 指标聚合器（OTLP）。
 *
 * 与 observability/metrics.ts 不合并：那个是按字符串键聚合、给 Prometheus 文本用的；
 * 这个按属性集聚合、面向 GenAI 语义约定（`gen_ai.provider.name` / `gen_ai.token.type` …）。
 * 强行统一只会让两边都变形。代价是同一份事件被两处订阅，但都是纯内存累加。
 */
class MetricAccumulator {
  private readonly histograms = new Map<
    string,
    { unit: string; bounds: number[]; points: Map<string, HistogramPoint> }
  >();
  private readonly sums = new Map<
    string,
    { unit: string; points: Map<string, SumPoint> }
  >();

  observe(
    name: string,
    unit: string,
    bounds: number[],
    attributes: Record<string, AttributeValue>,
    value: number,
  ): void {
    const spec = this.histograms.get(name) ?? {
      unit,
      bounds,
      points: new Map<string, HistogramPoint>(),
    };
    this.histograms.set(name, spec);

    const key = attributeKey(attributes);
    let point = spec.points.get(key);
    if (!point) {
      point = {
        attributes: cleanAttributes(attributes),
        count: 0,
        sum: 0,
        bucketCounts: new Array<number>(bounds.length + 1).fill(0),
      };
      spec.points.set(key, point);
    }
    point.count += 1;
    point.sum += value;
    // 落到第一个 >= value 的边界里；都没有则进 +Inf 桶
    const found = bounds.findIndex((bound) => value <= bound);
    const bucket = found === -1 ? bounds.length : found;
    point.bucketCounts[bucket] = (point.bucketCounts[bucket] ?? 0) + 1;
  }

  increment(
    name: string,
    unit: string,
    attributes: Record<string, AttributeValue>,
    amount = 1,
  ): void {
    const spec = this.sums.get(name) ?? { unit, points: new Map<string, SumPoint>() };
    this.sums.set(name, spec);

    const key = attributeKey(attributes);
    const point = spec.points.get(key) ?? {
      attributes: cleanAttributes(attributes),
      value: 0,
    };
    point.value += amount;
    spec.points.set(key, point);
  }

  /** 渲染成 OTLP metrics 数组；累积时间从 startNs 起算 */
  toOtlp(startNs: string, nowNs: string): Record<string, unknown>[] {
    const metrics: Record<string, unknown>[] = [];

    for (const [name, spec] of this.histograms) {
      metrics.push({
        name,
        unit: spec.unit,
        histogram: {
          // 2 = CUMULATIVE：每次上报的都是进程启动至今的累计值，由 collector 处理重置
          aggregationTemporality: 2,
          dataPoints: [...spec.points.values()].map((point) => ({
            attributes: toAttributes(point.attributes),
            startTimeUnixNano: startNs,
            timeUnixNano: nowNs,
            count: point.count,
            sum: point.sum,
            bucketCounts: point.bucketCounts,
            explicitBounds: spec.bounds,
          })),
        },
      });
    }

    for (const [name, spec] of this.sums) {
      metrics.push({
        name,
        unit: spec.unit,
        sum: {
          aggregationTemporality: 2,
          isMonotonic: true,
          dataPoints: [...spec.points.values()].map((point) => ({
            attributes: toAttributes(point.attributes),
            startTimeUnixNano: startNs,
            timeUnixNano: nowNs,
            asInt: String(point.value),
          })),
        },
      });
    }
    return metrics;
  }

  /** 有没有攒下东西：没有就不必发一次空请求 */
  get isEmpty(): boolean {
    for (const spec of this.histograms.values()) if (spec.points.size > 0) return false;
    for (const spec of this.sums.values()) if (spec.points.size > 0) return false;
    return true;
  }
}

/** 丢掉 undefined，避免把无意义的空属性写进数据点 */
function cleanAttributes(
  attributes: Record<string, AttributeValue>,
): Record<string, AttributeValue> {
  return Object.fromEntries(
    Object.entries(attributes).filter(([, value]) => value !== undefined),
  );
}

export class OtelExporter {
  private readonly spans: OtlpSpan[] = [];
  /** 待收尾的 span：key → 起始时间与 spanId */
  private readonly open = new Map<string, { startNs: string; spanId: string }>();
  /** 每个 run 的根 span id，作为子 span 的 parent */
  private readonly runSpans = new Map<string, string>();
  /** GenAI 指标：跨请求累计，随进程运行周期上报 */
  private readonly metrics = new MetricAccumulator();
  /** 指标累积起点：进程内第一次挂载的时刻 */
  private readonly metricStartNs = toNanos(Date.now() / 1000);
  private timer?: NodeJS.Timeout;

  constructor(private readonly settings: Settings) {}

  /**
   * 订阅一条事件总线。
   * 与 Metrics 同构：server 每个请求建一条总线，进程级导出器需要逐条挂上去，
   * 否则只有 CLI 那条总线上的 span 会被导出。
   */
  attach(bus: EventBus): void {
    bus.subscribe(WILDCARD, (event) => this.onEvent(event));
    this.startMetricTimer();
  }

  /** 定时上报指标：长跑的 server 从不调用 close()，只靠退出时上报等于没有指标 */
  private startMetricTimer(): void {
    if (this.timer || this.settings.otelMetricsInterval <= 0) return;
    this.timer = setInterval(
      () => void this.flushMetrics(),
      this.settings.otelMetricsInterval * 1000,
    );
    // 别让上报定时器把进程钉住：CLI 退出不该等它
    this.timer.unref?.();
  }

  /** 立即导出当前缓冲并清空；close() 与缓冲到上限时调用 */
  async flush(): Promise<void> {
    if (this.spans.length === 0) return;
    const batch = this.spans.splice(0, this.spans.length);
    try {
      await this.post("/v1/traces", this.buildSpansPayload(batch));
    } catch (error) {
      // 观测链路故障不能影响业务：降级成一条警告
      const reason = error instanceof Error ? error.message : String(error);
      logger.warning(`OTLP 导出失败，已丢弃 ${batch.length} 个 span: ${reason}`);
    }
  }

  /** 上报指标（与 span 走同一条 OTLP 链路，只是路径不同） */
  async flushMetrics(): Promise<void> {
    if (this.metrics.isEmpty) return;
    const payload = {
      resourceMetrics: [
        {
          resource: this.resource(),
          scopeMetrics: [
            {
              scope: { name: "miniagent.observability", version: SERVICE_VERSION },
              metrics: this.metrics.toOtlp(
                this.metricStartNs,
                toNanos(Date.now() / 1000),
              ),
            },
          ],
        },
      ],
    };
    try {
      await this.post("/v1/metrics", payload);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warning(`OTLP 指标上报失败（累计值不丢，下次继续）: ${reason}`);
    }
  }

  /** 进程退出前调用：把剩下的 span 与指标都发出去 */
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.flush();
    await this.flushMetrics();
  }

  private async onEvent(event: Event): Promise<void> {
    // 子 agent 的事件被中继到父总线上，携带的 runId 也是父的（否则进不了父轨迹）。
    // 因此 run 级别的 start/end 必须按标记跳过：子 agent 的 run_start/run_end 会覆盖
    // 父的根 span，导致父运行最后没有根 span。子 agent 的模型与工具调用则保留，
    // 挂到父根 span 下（并用 sub_run_id 区分同批并发的多个子 agent）。
    const relayed = event.payload.from_subagent === true;
    const scope = relayed ? `:${String(event.payload.sub_run_id ?? "sub")}` : "";

    switch (event.type) {
      case EventType.RunStart:
        if (!relayed) this.startRun(event);
        break;
      case EventType.RunEnd:
        if (!relayed) {
          this.recordRunMetric(event);
          this.endRun(event);
        }
        break;
      case EventType.LLMStart:
        this.openSpan(event, `llm:${event.runId}${scope}`);
        break;
      case EventType.LLMEnd:
        this.recordLlmMetrics(event);
        this.endLlmSpan(event, `llm:${event.runId}${scope}`);
        break;
      case EventType.LLMError:
        this.recordLlmMetrics(event, true);
        this.endLlmSpan(
          event,
          `llm:${event.runId}${scope}`,
          String(event.payload.message ?? "LLM 调用失败"),
        );
        break;
      case EventType.ToolStart:
        this.openSpan(event, this.toolKey(event, scope));
        break;
      case EventType.ToolEnd:
        this.endToolSpan(event, this.toolKey(event, scope));
        break;
      default:
        // 记忆/上下文类事件不构造成 span，避免 trace 被噪声淹没
        break;
    }
    if (this.spans.length >= MAX_BUFFERED_SPANS) await this.flush();
  }

  /** 工具 span 的配对键：同一批里同名工具可能并发，且并发的子 agent 会共用父 runId */
  private toolKey(event: Event, scope: string): string {
    const id = event.payload.call_id ?? event.payload.name;
    return `tool:${event.runId}${scope}:${String(id)}`;
  }

  /** 中继事件来自哪个子 agent（角色 + 子 runId），用于在 trace 里区分同批并发的多个子 agent */
  private relayAttributes(event: Event): Record<string, AttributeValue> {
    if (event.payload.from_subagent !== true) return {};
    return {
      "miniagent.sub_run_id": String(event.payload.sub_run_id ?? ""),
      "miniagent.sub_role":
        typeof event.payload.sub_role === "string" ? event.payload.sub_role : undefined,
    };
  }

  /** 模型调用指标：token 用量与耗时都按 GenAI 约定的名字上报，便于直接用社区大盘 */
  private recordLlmMetrics(event: Event, failed = false): void {
    const base = {
      "gen_ai.provider.name": this.settings.provider,
      "gen_ai.request.model": this.settings.model,
    };
    const latency = Number(event.payload.latency ?? 0);
    this.metrics.observe(
      "gen_ai.client.operation.duration",
      "s",
      DURATION_BOUNDS,
      { ...base, "gen_ai.operation.name": "chat", ...(failed ? { "error.type": "llm_error" } : {}) },
      latency,
    );
    if (failed) return;

    this.metrics.observe(
      "gen_ai.client.token.usage",
      "{token}",
      TOKEN_BOUNDS,
      { ...base, "gen_ai.token.type": "input" },
      Number(event.payload.prompt_tokens ?? 0),
    );
    this.metrics.observe(
      "gen_ai.client.token.usage",
      "{token}",
      TOKEN_BOUNDS,
      { ...base, "gen_ai.token.type": "output" },
      Number(event.payload.completion_tokens ?? 0),
    );
  }

  /** 运行次数：按成功/失败分开计，多实例汇总后就是整体成功率 */
  private recordRunMetric(event: Event): void {
    this.metrics.increment("miniagent.agent.runs", "{run}", {
      "gen_ai.provider.name": this.settings.provider,
      "miniagent.outcome": event.payload.ok === false ? "failed" : "ok",
    });
    const latency = event.payload.latency;
    if (typeof latency === "number") {
      this.metrics.observe(
        "miniagent.agent.run.duration",
        "s",
        DURATION_BOUNDS,
        { "gen_ai.provider.name": this.settings.provider },
        latency,
      );
    }
  }

  private startRun(event: Event): void {
    const spanId = traceIdOf(event.runId).slice(32, 48);
    this.runSpans.set(event.runId, spanId);
    this.open.set(`run:${event.runId}`, { startNs: toNanos(event.ts), spanId });
  }

  private endRun(event: Event): void {
    const pending = this.open.get(`run:${event.runId}`);
    if (!pending) return;
    this.open.delete(`run:${event.runId}`);

    const ok = event.payload.ok !== false;
    this.push({
      traceId: traceIdOf(event.runId),
      spanId: pending.spanId,
      name: `invoke_agent ${this.settings.provider}`,
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: pending.startNs,
      endTimeUnixNano: toNanos(event.ts),
      attributes: toAttributes({
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.provider.name": this.settings.provider,
        "gen_ai.request.model": this.settings.model,
        "gen_ai.conversation.id": event.runId,
        "gen_ai.agent.name": AGENT_NAME,
        "miniagent.iterations": Number(event.payload.iterations ?? 0),
      }),
      status: ok
        ? { code: STATUS_OK }
        : { code: STATUS_ERROR, message: "agent run failed" },
    });

    // 一个 run 一条 trace：run 收尾即可整批发出
    void this.flush();
  }

  /** LLMStart / ToolStart 共用的开 span 逻辑 */
  private openSpan(event: Event, key: string): void {
    this.open.set(key, {
      startNs: toNanos(event.ts),
      spanId: randomBytes(8).toString("hex"),
    });
  }

  private endLlmSpan(event: Event, key: string, errorMessage?: string): void {
    const pending = this.open.get(key);
    if (!pending) return;
    this.open.delete(key);

    const finishReason = event.payload.finish_reason;
    this.push({
      traceId: traceIdOf(event.runId),
      spanId: pending.spanId,
      parentSpanId: this.runSpans.get(event.runId),
      name: `chat ${this.settings.model}`,
      kind: SPAN_KIND_CLIENT,
      startTimeUnixNano: pending.startNs,
      endTimeUnixNano: toNanos(event.ts),
      attributes: toAttributes({
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": this.settings.provider,
        "gen_ai.request.model": this.settings.model,
        // 兼容端点普遍不回响应模型名，此时退化为请求模型
        "gen_ai.response.model": this.settings.model,
        "gen_ai.usage.input_tokens": Number(event.payload.prompt_tokens ?? 0),
        "gen_ai.usage.output_tokens": Number(event.payload.completion_tokens ?? 0),
        "gen_ai.response.finish_reasons":
          typeof finishReason === "string" ? finishReason : undefined,
        "miniagent.iteration": Number(event.payload.iteration ?? 0),
        ...this.relayAttributes(event),
        ...(errorMessage ? { "error.type": "llm_error" } : {}),
      }),
      status: errorMessage
        ? { code: STATUS_ERROR, message: errorMessage }
        : { code: STATUS_OK },
    });
  }

  private endToolSpan(event: Event, key: string): void {
    const pending = this.open.get(key);
    if (!pending) return;
    this.open.delete(key);

    const ok = event.payload.ok !== false;
    this.push({
      traceId: traceIdOf(event.runId),
      spanId: pending.spanId,
      parentSpanId: this.runSpans.get(event.runId),
      name: `execute_tool ${String(event.payload.name ?? "unknown")}`,
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: pending.startNs,
      endTimeUnixNano: toNanos(event.ts),
      attributes: toAttributes({
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": String(event.payload.name ?? "unknown"),
        "gen_ai.tool.type": "function",
        "gen_ai.tool.call.id":
          typeof event.payload.call_id === "string" ? event.payload.call_id : undefined,
        ...this.relayAttributes(event),
        ...(ok ? {} : { "error.type": "tool_error" }),
      }),
      status: ok
        ? { code: STATUS_OK }
        : {
            code: STATUS_ERROR,
            message: String(event.payload.error ?? "工具执行失败"),
          },
    });
  }

  private push(span: OtlpSpan): void {
    this.spans.push(span);
  }

  /** 资源属性：告诉后端这批数据来自哪个服务（多实例部署时用于区分 pod） */
  private resource(): Record<string, unknown> {
    return {
      attributes: toAttributes({
        "service.name": this.settings.otelServiceName,
        "service.version": SERVICE_VERSION,
        "telemetry.sdk.name": "miniagent",
        "telemetry.sdk.language": "nodejs",
        // 自研导出器没有 SDK 版本号，用协议版本代替，便于对端判断兼容性
        "telemetry.sdk.version": "otlp-json/1.0",
      }),
    };
  }

  /** OTLP/HTTP JSON 编码：resourceSpans → scopeSpans → spans */
  private buildSpansPayload(spans: OtlpSpan[]): Record<string, unknown> {
    return {
      resourceSpans: [
        {
          resource: this.resource(),
          scopeSpans: [
            {
              scope: { name: "miniagent.observability", version: SERVICE_VERSION },
              spans,
            },
          ],
        },
      ],
    };
  }

  private async post(path: string, payload: unknown): Promise<void> {
    const timeoutSignal = AbortSignal.timeout(this.settings.otelTimeout * 1000);
    const response = await fetch(`${this.settings.otelEndpoint}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.settings.otelHeaders,
      },
      body: JSON.stringify(payload),
      signal: timeoutSignal,
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 300);
      throw new Error(`HTTP ${response.status}: ${body}`);
    }
  }
}

/** 未启用导出时的空实现，让调用方不必到处判空 */
export class NoopOtelExporter {
  attach(): void {}
  async flush(): Promise<void> {}
  async flushMetrics(): Promise<void> {}
  async close(): Promise<void> {}
}

export type OtelLike = Pick<
  OtelExporter,
  "attach" | "flush" | "flushMetrics" | "close"
>;

/** 按配置决定是否创建导出器 */
export function createOtelExporter(settings: Settings): OtelLike {
  if (!settings.otelEnabled) return new NoopOtelExporter();
  return new OtelExporter(settings);
}

/** 启动时打印一行，声明观测数据流向哪里 */
export function describeOtel(settings: Settings): string {
  if (!settings.otelEnabled) return "未启用（本地 JSONL 轨迹仍会写入）";
  return `OTLP/HTTP → ${settings.otelEndpoint}/v1/traces（service.name=${settings.otelServiceName}）`;
}
