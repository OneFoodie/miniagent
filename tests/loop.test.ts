/** Agent 主循环测试：工具序列、并发、最大轮次、取消。 */

import { mkdir, mkdtemp, readFile, readdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { Agent, foldOldToolResults, truncateToolResult } from "../src/agent/agent.js";
import { AgentContext } from "../src/agent/context.js";
import { loadSettings } from "../src/core/config.js";
import {
  AgentCancelledError,
  AgentLimitError,
} from "../src/core/errors.js";
import { EventBus, EventType, WILDCARD } from "../src/core/events.js";
import type { LLMResponse, Message } from "../src/core/types.js";
import { calculator } from "../src/tools/builtins/calculator.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { FakeLLM, finalResponse, toolCallResponse } from "./fakes.js";

/**
 * 测试临时目录：默认配置会把运行存档与卸载产物写进仓库目录（`./checkpoints`、`./workspace`），
 * 而本文件有故意跑失败/跑满轮次的用例，留下的存档会污染工作区。统一挪到系统临时目录。
 */
const SCRATCH = join(tmpdir(), "miniagent-loop-tests");

/** 用假 Key + 小轮次构造测试配置 */
function testSettings() {
  process.env.MINIAGENT_DEEPSEEK_API_KEY = "test-key";
  process.env.MINIAGENT_MAX_ITERATIONS = "3";
  const settings = loadSettings();
  return {
    ...settings,
    workspace: join(SCRATCH, "workspace"),
    checkpointDir: join(SCRATCH, "checkpoints"),
  };
}

function makeAgent(fake: FakeLLM): Agent {
  const registry = new ToolRegistry();
  registry.register(calculator);
  return new Agent(fake, registry, testSettings(), new EventBus());
}

describe("Agent loop", () => {
  it("记录本次运行的执行事实（成功与失败都记）", async () => {
    const fake = new FakeLLM([
      toolCallResponse([
        ["call_1", "calculator", { expression: "1+1" }],
        ["call_2", "no_such_tool", {}],
      ]),
      finalResponse("好了"),
    ]);
    const result = await makeAgent(fake).run("算一下");

    // 这份事实会进会话历史与运行存档，是下一轮判断「这步到底做没做过」的依据
    expect(result.context.tools).toEqual([
      { name: "calculator", ok: true },
      { name: "no_such_tool", ok: false },
    ]);
  });

  it("先调用工具再回答", async () => {
    const fake = new FakeLLM([
      toolCallResponse([["call_1", "calculator", { expression: "1+2*3" }]]),
      finalResponse("答案是 7"),
    ]);
    const result = await makeAgent(fake).run("帮我算一下");

    expect(result.answer).toBe("答案是 7");
    expect(result.context.iterations).toBe(1);
    expect(
      result.context.usage.promptTokens + result.context.usage.completionTokens,
    ).toBe(15);
    // 第一次调用确实把工具定义传给了模型
    expect(fake.calls[0]!.tools).toBeDefined();
    expect(fake.calls[0]!.tools).not.toHaveLength(0);
    // 消息序列: system, user, assistant(toolCall), tool, assistant(final)
    expect(result.messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    const toolMessage = result.messages[3]!;
    expect(toolMessage.toolCallId).toBe("call_1");
    expect(toolMessage.content).toContain("7");
  });

  it("一轮内并发调用多个工具", async () => {
    const fake = new FakeLLM([
      toolCallResponse([
        ["c1", "calculator", { expression: "2+2" }],
        ["c2", "calculator", { expression: "10-4" }],
      ]),
      finalResponse("两个结果都算好了"),
    ]);
    const result = await makeAgent(fake).run("并发算两个");

    const toolMessages = result.messages.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages.map((m) => m.toolCallId).sort()).toEqual(["c1", "c2"]);
  });

  it("工具失败对模型可见", async () => {
    const fake = new FakeLLM([
      toolCallResponse([["c1", "calculator", { expression: "1 +" }]]),
      finalResponse("表达式有误，已告知用户"),
    ]);
    const result = await makeAgent(fake).run("算个错的表达式");

    const toolMessage = result.messages.find((m) => m.role === "tool")!;
    expect(toolMessage.content).toContain("工具执行失败");
  });

  it("超过最大轮次抛错", async () => {
    const looping = toolCallResponse([
      ["c1", "calculator", { expression: "1+1" }],
    ]);
    const fake = new FakeLLM([looping, looping, looping]);
    await expect(makeAgent(fake).run("无限循环")).rejects.toBeInstanceOf(
      AgentLimitError,
    );
    expect(fake.calls).toHaveLength(3);
  });

  it("模型重试耗尽时发出 llm_error 事件", async () => {
    const bus = new EventBus();
    const types: string[] = [];
    bus.subscribe(WILDCARD, async (event) => {
      types.push(event.type);
    });

    const failing = {
      async chat(): Promise<LLMResponse> {
        throw new Error("429 重试耗尽");
      },
    };
    await expect(
      new Agent(failing, new ToolRegistry(), testSettings(), bus).run("随便问", []),
    ).rejects.toThrow("429");

    expect(types).toContain(EventType.LLMError);
    // 事件在抛错之前发出，且带上轮次信息，便于定位是第几轮挂的
    expect(types.indexOf(EventType.LLMError)).toBeLessThan(types.length);
  });

  it("取消不算模型失败——不发 llm_error", async () => {
    const bus = new EventBus();
    const types: string[] = [];
    bus.subscribe(WILDCARD, async (event) => {
      types.push(event.type);
    });

    const slowLLM = {
      async chat(
        _messages: unknown[],
        _tools?: unknown[],
        signal?: AbortSignal,
      ): Promise<LLMResponse> {
        return new Promise<LLMResponse>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      },
    };
    const ctx = new AgentContext();
    const runPromise = new Agent(
      slowLLM,
      new ToolRegistry(),
      testSettings(),
      bus,
    ).run("慢慢想", [], ctx);
    setTimeout(() => ctx.requestCancel(), 20);

    await expect(runPromise).rejects.toBeInstanceOf(AgentCancelledError);
    expect(types).not.toContain(EventType.LLMError);
  });

  it("迭代前取消立即生效", async () => {
    const fake = new FakeLLM([
      toolCallResponse([["c1", "calculator", { expression: "1+1" }]]),
    ]);
    const ctx = new AgentContext();
    ctx.requestCancel();

    await expect(
      makeAgent(fake).run("还没开始就取消", [], ctx),
    ).rejects.toBeInstanceOf(AgentCancelledError);
    // 取消在迭代边界生效，一次 LLM 都不应调用
    expect(fake.calls).toHaveLength(0);
  });

  it("LLM 在途时取消，立即中断等待", async () => {
    // 模拟一个"挂起"的 LLM：收到 abort 才失败，否则 30s 后才返回
    const slowLLM = {
      async chat(
        _messages: unknown[],
        _tools?: unknown[],
        signal?: AbortSignal,
      ): Promise<LLMResponse> {
        return new Promise<LLMResponse>((resolve, reject) => {
          const timer = setTimeout(
            () => resolve(finalResponse("不该等到我")),
            30_000,
          );
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
      },
    };
    const ctx = new AgentContext();
    const agent = new Agent(
      slowLLM,
      new ToolRegistry(),
      testSettings(),
      new EventBus(),
    );

    const runPromise = agent.run("慢慢想", [], ctx);
    // 50ms 后（LLM 已在途）点击停止
    setTimeout(() => ctx.requestCancel(), 50);

    const start = performance.now();
    await expect(runPromise).rejects.toBeInstanceOf(AgentCancelledError);
    // 应在毫秒级结束，而不是等到超时
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe("循环内上下文收紧（foldOldToolResults）", () => {
  /** 造一批「assistant 带 tool_calls + 对应 tool 结果」的结构完整消息 */
  function withToolResults(texts: string[]): Message[] {
    return [
      { role: "user", content: "问题" },
      {
        role: "assistant",
        content: "",
        toolCalls: texts.map((_, index) => ({
          id: `c${index}`,
          name: "t",
          arguments: {},
        })),
      },
      ...texts.map((text, index) => ({
        role: "tool" as const,
        content: text,
        toolCallId: `c${index}`,
        name: "t",
      })),
    ];
  }

  it("预算内完全不动", () => {
    const messages = withToolResults(["x".repeat(100)]);
    const result = foldOldToolResults(messages, 1000);

    expect(result.folded).toBe(0);
    expect(result.tokensBefore).toBe(result.tokensAfter);
    expect(messages[2]!.content).toHaveLength(100);
  });

  it("预算为 0 表示不限制", () => {
    const messages = withToolResults(["x".repeat(10_000)]);
    expect(foldOldToolResults(messages, 0).folded).toBe(0);
  });

  it("超预算时从最早折叠，且不破坏 tool_calls 配对结构", () => {
    const messages = withToolResults(["a".repeat(1000), "b".repeat(1000), "c".repeat(1000)]);
    // 保护最新一条（模拟「本批结果」）
    const result = foldOldToolResults(messages, 300, 1);

    expect(result.folded).toBeGreaterThan(0);
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);

    // 结构必须完整：消息条数不变、toolCallId 不变、assistant 的 toolCalls 还在
    expect(messages).toHaveLength(5);
    expect(messages[1]!.toolCalls).toHaveLength(3);
    expect(messages.slice(2).map((item) => item.toolCallId)).toEqual(["c0", "c1", "c2"]);

    // 最早的被折叠，最新的原文保留（模型还没看过，折叠等于抽走行动依据）
    expect(messages[2]!.content).toContain("已折叠");
    expect(messages[3]!.content).toContain("已折叠");
    expect(messages[4]!.content).toBe("c".repeat(1000));
  });

  it("本批结果全受保护时一条都不折叠", () => {
    const messages = withToolResults(["a".repeat(1000), "b".repeat(1000)]);
    const result = foldOldToolResults(messages, 10, 2);

    expect(result.folded).toBe(0);
    expect(messages[2]!.content).toBe("a".repeat(1000));
  });

  it("主循环超预算时折叠并发出 context_trim 事件", async () => {
    const huge = "乙".repeat(1200);
    // 两轮工具调用：第一轮的结果才会成为折叠对象（本批受保护）
    const fake = new FakeLLM([
      toolCallResponse([["c1", "calculator", { expression: "1+1" }]]),
      toolCallResponse([["c2", "calculator", { expression: "2+2" }]]),
      finalResponse("好了"),
    ]);
    const registry = new ToolRegistry();
    registry.register({
      name: "calculator",
      description: "测试替身",
      run: async () => ({ ok: true, data: { text: huge } }),
      toPayload: () => ({}),
    });

    const bus = new EventBus();
    const trims: Array<Record<string, unknown>> = [];
    bus.subscribe(EventType.ContextTrim, async (event) => {
      trims.push(event.payload);
    });

    // 单条上限放开，确保折叠是「整体预算」触发的，而不是单条截断/卸载
    const agent = new Agent(
      fake,
      registry,
      { ...testSettings(), toolResultMaxChars: 0, memoryMaxTokens: 200 },
      bus,
    );
    const result = await agent.run("随便问问", [], new AgentContext());

    expect(result.answer).toBe("好了");
    expect(trims).toHaveLength(1);
    expect(Number(trims[0]!.folded)).toBeGreaterThan(0);
    // 回灌给模型的内容确实变小了
    expect(Number(trims[0]!.tokens_after)).toBeLessThan(Number(trims[0]!.tokens_before));
    // 最新一轮的工具结果仍保留原文
    const toolMessages = result.messages.filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[1]!.content).toContain(huge);
  });
});

describe("卸载产物保留策略在主循环中生效", () => {
  it("每次运行前清理历史 offload 目录", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "miniagent-loop-prune-"));
    const offload = join(workspace, "offload");
    for (let index = 0; index < 3; index += 1) {
      const dir = join(offload, `old${index}`);
      await mkdir(dir, { recursive: true });
      const stamp = new Date(1_700_000_000_000 + index * 60_000);
      await utimes(dir, stamp, stamp);
    }

    const agent = new Agent(
      new FakeLLM([finalResponse("好")]),
      new ToolRegistry(),
      { ...testSettings(), workspace, offloadKeepRuns: 1 },
      new EventBus(),
    );
    await agent.run("随便问问", []);

    // 只留下最新的一个
    expect((await readdir(offload)).sort()).toEqual(["old2"]);
  });
});

describe("truncateToolResult 工具结果截断", () => {
  it("未超上限时原样返回", () => {
    expect(truncateToolResult("短内容", 100)).toBe("短内容");
  });

  it("超上限时截断并标注原始长度", () => {
    const content = "甲".repeat(200);
    const result = truncateToolResult(content, 50);

    expect(result.startsWith("甲".repeat(50))).toBe(true);
    // 必须明确告知被截断，否则模型会把半截内容当成完整内容
    expect(result).toContain("已截断");
    expect(result).toContain("200");
  });

  it("上限为 0 表示不限制", () => {
    const content = "甲".repeat(500);
    expect(truncateToolResult(content, 0)).toBe(content);
  });

  it("回灌的工具结果超限时被卸载到 workspace，而不是丢弃", async () => {
    const huge = "乙".repeat(5000);
    const fake = new FakeLLM([
      toolCallResponse([["c1", "calculator", { expression: "1+1" }]]),
      finalResponse("好"),
    ]);
    const registry = new ToolRegistry();
    // 冒充一个返回超大结果的工具
    registry.register({
      name: "calculator",
      description: "测试替身",
      run: async () => ({ ok: true, data: { text: huge } }),
      toPayload: () => ({}),
    });

    const workspace = await mkdtemp(join(tmpdir(), "miniagent-loop-offload-"));
    const agent = new Agent(
      fake,
      registry,
      { ...testSettings(), workspace },
      new EventBus(),
    );
    const result = await agent.run("随便问问", [], new AgentContext());

    const toolMessage = result.messages.find((message) => message.role === "tool");
    expect(toolMessage).toBeDefined();
    expect(toolMessage!.content.length).toBeLessThan(huge.length);
    expect(toolMessage!.content).toContain("完整内容保存在");

    // 完整内容真的落盘了，agent 可以再 read_file 取回
    const offloaded = join(
      workspace,
      "offload",
      result.context.runId,
      "calculator-c1.txt",
    );
    expect(await readFile(offloaded, "utf-8")).toBe(JSON.stringify({ text: huge }));
  });
});
