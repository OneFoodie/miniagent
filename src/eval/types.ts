/** 评测集的数据契约。 */

/** 一条评测用例 */
export interface EvalCase {
  id: string;
  question: string;
  /** 规则裁判的硬性期望（全部满足才算通过） */
  expect?: {
    /** 答案必须包含的关键词（全部） */
    mustInclude?: string[];
    /** 答案不得出现的关键词（任一命中即失败） */
    mustNotInclude?: string[];
    /** 必须被调用到的工具，用于工具正确率 */
    tools?: string[];
  };
  /** 覆盖套件默认的迭代上限 */
  maxIterations?: number;
  /** 给 LLM 裁判的额外判分说明（仅启用 LLM 裁判时使用） */
  judgeNote?: string;
}

/** 一个评测套件 */
export interface EvalSuite {
  name: string;
  defaultMaxIterations?: number;
  cases: EvalCase[];
}

/** 一次运行观测到的客观事实（裁判只看它，不看过程） */
export interface CaseObservations {
  answer: string;
  iterations: number;
  promptTokens: number;
  completionTokens: number;
  latency: number;
  /** 实际被调用过的工具名（去重） */
  tools: string[];
  /** 运行抛错时的错误信息 */
  error?: string;
}

/** 裁判结论 */
export interface JudgeVerdict {
  pass: boolean;
  /** 未通过的原因 */
  reasons: string[];
}

/** LLM 裁判的打分结果 */
export interface LlmVerdict {
  /** 0-10 分 */
  score: number;
  comment: string;
  /** 是否命中了缓存（同一问答不重复花 API 调用） */
  cached: boolean;
}

export type Judge = (
  testCase: EvalCase,
  observations: CaseObservations,
) => Promise<LlmVerdict>;

/** 单条用例的评测结果 */
export interface EvalCaseResult {
  id: string;
  question: string;
  observations: CaseObservations;
  rule: JudgeVerdict;
  /** 未启用 LLM 裁判时为 undefined */
  llm?: LlmVerdict;
  /** 最终判定 */
  passed: boolean;
  /** 期望工具是否被全部调用；用例没有工具期望时为 undefined（不计入正确率分母） */
  toolExpectationMet?: boolean;
}

/** 汇总报告 */
export interface EvalReport {
  suite: string;
  model: string;
  startedAt: string;
  durationSec: number;
  totals: {
    cases: number;
    passed: number;
    /** 成功率 */
    successRate: number;
    /** 期望工具被全部调用的用例占比（没有工具期望的用例不计入） */
    toolAccuracy: number;
    avgPromptTokens: number;
    avgCompletionTokens: number;
    p50Latency: number;
    p95Latency: number;
    avgIterations: number;
  };
  results: EvalCaseResult[];
}
