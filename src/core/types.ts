/** 框架核心数据契约：所有模块通过这些接口通信，不使用裸 any / 未经校验的结构。 */

/** DeepSeek 消息角色 */
export type Role = "system" | "user" | "assistant" | "tool";

/** 模型发起的一次工具调用请求 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** 单次 LLM 调用的 token 用量 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

/** 对话消息（序列化为 DeepSeek 协议时再转成 snake_case） */
export interface Message {
  role: Role;
  content: string;
  /** assistant 消息可能携带的工具调用 */
  toolCalls?: ToolCall[];
  /** role=tool 时对应的调用 id */
  toolCallId?: string;
  /** role=tool 时对应的工具名 */
  name?: string;
}

/** LLM 一次推理的结构化结果 */
export interface LLMResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  finishReason: string;
}

/** 工具执行结果。ok=false 时 error 给出模型可读的失败原因 */
export interface ToolResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export function emptyUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0 };
}
