/** LLM 抽象接口。Agent 只依赖此接口，可替换为 FakeLLM 或其他实现。 */

import type { LLMResponse, Message } from "../core/types.js";

/** DeepSeek tools 载荷中的函数描述结构 */
export type ToolPayload = Record<string, unknown>;

/** 流式增量：文本片段，或某次工具调用的新片段（参数可能被切成多段） */
export interface LLMDelta {
  /** 本轮新增的文本片段；工具调用分片时为空 */
  text: string;
  /** 正在流式拼装的工具调用下标，仅在有工具调用分片时出现 */
  toolIndex?: number;
  /** 新工具调用的名字（分片一开始就可能拿到，也可能要等下一片），供 UI 提示 */
  toolName?: string;
}

/** 增量回调：每收到一段就调用一次，供上层立即透出 */
export type DeltaHandler = (delta: LLMDelta) => void;

export interface BaseLLM {
  /**
   * 给定对话历史（与可选工具定义），返回模型响应。
   * signal 用于外部取消（用户点击停止时 abort，进行中的 HTTP 请求立即失败）。
   */
  chat(
    messages: Message[],
    tools?: ToolPayload[],
    signal?: AbortSignal,
  ): Promise<LLMResponse>;

  /**
   * 流式版本：语义与 chat 完全一致（返回的还是拼装好的完整响应），
   * 只是过程里每收到一段就回调 onDelta，让 UI 能逐字显示。
   *
   * 可选实现：不支持流式的后端可以不提供，Agent 会自动退回 chat。
   */
  chatStream?(
    messages: Message[],
    tools?: ToolPayload[],
    signal?: AbortSignal,
    onDelta?: DeltaHandler,
  ): Promise<LLMResponse>;
}
