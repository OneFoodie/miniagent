/** 测试用替身：按脚本返回响应的 FakeLLM，以及构造响应的辅助函数。 */

import type { LLMResponse, Message, ToolCall } from "../src/core/types.js";
import type { BaseLLM } from "../src/llm/base.js";

export interface LLMCall {
  messages: Message[];
  tools?: Record<string, unknown>[];
}

export class FakeLLM implements BaseLLM {
  readonly calls: LLMCall[] = [];

  constructor(private readonly script: LLMResponse[]) {}

  async chat(
    messages: Message[],
    tools?: Record<string, unknown>[],
    _signal?: AbortSignal,
  ): Promise<LLMResponse> {
    this.calls.push({ messages: [...messages], tools });
    if (this.calls.length > this.script.length) {
      throw new Error("FakeLLM 脚本已耗尽，主循环调用次数超出预期");
    }
    return this.script[this.calls.length - 1]!;
  }
}

/** 构造工具调用响应。calls 为 (callId, toolName, arguments) 三元组列表 */
export function toolCallResponse(
  calls: Array<[string, string, Record<string, unknown>]>,
  content = "",
): LLMResponse {
  const toolCalls: ToolCall[] = calls.map(([id, name, args]) => ({
    id,
    name,
    arguments: args,
  }));
  return {
    content,
    toolCalls,
    usage: { promptTokens: 0, completionTokens: 0 },
    finishReason: "tool_calls",
  };
}

export function finalResponse(text: string): LLMResponse {
  return {
    content: text,
    toolCalls: [],
    usage: { promptTokens: 10, completionTokens: 5 },
    finishReason: "stop",
  };
}
