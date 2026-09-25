/** 评测：规则裁判、LLM 裁判输出解析、报告汇总。 */

import { describe, expect, it } from "vitest";

import { parseVerdict, ruleJudge, summarise } from "../src/eval/index.js";
import type { CaseObservations, EvalCase, EvalCaseResult } from "../src/eval/index.js";

function observations(overrides: Partial<CaseObservations> = {}): CaseObservations {
  return {
    answer: "",
    iterations: 1,
    promptTokens: 100,
    completionTokens: 20,
    latency: 1,
    tools: [],
    ...overrides,
  };
}

describe("ruleJudge 规则裁判", () => {
  it("关键词齐全且工具调用到位 → 通过", () => {
    const testCase: EvalCase = {
      id: "x",
      question: "q",
      expect: { mustInclude: ["768"], tools: ["calculator"] },
    };
    const verdict = ruleJudge(
      testCase,
      observations({ answer: "答案是 768", tools: ["calculator"] }),
    );

    expect(verdict.pass).toBe(true);
    expect(verdict.reasons).toEqual([]);
  });

  it("缺少必需关键词 → 失败并指出缺哪个", () => {
    const verdict = ruleJudge(
      { id: "x", question: "q", expect: { mustInclude: ["768", "详细过程"] } },
      observations({ answer: "768" }),
    );

    expect(verdict.pass).toBe(false);
    expect(verdict.reasons[0]).toContain("详细过程");
  });

  it("出现禁止关键词 → 失败", () => {
    const verdict = ruleJudge(
      { id: "x", question: "q", expect: { mustNotInclude: ["无法确定"] } },
      observations({ answer: "我无法确定" }),
    );

    expect(verdict.pass).toBe(false);
    expect(verdict.reasons[0]).toContain("无法确定");
  });

  it("缺少期望的工具 → 失败", () => {
    const verdict = ruleJudge(
      { id: "x", question: "q", expect: { tools: ["calculator"] } },
      observations({ answer: "768", tools: ["web_search"] }),
    );

    expect(verdict.pass).toBe(false);
    expect(verdict.reasons[0]).toContain("calculator");
  });

  it("运行报错直接判失败", () => {
    const verdict = ruleJudge({ id: "x", question: "q" }, observations({ error: "已取消" }));
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons[0]).toContain("已取消");
  });

  it("没有期望的用例默认通过", () => {
    expect(ruleJudge({ id: "x", question: "q" }, observations({ answer: "随便" })).pass).toBe(
      true,
    );
  });
});

describe("parseVerdict LLM 裁判输出解析", () => {
  it("解析纯 JSON", () => {
    expect(parseVerdict('{"score": 8, "comment": "不错"}')).toMatchObject({
      score: 8,
      comment: "不错",
    });
  });

  it("解析被代码块包裹的 JSON", () => {
    expect(parseVerdict('```json\n{"score": 6, "comment": "一般"}\n```').score).toBe(6);
  });

  it("分数越界时夹到 0-10", () => {
    expect(parseVerdict('{"score": 99}').score).toBe(10);
    expect(parseVerdict('{"score": -3}').score).toBe(0);
  });

  it("无法解析时判 0 分并说明原因", () => {
    const verdict = parseVerdict("我觉得还行");
    expect(verdict.score).toBe(0);
    expect(verdict.comment).toContain("无法解析");
  });

  it("JSON 缺 score 时判 0 分", () => {
    expect(parseVerdict('{"comment": "忘了给分"}').score).toBe(0);
  });
});

describe("summarise 报告汇总", () => {
  function result(overrides: Partial<EvalCaseResult> = {}): EvalCaseResult {
    return {
      id: "id",
      question: "q",
      observations: observations(),
      rule: { pass: true, reasons: [] },
      passed: true,
      ...overrides,
    };
  }

  it("成功率与工具正确率各按自己的分母算", () => {
    const report = summarise("s", "m", new Date(), [
      result({ toolExpectationMet: true }),
      result({ toolExpectationMet: false, passed: false }),
      // 没有工具期望 → 不计入工具正确率分母
      result({ toolExpectationMet: undefined }),
    ]);

    expect(report.totals.cases).toBe(3);
    expect(report.totals.passed).toBe(2);
    expect(report.totals.successRate).toBe(0.6667);
    expect(report.totals.toolAccuracy).toBe(0.5);
  });

  it("工具期望分母为 0 时返回 0 而不是 NaN", () => {
    const report = summarise("s", "m", new Date(), [result({ toolExpectationMet: undefined })]);
    expect(report.totals.toolAccuracy).toBe(0);
  });

  it("空结果集不产生 NaN", () => {
    const report = summarise("s", "m", new Date(), []);
    expect(report.totals).toMatchObject({
      cases: 0,
      successRate: 0,
      toolAccuracy: 0,
      avgPromptTokens: 0,
      p50Latency: 0,
    });
  });

  it("token 与迭代数取均值，时延取分位", () => {
    const report = summarise("s", "m", new Date(), [
      result({ observations: observations({ promptTokens: 100, iterations: 1, latency: 1 }) }),
      result({ observations: observations({ promptTokens: 300, iterations: 3, latency: 2 }) }),
    ]);

    expect(report.totals.avgPromptTokens).toBe(200);
    expect(report.totals.avgIterations).toBe(2);
    expect(report.totals.p95Latency).toBe(2);
  });
});
