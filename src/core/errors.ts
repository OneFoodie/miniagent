/** 统一异常层级：任何模块都不允许吞掉异常。 */

export class MiniAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MiniAgentError";
  }
}

/** 配置缺失或非法 */
export class ConfigError extends MiniAgentError {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** 模型调用失败（网络、HTTP、解析） */
export class LLMError extends MiniAgentError {
  constructor(message: string) {
    super(message);
    this.name = "LLMError";
  }
}

/** 工具定义或调用参数错误 */
export class ToolError extends MiniAgentError {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/** 超过最大迭代轮次仍未给出最终答案 */
export class AgentLimitError extends MiniAgentError {
  constructor(message: string) {
    super(message);
    this.name = "AgentLimitError";
  }
}

/** Agent 运行被外部取消 */
export class AgentCancelledError extends MiniAgentError {
  constructor(message: string) {
    super(message);
    this.name = "AgentCancelledError";
  }
}

/**
 * 运行挂在「等待人工审批」上。
 *
 * 注意它和其它错误不同：**这不是失败**，而是一次可继续的暂停。
 * 现场已经写进 checkpoint，拿到决定后用 `Agent.resume()` 接着跑即可。
 */
export class ApprovalRequiredError extends MiniAgentError {
  constructor(
    message: string,
    /** 本次运行的 id，用于恢复 */
    readonly runId: string,
    /** 等待决定的工具调用 */
    readonly call: { id: string; name: string; arguments: Record<string, unknown> },
  ) {
    super(message);
    this.name = "ApprovalRequiredError";
  }
}
