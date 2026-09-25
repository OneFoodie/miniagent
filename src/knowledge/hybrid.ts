/**
 * 混合检索：词面 + 向量两路召回，用 RRF（Reciprocal Rank Fusion）融合。
 *
 * 两路的失效模式**不重叠**，这正是要融合的理由：
 *   向量通道 —— 同义改写、跨语言能召回；但代号 / 编号这类精确 token 容易被语义平滑掉
 *   词面通道 —— 精确 token 命中率高；但换个说法（甚至只是换种语言）就召不回
 *
 * RRF 只用**排名**不用分数，所以不必把两路的分数量纲对齐
 * （词面的余弦分与向量的 `1 - distance` 虽然都落在 0~1，分布却完全不同）。
 * 公式：`score = Σ weight_c / (k + rank_c)`，k 取 60（原论文的经验值）。
 *
 * 刻意不做 cross-encoder 重排：那要再挂一个 ONNX 模型（体积与首次加载成本都不小），
 * 而这里要解决的「精确匹配被漏掉」用 RRF 已经能覆盖——目标片段会在词面通道排到头部，
 * 融合后的排名自然被抬起来。
 */

import { getLogger } from "../core/logging.js";
import type { KnowledgeBase, KnowledgeChunk, KnowledgeHit } from "./base.js";

const logger = getLogger("miniagent.knowledge.hybrid");

/** RRF 常数：越大则头部排名之间的差距越被压平 */
export const DEFAULT_RRF_K = 60;
/** 两路各取多少候选进入融合。取 topK 的数倍才有融合空间 */
const CANDIDATE_FACTOR = 5;
/** 候选数下限，避免 topK 很小时两路几乎没有交集 */
const MIN_CANDIDATES = 20;

export interface HybridKnowledgeOptions {
  /** 词面通道 */
  lexical: KnowledgeBase;
  /** 语义通道 */
  vector: KnowledgeBase;
  rrfK?: number;
  /** 词面通道权重。要更倚重精确匹配（代号、编号）就调大它 */
  lexicalWeight?: number;
  /** 语义通道权重。要更倚重同义与跨语言召回就调大它 */
  vectorWeight?: number;
}

/** 融合过程中的中间态：累加分数，并记录命中来自哪几路 */
interface FusedHit {
  chunk: KnowledgeChunk;
  score: number;
  channels: Set<string>;
}

export class HybridKnowledgeBase implements KnowledgeBase {
  constructor(private readonly options: HybridKnowledgeOptions) {}

  /** 文档概览交给词面通道：它只读文件、不碰模型，最便宜也最稳 */
  async docs(): Promise<Array<{ source: string; chunks: number }>> {
    return this.options.lexical.docs();
  }

  async search(query: string, topK = 4): Promise<KnowledgeHit[]> {
    const lexicalWeight = this.options.lexicalWeight ?? 1;
    const vectorWeight = this.options.vectorWeight ?? 1;
    const k = this.options.rrfK ?? DEFAULT_RRF_K;
    const limit = Math.max(topK * CANDIDATE_FACTOR, MIN_CANDIDATES);

    // 两路并发。任一路失败都降级为另一路——知识库检索不该因为嵌入模型没装好就整体不可用
    const [lexical, vector] = await Promise.all([
      this.runChannel("词面", this.options.lexical, query, limit),
      this.runChannel("语义", this.options.vector, query, limit),
    ]);
    if (!lexical && !vector) {
      // 词面通道是零依赖的，它挂了基本说明知识库目录不可读——这种时候不该假装“无结果”
      throw new Error("知识库检索失败：词面与语义通道都不可用");
    }

    const fused = new Map<string, FusedHit>();
    const accumulate = (hits: KnowledgeHit[], weight: number, channel: string): void => {
      hits.forEach((hit, index) => {
        // rank 从 1 起算，与 RRF 原式一致
        const contribution = weight / (k + index + 1);
        const existing = fused.get(hit.chunk.id);
        if (existing) {
          existing.score += contribution;
          existing.channels.add(channel);
          return;
        }
        fused.set(hit.chunk.id, {
          chunk: hit.chunk,
          score: contribution,
          channels: new Set([channel]),
        });
      });
    };
    // 权重按「实际可用的通道」累加，否则单路降级时归一化会把分数压到一半
    let maxPossible = 0;
    if (lexical) {
      accumulate(lexical, lexicalWeight, "词面");
      maxPossible += lexicalWeight / (k + 1);
    }
    if (vector) {
      accumulate(vector, vectorWeight, "语义");
      maxPossible += vectorWeight / (k + 1);
    }

    const ranked = [...fused.values()].sort((a, b) => b.score - a.score).slice(0, topK);
    // 首位来自哪一路，是调权重时最需要的信息
    const first = ranked[0];
    logger.info(
      `混合检索「${query}」: 词面 ${lexical?.length ?? 0} 条 / 语义 ${vector?.length ?? 0} 条` +
        ` → 融合 ${fused.size} 条` +
        (first ? `，首位来自 ${[...first.channels].join("+")}` : ""),
    );
    return ranked.map((item) => ({
      chunk: item.chunk,
      // 归一化成「融合分 / 理论满分」：两路都排第 1 得 1.0，只有一路排第 1 得 0.5，
      // 比裸 RRF 分（约 0.016）更好读，也与旧后端的 0~1 口径一致
      score: Math.min(1, item.score / (maxPossible || 1)),
    }));
  }

  /** 跑单路通道；失败只记警告并返回 undefined，让另一路顶上 */
  private async runChannel(
    label: string,
    base: KnowledgeBase,
    query: string,
    limit: number,
  ): Promise<KnowledgeHit[] | undefined> {
    try {
      return await base.search(query, limit);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warning(`${label}通道检索失败: ${reason}`);
      return undefined;
    }
  }
}
