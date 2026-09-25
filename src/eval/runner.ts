/**
 * 评测执行器：逐条跑用例 → 收集客观指标 → 双裁判 → 汇总报告。
 *
 * 与 server 的分工一致：Agent 是无状态门面，每个用例用一个独立的 EventBus，
 * 这样「这条用例调了哪些工具」不会串到别的用例上。
 */

import type { Agent } from "../agent/agent.js";
import { AgentContext } from "../agent/context.js";
import { EventBus, EventType } from "../core/events.js";
import { percentile } from "../observability/metrics.js";
import { ruleJudge } from "./judge.js";
import type {
  CaseObservations,
  EvalCase,
  EvalCaseResult,
  EvalReport,
  EvalSuite,
  Judge,
} from "./types.js";

export interface RunEvalOptions {
  suite: EvalSuite;
  model: string;
  /**
   * 造 Agent 的工厂。maxIterations 由用例决定，所以由工厂把它写进 settings——
   * 执行器不关心 Agent 怎么装配（工具、技能、知识库由调用方决定）。
   */
  createAgent: (bus: EventBus, maxIterations: number) => Agent;
  /** 可选的 LLM 裁判 */
  judge?: Judge;
  /** LLM 裁判及格分（0-10），默认 7 */
  judgeThreshold?: number;
  /** 只跑前 N 条，用于冒烟 */
  limit?: number;
  /** 单条用例超时（秒），默认 120 */
  caseTimeout?: number;
  onCaseStart?: (testCase: EvalCase, index: number, total: number) => void;
  onCaseDone?: (result: EvalCaseResult) => void;
}

export async function runEval(options: RunEvalOptions): Promise<EvalReport> {
  const cases = options.limit ? options.suite.cases.slice(0, options.limit) : options.suite.cases;
  const startedAt = new Date();
  const results: EvalCaseResult[] = [];

  for (const [index, testCase] of cases.entries()) {
    options.onCaseStart?.(testCase, index + 1, cases.length);
    const result = await runCase(testCase, options);
    results.push(result);
    options.onCaseDone?.(result);
  }

  return summarise(options.suite.name, options.model, startedAt, results);
}

async function runCase(testCase: EvalCase, options: RunEvalOptions): Promise<EvalCaseResult> {
  const bus = new EventBus();
  const calledTools = new Set<string>();
  bus.subscribe(EventType.ToolEnd, async (event) => {
    calledTools.add(String(event.payload.name ?? "unknown"));
  });

  const maxIterations = testCase.maxIterations ?? options.suite.defaultMaxIterations ?? 6;
  const agent = options.createAgent(bus, maxIterations);
  const context = new AgentContext();

  // 单条超时：借 AgentContext 的协作式取消中断，避免一条卡死整轮评测
  const timer = setTimeout(
    () => context.requestCancel(),
    (options.caseTimeout ?? 120) * 1000,
  );

  let observations: CaseObservations;
  try {
    const result = await agent.run(testCase.question, [], context);
    observations = {
      answer: result.answer,
      iterations: result.context.iterations,
      promptTokens: result.context.usage.promptTokens,
      completionTokens: result.context.usage.completionTokens,
      latency: result.latency,
      tools: [...calledTools],
    };
  } catch (error) {
    observations = {
      answer: "",
      iterations: context.iterations,
      promptTokens: context.usage.promptTokens,
      completionTokens: context.usage.completionTokens,
      latency: 0,
      tools: [...calledTools],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }

  const rule = ruleJudge(testCase, observations);
  const llm = options.judge ? await options.judge(testCase, observations) : undefined;
  const threshold = options.judgeThreshold ?? 7;

  const expectedTools = testCase.expect?.tools ?? [];
  return {
    id: testCase.id,
    question: testCase.question,
    observations,
    rule,
    llm,
    // 规则裁判是硬门槛；启用 LLM 裁判时它也必须达标
    passed: rule.pass && (llm === undefined || llm.score >= threshold),
    toolExpectationMet:
      expectedTools.length === 0
        ? undefined
        : expectedTools.every((tool) => observations.tools.includes(tool)),
  };
}

/** 汇总报告：成功率、工具正确率、token 与时延分位 */
export function summarise(
  suiteName: string,
  model: string,
  startedAt: Date,
  results: EvalCaseResult[],
): EvalReport {
  const endedAt = new Date();
  const passed = results.filter((result) => result.passed).length;

  const withToolExpectation = results.filter(
    (result) => result.toolExpectationMet !== undefined,
  );
  const toolMet = withToolExpectation.filter((result) => result.toolExpectationMet).length;

  const latencies = results
    .map((result) => result.observations.latency)
    .sort((a, b) => a - b);

  return {
    suite: suiteName,
    model,
    startedAt: startedAt.toISOString(),
    durationSec: Number(((endedAt.getTime() - startedAt.getTime()) / 1000).toFixed(2)),
    totals: {
      cases: results.length,
      passed,
      successRate: ratio(passed, results.length),
      toolAccuracy: ratio(toolMet, withToolExpectation.length),
      avgPromptTokens: mean(results.map((r) => r.observations.promptTokens)),
      avgCompletionTokens: mean(results.map((r) => r.observations.completionTokens)),
      p50Latency: Number(percentile(latencies, 0.5).toFixed(3)),
      p95Latency: Number(percentile(latencies, 0.95).toFixed(3)),
      avgIterations: mean(results.map((r) => r.observations.iterations)),
    },
    results,
  };
}

/** 分母为 0 时返回 0，避免出现 NaN 污染报告 */
function ratio(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Number((numerator / denominator).toFixed(4));
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
}
