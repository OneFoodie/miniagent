/**
 * OpenAI 兼容客户端与多 provider 配置测试。
 *
 * 不发真实请求：把 globalThis.fetch 换成记录型桩，断言「发出去的报文长什么样」
 * 与「各种响应/失败被归一化成什么」。这类协议层的东西最容易在换服务商时悄悄跑偏。
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadSettings, type Settings } from "../src/core/config.js";
import { LLMError } from "../src/core/errors.js";
import { findProvider, knownProviders } from "../src/core/providers.js";
import { OpenAICompatibleClient } from "../src/llm/openai.js";

/** 会被本文件改动的环境变量，逐条清理避免污染其它用例 */
const ENV_KEYS = [
  "MINIAGENT_PROVIDER",
  "MINIAGENT_API_KEY",
  "MINIAGENT_BASE_URL",
  "MINIAGENT_MODEL",
  "MINIAGENT_DEEPSEEK_API_KEY",
  "MINIAGENT_DEEPSEEK_BASE_URL",
];

function withEnv(values: Record<string, string>): void {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, values);
}

interface RecordedRequest {
  url: string;
  init: RequestInit;
}

/** 用桩替换 fetch，返回被调用的请求列表 */
function stubFetch(handler: () => Response): RecordedRequest[] {
  const calls: RecordedRequest[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return handler();
  });
  return calls;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** 一次最简成功响应 */
function reply(content: string): Response {
  return jsonResponse({
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 7, completion_tokens: 2 },
  });
}

function clientSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    ...loadSettings(),
    provider: "openai",
    apiKey: "sk-test",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    ...overrides,
  };
}

function requestBody(call: RecordedRequest): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  vi.unstubAllGlobals();
});

describe("OpenAICompatibleClient 协议", () => {
  it("请求打到 {baseUrl}/chat/completions，带 Bearer 鉴权与模型名", async () => {
    const calls = stubFetch(() => reply("你好"));
    const client = new OpenAICompatibleClient(clientSettings());

    const result = await client.chat([{ role: "user", content: "hi" }]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test");

    const body = requestBody(calls[0]!);
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.tool_choice).toBeUndefined();

    expect(result.content).toBe("你好");
    expect(result.usage).toEqual({ promptTokens: 7, completionTokens: 2 });
    expect(result.finishReason).toBe("stop");
  });

  it("传工具时带上 tools 与 tool_choice=auto", async () => {
    const calls = stubFetch(() => reply("ok"));
    const client = new OpenAICompatibleClient(clientSettings());
    const tool = {
      type: "function",
      function: { name: "calc", description: "算数", parameters: { type: "object" } },
    };

    await client.chat([{ role: "user", content: "1+1" }], [tool]);

    const body = requestBody(calls[0]!);
    expect(body.tools).toEqual([tool]);
    expect(body.tool_choice).toBe("auto");
  });

  it("把 toolCalls / toolCallId / name 序列化成 snake_case", async () => {
    const calls = stubFetch(() => reply("ok"));
    const client = new OpenAICompatibleClient(clientSettings());

    await client.chat([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "calc", arguments: { expr: "1+1" } }],
      },
      { role: "tool", content: "2", toolCallId: "call_1", name: "calc" },
    ]);

    const messages = requestBody(calls[0]!).messages as Record<string, unknown>[];
    expect(messages[0]!.tool_calls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "calc", arguments: '{"expr":"1+1"}' },
      },
    ]);
    expect(messages[1]!.tool_call_id).toBe("call_1");
    expect(messages[1]!.name).toBe("calc");
  });

  it("解析响应里的 tool_calls（arguments 是 JSON 字符串）", async () => {
    stubFetch(() =>
      jsonResponse({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { id: "call_9", function: { name: "calc", arguments: '{"expr":"2*3"}' } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    );
    const client = new OpenAICompatibleClient(clientSettings());

    const result = await client.chat([{ role: "user", content: "算" }]);

    expect(result.content).toBe("");
    expect(result.toolCalls).toEqual([
      { id: "call_9", name: "calc", arguments: { expr: "2*3" } },
    ]);
    expect(result.finishReason).toBe("tool_calls");
  });

  it("工具参数不是合法 JSON 时给出可定位的错误", async () => {
    stubFetch(() =>
      jsonResponse({
        choices: [
          {
            message: {
              content: "",
              tool_calls: [{ id: "c", function: { name: "calc", arguments: "{坏" } }],
            },
          },
        ],
      }),
    );
    const client = new OpenAICompatibleClient(clientSettings());

    await expect(client.chat([{ role: "user", content: "算" }])).rejects.toThrow(
      /无法解析工具参数/,
    );
  });
});

describe("流式（token 级）", () => {
  /** 把若干 SSE 事件拼成一个流式 Response；chunks 用于模拟 TCP 分片 */
  function streamResponse(events: string[], chunks?: string[]): Response {
    const body = events.join("");
    const parts = chunks ?? [body];
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const part of parts) controller.enqueue(encoder.encode(part));
          controller.close();
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
  }

  function sse(delta: unknown): string {
    return `data: ${JSON.stringify(delta)}\n\n`;
  }

  it("请求带 stream 与 include_usage，逐段回调文本并拼出完整响应", async () => {
    const calls = stubFetch(() =>
      streamResponse([
        sse({ choices: [{ delta: { content: "你" }, finish_reason: null }] }),
        sse({ choices: [{ delta: { content: "好" }, finish_reason: null }] }),
        sse({ choices: [{ delta: {}, finish_reason: "stop" }] }),
        sse({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 3 } }),
        "data: [DONE]\n\n",
      ]),
    );
    const client = new OpenAICompatibleClient(clientSettings());
    const deltas: string[] = [];

    const result = await client.chatStream(
      [{ role: "user", content: "hi" }],
      undefined,
      undefined,
      (delta) => deltas.push(delta.text),
    );

    const body = requestBody(calls[0]!);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(deltas).toEqual(["你", "好"]);
    expect(result.content).toBe("你好");
    expect(result.finishReason).toBe("stop");
    expect(result.usage).toEqual({ promptTokens: 11, completionTokens: 3 });
  });

  it("一次 TCP 分片里包含多条事件、半条 JSON 跨分片，都能正确还原", async () => {
    const first = sse({ choices: [{ delta: { content: "甲" } }] });
    const second = sse({ choices: [{ delta: { content: "乙" } }] });
    // 故意把第二条事件从中间切开
    const cut = second.length - 12;
    const calls = stubFetch(() =>
      streamResponse([], [first + second.slice(0, cut), second.slice(cut), "data: [DONE]\n\n"]),
    );
    const client = new OpenAICompatibleClient(clientSettings());
    const deltas: string[] = [];

    const result = await client.chatStream(
      [{ role: "user", content: "hi" }],
      undefined,
      undefined,
      (delta) => deltas.push(delta.text),
    );

    expect(calls).toHaveLength(1);
    expect(deltas).toEqual(["甲", "乙"]);
    expect(result.content).toBe("甲乙");
  });

  it("\\r\\n 分隔的 SSE 也能解析", async () => {
    stubFetch(() =>
      streamResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\r\n\r\n`,
        "data: [DONE]\r\n\r\n",
      ]),
    );
    const client = new OpenAICompatibleClient(clientSettings());

    const result = await client.chatStream([{ role: "user", content: "hi" }]);

    expect(result.content).toBe("ok");
  });

  it("tool_calls 分片按下标累积：id/name 在前，arguments 分多段", async () => {
    const calls = stubFetch(() =>
      streamResponse([
        sse({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call_a", function: { name: "calculator" } },
                ],
              },
            },
          ],
        }),
        sse({
          choices: [
            { delta: { tool_calls: [{ index: 0, function: { arguments: '{"expr' } }] } },
          ],
        }),
        sse({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: 'ession":"1+1"}' } }],
              },
            },
          ],
        }),
        sse({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 1, id: "call_b", function: { name: "web_search" } },
                ],
              },
            },
          ],
        }),
        sse({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
        "data: [DONE]\n\n",
      ]),
    );
    const client = new OpenAICompatibleClient(clientSettings());
    const toolStarts: Array<string | undefined> = [];

    const result = await client.chatStream(
      [{ role: "user", content: "算" }],
      [{ type: "function", function: { name: "calculator" } }],
      undefined,
      (delta) => {
        if (delta.toolIndex !== undefined) toolStarts.push(delta.toolName);
      },
    );

    expect(calls).toHaveLength(1);
    expect(result.toolCalls).toEqual([
      { id: "call_a", name: "calculator", arguments: { expression: "1+1" } },
      { id: "call_b", name: "web_search", arguments: {} },
    ]);
    expect(result.finishReason).toBe("tool_calls");
    // 每个工具只在"开始"时通知一次
    expect(toolStarts).toEqual(["calculator", "web_search"]);
  });

  it("坏分片只跳过它自己，不影响整条流", async () => {
    stubFetch(() =>
      streamResponse([
        "data: {这不是合法 JSON\n\n",
        sse({ choices: [{ delta: { content: "仍然可用" } }] }),
        "data: [DONE]\n\n",
      ]),
    );
    const client = new OpenAICompatibleClient(clientSettings());

    const result = await client.chatStream([{ role: "user", content: "hi" }]);

    expect(result.content).toBe("仍然可用");
  });

  it("已经吐过片段后中断 → 不重试（避免前端看到重复文本）", async () => {
    let attempt = 0;
    const calls = stubFetch(() => {
      attempt += 1;
      if (attempt === 1) {
        const encoder = new TextEncoder();
        let pulled = 0;
        return new Response(
          new ReadableStream({
            // 先让消费者拿到一个分片，再报错——模拟"吐了一半断线"
            pull(controller) {
              pulled += 1;
              if (pulled === 1) {
                controller.enqueue(
                  encoder.encode(sse({ choices: [{ delta: { content: "半句" } }] })),
                );
              } else {
                controller.error(new Error("连接断了"));
              }
            },
          }),
          { status: 200 },
        );
      }
      return reply("不该走到这里");
    });
    const client = new OpenAICompatibleClient(clientSettings({ maxRetries: 3 }));

    await expect(
      client.chatStream([{ role: "user", content: "hi" }], undefined, undefined, () => {}),
    ).rejects.toThrow(/流式读取中断/);
    expect(calls).toHaveLength(1);
  });

  it("还没吐片段就失败 → 仍按普通请求重试", async () => {
    let attempt = 0;
    const calls = stubFetch(() => {
      attempt += 1;
      return attempt === 1
        ? new Response("busy", { status: 503 })
        : streamResponse([sse({ choices: [{ delta: { content: "重试成功" } }] })]);
    });
    const client = new OpenAICompatibleClient(clientSettings({ maxRetries: 1 }));

    const result = await client.chatStream([{ role: "user", content: "hi" }]);

    expect(calls).toHaveLength(2);
    expect(result.content).toBe("重试成功");
  });

  it("服务端拒绝 stream_options → 去掉它再试一次", async () => {
    let attempt = 0;
    const calls = stubFetch(() => {
      attempt += 1;
      if (attempt === 1) return new Response("unknown field", { status: 400 });
      return streamResponse([sse({ choices: [{ delta: { content: "降级成功" } }] })]);
    });
    const client = new OpenAICompatibleClient(clientSettings({ maxRetries: 0 }));

    const result = await client.chatStream([{ role: "user", content: "hi" }]);

    expect(calls).toHaveLength(2);
    expect(requestBody(calls[1]!).stream_options).toBeUndefined();
    expect(requestBody(calls[1]!).stream).toBe(true);
    expect(result.content).toBe("降级成功");
  });

  it("chat() 不带 stream 参数，走的还是非流式分支", async () => {
    const calls = stubFetch(() => reply("普通回答"));
    const client = new OpenAICompatibleClient(clientSettings());

    const result = await client.chat([{ role: "user", content: "hi" }]);

    expect(requestBody(calls[0]!).stream).toBeUndefined();
    expect(result.content).toBe("普通回答");
  });
});

describe("失败与重试", () => {
  it("429 属于可重试，重试后成功", async () => {
    let attempt = 0;
    const calls = stubFetch(() => {
      attempt += 1;
      return attempt === 1 ? new Response("rate limited", { status: 429 }) : reply("ok");
    });
    const client = new OpenAICompatibleClient(clientSettings({ maxRetries: 1 }));

    const result = await client.chat([{ role: "user", content: "hi" }]);

    expect(calls).toHaveLength(2);
    expect(result.content).toBe("ok");
  });

  it("400 不可重试，只发一次请求", async () => {
    const calls = stubFetch(() => new Response("bad request", { status: 400 }));
    const client = new OpenAICompatibleClient(clientSettings({ maxRetries: 3 }));

    await expect(client.chat([{ role: "user", content: "hi" }])).rejects.toThrow(
      /HTTP 400/,
    );
    expect(calls).toHaveLength(1);
  });

  it("重试耗尽后的报错带上 provider 名，便于判断是哪条链路挂了", async () => {
    stubFetch(() => new Response("boom", { status: 503 }));
    const client = new OpenAICompatibleClient(
      clientSettings({ provider: "moonshot", maxRetries: 0 }),
    );

    await expect(client.chat([{ role: "user", content: "hi" }])).rejects.toThrow(
      /moonshot 请求重试后仍失败/,
    );
  });

  it("外部取消立即终止，不重试", async () => {
    const calls = stubFetch(() => reply("不该被调用"));
    const client = new OpenAICompatibleClient(clientSettings({ maxRetries: 3 }));
    const controller = new AbortController();
    controller.abort();

    await expect(
      client.chat([{ role: "user", content: "hi" }], undefined, controller.signal),
    ).rejects.toThrow(/已被取消/);
    expect(calls).toHaveLength(0);
  });
});

describe("凭据与本地端点", () => {
  it("云端服务商缺 Key 时明确要求配置 MINIAGENT_API_KEY", async () => {
    const calls = stubFetch(() => reply("ok"));
    const client = new OpenAICompatibleClient(clientSettings({ apiKey: "" }));

    await expect(client.chat([{ role: "user", content: "hi" }])).rejects.toBeInstanceOf(
      LLMError,
    );
    await expect(client.chat([{ role: "user", content: "hi" }])).rejects.toThrow(
      /MINIAGENT_API_KEY/,
    );
    expect(calls).toHaveLength(0);
  });

  it("本地端点不要求 Key，也不发 Authorization 头", async () => {
    const calls = stubFetch(() => reply("本地回答"));
    const client = new OpenAICompatibleClient(
      clientSettings({ provider: "ollama", apiKey: "", baseUrl: "http://localhost:11434/v1" }),
    );

    const result = await client.chat([{ role: "user", content: "hi" }]);

    expect(result.content).toBe("本地回答");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });
});

describe("provider 预设与配置", () => {
  it("预设决定 baseUrl 与默认模型名", () => {
    withEnv({ MINIAGENT_PROVIDER: "dashscope" });
    const settings = loadSettings();
    expect(settings.provider).toBe("dashscope");
    expect(settings.baseUrl).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
    expect(settings.model).toBe("qwen-plus");
  });

  it("MINIAGENT_BASE_URL / MINIAGENT_MODEL 可覆盖预设（自建网关场景）", () => {
    withEnv({
      MINIAGENT_PROVIDER: "deepseek",
      MINIAGENT_BASE_URL: "https://gateway.internal/v1",
      MINIAGENT_MODEL: "my-finetune",
    });
    const settings = loadSettings();
    expect(settings.baseUrl).toBe("https://gateway.internal/v1");
    expect(settings.model).toBe("my-finetune");
  });

  it("未知 provider 直接报错并列出候选", () => {
    withEnv({ MINIAGENT_PROVIDER: "not-a-provider" });
    expect(() => loadSettings()).toThrow(/未知的模型服务商/);
    expect(() => loadSettings()).toThrow(new RegExp(knownProviders()));
  });

  it("custom 缺 baseUrl、ollama 缺模型名都在启动时报错", () => {
    withEnv({ MINIAGENT_PROVIDER: "custom", MINIAGENT_MODEL: "x" });
    expect(() => loadSettings()).toThrow(/MINIAGENT_BASE_URL/);

    withEnv({ MINIAGENT_PROVIDER: "ollama" });
    expect(() => loadSettings()).toThrow(/MINIAGENT_MODEL/);
  });

  it("沿用旧变量 MINIAGENT_DEEPSEEK_API_KEY 仍然有效", () => {
    withEnv({ MINIAGENT_DEEPSEEK_API_KEY: "legacy-key" });
    expect(loadSettings().apiKey).toBe("legacy-key");
  });

  it("预设表可按名字查到", () => {
    expect(findProvider("OpenAI")?.baseUrl).toBe("https://api.openai.com/v1");
    expect(findProvider("unknown")).toBeUndefined();
  });
});
