/**
 * 向量知识库的索引逻辑测试。
 *
 * 关键设计：`VectorKnowledgeBase` 的 embedding 是构造注入的，所以这里塞一个
 * **确定性的假嵌入**，就能在完全不下载模型的前提下验证增量、删除、检索与持久化。
 * 语义召回质量不在这里测（那是模型的能力），端到端验证见设计文档。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { EmbeddingModel } from "../src/knowledge/embedding.js";
import { VectorKnowledgeBase } from "../src/knowledge/vector.js";

/** 把文本映射成定长向量：字符重叠越多向量越接近，够用来验证排序 */
function toVector(text: string, dims = 16): number[] {
  const vector = new Array<number>(dims).fill(0);
  for (const char of text) {
    const index = (char.codePointAt(0) ?? 0) % dims;
    vector[index] = (vector[index] ?? 0) + 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

/** 记录调用情况的假嵌入，用来断言「有没有重复嵌入」 */
class FakeEmbedding implements EmbeddingModel {
  calls = 0;
  embedded: string[] = [];

  async embed(texts: string[]): Promise<number[][]> {
    this.calls += 1;
    this.embedded.push(...texts);
    return texts.map((text) => toVector(text));
  }
}

const tempDirs: string[] = [];

/**
 * source 的形态是「根目录名/相对路径」（多目录时用来区分来源），
 * 测试里的知识库根目录叫 docs，所以片段来源都带这个前缀。
 */
const source = (name: string): string => `docs/${name}`;

async function makeWorkspace(): Promise<{ docs: string; db: string }> {
  const root = await mkdtemp(join(tmpdir(), "vec-kb-"));
  tempDirs.push(root);
  const docs = join(root, "docs");
  await mkdir(docs, { recursive: true });
  return { docs, db: join(root, "db") };
}

function build(docs: string, db: string, embedding: EmbeddingModel): VectorKnowledgeBase {
  return new VectorKnowledgeBase({ dirs: [docs], dbPath: db, embedding });
}

afterEach(async () => {
  // LanceDB 在 Windows 上会持有文件句柄，删不掉就留给系统清理，不让它影响断言
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})),
  );
});

describe("向量知识库索引", () => {
  it("首次同步会切分入库，docs 反映每个文件的片段数", async () => {
    const { docs, db } = await makeWorkspace();
    await writeFile(
      join(docs, "a.md"),
      "# 甲\n\n第一段内容。\n\n# 乙\n\n第二段内容。",
      "utf-8",
    );

    const kb = build(docs, db, new FakeEmbedding());
    const listed = await kb.docs();

    expect(listed).toHaveLength(1);
    expect(listed[0]!.source).toBe(source("a.md"));
    expect(listed[0]!.chunks).toBeGreaterThan(0);
  });

  it("文件未变更时不会重复嵌入内容（检索只额外嵌入查询本身）", async () => {
    const { docs, db } = await makeWorkspace();
    await writeFile(join(docs, "a.md"), "# 标题\n\n内容。", "utf-8");

    const embedding = new FakeEmbedding();
    const kb = build(docs, db, embedding);

    await kb.docs();
    const firstRound = embedding.embedded.length;

    // 连续多次检索：指纹未变，文件内容不该再被嵌入
    await kb.search("标题");
    await kb.search("内容");
    await kb.docs();

    // 后续新增的嵌入调用只应是查询文本本身
    expect(embedding.embedded.slice(firstRound)).toEqual(["标题", "内容"]);
  });

  it("改动一个文件只重嵌入该文件", async () => {
    const { docs, db } = await makeWorkspace();
    await writeFile(join(docs, "a.md"), "# 甲\n\n内容甲。", "utf-8");
    await writeFile(join(docs, "b.md"), "# 乙\n\n内容乙。", "utf-8");

    const embedding = new FakeEmbedding();
    const kb = build(docs, db, embedding);
    await kb.docs();

    // 只改 a.md（mtime 必须变化，Windows 时间精度下要等一下）
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(join(docs, "a.md"), "# 甲改\n\n内容甲已更改。", "utf-8");

    embedding.embedded = [];
    await kb.docs();

    const touched = [...new Set(embedding.embedded.map((text) => text.split("\n")[0]))];
    expect(touched.some((text) => text?.includes("甲改"))).toBe(true);
    expect(touched.some((text) => text?.includes("乙"))).toBe(false);
  });

  it("文件被删除后它的片段也消失", async () => {
    const { docs, db } = await makeWorkspace();
    await writeFile(join(docs, "a.md"), "# 甲\n\n内容。", "utf-8");
    const bPath = join(docs, "b.md");
    await writeFile(bPath, "# 乙\n\n内容。", "utf-8");

    const kb = build(docs, db, new FakeEmbedding());
    expect((await kb.docs()).map((item) => item.source).sort()).toEqual([
      source("a.md"),
      source("b.md"),
    ]);

    await rm(bPath);
    const after = await kb.docs();

    expect(after.map((item) => item.source)).toEqual([source("a.md")]);
  });

  it("检索返回命中片段，且带来源与标题", async () => {
    const { docs, db } = await makeWorkspace();
    await writeFile(
      join(docs, "security.md"),
      "# 安全基线\n\n## 密钥轮换\n\n生产环境的 API 密钥每 90 天轮换一次。",
      "utf-8",
    );
    await writeFile(join(docs, "other.md"), "# 其它\n\n完全无关的内容在此。", "utf-8");

    const kb = build(docs, db, new FakeEmbedding());
    const hits = await kb.search("密钥轮换", 2);

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.chunk.source).toBe(source("security.md"));
    expect(hits[0]!.chunk.text).toContain("90 天");
    expect(hits[0]!.score).toBeGreaterThan(0);
  });

  it("数据持久化：新实例无需重新嵌入即可检索", async () => {
    const { docs, db } = await makeWorkspace();
    await writeFile(join(docs, "a.md"), "# 标题\n\n持久化内容。", "utf-8");

    await build(docs, db, new FakeEmbedding()).docs();

    // 换一个实例、换一个嵌入实现，模拟进程重启
    const reopenedEmbedding = new FakeEmbedding();
    const reopened = build(docs, db, reopenedEmbedding);
    const listed = await reopened.docs();

    expect(listed).toHaveLength(1);
    // 指纹一致，不该触发任何嵌入
    expect(reopenedEmbedding.calls).toBe(0);

    const hits = await reopened.search("持久化", 1);
    expect(hits[0]!.chunk.source).toBe(source("a.md"));
  });

  it("空查询与空目录都返回空结果而不报错", async () => {
    const { docs, db } = await makeWorkspace();
    const kb = build(docs, db, new FakeEmbedding());

    expect(await kb.search("")).toEqual([]);
    expect(await kb.docs()).toEqual([]);
  });
});

describe("容量治理：对账与重建", () => {
  it("对账报告一致状态：无待嵌入、无多余行", async () => {
    const { docs, db } = await makeWorkspace();
    await writeFile(join(docs, "a.md"), "# 甲\n\n内容。", "utf-8");
    await writeFile(join(docs, "b.md"), "# 乙\n\n内容。", "utf-8");

    const kb = build(docs, db, new FakeEmbedding());
    await kb.docs();
    // 同步过一次之后才对账，避免把「还没建索引」算成漂移
    const report = await kb.verify();

    expect(report.diskFiles).toBe(2);
    expect(report.indexedFiles).toBe(2);
    expect(report.chunks).toBeGreaterThan(0);
    expect(report.pending).toEqual([]);
    expect(report.orphans).toEqual([]);
  });

  it("对账能查出「磁盘已改但索引没跟上」与「索引里多出来的行」", async () => {
    const { docs, db } = await makeWorkspace();
    const bPath = join(docs, "b.md");
    await writeFile(join(docs, "a.md"), "# 甲\n\n内容。", "utf-8");
    await writeFile(bPath, "# 乙\n\n内容。", "utf-8");

    const kb = build(docs, db, new FakeEmbedding());
    await kb.docs();

    // 1. 改一个文件（mtime 变）2. 删一个文件 —— verify 不该自己同步，只报告
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(join(docs, "a.md"), "# 甲改\n\n改过了。", "utf-8");
    await rm(bPath);

    const report = await kb.verify();
    expect(report.diskFiles).toBe(1);
    expect(report.pending).toEqual([source("a.md")]);
    expect(report.orphans).toEqual([source("b.md")]);

    // 报告完仍然没动索引：再查一次结果一致
    const again = await kb.verify();
    expect(again.pending).toEqual([source("a.md")]);
  });

  it("重建会丢掉旧表并按磁盘现状重新嵌入", async () => {
    const { docs, db } = await makeWorkspace();
    await writeFile(join(docs, "a.md"), "# 甲\n\n内容。", "utf-8");

    const embedding = new FakeEmbedding();
    const kb = build(docs, db, embedding);
    await kb.docs();
    const beforeRebuild = embedding.calls;

    embedding.embedded = [];
    const result = await kb.rebuild();

    expect(result.files).toBe(1);
    expect(result.chunks).toBeGreaterThan(0);
    // 重建必须真的重新嵌入过（而不是因为指纹没变被跳过）
    expect(embedding.calls).toBeGreaterThan(beforeRebuild);
    expect(embedding.embedded.some((text) => text.includes("甲"))).toBe(true);

    // 重建后索引与磁盘一致
    const report = await kb.verify();
    expect(report.pending).toEqual([]);
    expect(report.orphans).toEqual([]);
  });

  it("重建后剩下的文件生效，被删掉的文件不再出现在索引里", async () => {
    const { docs, db } = await makeWorkspace();
    await writeFile(join(docs, "a.md"), "# 甲\n\n内容。", "utf-8");
    const bPath = join(docs, "b.md");
    await writeFile(bPath, "# 乙\n\n内容。", "utf-8");

    const kb = build(docs, db, new FakeEmbedding());
    await kb.docs();
    await rm(bPath);

    await kb.rebuild();
    const listed = await kb.docs();

    expect(listed.map((item) => item.source)).toEqual([source("a.md")]);
  });
});
