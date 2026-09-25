/**
 * OpenAI 兼容的 chat/completions 客户端：tool calling、指数退避重试、错误归一化。
 *
 * 只依赖协议本身，不绑定任何一家厂商：DeepSeek / OpenAI / Moonshot / 通义 /
 * 智谱 / Ollama 走的都是同一个 `POST {baseUrl}/chat/completions`，
 * 差别只在接入点、模型名与 Key，这三样都在 Settings 里（见 core/providers.ts）。
 */

import type { Settings } from "../core/config.js";
import { LLMError } from "../core/errors.js";
import { getLogger } from "../core/logging.js";
import type { LLMResponse, Message, ToolCall } from "../core/types.js";
import type { DeltaHandler } from "./base.js";

const logger = getLogger("miniagent.llm.openai");

/** 可重试的 HTTP 状态码 */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 把框架 Message 序列化为 OpenAI 请求结构（snake_case） */
function serializeMessage(message: Message): Record<string, unknown> {
  const base: Record<string, unknown> = { role: message.role };
  if (message.content !== undefined) base.content = message.content;
  if (message.toolCalls && message.toolCalls.length > 0) {
    base.tool_calls = message.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: {
        name: call.name,
        arguments: JSON.stringify(call.arguments ?? {}),
      },
    }));
  }
  if (message.toolCallId !== undefined) base.tool_call_id = message.toolCallId;
  if (message.name !== undefined) base.name = message.name;
  return base;
}

export class OpenAICompatibleClient {
  constructor(private readonly settings: Settings) {}

  async chat(
    messages: Message[],
    tools?: Record<string, unknown>[],
    externalSignal?: AbortSignal,
  ): Promise<LLMResponse> {
    return this.complete(messages, tools, { signal: externalSignal });
  }

  /** 流式：返回的仍是拼装完整的响应，只是过程中通过 onDelta 逐段透出 */
  async chatStream(
    messages: Message[],
    tools?: Record<string, unknown>[],
    externalSignal?: AbortSignal,
    onDelta?: DeltaHandler,
  ): Promise<LLMResponse> {
    // 即使没有 onDelta 也走流式：区别在协议本身，而不在有没有人监听增量
    return this.complete(messages, tools, { signal: externalSignal, onDelta, stream: true });
  }

  private async complete(
    messages: Message[],
    tools: Record<string, unknown>[] | undefined,
    options: { signal?: AbortSignal; onDelta?: DeltaHandler; stream?: boolean } = {},
  ): Promise<LLMResponse> {
    const { signal: externalSignal, onDelta } = options;
    const streaming = options.stream === true;
    if (!this.settings.apiKey && !this.isLocalEndpoint()) {
      throw new LLMError(this.missingKeyHint());
    }

    const payload: Record<string, unknown> = {
      model: this.settings.model,
      messages: messages.map(serializeMessage),
    };
    if (tools && tools.length > 0) {
      payload.tools = tools;
      payload.tool_choice = "auto";
    }
    if (streaming) {
      payload.stream = true;
      // 不带 include_usage 时绝大多数服务商在流式下不回 usage，token 统计会静默归零
      payload.stream_options = { include_usage: true };
    }

    let lastError: unknown = null;
    /** 是否已经向外吐过片段：吐过就不能重试，否则前端会看到重复文本 */
    let emitted = false;
    /** stream_options 是否已降级过一次（见下方 catch 里的说明） */
    let strippedStreamOptions = false;
    for (let attempt = 0; attempt <= this.settings.maxRetries; attempt++) {
      // 外部已取消 → 立即终止，不再重试
      if (externalSignal?.aborted) {
        throw new AgentAbortError("LLM 调用已被取消");
      }
      try {
        const response = await this.request(payload, externalSignal);
        if (!streaming) return this.parseResponse(await response.json());
        return await this.readStream(response, (delta) => {
          emitted = true;
          onDelta?.(delta);
        });
      } catch (error) {
        lastError = error;
        // 外部取消 → 直接抛出
        if (error instanceof AgentAbortError || externalSignal?.aborted) {
          throw new AgentAbortError("LLM 调用已被取消");
        }
        // 重试会把已显示的内容再来一遍，只能如实失败
        if (emitted) {
          throw error instanceof LLMError
            ? error
            : new LLMError(`流式响应中断: ${String(error)}`);
        }
        // 少数网关不认识 stream_options 并直接回 4xx：去掉它再试一次（代价是拿不到 usage）。
        // 只降级一次，避免死循环。
        if (
          payload.stream_options !== undefined &&
          !strippedStreamOptions &&
          error instanceof LLMError &&
          !(error as RetryableLLMError).retryable
        ) {
          strippedStreamOptions = true;
          delete payload.stream_options;
          logger.warning("服务端拒绝了 stream_options，已去掉后重试一次（本轮无 token 用量）");
          attempt -= 1;
          continue;
        }
        // LLMError 且不可重试（4xx 非限流）→ 直接抛出
        if (error instanceof LLMError && !(error as RetryableLLMError).retryable) {
          throw error;
        }
        if (attempt >= this.settings.maxRetries) break;
        const backoff = Math.min(8, 0.5 * 2 ** attempt);
        logger.warning(
          `${this.settings.provider} 请求失败，${backoff.toFixed(1)}s 后重试（第 ${attempt + 1} 次）`,
        );
        await sleep(backoff * 1000);
      }
    }
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new LLMError(`${this.settings.provider} 请求重试后仍失败: ${detail}`);
  }

  /** 本地端点（Ollama 等）通常不校验 Key，不强制要求配置 */
  private isLocalEndpoint(): boolean {
    try {
      const { hostname } = new URL(this.settings.baseUrl);
      return ["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(hostname);
    } catch {
      return false;
    }
  }

  private missingKeyHint(): string {
    const { provider, baseUrl } = this.settings;
    return (
      `未配置 API Key（provider=${provider}）。\n` +
      `  请设置环境变量 MINIAGENT_API_KEY（或沿用 MINIAGENT_DEEPSEEK_API_KEY），\n` +
      `  接入点: ${baseUrl}`
    );
  }

  private async request(
    payload: Record<string, unknown>,
    externalSignal?: AbortSignal,
  ): Promise<Response> {
    // 超时信号 + 外部取消信号，任一触发 fetch 即失败
    const timeoutSignal = AbortSignal.timeout(this.settings.requestTimeout * 1000);
    const signal = externalSignal
      ? AbortSignal.any([timeoutSignal, externalSignal])
      : timeoutSignal;

    let response: Response;
    try {
      response = await fetch(`${this.settings.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.settings.apiKey
            ? { Authorization: `Bearer ${this.settings.apiKey}` }
            : {}),
        },
        body: JSON.stringify(payload),
        signal,
      });
    } catch (error) {
      // 外部取消与超时/网络错误分开，便于上层立即终止而非重试
      if (externalSignal?.aborted) {
        throw new AgentAbortError("LLM 调用已被取消");
      }
      throw new RetryableLLMError(
        `网络请求失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (RETRYABLE_STATUS.has(response.status)) {
      throw new RetryableLLMError(`HTTP ${response.status}`);
    }
    if (!response.ok) {
      const body = (await response.text()).slice(0, 500);
      throw new LLMError(
        `${this.settings.provider} 返回错误 HTTP ${response.status}: ${body}`,
      );
    }
    return response;
  }

  /**
   * 读 SSE 流并拼装响应。
   *
   * 两个必须处理的细节：
   *  1. **分片**：一个 TCP 包不等于一条事件，也不是一条完整 JSON，所以要按空行切事件、
   *     把最后一段不完整的数据留到下一个 chunk；
   *  2. **tool_calls 是分片下发的**：同一个下标会出现多条增量（先给 id/name，再一段段给
   *     arguments），必须按下标累积后一次性 JSON.parse。
   */
  private async readStream(
    response: Response,
    onDelta: DeltaHandler,
  ): Promise<LLMResponse> {
    if (!response.body) {
      throw new LLMError("流式响应没有响应体（服务端可能不支持 stream）");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const accumulator = new StreamAccumulator();
    let buffer = "";

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // 统一换行符，避免 \r\n\r\n 与 \n\n 两种分隔风格都要判一次
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          accumulator.feed(buffer.slice(0, boundary), onDelta);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
        }
      }
      // 有的服务端最后一条事件不带结尾空行
      if (buffer.trim()) accumulator.feed(buffer, onDelta);
    } catch (error) {
      if (error instanceof LLMError) throw error;
      throw new RetryableLLMError(
        `流式读取中断: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      reader.releaseLock();
    }
    return accumulator.result();
  }

  private parseResponse(data: unknown): LLMResponse {
    try {
      const root = data as {
        choices: Array<{
          message: {
            content?: string | null;
            tool_calls?: Array<{
              id: string;
              function: { name: string; arguments: string };
            }> | null;
          };
          finish_reason?: string;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const choice = root.choices[0]!;
      const message = choice.message;

      const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((item) => {
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(item.function.arguments || "{}") as Record<string, unknown>;
        } catch {
          throw new LLMError(`无法解析工具参数: ${item.function.arguments}`);
        }
        return { id: item.id, name: item.function.name, arguments: args };
      });

      return {
        content: message.content ?? "",
        toolCalls,
        usage: {
          promptTokens: root.usage?.prompt_tokens ?? 0,
          completionTokens: root.usage?.completion_tokens ?? 0,
        },
        finishReason: choice.finish_reason ?? "stop",
      };
    } catch (error) {
      if (error instanceof LLMError) throw error;
      throw new LLMError(
        `${this.settings.provider} 响应结构异常: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

/** 一个工具调用的分片累积槽：id/name 先到，arguments 分多段到 */
interface ToolCallParts {
  id: string;
  name: string;
  args: string;
}

/** 流式响应的拼装器：把 SSE 增量还原成一个完整的 LLMResponse */
class StreamAccumulator {
  private content = "";
  private finishReason = "stop";
  private promptTokens = 0;
  private completionTokens = 0;
  /** 按 index 落位：分片可能乱序/跳跃，不能用 push */
  private readonly toolParts: Array<ToolCallParts | undefined> = [];

  /** 喂一条 SSE 事件（可能是 event:/id: 多行，也可能只有 data:） */
  feed(rawEvent: string, onDelta: DeltaHandler): void {
    for (const line of rawEvent.split("\n")) {
      const trimmed = line.trim();
      // 只关心 data: 行；event:/id:/注释行对拼装没有贡献
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice("data:".length).trim();
      if (!data || data === "[DONE]") continue;

      let chunk: unknown;
      try {
        chunk = JSON.parse(data);
      } catch {
        // 单条坏事件不该毁掉整条流：记下来继续读
        logger.warning(`跳过无法解析的流式分片: ${data.slice(0, 120)}`);
        continue;
      }
      this.push(chunk, onDelta);
    }
  }

  private push(chunk: unknown, onDelta: DeltaHandler): void {
    const root = chunk as {
      choices?: Array<{
        delta?: {
          content?: string | null;
          tool_calls?: Array<{
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }> | null;
        };
        finish_reason?: string | null;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
    };

    // 开启 include_usage 后，最后一条 chunk 只有 usage、choices 为空
    if (root.usage) {
      this.promptTokens = root.usage.prompt_tokens ?? this.promptTokens;
      this.completionTokens = root.usage.completion_tokens ?? this.completionTokens;
    }

    const choice = root.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) this.finishReason = choice.finish_reason;

    const delta = choice.delta;
    if (!delta) return;

    if (delta.content) {
      this.content += delta.content;
      onDelta({ text: delta.content });
    }

    for (const part of delta.tool_calls ?? []) {
      const index = part.index ?? 0;
      let slot = this.toolParts[index];
      const isNew = slot === undefined;
      if (!slot) {
        slot = { id: "", name: "", args: "" };
        this.toolParts[index] = slot;
      }
      if (part.id) slot.id = part.id;
      if (part.function?.name) slot.name = part.function.name;
      if (part.function?.arguments) slot.args += part.function.arguments;
      // 只在工具调用"开始"时通知一次，逐字符推参数对 UI 没有意义
      if (isNew) onDelta({ text: "", toolIndex: index, toolName: slot.name });
    }
  }

  result(): LLMResponse {
    const toolCalls: ToolCall[] = [];
    for (const part of this.toolParts) {
      if (!part) continue;
      let args: Record<string, unknown> = {};
      if (part.args) {
        try {
          args = JSON.parse(part.args) as Record<string, unknown>;
        } catch {
          throw new LLMError(`无法解析工具参数: ${part.args}`);
        }
      }
      toolCalls.push({ id: part.id, name: part.name, arguments: args });
    }
    return {
      content: this.content,
      toolCalls,
      usage: { promptTokens: this.promptTokens, completionTokens: this.completionTokens },
      finishReason: this.finishReason,
    };
  }
}

/** 标记一次可重试的 LLM 调用失败 */
class RetryableLLMError extends LLMError {
  readonly retryable = true;

  constructor(message: string) {
    super(message);
    this.name = "RetryableLLMError";
  }
}

/** 外部主动取消（区别于网络故障，不重试） */
class AgentAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentAbortError";
  }
}
