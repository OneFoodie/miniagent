/**
 * 进程内指标采集：计数器 + 时延直方图，通过 GET /metrics 暴露。
 *
 * 订阅是「附加式」而非「构造式」：server 每个请求都新建一个 EventBus，
 * 若在构造时订阅，同一实例就只能挂上第一个 bus。改成 attach(bus) 后，
 * 一个聚合器可以接收任意多个总线的事件，计数自然跨请求累加。
 */

import type { Event, EventBus } from "../core/events.js";
import { EventType } from "../core/events.js";

export function percentile(sortedValues: number[], ratio: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(
    sortedValues.length - 1,
    Math.floor(ratio * sortedValues.length),
  );
  return sortedValues[index]!;
}

interface MetricsSnapshot {
  counters: Record<string, number>;
  histograms: Record<string, { count: number; p50: number; p95: number; max: number }>;
}

export class Metrics {
  private counters = new Map<string, number>();
  private histograms = new Map<string, number[]>();
  /** 防止同一个总线被重复挂载，否则一次事件会被记两遍 */
  private readonly attachedTo = new WeakSet<EventBus>();

  /** 挂载一个事件总线；可多次调用挂不同总线，计数汇入同一份聚合 */
  attach(bus: EventBus): void {
    if (this.attachedTo.has(bus)) return;
    this.attachedTo.add(bus);
    bus.subscribe(EventType.LLMEnd, (event) => this.onLLMEnd(event));
    bus.subscribe(EventType.LLMError, (event) => this.onLLMError(event));
    bus.subscribe(EventType.ToolEnd, (event) => this.onToolEnd(event));
    bus.subscribe(EventType.RunEnd, (event) => this.onRunEnd(event));
  }

  private increment(key: string, amount = 1): void {
    this.counters.set(key, (this.counters.get(key) ?? 0) + amount);
  }

  private observe(key: string, value: number): void {
    const list = this.histograms.get(key) ?? [];
    list.push(value);
    this.histograms.set(key, list);
  }

  private async onLLMEnd(event: Event): Promise<void> {
    const payload = event.payload;
    this.increment("llm.calls");
    this.increment("llm.prompt_tokens", Number(payload.prompt_tokens ?? 0));
    this.increment("llm.completion_tokens", Number(payload.completion_tokens ?? 0));
    this.observe("llm.latency", Number(payload.latency ?? 0));
  }

  private async onLLMError(event: Event): Promise<void> {
    // 与工具错误分开计：模型重试耗尽和「工具跑挂了」是两类不同的问题
    this.increment("llm.errors");
    this.observe("llm_error.latency", Number(event.payload.latency ?? 0));
  }

  private async onToolEnd(event: Event): Promise<void> {
    const payload = event.payload;
    const name = String(payload.name ?? "unknown");
    const latency = Number(payload.latency ?? 0);

    // 汇总口径与分工具口径都记：前者算总错误率，后者定位是哪个工具在失败
    this.increment("tool.calls");
    this.increment(`tool.${name}.calls`);
    if (!payload.ok) {
      this.increment("tool.errors");
      this.increment(`tool.${name}.errors`);
    }
    this.observe("tool.latency", latency);
    this.observe(`tool.${name}.latency`, latency);
  }

  private async onRunEnd(event: Event): Promise<void> {
    this.increment("runs");
    // 失败率：run_end 的 ok=false 分支不发 latency，所以分开判断
    if (event.payload.ok === false) this.increment("runs.failed");
    this.observe("run.iterations", Number(event.payload.iterations ?? 0));
    const latency = event.payload.latency;
    if (typeof latency === "number") this.observe("run.latency", latency);
  }

  /** 导出当前全部指标（含 p50/p95 时延分位） */
  snapshot(): MetricsSnapshot {
    const counters: Record<string, number> = {};
    for (const [key, value] of [...this.counters].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      counters[key] = value;
    }

    const histograms: MetricsSnapshot["histograms"] = {};
    for (const [key, values] of [...this.histograms].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      histograms[key] = summarise(values);
    }
    return { counters, histograms };
  }

  /**
   * 渲染成 Prometheus 文本格式，可直接被 Prometheus / Grafana 抓取。
   * 直方图导出成 summary 形状（分位 + count + max）——样本量在教学规模下很小，
   * 不值得引入真正的 bucket 直方图。
   */
  toPrometheus(): string {
    const snapshot = this.snapshot();
    const lines: string[] = [];

    for (const [key, value] of Object.entries(snapshot.counters)) {
      const name = prometheusName(key);
      lines.push(`# TYPE ${name} counter`, `${name} ${value}`);
    }
    for (const [key, stats] of Object.entries(snapshot.histograms)) {
      const name = prometheusName(key);
      lines.push(
        `# TYPE ${name} summary`,
        `${name}{quantile="0.5"} ${stats.p50}`,
        `${name}{quantile="0.95"} ${stats.p95}`,
        `${name}_max ${stats.max}`,
        `${name}_count ${stats.count}`,
      );
    }
    return `${lines.join("\n")}\n`;
  }
}

function summarise(values: number[]): {
  count: number;
  p50: number;
  p95: number;
  max: number;
} {
  const ordered = [...values].sort((a, b) => a - b);
  return {
    count: ordered.length,
    p50: percentile(ordered, 0.5),
    p95: percentile(ordered, 0.95),
    max: ordered.at(-1) ?? 0,
  };
}

/** 指标名只允许字母数字下划线冒号，`tool.web_search.latency` → `tool_web_search_latency` */
function prometheusName(key: string): string {
  return key.replace(/[^A-Za-z0-9_:]/g, "_");
}
