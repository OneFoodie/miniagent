/** 生命周期记忆：切词、TF-IDF 召回、置信度、矛盾消解、遗忘曲线、四信号排序。 */

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadSettings, type Settings } from "../src/core/config.js";
import {
  baseTokens,
  composeScore,
  createLongTermMemory,
  decayedConfidence,
  describeLongTermMemory,
  inferKind,
  hasContradictionCue,
  LifecycleMemory,
  recencyScore,
  resolveMemoryBackend,
  SIGNAL_WEIGHTS,
  TfidfIndex,
  tokenize,
} from "../src/memory/index.js";
import type { StoredMemory } from "../src/memory/lifecycle.js";

const DAY = 86400;
const NOW = 1_700_000_000;

async function makeMemory(): Promise<LifecycleMemory> {
  const dir = await mkdtemp(join(tmpdir(), "miniagent-lifecycle-"));
  return new LifecycleMemory({ filePath: join(dir, "lifecycle.jsonl") });
}

/** 从 load() 的 meta 里取出置信度，便于断言 */
function confidenceOf(record: { meta?: Record<string, unknown> }): number {
  return Number(record.meta?.confidence ?? 0);
}

describe("tokenize 中英混排切词", () => {
  it("拉丁与数字按词切", () => {
    expect(tokenize("Hello Rust 2026")).toEqual(["hello", "rust", "2026"]);
  });

  it("中文切成单字 + 相邻双字（中文没有空格，这是关键）", () => {
    const tokens = tokenize("量子计算");
    expect(tokens).toContain("量");
    expect(tokens).toContain("量子");
    expect(tokens).toContain("子计");
    expect(tokens).toContain("计算");
  });

  it("标点被当作分隔符", () => {
    expect(tokenize("a,b")).toEqual(["a", "b"]);
  });
});

describe("baseTokens 基础 token", () => {
  it("丢掉相邻双字，保留中文单字与拉丁词", () => {
    const base = baseTokens(tokenize("用户喜欢 Rust"));

    expect(base.has("用")).toBe(true);
    // 「户喜」是相邻双字，比较"内容有没有变"时它会添乱，必须丢掉
    expect(base.has("户喜")).toBe(false);
    expect(base.has("rust")).toBe(true);
  });

  it("数字串整体保留——这是识别「改了值」的关键", () => {
    const base = baseTokens(tokenize("代号 ZTX-9917"));
    expect(base.has("ztx")).toBe(true);
    expect(base.has("9917")).toBe(true);
  });
});

describe("TfidfIndex 语义相似度", () => {
  const documents = [
    tokenize("用户对量子计算感兴趣"),
    tokenize("今天天气不错"),
    tokenize("用户喜欢 Rust 语言"),
  ];
  const index = new TfidfIndex(documents);
  const vectorOf = (text: string): Map<string, number> => index.vector(tokenize(text));

  it("语义接近的文本相似度明显更高", () => {
    const query = vectorOf("量子计算的进展");
    const related = TfidfIndex.cosine(query, vectorOf("用户对量子计算感兴趣"));
    const unrelated = TfidfIndex.cosine(query, vectorOf("今天天气不错"));

    expect(related).toBeGreaterThan(0.2);
    expect(unrelated).toBe(0);
  });

  it("修掉了旧实现的中文召回死角：部分重叠也能命中", () => {
    // 旧实现把整句当一个词，要求 includes 精确子串，这里必然为 0
    const similarity = TfidfIndex.cosine(
      vectorOf("量子计算的进展如何"),
      vectorOf("量子计算"),
    );
    expect(similarity).toBeGreaterThan(0);
  });

  it("向量已 L2 归一化，自相似为 1", () => {
    const vector = vectorOf("量子计算");
    expect(TfidfIndex.cosine(vector, vector)).toBeCloseTo(1, 6);
  });
});

describe("scoring 纯函数", () => {
  it("四信号权重之和为 1", () => {
    const total =
      SIGNAL_WEIGHTS.semantic +
      SIGNAL_WEIGHTS.recency +
      SIGNAL_WEIGHTS.confidence +
      SIGNAL_WEIGHTS.priority;
    expect(total).toBeCloseTo(1, 10);
  });

  it("composeScore 就是四信号加权和", () => {
    const score = composeScore({
      semantic: 0.8,
      recency: 0.5,
      confidence: 0.6,
      priority: 0.4,
    });
    expect(score).toBeCloseTo(
      0.5 * 0.8 + 0.2 * 0.5 + 0.15 * 0.6 + 0.15 * 0.4,
      10,
    );
  });

  it("置信度随天数指数衰减，且易失类型衰减更快", () => {
    const fresh = decayedConfidence(0.6, NOW, "fact", NOW);
    const monthOld = decayedConfidence(0.6, NOW, "fact", NOW + 30 * DAY);
    expect(fresh).toBeCloseTo(0.6, 6);
    expect(monthOld).toBeLessThan(fresh);

    const contextOld = decayedConfidence(0.6, NOW, "context", NOW + 30 * DAY);
    expect(contextOld).toBeLessThan(monthOld);
  });

  it("衰减是幂等的：同一天问两次得到同一个值", () => {
    const once = decayedConfidence(0.6, NOW, "fact", NOW + 10 * DAY);
    const twice = decayedConfidence(0.6, NOW, "fact", NOW + 10 * DAY);
    expect(twice).toBe(once);
  });

  it("时效分 30 天正好减半", () => {
    expect(recencyScore(NOW, NOW)).toBeCloseTo(1, 6);
    expect(recencyScore(NOW, NOW + 30 * DAY)).toBeCloseTo(0.5, 6);
  });

  it("能识别推翻词与记忆类型", () => {
    expect(hasContradictionCue("我不再喜欢咖啡了")).toBe(true);
    expect(hasContradictionCue("用户喜欢咖啡")).toBe(false);

    expect(inferKind("用户喜欢简洁的回答")).toBe("preference");
    expect(inferKind("记住下次提醒我交周报")).toBe("todo");
    expect(inferKind("以后必须用中文回复")).toBe("instruction");
    expect(inferKind("项目使用 PostgreSQL")).toBe("fact");
  });
});

describe("LifecycleMemory", () => {
  it("写入后可被召回，且带出评分元数据", async () => {
    const memory = await makeMemory();
    await memory.add({ text: "用户对量子计算感兴趣", ts: NOW });

    const hits = await memory.search("量子计算的进展", 3);

    expect(hits).toHaveLength(1);
    expect(hits[0]!.text).toBe("用户对量子计算感兴趣");
    expect(hits[0]!.meta?.kind).toBe("fact");
    expect(Number(hits[0]!.meta?.score)).toBeGreaterThan(0);
  });

  it("召回即强化：置信度提升且访问次数累加", async () => {
    const memory = await makeMemory();
    // 必须用真实当前时间：search 按 Date.now() 计算衰减
    const now = Date.now() / 1000;
    await memory.add({ text: "用户喜欢 Rust", ts: now });
    expect(confidenceOf((await memory.load())[0]!)).toBeCloseTo(0.6, 6);

    const hits = await memory.search("Rust", 1);

    // 0.6 未被衰减 + 0.1 召回加成
    expect(confidenceOf(hits[0]!)).toBeCloseTo(0.7, 3);
    expect((await memory.load())[0]!.meta?.accessCount).toBe(1);
  });

  it("长期未用会因遗忘曲线而置信度下降", async () => {
    const memory = await makeMemory();
    const now = Date.now() / 1000;
    await memory.add({ text: "很久以前记下的事实内容", ts: now - 100 * DAY });

    const hits = await memory.search("很久以前记下的事实内容", 1);

    // 0.6 * e^(-0.015 * 100) ≈ 0.134，再加 0.1 召回加成
    expect(confidenceOf(hits[0]!)).toBeLessThan(0.4);
  });

  it("重复写入只强化旧记忆，不产生第二条", async () => {
    const memory = await makeMemory();
    await memory.add({ text: "用户偏好简洁的技术回答", ts: NOW });
    await memory.add({ text: "用户偏好简洁的技术回答", ts: NOW });

    const all = await memory.load();
    expect(all).toHaveLength(1);
    expect(confidenceOf(all[0]!)).toBeCloseTo(0.7, 3);
  });

  it("矛盾消解：新说法取代旧说法，旧记忆不再被召回", async () => {
    const memory = await makeMemory();
    await memory.add({ text: "用户喜欢咖啡", ts: NOW });
    await memory.add({ text: "用户不再喜欢咖啡了", ts: NOW });

    const all = await memory.load();
    expect(all).toHaveLength(1);
    expect(all[0]!.text).toBe("用户不再喜欢咖啡了");

    const hits = await memory.search("用户喜欢咖啡", 5);
    expect(hits.map((hit) => hit.text)).toEqual(["用户不再喜欢咖啡了"]);
  });

  it("无关内容不会被误判为矛盾", async () => {
    const memory = await makeMemory();
    await memory.add({ text: "用户喜欢咖啡", ts: NOW });
    await memory.add({ text: "项目部署在阿里云上", ts: NOW });

    expect(await memory.load()).toHaveLength(2);
  });

  it("直接改口、没有推翻词，也要让旧值失效（不能当重复丢掉）", async () => {
    const memory = await makeMemory();
    await memory.add({ text: "本项目的向量库代号是 ZTX-9917", ts: NOW });
    await memory.add({ text: "本项目的向量库代号是 ZTX-8800", ts: NOW });

    // 关键：新值必须真的写进去，旧值必须失效，不能两条并存
    const all = await memory.load();
    expect(all).toHaveLength(1);
    expect(all[0]!.text).toContain("ZTX-8800");
    expect((await memory.search("向量库代号", 5))[0]!.text).toContain("ZTX-8800");
  });

  it("补充信息时判为重复，但用更全的文本刷新旧记录", async () => {
    const memory = await makeMemory();
    await memory.add({ text: "项目部署在北京", ts: NOW });
    await memory.add({ text: "项目部署在北京和上海", ts: NOW });

    const all = await memory.load();
    expect(all).toHaveLength(1);
    // 旧信息一个没少 → 判重复；但新的更全 → 文本要刷新，否则丢掉"和上海"
    expect(all[0]!.text).toBe("项目部署在北京和上海");
  });

  it("新说法信息更少时，保留更完整的旧文本", async () => {
    const memory = await makeMemory();
    await memory.add({ text: "项目部署在北京和上海", ts: NOW });
    await memory.add({ text: "项目部署在北京", ts: NOW });

    const all = await memory.load();
    expect(all).toHaveLength(1);
    expect(all[0]!.text).toBe("项目部署在北京和上海");
  });

  it("结果按综合分降序，且零重叠的查询不返回任何结果", async () => {
    const memory = await makeMemory();
    await memory.add({ text: "用户对量子计算感兴趣", ts: NOW });
    await memory.add({ text: "用户对向量数据库感兴趣", ts: NOW });

    const hits = await memory.search("量子计算", 5);
    const scores = hits.map((hit) => Number(hit.meta?.score));
    expect(scores).toEqual([...scores].sort((a, b) => b - a));

    expect(await memory.search("完全无关的内容", 5)).toEqual([]);
  });

  it("跨实例持久化：新实例能读到旧数据与消解结果", async () => {
    const dir = await mkdtemp(join(tmpdir(), "miniagent-lifecycle-"));
    const filePath = join(dir, "lifecycle.jsonl");

    const first = new LifecycleMemory({ filePath });
    await first.add({ text: "用户喜欢咖啡", ts: NOW });
    await first.add({ text: "用户不再喜欢咖啡了", ts: NOW });

    const second = new LifecycleMemory({ filePath });
    const all = await second.load();
    expect(all).toHaveLength(1);
    expect(all[0]!.text).toBe("用户不再喜欢咖啡了");
  });

  it("空查询与空文本都不产生副作用", async () => {
    const memory = await makeMemory();
    await memory.add({ text: "   ", ts: NOW });
    expect(await memory.load()).toEqual([]);
    expect(await memory.search("   ")).toEqual([]);
  });

  it("meta 可显式指定类型与优先级（并写进落盘记录）", async () => {
    const memory = await makeMemory();
    await memory.add({
      text: "这段话里没有任何类型线索",
      ts: NOW,
      meta: { kind: "instruction", priority: 0.95 },
    });

    const [record] = await memory.load();
    expect(record!.meta?.kind).toBe("instruction");
    expect(Number(record!.meta?.priority)).toBeCloseTo(0.95, 6);
  });

  it("落盘文件是逐行 JSON，含生命周期字段", async () => {
    const dir = await mkdtemp(join(tmpdir(), "miniagent-lifecycle-"));
    const filePath = join(dir, "lifecycle.jsonl");
    const memory = new LifecycleMemory({ filePath });
    await memory.add({ text: "用户喜欢 Rust", ts: NOW });

    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(filePath, "utf-8");
    const stored = JSON.parse(raw.trim()) as StoredMemory;

    expect(stored.text).toBe("用户喜欢 Rust");
    expect(stored.kind).toBe("preference");
    expect(stored.confidence).toBeCloseTo(0.6, 6);
    expect(stored.accessCount).toBe(0);
    expect(typeof stored.id).toBe("string");
  });
});

describe("记忆后端选择", () => {
  /** 读取一份受控配置：临时覆盖相关环境变量，读完还原 */
  function buildSettings(overrides: Record<string, string> = {}): Settings {
    const keys = [
      "MINIAGENT_MEMORY_BACKEND",
      "MINIAGENT_MEMOS_API_KEY",
      "MINIAGENT_LIFECYCLE_MEMORY_FILE",
      "MINIAGENT_MEMORY_FILE",
    ];
    const snapshot = new Map(keys.map((key) => [key, process.env[key]]));

    for (const key of keys) delete process.env[key];
    for (const [key, value] of Object.entries(overrides)) process.env[key] = value;

    const settings = loadSettings();

    for (const [key, value] of snapshot) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return settings;
  }

  it("显式指定 lifecycle 时启用生命周期记忆", async () => {
    const settings = buildSettings({
      MINIAGENT_MEMORY_BACKEND: "lifecycle",
      MINIAGENT_LIFECYCLE_MEMORY_FILE: "./tmp/lifecycle.jsonl",
    });

    expect(resolveMemoryBackend(settings)).toBe("lifecycle");
    expect(createLongTermMemory(settings)).toBeInstanceOf(LifecycleMemory);
    expect(describeLongTermMemory(settings)).toContain("生命周期");
  });

  it("未配置时默认走 JSONL", () => {
    const settings = buildSettings();
    expect(resolveMemoryBackend(settings)).toBe("jsonl");
    expect(describeLongTermMemory(settings)).toContain("JSONL");
  });

  it("配了 memos 但没给 key 时降级到 JSONL", () => {
    const settings = buildSettings({ MINIAGENT_MEMORY_BACKEND: "memos" });
    expect(resolveMemoryBackend(settings)).toBe("jsonl");
  });

  it("未知后端名降级到 JSONL", () => {
    const settings = buildSettings({ MINIAGENT_MEMORY_BACKEND: "no-such-backend" });
    expect(resolveMemoryBackend(settings)).toBe("jsonl");
  });
});

describe("记忆巩固（consolidation）", () => {
  /** 一批互相低重合的事实：重合度过高会被去重逻辑合并，测不出巩固行为 */
  const FACTS = [
    "用户喜欢用 Rust 编写服务端程序",
    "项目部署在北京的机房",
    "团队每周三开需求评审会",
    "数据库选型倾向 PostgreSQL",
    "预算上限是三十万元",
    "发布窗口定在每月第一周",
    "监控使用 Prometheus 与 Grafana",
    "日志统一收集到对象存储",
  ];

  /** 造一个已灌入 n 条互不相同记忆的实例 */
  async function withMemories(
    n: number,
    options: {
      threshold: number;
      batch: number;
      summarize?: (texts: string[]) => Promise<string | undefined>;
    },
  ): Promise<LifecycleMemory> {
    const dir = await mkdtemp(join(tmpdir(), "miniagent-consolidate-"));
    const memory = new LifecycleMemory({
      filePath: join(dir, "lifecycle.jsonl"),
      consolidate: {
        threshold: options.threshold,
        batch: options.batch,
        maxChars: 400,
        summarize:
          options.summarize ?? (async (texts) => `归档摘要：${texts.length} 条`),
      },
    });
    for (let i = 0; i < n; i++) {
      await memory.add({ text: FACTS[i % FACTS.length]!, ts: NOW + i });
    }
    return memory;
  }

  it("未超过阈值时不触发压缩", async () => {
    let calls = 0;
    const memory = await withMemories(3, {
      threshold: 10,
      batch: 3,
      summarize: async () => {
        calls++;
        return "不该被调用";
      },
    });

    expect(calls).toBe(0);
    expect(await memory.load()).toHaveLength(3);
  });

  it("超过阈值时吸收最低分的一批，检索集回落到阈值以内并出现归档", async () => {
    const memory = await withMemories(6, { threshold: 3, batch: 2 });

    const active = await memory.load();
    expect(active.length).toBeLessThanOrEqual(3);
    expect(active.some((record) => record.text.startsWith("归档摘要"))).toBe(true);
  });

  it("被归档的原始记录留在文件里，标记 consolidatedInto", async () => {
    const dir = await mkdtemp(join(tmpdir(), "miniagent-consolidate-"));
    const filePath = join(dir, "lifecycle.jsonl");
    const memory = new LifecycleMemory({
      filePath,
      consolidate: {
        threshold: 2,
        batch: 2,
        maxChars: 400,
        summarize: async (texts) => `归档摘要：${texts.length} 条`,
      },
    });
    await memory.add({ text: "事实甲关于量子计算", ts: NOW });
    await memory.add({ text: "事实乙关于天气预报", ts: NOW });
    await memory.add({ text: "事实丙关于股票行情", ts: NOW });

    // 直接读文件：原记录必须还在，只是被标记
    const raw = await readFile(filePath, "utf-8");
    const records = raw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as StoredMemory);

    const consolidated = records.filter((record) => record.consolidatedInto);
    expect(consolidated).toHaveLength(2);
    // 标记指向真实存在的归档记录
    const archiveIds = new Set(records.map((record) => record.id));
    for (const record of consolidated) {
      expect(archiveIds.has(record.consolidatedInto!)).toBe(true);
    }
  });

  it("压缩失败时放弃巩固，原记录保持可检索", async () => {
    const memory = await withMemories(4, {
      threshold: 2,
      batch: 2,
      summarize: async () => {
        throw new Error("LLM 挂了");
      },
    });

    const active = await memory.load();
    expect(active).toHaveLength(4);
    expect(active.every((record) => !record.text.startsWith("归档摘要"))).toBe(true);
  });

  it("模型返回空值时同样放弃巩固", async () => {
    const memory = await withMemories(4, {
      threshold: 2,
      batch: 2,
      summarize: async () => undefined,
    });
    expect(await memory.load()).toHaveLength(4);
  });

  it("归档摘要可被检索到", async () => {
    const memory = await withMemories(5, { threshold: 2, batch: 3 });
    const hits = await memory.search("归档摘要", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.text).toContain("归档摘要");
  });
});
