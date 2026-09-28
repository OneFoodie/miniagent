/**
 * 长期记忆的 JSONL 实现。
 *
 * 存储：一行一条 JSON 记录，追加写，读时全量载入内存再打分。
 * 检索：关键词命中数为主分，时间衰减为辅分——越久远的记忆权重越低。
 *
 * 该实现面向单机、数据量小的场景；数据量大时把 LongTermMemory 换成向量库即可，
 * 调用方代码无需改动。
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  LongTermMemory,
  MemoryRecord,
  MemorySearchOptions,
} from "./base.js";
import { matchesSession } from "./base.js";

export class JsonlLongTermMemory implements LongTermMemory {
  constructor(private readonly filePath: string) {}

  async add(record: MemoryRecord): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(record)}\n`, "utf-8");
  }

  async load(limit = 200): Promise<MemoryRecord[]> {
    const all = await this.readAll();
    return all.slice(-limit);
  }

  async search(
    query: string,
    limit = 5,
    options?: MemorySearchOptions,
  ): Promise<MemoryRecord[]> {
    const terms = tokenize(query);
    if (terms.length === 0) return [];

    const now = Date.now() / 1000;
    return (await this.readAll())
      // 先按会话收窄再排序：过滤掉别的会话的记录，它们不该参与本次召回的竞争
      .filter((record) => matchesSession(record.meta, options))
      .map((record) => ({ record, score: score(record, terms, now) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((item) => item.record);
  }

  /** 读取全部记录；文件不存在或某行损坏时跳过，不让记忆文件拖垮主流程 */
  private async readAll(): Promise<MemoryRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf-8");
    } catch {
      return [];
    }
    const records: MemoryRecord[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as MemoryRecord);
      } catch {
        // 单行损坏忽略
      }
    }
    return records;
  }
}

/** 命中数 × 时间衰减因子；30 天前的记忆权重约为一半 */
function score(record: MemoryRecord, terms: string[], now: number): number {
  const text = record.text.toLowerCase();
  const hits = terms.reduce((count, term) => (text.includes(term) ? count + 1 : count), 0);
  if (hits === 0) return 0;
  const ageDays = Math.max(0, (now - record.ts) / 86400);
  return hits / (1 + ageDays / 30);
}

/** 中英混排的简易切词：按非字母数字切分，丢弃单字符 */
function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 1);
}
