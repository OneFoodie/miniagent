#!/usr/bin/env node
/**
 * 评测入口。
 *
 * 用法::
 *
 *     npm run eval                              # 跑全部用例（会真实调用 DeepSeek）
 *     npm run eval -- --limit 2                 # 冒烟：只跑前两条
 *     npm run eval -- --judge                   # 追加 LLM 裁判（结果按问答缓存）
 *     npm run eval -- --cases eval/cases/x.json --out eval_reports/x.json
 *
 * 设计取舍：**不挂长期记忆**。长期记忆是有状态的，会把上一轮的召回结果带进下一轮，
 * 同一条用例两次跑出不同结果，回归比对就失去意义。技能与知识库保留，
 * 因为它们的输入（skills/ 与 knowledgeDirs）是仓库里的静态内容，可复现。
 *
 * 有用例未通过时以非零码退出，便于接进 CI。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { Agent } from "../src/agent/agent.js";
import { loadSettings } from "../src/core/config.js";
import type { EventBus } from "../src/core/events.js";
import { setupLogging } from "../src/core/logging.js";
import { createLlmJudge, loadSuite, runEval, type EvalCaseResult, type EvalReport } from "../src/eval/index.js";
import { createKnowledgeBase, registerKnowledgeTools } from "../src/knowledge/index.js";
import { OpenAICompatibleClient } from "../src/llm/openai.js";
import { registerSkillTools, SkillRegistry } from "../src/skills/index.js";
import { registerBuiltins } from "../src/tools/builtins/index.js";
import {
  childRegistryOf,
  registerSubagent,
} from "../src/tools/builtins/subagent.js";
import { ToolRegistry } from "../src/tools/registry.js";

const DEFAULT_CASES = "eval/cases/basic.json";
const REPORT_DIR = "eval_reports";
const JUDGE_CACHE = `${REPORT_DIR}/judge-cache.json`;

async function main(): Promise<void> {
  setupLogging(process.env.MINIAGENT_LOG_LEVEL ?? "WARNING");

  const args = parseArgs(process.argv.slice(2));
  const settings = loadSettings();

  if (!settings.apiKey) {
    throw new Error(
      `未配置 MINIAGENT_API_KEY（provider=${settings.provider}），评测需要真实调用模型`,
    );
  }

  const suite = await loadSuite(args.cases);
  const llm = new OpenAICompatibleClient(settings);

  // 工具集与 server 保持一致（内置 + 技能元工具 + 知识库检索）
  const registry = new ToolRegistry();
  await registerBuiltins(registry, settings);
  registerSkillTools(registry, await SkillRegistry.load(settings.skillsDir));
  registerKnowledgeTools(registry, createKnowledgeBase(settings));
  // 子 agent 必须最后注册：它的子工具集是「除自己以外的全部工具」
  registerSubagent(registry, {
    llm,
    settings,
    childRegistry: (role) => childRegistryOf(registry, role),
  });

  const report = await runEval({
    suite,
    model: settings.model,
    createAgent: (bus: EventBus, maxIterations: number) =>
      new Agent(llm, registry, { ...settings, maxIterations }, bus),
    judge: args.judge
      ? createLlmJudge(llm, { threshold: args.judgeThreshold, cachePath: JUDGE_CACHE })
      : undefined,
    judgeThreshold: args.judgeThreshold,
    limit: args.limit,
    onCaseStart: (testCase, index, total) => {
      process.stdout.write(`[${index}/${total}] ${testCase.id} … `);
    },
    onCaseDone: (result) => {
      process.stdout.write(result.passed ? "通过\n" : `未通过（${describe(result)}）\n`);
    },
  });

  const reportPath = resolve(args.out ?? defaultReportPath(report));
  await mkdir(resolve(REPORT_DIR), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");

  printSummary(report, reportPath);
  if (report.totals.passed < report.totals.cases) {
    process.exitCode = 1;
  }
}

interface Args {
  cases: string;
  out?: string;
  judge: boolean;
  judgeThreshold?: number;
  limit?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { cases: DEFAULT_CASES, judge: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--judge") {
      args.judge = true;
    } else if (arg === "--cases") {
      args.cases = argv[++i] ?? args.cases;
    } else if (arg === "--out") {
      args.out = argv[++i];
    } else if (arg === "--limit") {
      args.limit = Number(argv[++i]);
    } else if (arg === "--judge-threshold") {
      args.judgeThreshold = Number(argv[++i]);
    }
  }
  return args;
}

function defaultReportPath(report: EvalReport): string {
  const stamp = report.startedAt.replace(/[:.]/g, "-");
  return `${REPORT_DIR}/${report.suite}-${stamp}.json`;
}

function describe(result: EvalCaseResult): string {
  const reasons = [...result.rule.reasons];
  if (result.llm && result.llm.score < 7) reasons.push(`LLM 裁判 ${result.llm.score}/10`);
  return reasons.join("；") || "未知原因";
}

function printSummary(report: EvalReport, reportPath: string): void {
  const { totals } = report;
  const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;
  process.stdout.write(
    [
      "",
      `套件: ${report.suite}  模型: ${report.model}`,
      `用例: ${totals.cases}  通过: ${totals.passed}  成功率: ${percent(totals.successRate)}`,
      `工具正确率: ${percent(totals.toolAccuracy)}`,
      `平均 token: prompt ${totals.avgPromptTokens} / completion ${totals.avgCompletionTokens}`,
      `平均迭代: ${totals.avgIterations}  时延 p50 ${totals.p50Latency}s / p95 ${totals.p95Latency}s`,
      `耗时: ${report.durationSec}s`,
      `报告: ${reportPath}`,
      "",
    ].join("\n"),
  );
}

await main();
