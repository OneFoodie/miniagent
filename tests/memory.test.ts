/** 记忆模块：滑窗裁剪、tool 消息配对保护、摘要触发、JSONL 长期记忆检索。 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { Message } from "../src/core/types.js";
import { applyWindow } from "../src/memory/buffer.js";
import { JsonlLongTermMemory } from "../src/memory/store.js";
import { SummaryMemory } from "../src/memory/summary.js";
import { FakeLLM, finalResponse } from "./fakes.js";

/** 造一条指定字符数的消息（估算 token ≈ 字符数 / 2） */
function msg(role: Message["role"], chars: number, extra: Partial<Message> = {}): Message {
  return { role, content: "x".repeat(chars), ...extra };
}

describe("applyWindow 滑窗", () => {
  it("始终保留首条 system，并在预算内保留最近消息", () => {
    const messages: Message[] = [
      { role: "system", content: "S" },
      msg("user", 100), // 54 token
      msg("assistant", 100), // 54 token
      msg("user", 100), // 54 token
    ];
    const { kept, dropped } = applyWindow(messages, 120);

    expect(kept[0]!.role).toBe("system");
    expect(kept).toHaveLength(3);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.content).toBe("x".repeat(100));
  });

  it("预算极小时也至少保留一条（不会裁空）", () => {
    const messages: Message[] = [{ role: "system", content: "S" }, msg("user", 4000)];
    const { kept } = applyWindow(messages, 10);
    expect(kept).toHaveLength(2);
  });

  it("不会从孤立的 tool 消息开始保留（避免配对 assistant 被裁掉导致 API 报错）", () => {
    const messages: Message[] = [
      { role: "system", content: "S" },
      msg("assistant", 1000, {
        toolCalls: [{ id: "c1", name: "calculator", arguments: {} }],
      }),
      msg("tool", 200, { toolCallId: "c1", name: "calculator" }),
      msg("user", 200),
    ];
    const { kept, dropped } = applyWindow(messages, 250);

    expect(kept[0]!.role).toBe("system");
    expect(kept[1]!.role).toBe("user");
    // 配对的 assistant 与 tool 一起被裁掉
    expect(dropped.map((item) => item.role)).toEqual(["assistant", "tool"]);
  });
});

describe("SummaryMemory 摘要", () => {
  const messages: Message[] = [
    { role: "system", content: "S" },
    msg("user", 200),
    msg("assistant", 200),
    msg("user", 40),
  ];

  it("被裁掉的历史超过阈值时调用 LLM 压缩并保存摘要", async () => {
    const fake = new FakeLLM([finalResponse("用户想了解 DeepSeek 发布时间")]);
    const memory = new SummaryMemory(fake, {
      maxTokens: 60,
      summarizeThreshold: 20,
      maxSummaryChars: 200,
    });

    const kept = await memory.prepare(messages);

    expect(fake.calls).toHaveLength(1);
    expect(memory.currentSummary).toContain("DeepSeek");
    expect(kept[0]!.role).toBe("system");
  });

  it("未达阈值时不额外调用 LLM", async () => {
    const fake = new FakeLLM([]);
    const memory = new SummaryMemory(fake, {
      maxTokens: 60,
      summarizeThreshold: 100000,
      maxSummaryChars: 200,
    });

    await memory.prepare(messages);

    expect(fake.calls).toHaveLength(0);
    expect(memory.currentSummary).toBe("");
  });

  it("压缩失败时保留旧摘要且不抛异常", async () => {
    const fake = new FakeLLM([]); // 脚本为空，调用即抛错
    const memory = new SummaryMemory(fake, {
      maxTokens: 60,
      summarizeThreshold: 20,
      maxSummaryChars: 200,
    });

    await expect(memory.prepare(messages)).resolves.toBeDefined();
    expect(memory.currentSummary).toBe("");
  });
});

describe("JsonlLongTermMemory 长期记忆", () => {
  async function makeStore(): Promise<JsonlLongTermMemory> {
    const dir = await mkdtemp(join(tmpdir(), "miniagent-memory-"));
    return new JsonlLongTermMemory(join(dir, "long_term.jsonl"));
  }

  it("按关键词检索并带上时间衰减", async () => {
    const store = await makeStore();
    const now = Date.now() / 1000;
    await store.add({ text: "问：DeepSeek 什么时候发布", ts: now });
    await store.add({ text: "问：今天天气如何", ts: now });

    const hits = await store.search("DeepSeek");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.text).toContain("DeepSeek");
  });

  it("无命中或文件不存在时返回空数组", async () => {
    const store = await makeStore();
    expect(await store.search("任意关键词")).toEqual([]);

    await store.add({ text: "问：Rust 的所有权机制", ts: Date.now() / 1000 });
    expect(await store.search("python")).toEqual([]);
  });

  it("load 返回最近若干条", async () => {
    const store = await makeStore();
    const now = Date.now() / 1000;
    for (let i = 0; i < 5; i++) await store.add({ text: `记录 ${i}`, ts: now });
    expect(await store.load(2)).toHaveLength(2);
  });
});
