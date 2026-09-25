/**
 * 两类裁判。
 *
 * 规则裁判：确定性、零成本，判「答案里有没有该有的、有没有不该有的、该调的工具调了没」。
 * 这是主力——它可复现、可单测，回归时能精确指出是哪一条期望没满足。
 *
 * LLM 裁判：判规则裁判描述不了的东西（措辞不同但意思对、答得完不完整）。
 * 成本高，所以默认不启用，且结果按问答内容缓存，重复评测不重复花钱。
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { BaseLLM } from "../llm/base.js";
import type {
  CaseObservations,
  EvalCase,
  Judge,
  JudgeVerdict,
  LlmVerdict,
} from "./types.js";

/** 规则裁判：任何一条期望不满足即判失败，reasons 里逐条说明 */
export function ruleJudge(testCase: EvalCase, observations: CaseObservations): JudgeVerdict {
  const reasons: string[] = [];

  if (observations.error) {
    reasons.push(`执行失败: ${observations.error}`);
  }
  for (const keyword of testCase.expect?.mustInclude ?? []) {
    if (!observations.answer.includes(keyword)) {
      reasons.push(`答案缺少必需内容「${keyword}」`);
    }
  }
  for (const keyword of testCase.expect?.mustNotInclude ?? []) {
    if (observations.answer.includes(keyword)) {
      reasons.push(`答案出现了禁止内容「${keyword}」`);
    }
  }
  for (const tool of testCase.expect?.tools ?? []) {
    if (!observations.tools.includes(tool)) {
      reasons.push(`未调用期望的工具「${tool}」`);
    }
  }

  return { pass: reasons.length === 0, reasons };
}

export interface LlmJudgeOptions {
  /** 及格分（0-10），默认 7 */
  threshold?: number;
  /** 缓存文件路径；不传则只用进程内缓存 */
  cachePath?: string;
}

/**
 * 造一个 LLM 裁判。
 * 缓存 key 是「问题 + 答案」的哈希——同一问答重复评测时直接复用上次打分，
 * 避免每次回归都把 API 费用重花一遍。
 */
export function createLlmJudge(llm: BaseLLM, options: LlmJudgeOptions = {}): Judge {
  const cache = new Map<string, LlmVerdict>();
  let loaded = false;

  return async (testCase, observations) => {
    const key = hash(`${testCase.question}\n${observations.answer}`);

    if (!loaded) {
      loaded = true;
      await loadCache(options.cachePath, cache);
    }
    const hit = cache.get(key);
    if (hit) return { ...hit, cached: true };

    const verdict = await askJudge(llm, testCase, observations);
    cache.set(key, verdict);
    await saveCache(options.cachePath, cache);
    return { ...verdict, cached: false };
  };
}

async function askJudge(
  llm: BaseLLM,
  testCase: EvalCase,
  observations: CaseObservations,
): Promise<LlmVerdict> {
  const sections = [
    "你在给一个 Agent 的回答打分。",
    `问题：${testCase.question}`,
  ];
  const hints = testCase.expect?.mustInclude ?? [];
  if (hints.length > 0) sections.push(`答案应当覆盖：${hints.join("、")}`);
  if (testCase.judgeNote) sections.push(`额外要求：${testCase.judgeNote}`);
  sections.push(
    `Agent 的回答：${observations.answer}`,
    '判断这个回答是否正确、完整地回应了问题（措辞可以不同，只看事实与意图是否到位）。',
    '只输出一行 JSON，不要包裹代码块：{"score": 0 到 10 的整数, "comment": "一句话理由"}',
  );

  try {
    const response = await llm.chat([{ role: "user", content: sections.join("\n\n") }], []);
    return parseVerdict(response.content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { score: 0, comment: `裁判调用失败: ${message}`, cached: false };
  }
}

/** 从模型输出里抠出 JSON；抠不到就判 0 分并说明，避免评测因裁判格式问题整体崩掉 */
export function parseVerdict(content: string): LlmVerdict {
  const match = /\{[\s\S]*\}/.exec(content);
  if (!match) {
    return { score: 0, comment: `裁判输出无法解析: ${content.slice(0, 80)}`, cached: false };
  }
  try {
    const parsed = JSON.parse(match[0]) as { score?: unknown; comment?: unknown };
    const score = Number(parsed.score);
    if (!Number.isFinite(score)) {
      return { score: 0, comment: "裁判未给出数值分数", cached: false };
    }
    return {
      score: Math.max(0, Math.min(10, Math.round(score))),
      comment: typeof parsed.comment === "string" ? parsed.comment : "",
      cached: false,
    };
  } catch {
    return { score: 0, comment: `裁判输出不是合法 JSON: ${match[0].slice(0, 80)}`, cached: false };
  }
}

function hash(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

async function loadCache(
  cachePath: string | undefined,
  cache: Map<string, LlmVerdict>,
): Promise<void> {
  if (!cachePath) return;
  try {
    const raw = await readFile(cachePath, "utf-8");
    const stored = JSON.parse(raw) as Record<string, { score: number; comment: string }>;
    for (const [key, value] of Object.entries(stored)) {
      cache.set(key, { ...value, cached: true });
    }
  } catch {
    // 缓存不存在或损坏 → 当作空缓存，重新打分即可
  }
}

async function saveCache(
  cachePath: string | undefined,
  cache: Map<string, LlmVerdict>,
): Promise<void> {
  if (!cachePath) return;
  try {
    await mkdir(dirname(cachePath), { recursive: true });
    const plain: Record<string, { score: number; comment: string }> = {};
    for (const [key, value] of cache) {
      plain[key] = { score: value.score, comment: value.comment };
    }
    await writeFile(cachePath, JSON.stringify(plain, null, 2), "utf-8");
  } catch {
    // 缓存写不进去不影响评测本身
  }
}
