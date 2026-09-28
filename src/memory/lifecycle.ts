/**
 * 带完整生命周期的本地长期记忆。
 *
 * 机制参考 rabisai-memory（把它原本的 LanceDB 换成 JSONL + 内存 TF-IDF 索引）：
 *   1. 置信度：新记忆 0.6 起步，被召回 +0.1 并刷新访问时间
 *   2. 矛盾消解：与旧记忆足够相似且含推翻词 → 旧记忆标记 superseded、置信度清零
 *   3. 去重：高度相似、没有推翻词、且信息没被替换 → 视为重复，只强化旧记忆而不重复插入
 *      （"信息被替换"要排除在外，否则「代号是 A」会把后来的「代号是 B」当重复丢掉）
 *   4. Ebbinghaus 遗忘：按记忆类型给不同日衰减率
 *   5. 多信号排序：0.5 语义 + 0.2 时效 + 0.15 置信度 + 0.15 优先级
 *   6. 巩固（consolidation）：可检索条数超阈值时，把最低分的一批用 LLM
 *      压缩成一条归档摘要并标记 consolidatedInto——同样不删除原记录。
 *      遗忘曲线管单条衰减，巩固管整体收敛，两者共同给检索规模设上界。
 *
 * 两种相似度分工明确：
 *   检索排序用余弦——对称、惩罚噪声，越聚焦越靠前
 *   去重与矛盾判定用重叠系数——判断"是否在说同一件事"，包含关系要能识别
 * （「不再喜欢咖啡了」包含「喜欢咖啡」，余弦只有 0.58，重叠系数能到 0.91）
 *
 * 存储用 JSONL 整文件重写：矛盾消解与置信度强化都要改既有记录，追加写不够用；
 * 教学规模（几百到几千条）下重写成本可忽略。
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { getLogger } from "../core/logging.js";
import type {
  LongTermMemory,
  MemoryRecord,
  MemorySearchOptions,
} from "./base.js";
import { matchesSession } from "./base.js";
import {
  clamp01,
  composeScore,
  decayedConfidence,
  DECAY_PER_DAY,
  DEFAULT_PRIORITY,
  hasContradictionCue,
  inferKind,
  INITIAL_CONFIDENCE,
  RECALL_BOOST,
  recencyScore,
  type MemoryKind,
} from "./scoring.js";
import { baseTokens, overlapCoefficient, TfidfIndex, tokenize } from "./textIndex.js";

const logger = getLogger("miniagent.memory.lifecycle");

/** 落盘的一条记忆 */
export interface StoredMemory {
  id: string;
  text: string;
  kind: MemoryKind;
  /** 存下来的置信度；读取时按距上次访问的时间衰减 */
  confidence: number;
  priority: number;
  createdAt: number;
  lastAccessedAt: number;
  accessCount: number;
  /** 被哪条记忆取代（矛盾消解的产物） */
  supersededBy?: string;
  /** 被归档到哪条摘要记忆（巩固的产物） */
  consolidatedInto?: string;
  meta?: Record<string, unknown>;
}

/** 记忆巩固：把一批低分记忆用 LLM 压成一条归档摘要 */
export interface ConsolidateOptions {
  /** 可检索条数超过该值时触发 */
  threshold: number;
  /** 单次吸收多少条最低分的记忆 */
  batch: number;
  /** 归档摘要字数上限 */
  maxChars: number;
  /** 语义压缩函数；返回 undefined / 空串表示本次放弃巩固（保留原记录） */
  summarize: (texts: string[]) => Promise<string | undefined>;
}

export interface LifecycleMemoryOptions {
  filePath: string;
  /** 重叠系数达到该值时判为重复 */
  duplicateThreshold?: number;
  /** 重叠系数达到该值且含推翻词时触发矛盾消解 */
  contradictionThreshold?: number;
  /** 不传则不启用巩固 */
  consolidate?: ConsolidateOptions;
}

const DEFAULT_DUPLICATE_THRESHOLD = 0.85;
const DEFAULT_CONTRADICTION_THRESHOLD = 0.7;

export class LifecycleMemory implements LongTermMemory {
  private readonly filePath: string;
  private readonly duplicateThreshold: number;
  private readonly contradictionThreshold: number;
  private readonly consolidate?: ConsolidateOptions;

  private records: StoredMemory[] = [];
  private index?: TfidfIndex;
  /** 文本切词缓存；只依赖文本，因此语料变化时无需失效 */
  private readonly tokensById = new Map<string, string[]>();
  private loaded = false;

  constructor(options: LifecycleMemoryOptions) {
    this.filePath = options.filePath;
    this.duplicateThreshold = options.duplicateThreshold ?? DEFAULT_DUPLICATE_THRESHOLD;
    this.contradictionThreshold =
      options.contradictionThreshold ?? DEFAULT_CONTRADICTION_THRESHOLD;
    this.consolidate = options.consolidate;
  }

  async add(record: MemoryRecord): Promise<void> {
    await this.ensureLoaded();

    const text = record.text.trim();
    if (!text) return;

    const now = record.ts > 0 ? record.ts : Date.now() / 1000;
    const kind = readKind(record) ?? inferKind(text);
    const priority = readPriority(record) ?? DEFAULT_PRIORITY[kind];
    const conflicting = hasContradictionCue(text);

    const tokens = tokenize(text);
    // 会话范围：写入侧和检索侧用同一把尺子。不这样做的话，会话 A 说过的「同一句话」会把
    // 会话 B 的新记忆当成重复吸收进 A 的记录——B 从此再也检索不到自己那条（已被过滤掉）。
    const scope = sessionScope(record.meta);
    // findMostSimilar 用的是"加入新记忆之前"的集合，因此不会匹配到自己
    const nearest = this.findMostSimilar(tokens, scope);

    // 先弄清与最近那条之间是"换个说法"还是"内容被换掉了"
    const change = nearest ? compareFacts(tokens, this.tokensOf(nearest.memory)) : undefined;

    // 情形一：高度重合 + 没有推翻词 + 信息没被替换 → 视为重复，只强化旧记忆。
    // 必须排除"替换"，否则「代号是 ZTX-9917」会把后来的「代号是 ZTX-8800」
    // 当成重复丢掉——系统就会一直记着过时的值。
    if (
      nearest &&
      !conflicting &&
      !change?.replaced &&
      nearest.overlap >= this.duplicateThreshold
    ) {
      // 新记忆信息更全时，用它的文本刷新旧记录，避免把补充进来的信息丢掉
      if (change?.keepsAll) {
        nearest.memory.text = text;
        this.tokensById.set(nearest.memory.id, tokens);
        this.invalidateIndex();
      }
      this.reinforce(nearest.memory, now);
      await this.persist();
      return;
    }

    const memory: StoredMemory = {
      id: randomUUID(),
      text,
      kind,
      confidence: readConfidence(record) ?? INITIAL_CONFIDENCE,
      priority,
      createdAt: now,
      lastAccessedAt: now,
      accessCount: 0,
      meta: record.meta,
    };

    // 情形二：足够重合，且（含推翻词 或 信息被替换）→ 矛盾消解：旧记忆失效但不删除，历史仍可查。
    // 没有推翻词也要覆盖"替换"：用户直接改口、没有说「改成」时，同样得让旧值失效，
    // 否则两条冲突值并存，检索时会互相污染。
    if (
      nearest &&
      (conflicting || change?.replaced) &&
      nearest.overlap >= this.contradictionThreshold
    ) {
      nearest.memory.supersededBy = memory.id;
      nearest.memory.confidence = 0;
      logger.info(
        `矛盾消解：「${truncate(nearest.memory.text)}」已被「${truncate(text)}」取代` +
          (conflicting ? "" : "（由信息替换判定触发，无推翻词）"),
      );
    }

    this.records.push(memory);
    this.tokensById.set(memory.id, tokens);
    this.invalidateIndex();
    await this.persist();
    await this.consolidateIfNeeded(scope);
  }

  async search(
    query: string,
    limit = 5,
    options?: MemorySearchOptions,
  ): Promise<MemoryRecord[]> {
    await this.ensureLoaded();

    const tokens = tokenize(query);
    if (tokens.length === 0) return [];

    const now = Date.now() / 1000;
    const index = this.getIndex();
    const queryVector = index.vector(tokens);

    const ranked = this.active()
      // 记忆库是全局共用的，会话隔离只能靠这里：只让本会话写入的记录参与排序
      .filter((memory) => matchesSession(memory.meta, options))
      .map((memory) => {
        const semantic = TfidfIndex.cosine(
          queryVector,
          index.vector(this.tokensOf(memory)),
        );
        const confidence = decayedConfidence(
          memory.confidence,
          memory.lastAccessedAt,
          memory.kind,
          now,
        );
        const score = composeScore({
          semantic,
          recency: recencyScore(memory.createdAt, now),
          confidence,
          priority: memory.priority,
        });
        return { memory, semantic, confidence, score };
      })
      .filter((entry) => entry.semantic > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(0, limit));

    // 召回即强化：把衰减后的结果固化下来再加成，避免重复衰减
    for (const entry of ranked) {
      entry.memory.confidence = clamp01(entry.confidence + RECALL_BOOST);
      entry.memory.lastAccessedAt = now;
      entry.memory.accessCount += 1;
    }
    if (ranked.length > 0) await this.persist();

    return ranked.map((entry) => ({
      text: entry.memory.text,
      ts: entry.memory.createdAt,
      meta: {
        ...entry.memory.meta,
        memoryId: entry.memory.id,
        kind: entry.memory.kind,
        score: Number(entry.score.toFixed(4)),
        // 报强化后的实际存盘值，与 load() 保持一致
        confidence: Number(entry.memory.confidence.toFixed(4)),
        accessCount: entry.memory.accessCount,
      },
    }));
  }

  async load(limit = 200): Promise<MemoryRecord[]> {
    await this.ensureLoaded();
    return this.active()
      .slice()
      .sort((a, b) => b.lastAccessedAt - a.lastAccessedAt)
      .slice(0, Math.max(0, limit))
      .map((memory) => ({
        text: memory.text,
        ts: memory.createdAt,
        meta: {
          ...memory.meta,
          memoryId: memory.id,
          kind: memory.kind,
          confidence: Number(memory.confidence.toFixed(4)),
          priority: Number(memory.priority.toFixed(4)),
          accessCount: memory.accessCount,
        },
      }));
  }

  /** 已失效或被归档的记忆不再参与召回与检索 */
  private active(): StoredMemory[] {
    return this.records.filter(
      (memory) =>
        memory.supersededBy === undefined && memory.consolidatedInto === undefined,
    );
  }

  /**
   * 记忆巩固：条数超阈值时，把最低分的一批压成一条归档摘要。
   *
   * 选谁是按"不含语义信号"的价值排序——巩固发生在写入路径上，此刻没有查询语境，
   * 于是 semantic 记 0，仅用时效 / 置信度 / 优先级三项加权（越小越该被吸收）。
   * 压缩失败或模型返回空 → 本次放弃，原记录原样保留。
   *
   * 巩固同样按会话隔离：否则会把别的会话的记忆吸收进本会话的归档，而归档又被那些会话
   * 检索过滤掉，等于替它们删了记忆。归档记录沿用同一 sessionId，才对本会话仍可检索。
   */
  private async consolidateIfNeeded(scope?: MemorySearchOptions): Promise<void> {
    const options = this.consolidate;
    if (!options) return;

    const active = this.active().filter((memory) => matchesSession(memory.meta, scope));
    if (active.length <= options.threshold) return;

    const now = Date.now() / 1000;
    const picked = active
      .map((memory) => ({
        memory,
        value: composeScore({
          semantic: 0,
          recency: recencyScore(memory.createdAt, now),
          confidence: decayedConfidence(
            memory.confidence,
            memory.lastAccessedAt,
            memory.kind,
            now,
          ),
          priority: memory.priority,
        }),
      }))
      .sort((a, b) => a.value - b.value)
      .slice(0, Math.min(options.batch, active.length - 1));
    if (picked.length < 2) return;

    try {
      const summary = await options.summarize(picked.map((item) => item.memory.text));
      const text = summary?.trim();
      if (!text) return;

      const archive: StoredMemory = {
        id: randomUUID(),
        text: text.length > options.maxChars ? text.slice(0, options.maxChars) : text,
        // 归档是事实性摘要，用 fact 的慢衰减，避免刚巩固完就又被遗忘
        kind: "fact",
        confidence: Math.max(...picked.map((item) => item.memory.confidence)),
        priority: DEFAULT_PRIORITY.fact,
        createdAt: now,
        lastAccessedAt: now,
        accessCount: 0,
        // 沿用本次写入的会话范围：归档只对本会话可见，不跟着变成"全局记忆"
        meta: {
          ...(scope?.sessionId ? { sessionId: scope.sessionId } : {}),
          consolidatedFrom: picked.length,
        },
      };
      for (const item of picked) item.memory.consolidatedInto = archive.id;

      this.records.push(archive);
      this.tokensById.set(archive.id, tokenize(archive.text));
      this.invalidateIndex();
      await this.persist();
      logger.info(
        `记忆巩固：${picked.length} 条低分记忆压缩为 1 条归档（检索集 ${active.length} → ${this.active().length}）`,
      );
    } catch (error) {
      // 压缩失败不阻断写入，原记录保持可检索
      const message = error instanceof Error ? error.message : String(error);
      logger.warning(`记忆巩固失败，保留原记录: ${message}`);
    }
  }

  private reinforce(memory: StoredMemory, now: number): void {
    const current = decayedConfidence(
      memory.confidence,
      memory.lastAccessedAt,
      memory.kind,
      now,
    );
    memory.confidence = clamp01(current + RECALL_BOOST);
    memory.lastAccessedAt = now;
    memory.accessCount += 1;
  }

  private findMostSimilar(
    tokens: string[],
    scope?: MemorySearchOptions,
  ): { memory: StoredMemory; overlap: number } | undefined {
    let best: { memory: StoredMemory; overlap: number } | undefined;
    for (const memory of this.active()) {
      // 只在同一会话内做相似判定：跨会话「像」不该触发去重，更不该触发矛盾消解
      if (!matchesSession(memory.meta, scope)) continue;
      const overlap = overlapCoefficient(tokens, this.tokensOf(memory));
      if (!best || overlap > best.overlap) best = { memory, overlap };
    }
    return best;
  }

  private tokensOf(memory: StoredMemory): string[] {
    let tokens = this.tokensById.get(memory.id);
    if (!tokens) {
      tokens = tokenize(memory.text);
      this.tokensById.set(memory.id, tokens);
    }
    return tokens;
  }

  /** 惰性重建索引：idf 依赖整个语料，所以只在记忆集合变化后重建 */
  private getIndex(): TfidfIndex {
    if (!this.index) {
      this.index = new TfidfIndex(
        this.active().map((memory) => this.tokensOf(memory)),
      );
    }
    return this.index;
  }

  private invalidateIndex(): void {
    this.index = undefined;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.records = await readRecords(this.filePath);
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const body = this.records.map((memory) => JSON.stringify(memory)).join("\n");
    await writeFile(this.filePath, body ? `${body}\n` : "", "utf-8");
  }
}

async function readRecords(filePath: string): Promise<StoredMemory[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch {
    return [];
  }

  const records: StoredMemory[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as StoredMemory);
    } catch {
      // 单行损坏忽略，不让记忆文件拖垮主流程
    }
  }
  return records;
}

function readKind(record: MemoryRecord): MemoryKind | undefined {
  const value = record.meta?.kind;
  return typeof value === "string" && Object.hasOwn(DECAY_PER_DAY, value)
    ? (value as MemoryKind)
    : undefined;
}

function readPriority(record: MemoryRecord): number | undefined {
  const value = record.meta?.priority;
  return typeof value === "number" && Number.isFinite(value) ? clamp01(value) : undefined;
}

function readConfidence(record: MemoryRecord): number | undefined {
  const value = record.meta?.confidence;
  return typeof value === "number" && Number.isFinite(value) ? clamp01(value) : undefined;
}

/**
 * 从记录的 meta 里取出会话范围。
 * 没有 sessionId 时返回 undefined —— 那是 CLI / 评测这类没有会话概念的场景，不过滤。
 */
function sessionScope(
  meta: Record<string, unknown> | undefined,
): MemorySearchOptions | undefined {
  const sessionId = meta?.sessionId;
  return typeof sessionId === "string" && sessionId ? { sessionId } : undefined;
}

/**
 * 比较新旧两条记忆的信息变化，用于区分「换个说法」与「内容被换掉」。
 *
 *   replaced —— 旧的有信息消失、新的又引入了新信息 → 内容真的变了（例如改了值）
 *   keepsAll —— 旧的信息一个都没少 → 新记忆是旧记忆的补全或重述
 *
 * 两个都为 false 表示字面上没变化（纯重复）。判据基于「基础 token」（中文单字 +
 * 拉丁词，丢掉相邻双字），因为双字组会把「换说法」误判成「换内容」。
 */
function compareFacts(
  next: string[],
  previous: string[],
): { replaced: boolean; keepsAll: boolean } {
  const after = baseTokens(next);
  const before = baseTokens(previous);

  const lost = [...before].some((token) => !after.has(token));
  const gained = [...after].some((token) => !before.has(token));

  return { replaced: lost && gained, keepsAll: !lost };
}

function truncate(text: string, max = 24): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}
