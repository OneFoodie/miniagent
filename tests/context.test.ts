/** 上下文处理：摘要的措辞保护、预算按窗口推导、工具结果卸载、子 agent 隔离。 */

import { mkdir, mkdtemp, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { offloadToolResult, pruneOffloadDir } from "../src/agent/agent.js";
import { AgentContext } from "../src/agent/context.js";
import { loadSettings, type Settings } from "../src/core/config.js";
import { EventBus, WILDCARD, type Event } from "../src/core/events.js";
import type { Message } from "../src/core/types.js";
import { SummaryMemory } from "../src/memory/summary.js";
import { calculator } from "../src/tools/builtins/calculator.js";
import {
  childRegistryOf,
  registerSubagent,
  SUBAGENT_TOOL_NAME,
} from "../src/tools/builtins/subagent.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { ToolRuntime } from "../src/tools/runtime.js";
import { FakeLLM, finalResponse, toolCallResponse } from "./fakes.js";

function testSettings(overrides: Partial<Settings> = {}): Settings {
  process.env.MINIAGENT_DEEPSEEK_API_KEY = "test-key";
  return { ...loadSettings(), ...overrides };
}

function msg(role: Message["role"], chars: number): Message {
  return { role, content: "x".repeat(chars) };
}

describe("摘要 prompt 保护精确措辞", () => {
  it("要求指令与约束逐字引用，而不是概括", async () => {
    const fake = new FakeLLM([finalResponse("【指令与约束】无\n\n【摘要】随便")]);
    const memory = new SummaryMemory(fake, {
      maxTokens: 60,
      summarizeThreshold: 10,
      maxSummaryChars: 400,
    });

    // 三条 200 字消息在 60 token 预算下必然裁掉前两条，触发压缩
    await memory.prepare([msg("user", 200), msg("assistant", 200), msg("user", 200)]);

    expect(fake.calls).toHaveLength(1);
    const prompt = fake.calls[0]!.messages[0]!.content;
    expect(prompt).toContain("【指令与约束】");
    expect(prompt).toContain("逐字引用原文");
    expect(prompt).toContain("不要改写");
  });
});

describe("历史预算按模型窗口推导", () => {
  it("默认按 128K 窗口 × 0.25 推导", () => {
    delete process.env.MINIAGENT_MODEL_CONTEXT_TOKENS;
    delete process.env.MINIAGENT_MEMORY_BUDGET_RATIO;
    delete process.env.MINIAGENT_MEMORY_MAX_TOKENS;

    const settings = loadSettings();
    expect(settings.modelContextTokens).toBe(131072);
    expect(settings.memoryBudgetRatio).toBe(0.25);
    expect(settings.memoryMaxTokens).toBe(Math.floor(131072 * 0.25));
  });

  it("换模型只改窗口，预算自动跟着变——不必再调预算", () => {
    process.env.MINIAGENT_MODEL_CONTEXT_TOKENS = "32768";
    try {
      const settings = loadSettings();
      expect(settings.memoryMaxTokens).toBe(Math.floor(32768 * 0.25));
    } finally {
      delete process.env.MINIAGENT_MODEL_CONTEXT_TOKENS;
    }
  });

  it("显式配置预算时优先于推导值", () => {
    process.env.MINIAGENT_MEMORY_MAX_TOKENS = "5000";
    try {
      expect(loadSettings().memoryMaxTokens).toBe(5000);
    } finally {
      delete process.env.MINIAGENT_MEMORY_MAX_TOKENS;
    }
  });
});

describe("工具结果卸载（Offload）", () => {
  it("超限时写入 workspace，并留下可用 read_file 读回的路径", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "miniagent-offload-"));
    const content = "甲".repeat(200);

    const result = await offloadToolResult(content, {
      maxChars: 50,
      toolName: "web_search",
      callId: "c1",
      runId: "r1",
      workspace,
    });

    expect(result.startsWith("甲".repeat(50))).toBe(true);
    expect(result).toContain("完整内容保存在 offload/r1/web_search-c1.txt");

    // 关键：内容确实落盘了，且路径就在文件沙箱内（read_file 的根就是 workspace）
    const saved = await readFile(
      join(workspace, "offload", "r1", "web_search-c1.txt"),
      "utf-8",
    );
    expect(saved).toBe(content);
  });

  it("未超限时原样返回，不写盘", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "miniagent-offload-"));
    const result = await offloadToolResult("短内容", {
      maxChars: 50,
      toolName: "t",
      callId: "c",
      runId: "r",
      workspace,
    });
    expect(result).toBe("短内容");
  });

  it("上限为 0 表示不限制", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "miniagent-offload-"));
    const content = "甲".repeat(500);
    expect(
      await offloadToolResult(content, {
        maxChars: 0,
        toolName: "t",
        callId: "c",
        runId: "r",
        workspace,
      }),
    ).toBe(content);
  });

  it("写盘失败时退化为截断——卸载不该成为对话的故障点", async () => {
    const dir = await mkdtemp(join(tmpdir(), "miniagent-offload-"));
    // 拿一个「文件」当 workspace 根，mkdir 必然失败
    const workspace = join(dir, "not-a-dir");
    await writeFile(workspace, "x", "utf-8");

    const result = await offloadToolResult("甲".repeat(200), {
      maxChars: 50,
      toolName: "t",
      callId: "c",
      runId: "r",
      workspace,
    });

    expect(result).toContain("已截断");
  });
});

describe("卸载产物的保留策略", () => {
  /** 造 n 个 run 目录，mtime 显式递增（否则同毫秒创建时分不出新旧） */
  async function makeRuns(count: number): Promise<string> {
    const workspace = await mkdtemp(join(tmpdir(), "miniagent-prune-"));
    for (let index = 0; index < count; index += 1) {
      const dir = join(workspace, "offload", `run${index}`);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "t-c.txt"), "内容", "utf-8");
      const stamp = new Date(1_700_000_000_000 + index * 60_000);
      await utimes(dir, stamp, stamp);
    }
    return workspace;
  }

  it("只保留最近 N 个 run 目录，更早的删掉", async () => {
    const workspace = await makeRuns(5);
    const removed = await pruneOffloadDir(workspace, 2);

    expect(removed).toBe(3);
    const left = await readdir(join(workspace, "offload"));
    // 保留 mtime 最新的两个
    expect(left.sort()).toEqual(["run3", "run4"]);
  });

  it("数量未超过上限时不动任何东西", async () => {
    const workspace = await makeRuns(2);
    expect(await pruneOffloadDir(workspace, 2)).toBe(0);
    expect(await readdir(join(workspace, "offload"))).toHaveLength(2);
  });

  it("keep 为 0 表示不清理", async () => {
    const workspace = await makeRuns(3);
    expect(await pruneOffloadDir(workspace, 0)).toBe(0);
    expect(await readdir(join(workspace, "offload"))).toHaveLength(3);
  });

  it("目录不存在时安全返回（还没卸载过任何东西）", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "miniagent-prune-"));
    expect(await pruneOffloadDir(workspace, 2)).toBe(0);
  });
});

describe("子 agent 隔离（Isolate）", () => {
  function makeRegistry(llm: FakeLLM): ToolRegistry {
    const registry = new ToolRegistry();
    registerSubagent(registry, {
      llm,
      settings: testSettings(),
      childRegistry: () => childRegistryOf(registry),
    });
    return registry;
  }

  it("跑完后只回传结论与用量，中间步骤不回到父上下文", async () => {
    const fake = new FakeLLM([finalResponse("子 agent 的结论")]);
    const result = await makeRegistry(fake)
      .get(SUBAGENT_TOOL_NAME)
      .run({ task: "查一件事" });

    expect(result.ok).toBe(true);
    const data = result.data as { answer: string; tokens: number };
    expect(data.answer).toBe("子 agent 的结论");
    // 用量上报出来，父侧能看到这次隔离花了多少
    expect(data.tokens).toBe(15);
  });

  it("子工具集不含本工具——递归深度天然为 1", () => {
    const registry = makeRegistry(new FakeLLM([]));
    expect(registry.has(SUBAGENT_TOOL_NAME)).toBe(true);
    expect(childRegistryOf(registry).has(SUBAGENT_TOOL_NAME)).toBe(false);
  });

  it("声明了独立超时，否则会被工具的默认 30s 掐断", () => {
    const registry = makeRegistry(new FakeLLM([]));
    expect(registry.get(SUBAGENT_TOOL_NAME).timeoutSeconds).toBeGreaterThan(30);
  });

  it("参数校验：空任务被拒", async () => {
    const result = await makeRegistry(new FakeLLM([]))
      .get(SUBAGENT_TOOL_NAME)
      .run({ task: "" });
    expect(result.ok).toBe(false);
  });

  it("中间步骤中继到父轨迹，并带 sub_run_id 标记", async () => {
    const parentBus = new EventBus();
    const events: Event[] = [];
    parentBus.subscribe(WILDCARD, async (event) => {
      events.push(event);
    });

    // 子 agent：先调一次工具，再作答
    const fake = new FakeLLM([
      toolCallResponse([["c1", "calculator", { expression: "1+1" }]]),
      finalResponse("结论：2"),
    ]);
    const registry = new ToolRegistry();
    registry.register(calculator);
    registerSubagent(registry, {
      llm: fake,
      settings: testSettings(),
      childRegistry: () => childRegistryOf(registry),
    });

    // 必须走 ToolRuntime：作用域是在那里注入的（单测直接调 tool.run 拿不到总线）
    const runtime = new ToolRuntime(registry, 4, 10);
    const context = new AgentContext();
    await runtime.executeBatch(
      [{ id: "call_parent", name: SUBAGENT_TOOL_NAME, arguments: { task: "算 1+1" } }],
      context.runId,
      parentBus,
      context.signal,
    );

    const relayed = events.filter((event) => event.payload.from_subagent === true);
    expect(relayed.length).toBeGreaterThan(0);
    // 必须挂在父 runId 上，否则 Tracer 会另写一个孤立文件
    expect(relayed.every((event) => event.runId === context.runId)).toBe(true);
    // 子 agent 的模型调用进来了
    expect(relayed.some((event) => event.type === "llm_end")).toBe(true);
    // 子 agent 内部的工具调用也进来了，且保留了子 runId 供区分
    const innerToolEnd = relayed.find(
      (event) => event.type === "tool_end" && event.payload.name === "calculator",
    );
    expect(innerToolEnd).toBeDefined();
    expect(typeof innerToolEnd!.payload.sub_run_id).toBe("string");
    expect(innerToolEnd!.payload.sub_run_id).toBeTruthy();
  });
});
