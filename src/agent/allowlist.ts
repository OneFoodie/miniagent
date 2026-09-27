/**
 * 命令级放行白名单：被人工放行过一次的工具调用，此后不再询问。
 *
 * 为什么必须常驻内存：判定发生在 `Agent.act()` 的工具批次路径上，是**同步**的
 * （见 agent.ts 的 decideApproval）。查文件做不到同步，所以启动时把 JSONL 读进
 * 内存里的一个指纹 Set，add/remove 时同步改内存、异步落盘。
 *
 * 为什么落成 JSONL 而不是逗号分隔的一行配置：命令里可能含逗号、引号、换行，
 * 逗号分隔会被截断；一行一条 JSON 天然容纳任意参数。它本质是**运行期状态**
 * （与 history/、memory/、checkpoints/ 同类），不是环境配置，所以独立成文件。
 *
 * 容错策略与 checkpoint.ts 的 loadCheckpoint 一致：文件不存在或某行损坏都不抛错，
 * 当作空（或跳过坏行）——白名单只是省打扰的优化，不该成为新的故障点。
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface AllowlistEntry {
  tool: string;
  arguments: Record<string, unknown>;
  addedAt: number;
}

/**
 * 只处理普通对象的稳定序列化：对象键排序，数组按序。
 *
 * 为什么不用 JSON.stringify：它的键顺序取决于对象插入顺序，`{a:1,b:2}` 与
 * `{b:2,a:1}` 会得到不同字符串，于是「同一条命令因参数顺序不同被要求放行两次」。
 * 键排序后这两种形状归一到同一个指纹。
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    // 顶层 undefined 时 JSON.stringify 返回 undefined，统一成 null 以免拼出 "undefined"
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    // JSON 里对象的 undefined 值会被丢弃，这里保持一致，避免 `{a:undefined}` 与 `{}` 判成两条
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

/**
 * 判定指纹 = 工具名 + NUL + 参数稳定 JSON。
 *
 * NUL 只用来分隔工具名与参数，保证 `("a", "bc")` 与 `("ab", "c")` 不会撞车。
 *
 * **一处刻意的例外**：`shell` 的 `timeout_seconds` 不参与指纹。
 * 它是执行细节（跑多久），不是「要做什么」；不剔除的话，模型这次给
 * `timeout_seconds: 5`、下次不给，就会被当成两条不同命令而要求放行两次——
 * 在模型自主决定超时的场景下这会频繁发生。规则只针对 shell。
 */
function fingerprint(tool: string, args: Record<string, unknown>): string {
  let effective = args;
  if (tool === "shell") {
    const { timeout_seconds: _ignored, ...rest } = args;
    effective = rest;
  }
  return `${tool}\u0000${stableStringify(effective)}`;
}

/** 从 JSONL 的一行还原条目；形状不对返回 undefined（坏行直接跳过） */
function parseEntry(line: string): AllowlistEntry | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  if (typeof record.tool !== "string") return undefined;
  if (record.arguments === null || typeof record.arguments !== "object") return undefined;
  return {
    tool: record.tool,
    arguments: record.arguments as Record<string, unknown>,
    addedAt: typeof record.addedAt === "number" ? record.addedAt : Date.now(),
  };
}

export class ApprovalAllowlist {
  private entries: AllowlistEntry[] = [];
  private keys = new Set<string>();

  constructor(private readonly file: string) {}

  /** 启动时读进内存；文件不存在或内容损坏都当作空白名单 */
  async load(): Promise<void> {
    this.entries = [];
    this.keys.clear();
    let raw: string;
    try {
      raw = await readFile(this.file, "utf-8");
    } catch {
      return;
    }
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const entry = parseEntry(trimmed);
      if (!entry) continue;
      // 文件里可能残留重复（如两次并发写入），加载时顺手去重，内存里始终唯一
      this.store(entry);
    }
  }

  /** 同步查内存指纹；命中即「已放行」 */
  has(tool: string, args: Record<string, unknown>): boolean {
    return this.keys.has(fingerprint(tool, args));
  }

  /** 放行一条；重复放行同一条不产生第二条 */
  async add(tool: string, args: Record<string, unknown>): Promise<void> {
    const key = fingerprint(tool, args);
    if (this.keys.has(key)) return;
    const entry: AllowlistEntry = { tool, arguments: args, addedAt: Date.now() };
    this.store(entry);
    // 追加写：既保留历史顺序，也避免并发 add 时整文件互相覆盖
    await mkdir(dirname(this.file), { recursive: true });
    await appendFile(this.file, `${JSON.stringify(entry)}\n`, "utf-8");
  }

  /** 按指纹删除；删到了返回 true，本来就没有返回 false */
  async remove(tool: string, args: Record<string, unknown>): Promise<boolean> {
    const key = fingerprint(tool, args);
    if (!this.keys.has(key)) return false;
    this.keys.delete(key);
    this.entries = this.entries.filter(
      (entry) => fingerprint(entry.tool, entry.arguments) !== key,
    );
    // 删除必须整文件重写：JSONL 无法原地摘掉中间一行
    await this.persistAll();
    return true;
  }

  /** 返回副本，避免调用方改到内存里的条目 */
  list(): AllowlistEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  /** 入内存并按指纹去重（load / add 共用） */
  private store(entry: AllowlistEntry): void {
    const key = fingerprint(entry.tool, entry.arguments);
    if (this.keys.has(key)) return;
    this.keys.add(key);
    this.entries.push(entry);
  }

  private async persistAll(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const text = this.entries.map((entry) => JSON.stringify(entry)).join("\n");
    // 末尾换行：与 add 的「一行一条」保持一致，后续 append 不会粘到上一行
    await writeFile(this.file, text ? `${text}\n` : "", "utf-8");
  }
}
