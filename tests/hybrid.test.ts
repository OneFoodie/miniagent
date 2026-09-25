/** 混合检索测试：RRF 融合、单路降级、权重与截断。 */

import { describe, expect, it } from "vitest";

import type { KnowledgeBase, KnowledgeHit } from "../src/knowledge/index.js";
import { HybridKnowledgeBase } from "../src/knowledge/index.js";

/** 造一个命中；id 是两路归并的依据 */
function hit(id: string, score = 1): KnowledgeHit {
  return {
    chunk: { id, source: `${id}.md`, heading: "", text: `正文 ${id}`, updatedAt: 0 },
    score,
  };
}

/** 可编排的假后端：固定返回脚本里的命中，并记录收到的 limit */
class FakeBase implements KnowledgeBase {
  readonly limits: number[] = [];
  readonly queries: string[] = [];

  constructor(private readonly script: KnowledgeHit[]) {}

  async docs(): Promise<Array<{ source: string; chunks: number }>> {
    return [{ source: "fake.md", chunks: this.script.length }];
  }

  async search(query: string, topK = 4): Promise<KnowledgeHit[]> {
    this.queries.push(query);
    this.limits.push(topK);
    return this.script.slice(0, topK);
  }
}

/** 总是失败的后端，用来验证降级 */
class BrokenBase implements KnowledgeBase {
  async docs(): Promise<Array<{ source: string; chunks: number }>> {
    return [];
  }

  async search(): Promise<KnowledgeHit[]> {
    throw new Error("嵌入模型未安装");
  }
}

function build(options: {
  lexical: KnowledgeBase;
  vector: KnowledgeBase;
  lexicalWeight?: number;
  vectorWeight?: number;
}) {
  return new HybridKnowledgeBase(options);
}

describe("HybridKnowledgeBase", () => {
  it("两路都排第一的片段拿到满分", async () => {
    const lexical = new FakeBase([hit("both"), hit("only-lexical")]);
    const vector = new FakeBase([hit("both"), hit("only-vector")]);

    const hits = await build({ lexical, vector }).search("随便问", 3);
    expect(hits[0]!.chunk.id).toBe("both");
    expect(hits[0]!.score).toBe(1);
    // 只在单路出现的片段，在该路排第 2 → 裸分 1/(k+2)，归一化后 = 61/124
    expect(hits.slice(1).map((item) => item.chunk.id).sort()).toEqual([
      "only-lexical",
      "only-vector",
    ]);
    expect(hits[1]!.score).toBeCloseTo(61 / 124, 10);
    expect(hits[2]!.score).toBeCloseTo(61 / 124, 10);
  });

  it("精确匹配的片段不会因语义近似而被挤出结果", async () => {
    // 词面通道认出代号，语义通道被“意思相近”的别的片段占据
    const lexical = new FakeBase([hit("X7-ALPHA"), hit("别的")]);
    const vector = new FakeBase([hit("语义相近但无关"), hit("另一个")]);

    const hits = await build({ lexical, vector }).search("X7-ALPHA 是什么", 3);
    const ids = hits.map((item) => item.chunk.id);
    expect(ids).toContain("X7-ALPHA");
    expect(ids).toContain("语义相近但无关");
    // 同分时先词面后语义，所以精确匹配排在语义近似之前
    expect(ids.indexOf("X7-ALPHA")).toBeLessThan(ids.indexOf("语义相近但无关"));
  });

  it("调大词面权重可以把精确匹配压过语义近似", async () => {
    const lexical = new FakeBase([hit("精确")]);
    const vector = new FakeBase([hit("近似")]);

    const hits = await build({ lexical, vector, lexicalWeight: 3 }).search("查询", 2);
    expect(hits[0]!.chunk.id).toBe("精确");
  });

  it("语义通道失败时降级为词面，且分数不被归一化压低", async () => {
    const lexical = new FakeBase([hit("a"), hit("b")]);
    const hits = await build({ lexical, vector: new BrokenBase() }).search("查询", 2);

    expect(hits.map((item) => item.chunk.id)).toEqual(["a", "b"]);
    // 只剩一路时它就是“理论满分”，排名第一仍是 1.0
    expect(hits[0]!.score).toBe(1);
  });

  it("两路都失败时抛错，而不是假装无结果", async () => {
    const hybrid = build({ lexical: new BrokenBase(), vector: new BrokenBase() });
    await expect(hybrid.search("查询")).rejects.toThrow("词面与语义通道都不可用");
  });

  it("按 topK 截断，并按 topK 的倍数取候选", async () => {
    const many = (prefix: string) =>
      new FakeBase(Array.from({ length: 50 }, (_, index) => hit(`${prefix}-${index}`)));
    const lexical = many("L");
    const vector = many("V");

    const hits = await build({ lexical, vector }).search("查询", 10);
    expect(hits).toHaveLength(10);
    // 候选必须比 topK 宽，否则两路几乎没有交集：10 * 5 = 50
    expect(lexical.limits).toEqual([50]);
    expect(vector.limits).toEqual([50]);
  });

  it("候选数有下限，topK 很小时也留出融合空间", async () => {
    const lexical = new FakeBase([hit("a")]);
    const vector = new FakeBase([hit("b")]);
    // 2 * 5 = 10 < 20，取下限
    await build({ lexical, vector }).search("查询", 2);
    expect(lexical.limits).toEqual([20]);
    expect(vector.limits).toEqual([20]);
  });

  it("docs() 委托给词面通道（不触发嵌入模型加载）", async () => {
    const lexical = new FakeBase([hit("a")]);
    const hybrid = build({ lexical, vector: new BrokenBase() });
    expect(await hybrid.docs()).toEqual([{ source: "fake.md", chunks: 1 }]);
  });

  it("两路收到同一个查询", async () => {
    const lexical = new FakeBase([]);
    const vector = new FakeBase([]);
    await build({ lexical, vector }).search("统一查询");
    expect(lexical.queries).toEqual(["统一查询"]);
    expect(vector.queries).toEqual(["统一查询"]);
  });
});
