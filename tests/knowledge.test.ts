/** 知识库：文档切分、多目录扫描、白名单、热更新、词面检索、search_knowledge 工具、可选依赖。 */

import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadSettings } from "../src/core/config.js";
import {
  chunkDocument,
  createKnowledgeBase,
  LexicalKnowledgeBase,
  lengthPenalty,
  registerKnowledgeTools,
  scanFiles,
} from "../src/knowledge/index.js";
import {
  explainMissingOptionalDependency,
  isMissingModule,
} from "../src/knowledge/optionalDeps.js";
import { ToolRegistry } from "../src/tools/registry.js";

/** 造一个知识库目录；文件名可含子目录，如 "sub/a.md" */
async function makeDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "miniagent-knowledge-"));
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf-8");
  }
  return dir;
}

/** source 形如 `<根目录名>/<相对路径>`，断言时只看相对路径部分 */
function leaf(source: string): string {
  return source.slice(source.indexOf("/") + 1);
}

describe("chunkDocument 文档切分", () => {
  it("按 Markdown 标题切小节，并保留标题作为来源", () => {
    const chunks = chunkDocument("# 甲\n\n内容一\n\n## 乙\n\n内容二");
    expect(chunks.map((chunk) => chunk.heading)).toEqual(["甲", "乙"]);
    expect(chunks[0]!.text).toBe("内容一");
  });

  it("同一小节内的短段落合并成一块", () => {
    const chunks = chunkDocument("## 标题\n\n第一段\n\n第二段", { maxChars: 100 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toContain("第一段");
    expect(chunks[0]!.text).toContain("第二段");
  });

  it("单段超长时按长度硬切并保留重叠", () => {
    const chunks = chunkDocument(`## 标题\n\n${"甲".repeat(10)}`, {
      maxChars: 4,
      overlapChars: 2,
    });
    expect(chunks.length).toBeGreaterThan(1);
    // 相邻块共享重叠部分：第二块以第一块的末两字开头
    expect(chunks[1]!.text.startsWith(chunks[0]!.text.slice(-2))).toBe(true);
  });

  it("代码块里的 # 不当作标题", () => {
    const chunks = chunkDocument("## 代码\n\n```\n# 这是注释\n```");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.heading).toBe("代码");
  });

  it("没有标题的文档整篇作为无标题片段", () => {
    expect(chunkDocument("就是一段普通文字")).toEqual([
      { heading: "", text: "就是一段普通文字" },
    ]);
  });

  it("空白文档切不出任何片段", () => {
    expect(chunkDocument("\n\n   \n")).toEqual([]);
  });
});

describe("scanFiles 文件扫描", () => {
  it("返回相对路径、根目录名与修改时间", async () => {
    const dir = await makeDir({ "sub/a.md": "内容" });
    const files = await scanFiles([dir]);

    expect(files).toHaveLength(1);
    expect(files[0]!.relativePath).toBe("sub/a.md");
    expect(files[0]!.rootLabel).toBe(basename(dir));
    expect(files[0]!.mtimeMs).toBeGreaterThan(0);
  });

  it("目录不存在时返回空列表", async () => {
    expect(await scanFiles([join(tmpdir(), `missing-${Date.now()}`)])).toEqual([]);
  });
});

describe("LexicalKnowledgeBase 词面检索", () => {
  it("按小节切分后可检索到对应片段，并带来源与标题", async () => {
    const dir = await makeDir({
      "guide.md": "# 部署\n\n项目部署在包头机房。\n\n# 计费\n\n计费按分钟结算。",
    });
    const hits = await new LexicalKnowledgeBase({ dirs: [dir] }).search("计费怎么算", 3);

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.chunk.heading).toBe("计费");
    expect(leaf(hits[0]!.chunk.source)).toBe("guide.md");
  });

  it("小节标题也进检索语料", async () => {
    const dir = await makeDir({
      "a.md": "# 熔断降级\n\n正文与标题用词完全无关的说明文字。",
    });
    const hits = await new LexicalKnowledgeBase({ dirs: [dir] }).search("熔断降级", 3);
    expect(hits.length).toBeGreaterThan(0);
  });

  it("配置多个目录时两个来源都入库", async () => {
    const first = await makeDir({ "one.md": "内容来自第一个目录" });
    const second = await makeDir({ "two.md": "内容来自第二个目录" });

    const docs = await new LexicalKnowledgeBase({ dirs: [first, second] }).docs();
    expect(docs.map((doc) => doc.source).sort()).toEqual(
      [`${basename(first)}/one.md`, `${basename(second)}/two.md`].sort(),
    );
  });

  it("白名单：代码与数据文件入库，二进制后缀被忽略", async () => {
    const dir = await makeDir({
      "a.py": "print('hello')",
      "b.json": '{"k":"v"}',
      "c.exe": "binary",
      "d.pdf": "binary",
    });
    const docs = await new LexicalKnowledgeBase({ dirs: [dir] }).docs();
    expect(docs.map((doc) => leaf(doc.source)).sort()).toEqual(["a.py", "b.json"]);
  });

  it("跳过 node_modules 等目录", async () => {
    const dir = await makeDir({
      "a.md": "正常内容",
      "node_modules/pkg/readme.md": "不该入库",
    });
    const docs = await new LexicalKnowledgeBase({ dirs: [dir] }).docs();
    expect(docs).toHaveLength(1);
    expect(leaf(docs[0]!.source)).toBe("a.md");
  });

  it("空白查询返回空结果", async () => {
    const dir = await makeDir({ "a.md": "内容" });
    expect(await new LexicalKnowledgeBase({ dirs: [dir] }).search("   ")).toEqual([]);
  });

  it("工厂按配置指向知识库目录", async () => {
    const dir = await makeDir({ "a.md": "内容" });
    const kb = createKnowledgeBase({ ...loadSettings(), knowledgeDirs: [dir] });
    expect((await kb.docs()).map((doc) => leaf(doc.source))).toEqual(["a.md"]);
  });
});

describe("热更新", () => {
  it("新增文档后无需重建实例即可检索到", async () => {
    const dir = await makeDir({ "a.md": "# 甲\n\n这里是甲的内容" });
    const kb = new LexicalKnowledgeBase({ dirs: [dir] });
    // 用与现有文档毫无交集的词，确保"未命中"是真的未命中
    expect(await kb.search("量子纠缠退相干")).toEqual([]);

    await writeFile(join(dir, "b.md"), "# 乙\n\n量子纠缠退相干实验记录", "utf-8");
    const hits = await kb.search("量子纠缠退相干");
    expect(hits.length).toBeGreaterThan(0);
    expect(leaf(hits[0]!.chunk.source)).toBe("b.md");
  });

  it("删除文档后立即检索不到", async () => {
    const dir = await makeDir({ "a.md": "# 甲\n\n内容甲在这里" });
    const kb = new LexicalKnowledgeBase({ dirs: [dir] });
    expect((await kb.search("内容甲")).length).toBeGreaterThan(0);

    await unlink(join(dir, "a.md"));
    expect(await kb.search("内容甲")).toEqual([]);
  });

  it("文档内容改动后自动重建索引", async () => {
    const dir = await makeDir({ "a.md": "# 甲\n\n原来的说法" });
    const kb = new LexicalKnowledgeBase({ dirs: [dir] });
    expect((await kb.search("原来的说法")).length).toBeGreaterThan(0);

    const file = join(dir, "a.md");
    await writeFile(file, "# 甲\n\n换成全新的说法", "utf-8");
    // 显式把 mtime 推到未来，避免与上一次扫描落在同一毫秒而漏检
    const later = new Date(Date.now() + 5000);
    await utimes(file, later, later);

    const hits = await kb.search("全新的说法");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.chunk.text).toContain("全新的说法");
  });

  it("并发检索只重建一次索引，不产生重复片段", async () => {
    const dir = await makeDir({ "a.md": "# 甲\n\n内容甲在这里" });
    const kb = new LexicalKnowledgeBase({ dirs: [dir] });

    const results = await Promise.all([
      kb.search("内容甲"),
      kb.search("内容甲"),
      kb.search("内容甲"),
    ]);
    for (const hits of results) {
      expect(hits).toHaveLength(1);
    }
  });
});

describe("长度惩罚", () => {
  it("达到阈值不再惩罚，越短折扣越大", () => {
    expect(lengthPenalty(600)).toBe(1);
    expect(lengthPenalty(150)).toBe(1);
    expect(lengthPenalty(27)).toBeLessThan(0.4);
    expect(lengthPenalty(10)).toBeLessThan(lengthPenalty(100));
  });

  it("惩罚确实作用在检索路径上（原本完全命中会得到 1.0）", async () => {
    const dir = await makeDir({ "meta.md": "向量库代号" });
    const hits = await new LexicalKnowledgeBase({ dirs: [dir] }).search("向量库代号", 5);

    expect(hits.length).toBeGreaterThan(0);
    // 全文就是查询词，裸余弦为 1；惩罚后必须远低于 1
    expect(hits[0]!.score).toBeLessThan(0.3);
  });
});

describe("冲突可见性", () => {
  it("片段带上来源文件的修改时间", async () => {
    const dir = await makeDir({ "a.md": "# 甲\n\n内容甲" });
    const hits = await new LexicalKnowledgeBase({ dirs: [dir] }).search("内容甲", 3);

    expect(hits[0]!.chunk.updatedAt).toBeGreaterThan(0);
  });

  it("top_k 截断后，把同小节但来自别的文档的片段补回来", async () => {
    const dir = await makeDir({
      "a.md": "# 发布窗口\n\n正式发布只允许在每周二 14:00 之后进行。",
      "b.md": "# 发布窗口\n\n正式发布只允许在每周五 09:00 之后进行。",
    });
    const kb = new LexicalKnowledgeBase({ dirs: [dir] });

    // top_k = 1 只够装得分最高的那份；冲突的另一方必须被补进来，
    // 否则模型只看到一份记载，会毫无察觉地把它当作唯一事实
    const hits = await kb.search("正式发布 每周", 1);
    expect(new Set(hits.map((hit) => leaf(hit.chunk.source)))).toEqual(
      new Set(["a.md", "b.md"]),
    );
  });

  it("同一文档同一小节的后续分块不会被额外补入", async () => {
    const dir = await makeDir({
      "long.md": `# 大节\n\n${"甲".repeat(700)}\n\n${"乙".repeat(700)}`,
    });
    const hits = await new LexicalKnowledgeBase({ dirs: [dir] }).search("甲", 1);

    // 同源同标题只是内容延续，不算"另一份记载"
    expect(hits).toHaveLength(1);
  });

  it("工具返回里给出 updated_at 供判新旧", async () => {
    const dir = await makeDir({ "a.md": "# 甲\n\n内容甲" });
    const registry = new ToolRegistry();
    registerKnowledgeTools(registry, new LexicalKnowledgeBase({ dirs: [dir] }));

    const result = await registry.get("search_knowledge").run({ query: "内容甲" });
    const data = result.data as { hits: Array<{ updated_at: string }> };
    expect(data.hits[0]!.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("search_knowledge 工具", () => {
  function makeRegistry(dir: string): ToolRegistry {
    const registry = new ToolRegistry();
    registerKnowledgeTools(registry, new LexicalKnowledgeBase({ dirs: [dir] }));
    return registry;
  }

  it("返回命中片段与其来源、小节标题", async () => {
    const dir = await makeDir({ "guide.md": "# 计费\n\n按分钟结算。" });
    const result = await makeRegistry(dir)
      .get("search_knowledge")
      .run({ query: "计费" });

    expect(result.ok).toBe(true);
    const data = result.data as { hits: Array<{ source: string; heading: string }> };
    expect(leaf(data.hits[0]!.source)).toBe("guide.md");
    expect(data.hits[0]!.heading).toBe("计费");
  });

  it("声明了独立超时——首次检索要等索引同步完，不能被默认 30s 掐断", async () => {
    const dir = await makeDir({});
    // 工具运行时的默认超时是 30s；首次检索可能要先嵌入变更文件（分钟级）
    expect(makeRegistry(dir).get("search_knowledge").timeoutSeconds).toBeGreaterThan(30);
  });

  it("空库时返回 hint，引导模型改用别的工具", async () => {
    const dir = await makeDir({});
    const result = await makeRegistry(dir)
      .get("search_knowledge")
      .run({ query: "任意问题" });

    const data = result.data as { hits: unknown[]; hint: string };
    expect(data.hits).toEqual([]);
    expect(data.hint).toContain("知识库为空");
  });

  it("库非空但没命中时，hint 列出已有文档", async () => {
    const dir = await makeDir({ "guide.md": "# 计费\n\n按分钟结算。" });
    const result = await makeRegistry(dir)
      .get("search_knowledge")
      .run({ query: "量子纠缠退相干" });

    const data = result.data as { hits: unknown[]; hint: string };
    expect(data.hits).toEqual([]);
    expect(data.hint).toContain("guide.md");
  });

  it("top_k 超过上限时参数校验失败", async () => {
    const dir = await makeDir({ "a.md": "内容" });
    const result = await makeRegistry(dir)
      .get("search_knowledge")
      .run({ query: "内容", top_k: 99 });

    expect(result.ok).toBe(false);
  });
});

describe("可选依赖（语义后端的两个包）", () => {
  it("把「包没装」翻成两条可操作解法", () => {
    const missing = Object.assign(new Error("Cannot find package '@lancedb/lancedb'"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
    const explained = explainMissingOptionalDependency(
      missing,
      "@lancedb/lancedb",
      "语义检索（vector / hybrid 后端）",
    );

    expect(explained.message).toContain("@lancedb/lancedb");
    expect(explained.message).toContain("npm install");
    expect(explained.message).toContain("MINIAGENT_KNOWLEDGE_BACKEND=lexical");
    expect(explained.message).toContain("--omit=optional");
  });

  it("其它错误原样返回，不把真实故障伪装成「你没装依赖」", () => {
    // 例如模型权重损坏、ONNX 初始化失败——这类问题装包解决不了，必须原样暴露
    const original = new Error("加载嵌入模型失败: 权重文件损坏");
    expect(
      explainMissingOptionalDependency(original, "@lancedb/lancedb", "语义检索"),
    ).toBe(original);
  });

  it("isMissingModule 只认模块解析错误", () => {
    expect(isMissingModule(Object.assign(new Error("x"), { code: "ERR_MODULE_NOT_FOUND" }))).toBe(
      true,
    );
    expect(isMissingModule(Object.assign(new Error("x"), { code: "MODULE_NOT_FOUND" }))).toBe(true);
    expect(isMissingModule(Object.assign(new Error("x"), { code: "EACCES" }))).toBe(false);
    expect(isMissingModule(new Error("x"))).toBe(false);
    expect(isMissingModule(undefined)).toBe(false);
  });

  it("package.json 把语义后端的依赖声明为 optional（防有人挪回 dependencies）", () => {
    // 这条断言防的是那台 1.8G 服务器上踩过的坑：放在 dependencies 里时，
    // onnxruntime 的 postinstall 下载失败会让整个 npm ci 失败，服务根本装不上。
    // 作为 optionalDependencies，安装失败只意味着「语义后端不可用」，词面后端照常。
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf-8");
    const pkg = JSON.parse(raw) as {
      dependencies: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };

    expect(pkg.optionalDependencies?.["@lancedb/lancedb"]).toBeTruthy();
    expect(pkg.optionalDependencies?.["@huggingface/transformers"]).toBeTruthy();
    expect(pkg.dependencies["@lancedb/lancedb"]).toBeUndefined();
    expect(pkg.dependencies["@huggingface/transformers"]).toBeUndefined();
    // 词面后端的核心依赖必须留在 dependencies：它要开箱即用
    expect(pkg.dependencies.zod).toBeTruthy();
    expect(pkg.dependencies["zod-to-json-schema"]).toBeTruthy();
  });
});
