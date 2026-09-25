/**
 * 本地词面检索实现：复用记忆模块的 TF-IDF（中英混排切词），零依赖、零 API 成本。
 *
 * 已知短板：对同义改写召回不好（「不再喜欢咖啡了」与「喜欢咖啡」余弦只有 0.58）。
 * 这是第一期的有意取舍——先把全链路跑通，接口留好，后续换 embedding 只需
 * 另写一个 implements KnowledgeBase 的类，工具层与 Agent 都不用改。
 *
 * 热更新：每次检索前做一次廉价的目录扫描（readdir + stat），把「路径 + 修改时间」
 * 拼成指纹；指纹没变就直接用现有索引，变了才重新读文件、切分、重建。所以改完文档
 * 不必重启进程——只是那次检索会稍慢一点。
 */

import { TfidfIndex, tokenize } from "../memory/textIndex.js";
import type { KnowledgeBase, KnowledgeChunk, KnowledgeHit } from "./base.js";
import { chunkDocument } from "./chunker.js";
import { readText, scanFiles, sourceOf } from "./store.js";

export interface LexicalKnowledgeOptions {
  /** 知识库根目录，可多个；source 会带上各自目录名以区分来源 */
  dirs: string[];
  /** 单块最大字符数 */
  maxChars?: number;
  /** 相邻块重叠字符数 */
  overlapChars?: number;
}

/** 达到该字符数即视为内容完整，不再惩罚 */
const SOLID_CHUNK_CHARS = 150;
/** 极短片段的得分下限系数（只削不砍，保证短而有价值的片段仍能被召回） */
const SHORT_CHUNK_FLOOR = 0.2;

/**
 * 长度惩罚：TF-IDF 余弦天然偏好短文本——词少则向量"纯"，命中少数几个词就能把相似度推高。
 * 实测中一个 27 字的元信息片段（文档头的日期/状态）会压过几百字的正文抢到榜首。
 * 这里按长度线性"打折"，而不是直接丢弃，避免误伤本就简短的小节。
 */
export function lengthPenalty(length: number): number {
  if (length >= SOLID_CHUNK_CHARS) return 1;
  return SHORT_CHUNK_FLOOR + (1 - SHORT_CHUNK_FLOOR) * (length / SOLID_CHUNK_CHARS);
}

export class LexicalKnowledgeBase implements KnowledgeBase {
  private chunks: KnowledgeChunk[] = [];
  /** 与 chunks 一一对应的切词结果 */
  private tokens: string[][] = [];
  private index?: TfidfIndex;
  /** 上一次索引对应的文件指纹；空串表示还没建过 */
  private signature = "";
  /** 正在进行的刷新：多个并发检索共享同一次，避免重复重建 */
  private refreshing?: Promise<void>;

  constructor(private readonly options: LexicalKnowledgeOptions) {}

  async docs(): Promise<Array<{ source: string; chunks: number }>> {
    await this.ensureFresh();
    const bySource = new Map<string, number>();
    for (const chunk of this.chunks) {
      bySource.set(chunk.source, (bySource.get(chunk.source) ?? 0) + 1);
    }
    return [...bySource].map(([source, chunks]) => ({ source, chunks }));
  }

  async search(query: string, topK = 4): Promise<KnowledgeHit[]> {
    await this.ensureFresh();

    const tokens = tokenize(query);
    if (tokens.length === 0 || this.chunks.length === 0) return [];

    const index = this.getIndex();
    const queryVector = index.vector(tokens);

    const ranked = this.chunks
      .map((chunk, i) => ({
        chunk,
        score:
          TfidfIndex.cosine(queryVector, index.vector(this.tokens[i]!)) *
          lengthPenalty(chunk.text.length),
      }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score);

    return this.withSameTopicPeers(ranked, Math.max(0, topK));
  }

  /**
   * 截断之后，把「同一小节、但来自别的文档」的片段补回来。
   *
   * 动机：知识库没有新旧排序，一个主题若有多份记载，冲突双方必须同时出现在模型眼前——
   * 否则模型只看到一份，会毫无察觉地把它当作唯一事实。实测里冲突的两份分数只差 0.0013，
   * 谁能进 top_k 纯属偶然，靠运气发现冲突是不可接受的。
   *
   * 只补「heading 相同但 source 不同」的：同一文档同一小节的后续分块是内容延续，
   * 不算另一份记载，补进来只是白烧 token。
   */
  private withSameTopicPeers(ranked: KnowledgeHit[], topK: number): KnowledgeHit[] {
    const primary = ranked.slice(0, topK);
    if (topK === 0 || primary.length === 0) return primary;

    const peers = ranked.slice(topK).filter((candidate) =>
      primary.some(
        (chosen) =>
          candidate.chunk.heading !== "" &&
          candidate.chunk.heading === chosen.chunk.heading &&
          candidate.chunk.source !== chosen.chunk.source,
      ),
    );

    // 兜底上限：补入数不超过 top_k，避免极端情况下结果整体翻倍
    return [...primary, ...peers.slice(0, topK)];
  }

  /**
   * 热更新入口。多个并发检索（模型一次批多个工具调用）会共享同一次刷新，
   * 否则两个流程交错清空/填充数组会写出重复的片段。
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
    const signature = files.map((file) => `${file.path}|${file.mtimeMs}`).join("\n");
    if (signature === this.signature) return;

    // 先在局部变量里建好再整体替换：中途抛错也不会留下半个索引
    const chunks: KnowledgeChunk[] = [];
    const tokens: string[][] = [];
    for (const file of files) {
      const text = await readText(file.path);
      if (text === undefined) continue;

      const source = sourceOf(file);
      for (const part of chunkDocument(text, this.options)) {
        chunks.push({
          id: `${source}#${chunks.length}`,
          source,
          heading: part.heading,
          text: part.text,
          // 文件修改时间随片段带下去，供模型判断两份冲突记载哪份更新
          updatedAt: file.mtimeMs,
        });
        // 标题一起进语料：标题里的词往往正是检索时的关键词
        tokens.push(tokenize(`${part.heading}\n${part.text}`));
      }
    }

    this.chunks = chunks;
    this.tokens = tokens;
    this.index = undefined;
    this.signature = signature;
  }

  /** 惰性建索引：idf 依赖整个语料，因此只在文档集变化后重建 */
  private getIndex(): TfidfIndex {
    if (!this.index) this.index = new TfidfIndex(this.tokens);
    return this.index;
  }
}
