/** 评测模块对外入口。 */

import { readFile } from "node:fs/promises";

import type { EvalSuite } from "./types.js";

export type {
  CaseObservations,
  EvalCase,
  EvalCaseResult,
  EvalReport,
  EvalSuite,
  Judge,
  JudgeVerdict,
  LlmVerdict,
} from "./types.js";
export { createLlmJudge, parseVerdict, ruleJudge, type LlmJudgeOptions } from "./judge.js";
export { runEval, summarise, type RunEvalOptions } from "./runner.js";

/** 读取用例文件；用例集指的是 JSON（不引入 YAML 解析依赖，保持零依赖） */
export async function loadSuite(path: string): Promise<EvalSuite> {
  const raw = await readFile(path, "utf-8");
  const suite = JSON.parse(raw) as EvalSuite;
  if (!Array.isArray(suite.cases) || suite.cases.length === 0) {
    throw new Error(`用例文件没有有效的 cases: ${path}`);
  }
  return suite;
}
