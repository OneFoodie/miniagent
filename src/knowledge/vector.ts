/**
 * 基于 LanceDB 的向量知识库：语义检索 + 持久化。
 *
 * 与词面实现（lexical.ts）的分工：
 *   lexical —— 零依赖、词面匹配，「零配置可跑」的降级路径
 *   vector  —— 语义召回，解决词面做不到的跨语言与同义改写
 *
 * 增量策略：每条片段记录来源文件与修改时间。重新加载时按文件比对 mtime，
 * 只重嵌入变过的文件，并删除磁盘上已消失的文件对应的行。
 * **嵌入是 CPU 密集操作（本地模型），全量重建代价很高，所以增量不是优化而是必需。**
 */

// 只引类型（编译后擦除）：真正的库在 openConnection 里动态 import，
// 这样 lexical 后端不必加载 LanceDB 原生模块，"零依赖可跑"才成立。
// 该包在 package.json 里是 optionalDependencies——轻量环境可以不装（见 optionalDeps.ts）。
import type { Connection, Table } from "@lancedb/lancedb";

import { getLogger } from "../core/logging.js";
import type { KnowledgeBase, KnowledgeChunk, KnowledgeHit } from "./base.js";
import { chunkDocument } from "./chunker.js";
import type { EmbeddingModel } from "./embedding.js";
import { explainMissingOptionalDependency } from "./optionalDeps.js";
import { readText, scanFiles, sourceOf, type ScannedFile } from "./store.js";

const logger = getLogger("miniagent.knowledge.vector");

const TABLE_NAME = "chunks";
/** 一次嵌入多少条：太大占内存，太小失去批处理收益 */
const EMBED_BATCH = 32;

/** 尚未嵌入的片段 */
interface PendingChunk {
  id: string;
  source: string;
  heading: string;
  text: string;
  updatedAt: number;
}

/**
 * 落表的一行 = 片段 + 向量。
 * 末尾交叉 Record 是为了满足 LanceDB 的 `Record<string, unknown>` 入参约束
 * （具名 interface 不带索引签名时不可赋值给它）。
 */
type ChunkRow = PendingChunk & { vector: number[] } & Record<string, unknown>;

export interface VectorKnowledgeOptions {
  /** 知识库根目录，可多个 */
  dirs: string[];
  /** 单块最大字符数 */
  maxChars?: number;
  /** 相邻块重叠字符数 */
  overlapChars?: number;
  /** LanceDB 数据目录 */
  dbPath: string;
  embedding: EmbeddingModel;
}

/**
 * 对账结果：磁盘与索引的差异。
 *
 * 存在的意义：增量索引只靠「路径 + mtime」指纹，一旦指纹判定失效
 * （手工动过索引目录、换了嵌入模型导致维度不符、上次写入中断），
 * 索引就会与磁盘悄悄漂移，而检索只会表现为「召不回」——很难看出来是这个原因。
 * 所以给一个能一眼看出漂移的检查口子。
 */
export interface ReconcileReport {
  /** 磁盘上扫到的文件数 */
  diskFiles: number;
  /** 索引里出现过的来源文件数 */
  indexedFiles: number;
  /** 索引里的片段总数 */
  chunks: number;
  /** 磁盘上有、但索引缺失或版本过期 → 需要（重新）嵌入 */
  pending: string[];
  /** 索引里有、磁盘上已消失 → 需要删除 */
  orphans: string[];
}

export class VectorKnowledgeBase implements KnowledgeBase {
  private connection?: Connection;
  private table?: Table;
  private opening?: Promise<Connection>;
  /** 上次同步对应的文件指纹 */
  private signature = "";
  /** 正在进行的同步：并发检索共享同一次，避免重复嵌入 */
  private refreshing?: Promise<void>;

  constructor(private readonly options: VectorKnowledgeOptions) {}

  async docs(): Promise<Array<{ source: string; chunks: number }>> {
    await this.ensureFresh();
    const table = await this.existingTable();
    if (!table) return [];

    const rows = await table.query().select(["source"]).toArray();
    const bySource = new Map<string, number>();
    for (const row of rows) {
      const source = String(row.source);
      bySource.set(source, (bySource.get(source) ?? 0) + 1);
    }
    return [...bySource].map(([source, chunks]) => ({ source, chunks }));
  }

  async search(query: string, topK = 4): Promise<KnowledgeHit[]> {
    await this.ensureFresh();

    const trimmed = query.trim();
    if (trimmed === "") return [];

    const table = await this.existingTable();
    if (!table || (await table.countRows()) === 0) return [];

    const [vector] = await this.options.embedding.embed([trimmed]);
    if (!vector) return [];

    // vectorSearch 的返回类型明确是 VectorQuery；search() 会返回联合类型，拿不到 distanceType
    const rows = (await table
      // 显式指定度量，不让结果依赖默认值（默认是 l2）
      .vectorSearch(vector)
      .distanceType("cosine")
      .limit(Math.max(0, topK))
      .toArray()) as Array<Record<string, unknown>>;

    return rows.map((row) => ({ chunk: toChunk(row), score: toScore(row._distance) }));
  }

  /**
   * 对账：比较磁盘与索引，**只报告不改动**。
   * 供 `npm run knowledge:reindex --check` 与运维巡检使用。
   */
  async verify(): Promise<ReconcileReport> {
    const files = await scanFiles(this.options.dirs);
    const table = await this.existingTable();
    const indexed = table ? await indexedVersions(table) : new Map<string, number>();

    const onDisk = new Map(files.map((file) => [sourceOf(file), file.mtimeMs]));
    const pending = files
      .filter((file) => indexed.get(sourceOf(file)) !== file.mtimeMs)
      .map(sourceOf);

    return {
      diskFiles: files.length,
      indexedFiles: indexed.size,
      chunks: table ? await table.countRows() : 0,
      pending,
      orphans: [...indexed.keys()].filter((source) => !onDisk.has(source)),
    };
  }

  /**
   * 全量重建：丢掉整张表后重新嵌入。
   *
   * 什么时候需要它：索引目录被手工改过、换了嵌入模型（向量维度变了会直接写不进去）、
   * 或上一次写入中断导致表内容可疑。日常改文档**不需要**——增量同步就够了，
   * 全量重建在本地 CPU 上是分钟级操作。
   */
  async rebuild(): Promise<{ files: number; chunks: number }> {
    const connection = await this.ensureConnection();
    const names = await connection.tableNames();
    if (names.includes(TABLE_NAME)) {
      await connection.dropTable(TABLE_NAME);
    }
    // 表和指纹都要清掉：否则 refresh() 会因为指纹未变而直接跳过
    this.table = undefined;
    this.signature = "";
    await this.ensureFresh();

    const table = await this.existingTable();
    const files = await scanFiles(this.options.dirs);
    return { files: files.length, chunks: table ? await table.countRows() : 0 };
  }

  /**
   * 同步入口。并发检索（模型一次批多个工具调用）共享同一次同步，
   * 否则两个流程交错删除/写入会互相干扰。
   */
  private async ensureFresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const task = this.refresh();
    this.refreshing = task;
    try {
      await task;
    } finally {
      this.refreshing = undefined;
    }
  }

  private async refresh(): Promise<void> {
    const files = await scanFiles(this.options.dirs);
    const signature = fingerprint(files);
    if (signature === this.signature) return;

    const connection = await this.ensureConnection();
    const table = await this.existingTable();
    const indexed = table ? await indexedVersions(table) : new Map<string, number>();

    // 1. 磁盘上已消失的文件 → 删掉它落在表里的行
    const onDisk = new Set(files.map(sourceOf));
    for (const source of indexed.keys()) {
      if (!onDisk.has(source) && table) {
        await table.delete(`source = ${sqlString(source)}`);
      }
    }

    // 2. 新增或修改过的文件 → 删旧行后重新嵌入
    const changed = files.filter((file) => indexed.get(sourceOf(file)) !== file.mtimeMs);
    if (changed.length > 0) {
      for (const file of changed) {
        const source = sourceOf(file);
        if (table && indexed.has(source)) {
          await table.delete(`source = ${sqlString(source)}`);
        }
      }

      const rows = await this.buildRows(changed);
      if (rows.length > 0) {
        if (table) {
          await table.add(rows);
        } else {
          // 首次有数据时建表（LanceDB 需要数据来推断 schema）
          this.table = await connection.createTable(TABLE_NAME, rows);
        }
      }
    }

    this.signature = signature;
    const total = this.table ? await this.table.countRows() : 0;
    logger.info(
      `向量知识库已同步: 重嵌入 ${changed.length} 个文件，共 ${total} 个片段`,
    );
  }

  /** 读取并切分变更文件，分批嵌入 */
  private async buildRows(files: ScannedFile[]): Promise<ChunkRow[]> {
    const pending: PendingChunk[] = [];
    for (const file of files) {
      const text = await readText(file.path);
      if (text === undefined) continue;

      const source = sourceOf(file);
      for (const part of chunkDocument(text, this.options)) {
        pending.push({
          id: `${source}#${pending.length}`,
          source,
          heading: part.heading,
          text: part.text,
          updatedAt: file.mtimeMs,
        });
      }
    }

    const rows: ChunkRow[] = [];
    for (let i = 0; i < pending.length; i += EMBED_BATCH) {
      const batch = pending.slice(i, i + EMBED_BATCH);
      const vectors = await this.options.embedding.embed(batch.map(embedText));
      batch.forEach((item, index) => {
        const vector = vectors[index];
        if (vector) rows.push({ ...item, vector });
      });
    }
    return rows;
  }

  private async ensureConnection(): Promise<Connection> {
    if (this.connection) return this.connection;
    if (!this.opening) {
      // 缓存的是 Promise 而不是结果：并发检索只开一次连接
      this.opening = this.openConnection();
    }
    return this.opening;
  }

  private async openConnection(): Promise<Connection> {
    try {
      // 就地解构，不写 `typeof import(...)` 这种类型注解（lint 禁止，也没必要）
      const { connect } = await import("@lancedb/lancedb");
      const connection = await connect(this.options.dbPath);
      this.connection = connection;
      return connection;
    } catch (error) {
      // 缺包 → 翻成「装依赖 / 换回词面后端」两条出路；
      // 连接失败等其它错误会被原样返回（见 explainMissingOptionalDependency）
      throw explainMissingOptionalDependency(
        error,
        "@lancedb/lancedb",
        "语义检索（vector / hybrid 后端）",
      );
    }
  }

  /** 取已存在的表；表还没建时返回 undefined（不提前建空表，LanceDB 需要数据推断 schema） */
  private async existingTable(): Promise<Table | undefined> {
    if (this.table) return this.table;
    const connection = await this.ensureConnection();
    const names = await connection.tableNames();
    if (!names.includes(TABLE_NAME)) return undefined;
    this.table = await connection.openTable(TABLE_NAME);
    return this.table;
  }
}

/** 嵌入文本：标题一起进，标题里的词往往正是检索时的关键词 */
function embedText(item: { heading: string; text: string }): string {
  return item.heading ? `${item.heading}\n${item.text}` : item.text;
}

/** 文件指纹：路径 + 修改时间 */
function fingerprint(files: ScannedFile[]): string {
  return files.map((file) => `${file.path}|${file.mtimeMs}`).join("\n");
}

/** 表里每个来源文件的版本（同一文件的所有片段共用同一个 mtime） */
async function indexedVersions(table: Table): Promise<Map<string, number>> {
  const rows = await table.query().select(["source", "updatedAt"]).toArray();
  const versions = new Map<string, number>();
  for (const row of rows) {
    const source = String(row.source);
    const updatedAt = Number(row.updatedAt);
    const current = versions.get(source);
    if (current === undefined || updatedAt > current) versions.set(source, updatedAt);
  }
  return versions;
}

/**
 * 余弦距离转相似度：相似度 = 1 − 距离。
 * search 里显式指定了 distanceType("cosine")，所以这里不依赖默认度量。
 */
function toScore(distance: unknown): number {
  const parsed = Number(distance);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(1, 1 - parsed));
}

function toChunk(row: Record<string, unknown>): KnowledgeChunk {
  return {
    id: String(row.id),
    source: String(row.source),
    heading: String(row.heading ?? ""),
    text: String(row.text),
    updatedAt: Number(row.updatedAt ?? 0),
  };
}

/** LanceDB 的 delete 接 SQL 谓词字符串，单引号需要转义 */
function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
