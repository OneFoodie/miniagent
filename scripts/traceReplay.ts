/**
 * trace 重放：把某次运行的 JSONL 轨迹渲染成可读时间线。
 *
 *   npm run trace:replay -- <runId 或 .jsonl 路径> [--full] [--json]
 *
 * 轨迹里存的是「完整入参与完整产出」，直接看 JSON 很难看出哪一步跑偏，
 * 所以这里按事件类型重排成人能读的时间线，末尾再给一份汇总（成本 / 耗时 / 失败工具）。
 *
 * 刻意不调 loadSettings：重放是纯离线分析，不该因为没配 API Key 就用不了。
 */

import { readFile, readdir } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";

/** 轨迹记录（与 observability/tracer.ts 落盘的结构一致） */
interface TraceRecord {
  ts: number;
  run_id: string;
  type: string;
  payload: Record<string, unknown>;
}

const TRACE_DIR = resolve(process.env.MINIAGENT_TRACE_DIR ?? "./traces");
/** 默认预览长度：够看出这一步做了什么，又不至于刷屏 */
const PREVIEW_CHARS = 300;

interface Options {
  target?: string;
  full: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { full: false, json: false };
  for (const arg of argv) {
    if (arg === "--full") options.full = true;
    else if (arg === "--json") options.json = true;
    else if (!arg.startsWith("-")) options.target = arg;
  }
  return options;
}

/** 展开目标为实际文件路径：可以是 run_id，也可以是直接给的路径 */
function resolveTracePath(target: string): string {
  if (isAbsolute(target) || target.includes("/") || target.includes("\\")) {
    return resolve(target);
  }
  return join(TRACE_DIR, `${target}.jsonl`);
}

async function loadRecords(path: string): Promise<TraceRecord[]> {
  const raw = await readFile(path, "utf-8");
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line) as TraceRecord;
      } catch {
        throw new Error(`第 ${index + 1} 行不是合法 JSON，轨迹文件可能被截断`);
      }
    });
}

/** 取字符串字段；缺失或非字符串时返回空串 */
function str(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value : "";
}

function num(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  return typeof value === "number" ? value : undefined;
}

function preview(text: string, full: boolean): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (full || oneLine.length <= PREVIEW_CHARS) return oneLine;
  return `${oneLine.slice(0, PREVIEW_CHARS)}…（${text.length} 字符，用 --full 看全）`;
}

/** 把 payload 压缩成单行 JSON 预览 */
function previewJson(value: unknown, full: boolean): string {
  const text = JSON.stringify(value) ?? String(value);
  return preview(text, full);
}

function render(
  records: TraceRecord[],
  options: Options,
): void {
  const start = records[0]?.ts ?? 0;
  const at = (ts: number): string => `+${(ts - start).toFixed(2)}s`.padStart(8);

  for (const record of records) {
    const { payload } = record;
    // 子 agent 的步骤是「中继」上来的（见 tools/builtins/subagent.ts），标出来才看得清层级
    const relayed = payload.from_subagent === true;
    const prefix = `${at(record.ts)} ${relayed ? "↳" : " "} `;

    switch (record.type) {
      case "run_start":
        console.log(`${prefix}▶ 开始  输入: ${preview(str(payload, "input"), options.full)}`);
        console.log(`${prefix}        提示词版本: ${previewJson(payload.prompt_versions, true)}`);
        break;

      case "llm_start":
        // iteration 从 0 起算，展示时 +1 更符合直觉
        console.log(`${prefix}🧠 第 ${(num(payload, "iteration") ?? 0) + 1} 轮 · 调用模型`);
        break;

      case "llm_end": {
        const tokens = `${num(payload, "prompt_tokens") ?? 0}+${num(payload, "completion_tokens") ?? 0}`;
        const latency = (num(payload, "latency") ?? 0).toFixed(2);
        console.log(`${prefix}🧠 模型返回 · ${tokens} token · ${latency}s · ${str(payload, "finish_reason")}`);
        const content = str(payload, "content");
        if (content) console.log(`${prefix}   思考: ${preview(content, options.full)}`);
        const calls = payload.tool_calls;
        if (Array.isArray(calls) && calls.length) {
          console.log(`${prefix}   决定调用: ${calls.join("、")}`);
        }
        break;
      }

      case "tool_start":
        console.log(`${prefix}🔧 ${str(payload, "name")} 入参: ${previewJson(payload.arguments, options.full)}`);
        break;

      case "tool_end": {
        const ok = payload.ok === true;
        const latency = (num(payload, "latency") ?? 0).toFixed(2);
        const mark = ok ? "✔" : "✘";
        const detail = ok ? previewJson(payload.output, options.full) : str(payload, "error");
        console.log(`${prefix}${mark} ${str(payload, "name")} · ${latency}s · ${preview(detail, options.full)}`);
        break;
      }

      case "memory_recall":
        console.log(`${prefix}📎 召回记忆 ${num(payload, "count") ?? 0} 条`);
        break;

      case "memory_write":
        console.log(`${prefix}📎 写入记忆（${str(payload, "backend")}）`);
        break;

      case "run_end":
        console.log(`${prefix}■ 结束  ok=${payload.ok} 轮次=${num(payload, "iterations") ?? 0}`);
        if (payload.answer) {
          console.log(`${prefix}   回答: ${preview(str(payload, "answer"), options.full)}`);
        }
        break;

      default:
        console.log(`${prefix}· ${record.type} ${previewJson(payload, options.full)}`);
    }
  }
}

/** 汇总：成本、耗时、工具成败——排查时最先看的就是这几项 */
function summarize(records: TraceRecord[]): void {
  interface Tally {
    promptTokens: number;
    completionTokens: number;
    llmCalls: number;
    recalls: number;
    tools: Map<string, { ok: number; fail: number }>;
  }
  const blank = (): Tally => ({
    promptTokens: 0,
    completionTokens: 0,
    llmCalls: 0,
    recalls: 0,
    tools: new Map(),
  });
  // 本层与子 agent 分开统计：合并会把「父只调了一次 run_subagent」和
  // 「子 agent 内部调了十次工具」混成一笔账，看不出到底是哪一层贵
  const own = blank();
  const nested = blank();

  for (const { type, payload } of records) {
    const tally = payload.from_subagent === true ? nested : own;
    if (type === "llm_end") {
      tally.llmCalls += 1;
      tally.promptTokens += num(payload, "prompt_tokens") ?? 0;
      tally.completionTokens += num(payload, "completion_tokens") ?? 0;
    } else if (type === "tool_end") {
      const name = str(payload, "name") || "(未命名)";
      const entry = tally.tools.get(name) ?? { ok: 0, fail: 0 };
      if (payload.ok === true) entry.ok += 1;
      else entry.fail += 1;
      tally.tools.set(name, entry);
    } else if (type === "memory_recall") {
      tally.recalls += 1;
    }
  }

  const ended = records.find((record) => record.type === "run_end");
  const span = (records.at(-1)?.ts ?? 0) - (records[0]?.ts ?? 0);

  const describe = (label: string, tally: Tally): void => {
    console.log(`\n【${label}】`);
    console.log(
      `  模型调用 ${tally.llmCalls} 次    token ${tally.promptTokens} + ${tally.completionTokens}` +
        `    记忆召回 ${tally.recalls} 次`,
    );
    if (tally.tools.size === 0) {
      console.log("  工具调用 无");
      return;
    }
    const parts = [...tally.tools.entries()].map(
      ([name, count]) => `${name} ${count.ok}✔${count.fail > 0 ? `${count.fail}✘` : ""}`,
    );
    console.log(`  工具调用 ${parts.join("  ")}`);
  };

  console.log("\n—— 汇总 ——");
  console.log(`事件数 ${records.length}    跨度 ${span.toFixed(2)}s`);
  if (ended) {
    const latency = num(ended.payload, "latency");
    console.log(
      `结果 ${ended.payload.ok === true ? "成功" : "失败"}` +
        `    轮次 ${num(ended.payload, "iterations") ?? 0}` +
        (latency === undefined ? "" : `    内部耗时 ${latency.toFixed(2)}s`),
    );
  }
  describe("本层", own);
  if (nested.llmCalls > 0 || nested.tools.size > 0) describe("子 agent（↳ 标记的步骤）", nested);
}

/** 没给参数时列出可用轨迹，省得再去翻目录 */
async function listAvailable(): Promise<void> {
  let files: string[];
  try {
    files = await readdir(TRACE_DIR);
  } catch {
    console.log(`轨迹目录不存在: ${TRACE_DIR}`);
    return;
  }
  const runs = files.filter((name) => name.endsWith(".jsonl")).map((name) => basename(name, ".jsonl"));
  if (runs.length === 0) {
    console.log(`轨迹目录为空: ${TRACE_DIR}`);
    return;
  }
  console.log(`用法: npm run trace:replay -- <runId 或 .jsonl 路径> [--full] [--json]\n`);
  console.log(`现有轨迹（${TRACE_DIR}）:`);
  for (const run of runs.slice(-20)) console.log(`  ${run}`);
  if (runs.length > 20) console.log(`  …共 ${runs.length} 条，只列最近 20 条`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (!options.target) {
    await listAvailable();
    return;
  }

  const path = resolveTracePath(options.target);
  let records: TraceRecord[];
  try {
    records = await loadRecords(path);
  } catch (error) {
    // 找不到文件是最常见的误用（runId 打错），直接把路径回显出来
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`读取轨迹失败: ${path}\n${reason}`);
    process.exitCode = 1;
    return;
  }
  if (records.length === 0) {
    console.error(`轨迹为空: ${path}`);
    process.exitCode = 1;
    return;
  }

  if (options.json) {
    console.log(JSON.stringify(records, null, 2));
    return;
  }

  console.log(`轨迹: ${path}`);
  if (records.some((record) => record.payload.from_subagent === true)) {
    console.log("（↳ 标记的步骤来自子 agent，汇总里单独成一段）");
  }
  console.log();
  render(records, options);
  summarize(records);
}

await main();
