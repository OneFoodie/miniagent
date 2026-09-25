/** MemOS 云记忆后端：请求组装、响应解析、失败降级与工厂选择。 */

import { describe, expect, it } from "vitest";

import { loadSettings, type Settings } from "../src/core/config.js";
import {
  createLongTermMemory,
  describeLongTermMemory,
  rememberTurn,
  type LongTermMemory,
  type MemoryRecord,
} from "../src/memory/index.js";
import { MemOsMemory } from "../src/memory/memos.js";
import { JsonlLongTermMemory } from "../src/memory/store.js";

/** 读取一份受控的配置：临时覆盖 MemOS 相关环境变量，读完立刻还原，避免测试互相污染 */
function buildSettings(overrides: Record<string, string> = {}): Settings {
  const keys = [
    "MINIAGENT_MEMOS_API_KEY",
    "MINIAGENT_MEMOS_BASE_URL",
    "MINIAGENT_MEMOS_USER_ID",
    "MINIAGENT_MEMOS_TIMEOUT",
  ];
  const snapshot = new Map(keys.map((key) => [key, process.env[key]]));

  for (const key of keys) delete process.env[key];
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;

  const settings = loadSettings();

  for (const [key, value] of snapshot) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return settings;
}

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

type FetchOutcome = { status?: number; payload?: unknown } | "throw";

/** 用假 fetch 替换全局实现，记录请求并返回预设响应 */
function stubFetch(handler: (request: CapturedRequest) => FetchOutcome): {
  impl: typeof fetch;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const request: CapturedRequest = {
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    requests.push(request);

    const outcome = handler(request);
    if (outcome === "throw") throw new Error("network down");
    return new Response(JSON.stringify(outcome.payload ?? {}), {
      status: outcome.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;

  return { impl, requests };
}

function makeMemory(impl: typeof fetch): MemOsMemory {
  return new MemOsMemory({
    apiKey: "test-key",
    baseUrl: "https://example.test/api/openmem/v1",
    userId: "u1",
    timeout: 5,
    fetchImpl: impl,
  });
}

describe("MemOsMemory.search", () => {
  it("合并事实与偏好记忆，按相关性降序，并发出正确的请求", async () => {
    const { impl, requests } = stubFetch(() => ({
      payload: {
        code: 0,
        data: {
          memory_detail_list: [
            { id: "m1", memory_key: "爱好", memory_value: "用户喜欢 Rust", relativity: 0.4 },
            { id: "m2", memory_key: "城市", memory_value: "用户在上海", relativity: 0.9 },
          ],
          preference_detail_list: [
            { id: "p1", memory_key: "回答风格", memory_value: "偏好简洁", relativity: 0.7 },
          ],
        },
      },
    }));

    const records = await makeMemory(impl).search("用户偏好", 3);

    expect(records.map((record) => record.text)).toEqual([
      "城市：用户在上海",
      "回答风格：偏好简洁",
      "爱好：用户喜欢 Rust",
    ]);
    expect(records[0]!.meta?.memoryId).toBe("m2");
    expect(requests[0]!.url).toBe("https://example.test/api/openmem/v1/search/memory");
    expect(requests[0]!.headers.Authorization).toBe("Token test-key");
    expect(requests[0]!.body.user_id).toBe("u1");
    expect(requests[0]!.body.memory_limit_number).toBe(3);
  });

  it("HTTP 非 200 时降级为空数组而非抛异常", async () => {
    const { impl } = stubFetch(() => ({ status: 401, payload: { message: "unauthorized" } }));
    await expect(makeMemory(impl).search("任意")).resolves.toEqual([]);
  });

  it("业务错误码 code!=0 同样降级为空数组", async () => {
    const { impl } = stubFetch(() => ({ payload: { code: 1001, message: "配额不足" } }));
    await expect(makeMemory(impl).search("任意")).resolves.toEqual([]);
  });

  it("网络异常时降级为空数组", async () => {
    const { impl } = stubFetch(() => "throw");
    await expect(makeMemory(impl).search("任意")).resolves.toEqual([]);
  });

  it("空查询不发请求", async () => {
    const { impl, requests } = stubFetch(() => ({ payload: { code: 0, data: {} } }));
    await expect(makeMemory(impl).search("   ")).resolves.toEqual([]);
    expect(requests).toHaveLength(0);
  });
});

describe("MemOsMemory 写入", () => {
  it("addConversation 按真实角色发送一轮对话", async () => {
    const { impl, requests } = stubFetch(() => ({ payload: { code: 0 } }));

    await makeMemory(impl).addConversation(
      [
        { role: "user", content: "我叫小林" },
        { role: "assistant", content: "记住了" },
      ],
      { conversationId: "s-1" },
    );

    expect(requests[0]!.url).toBe("https://example.test/api/openmem/v1/add/message");
    expect(requests[0]!.body.conversation_id).toBe("s-1");
    expect(requests[0]!.body.messages).toEqual([
      { role: "user", content: "我叫小林" },
      { role: "assistant", content: "记住了" },
    ]);
  });

  it("写入失败不抛异常，主流程不受影响", async () => {
    const { impl } = stubFetch(() => "throw");
    await expect(
      makeMemory(impl).add({ text: "问：a\n答：b", ts: Date.now() / 1000 }),
    ).resolves.toBeUndefined();
  });

  it("空对话不发请求", async () => {
    const { impl, requests } = stubFetch(() => ({ payload: { code: 0 } }));
    await makeMemory(impl).addConversation([]);
    expect(requests).toHaveLength(0);
  });

  it("load 返回空数组（云 API 没有枚举语义）", async () => {
    const { impl } = stubFetch(() => ({ payload: { code: 0 } }));
    await expect(makeMemory(impl).load()).resolves.toEqual([]);
  });
});

describe("rememberTurn 分派", () => {
  it("对话型后端收到真实角色", async () => {
    const { impl, requests } = stubFetch(() => ({ payload: { code: 0 } }));

    await rememberTurn(makeMemory(impl), {
      question: "我喜欢什么语言",
      answer: "Rust",
      ts: 1,
      conversationId: "s-9",
    });

    expect(requests[0]!.body.messages).toEqual([
      { role: "user", content: "我喜欢什么语言" },
      { role: "assistant", content: "Rust" },
    ]);
  });

  it("普通后端退化为一条自包含文本", async () => {
    const added: MemoryRecord[] = [];
    const memory: LongTermMemory = {
      add: async (record) => {
        added.push(record);
      },
      search: async () => [],
      load: async () => [],
    };

    await rememberTurn(memory, { question: "Q", answer: "A", ts: 123 });

    expect(added).toHaveLength(1);
    expect(added[0]!.text).toBe("问：Q\n答：A");
    expect(added[0]!.ts).toBe(123);
  });
});

describe("createLongTermMemory 工厂", () => {
  it("未配置 key 时回退到本地 JSONL", () => {
    const settings = buildSettings();

    expect(createLongTermMemory(settings)).toBeInstanceOf(JsonlLongTermMemory);
    expect(describeLongTermMemory(settings)).toContain("JSONL");
  });

  it("配置 key 后启用 MemOS 云记忆", () => {
    const settings = buildSettings({
      MINIAGENT_MEMOS_API_KEY: "mpg-test",
      MINIAGENT_MEMOS_USER_ID: "u-42",
    });

    expect(createLongTermMemory(settings)).toBeInstanceOf(MemOsMemory);
    expect(describeLongTermMemory(settings)).toContain("MemOS");
    expect(describeLongTermMemory(settings)).toContain("u-42");
  });
});
