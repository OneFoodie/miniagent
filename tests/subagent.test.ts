/**
 * 子 agent 的角色化与并行派发。
 *
 * 三块都要钉住：
 *  - **角色真的换了东西**：提示词里出现角色段、工具集按白名单裁剪（不是只改语气）；
 *  - **并行是真的并行**：用并发探针测最大并发数，而不是拿耗时做断言；
 *  - **失败互相隔离**：一个子任务炸了，其他子任务的结论照常回传。
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AgentContext } from "../src/agent/context.js";
import { loadSettings, type Settings } from "../src/core/config.js";
import { LLMError } from "../src/core/errors.js";
import { EventBus, WILDCARD, type Event } from "../src/core/events.js";
import type { LLMResponse, Message } from "../src/core/types.js";
import type { BaseLLM } from "../src/llm/base.js";
import { createDefaultPromptBuilder } from "../src/prompts/system.js";
import { findRole, knownRoles, promptBuilderForRole } from "../src/prompts/roles.js";
import { calculator } from "../src/tools/builtins/calculator.js";
import {
  childRegistryOf,
  registerSubagent,
  SUBAGENT_PARALLEL_TOOL_NAME,
  SUBAGENT_TOOL_NAME,
} from "../src/tools/builtins/subagent.js";
import { defineTool } from "../src/tools/base.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { ToolRuntime } from "../src/tools/runtime.js";
import { FakeLLM, finalResponse } from "./fakes.js";

function testSettings(overrides: Partial<Settings> = {}): Settings {
  process.env.MINIAGENT_DEEPSEEK_API_KEY = "test-key";
  return {
    ...loadSettings(),
    // 子 agent 单测不关心中断恢复，但也别把存档写进仓库目录
    checkpointEnabled: false,
    workspace: join(tmpdir(), "miniagent-subagent-ws"),
    ...overrides,
  };
}

/** 只为测角色白名单用的假工具：复核员不该拿到它 */
const writeStub = defineTool({
  name: "write_file",
  description: "写文件（测试替身）",
  args: z.object({ path: z.string() }),
  handler: async () => "ok",
});

function makeRegistry(llm: BaseLLM, settings = testSettings()): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(calculator);
  registry.register(writeStub);
  registerSubagent(registry, {
    llm,
    settings,
    childRegistry: (role) => childRegistryOf(registry, role),
  });
  return registry;
}

/** 并发探针：记录同时在飞的模型调用数，并原样把任务回显成结论 */
class ConcurrencyProbe implements BaseLLM {
  inFlight = 0;
  maxInFlight = 0;
  readonly systemPrompts: string[] = [];

  constructor(
    private readonly delayMs = 20,
    private readonly failOn?: string,
  ) {}

  async chat(messages: Message[]): Promise<LLMResponse> {
    this.systemPrompts.push(String(messages[0]?.content ?? ""));
    const task = String(messages.at(-1)?.content ?? "");
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      if (this.failOn && task.includes(this.failOn)) {
        throw new LLMError("模拟模型失败");
      }
      return finalResponse(`结论: ${task}`);
    } finally {
      this.inFlight -= 1;
    }
  }
}

describe("角色预设", () => {
  it("没有角色时提示词与版本号完全不变（不影响既有快照与归因）", () => {
    const plain = createDefaultPromptBuilder().build({
      skills: [],
      memorySummary: "",
      recalledMemory: [],
      toolNames: ["calculator"],
    });
    const noRole = promptBuilderForRole().build({
      skills: [],
      memorySummary: "",
      recalledMemory: [],
      toolNames: ["calculator"],
    });

    expect(noRole.text).toBe(plain.text);
    expect(noRole.versions).toEqual(plain.versions);
  });

  it("选了角色就多出一个角色段，且紧跟在身份段之后", () => {
    const critic = findRole("critic")!;
    const built = promptBuilderForRole(critic).build({
      skills: [],
      memorySummary: "",
      recalledMemory: [],
      toolNames: ["calculator"],
    });

    expect(built.versions).toContain("role_critic@1.0.0");
    expect(built.text).toContain("复核员");
    // 顺序：身份 → 角色 → 核心原则
    expect(built.text.indexOf("复核员")).toBeLessThan(built.text.indexOf("## 核心原则"));
  });

  it("角色名大小写不敏感，未知角色返回 undefined", () => {
    expect(findRole("Critic")?.name).toBe("critic");
    expect(findRole("nonexistent")).toBeUndefined();
    expect(knownRoles()).toContain("researcher");
  });
});

describe("角色决定工具集", () => {
  it("复核员拿不到写文件权限，分析员保留 calculator", () => {
    const registry = makeRegistry(new FakeLLM([]));

    const criticTools = childRegistryOf(registry, findRole("critic")).all().map((t) => t.name);
    expect(criticTools).not.toContain("write_file");
    expect(criticTools).not.toContain("calculator");

    const analystTools = childRegistryOf(registry, findRole("analyst")).all().map((t) => t.name);
    expect(analystTools).toContain("calculator");
    expect(analystTools).not.toContain("write_file");
  });

  it("白名单严格生效：一个都不匹配时也不放行额外工具", () => {
    const registry = new ToolRegistry();
    registry.register(calculator);

    // critic 的白名单里没有 calculator，即便它是注册表里唯一的工具也不给
    const child = childRegistryOf(registry, findRole("critic"));
    expect(child.all()).toHaveLength(0);
  });

  it("子工具集永远不含两个派发工具——递归深度仍为 1", () => {
    const registry = makeRegistry(new FakeLLM([]));
    const child = childRegistryOf(registry);
    expect(child.has(SUBAGENT_TOOL_NAME)).toBe(false);
    expect(child.has(SUBAGENT_PARALLEL_TOOL_NAME)).toBe(false);
  });
});

describe("run_subagent 角色接线", () => {
  it("传 role 后，子 agent 的系统提示词里出现角色段", async () => {
    const fake = new FakeLLM([finalResponse("复核意见")]);
    const result = await makeRegistry(fake)
      .get(SUBAGENT_TOOL_NAME)
      .run({ task: "复核这个结论", role: "critic" });

    expect(result.ok).toBe(true);
    expect((result.data as { role: string }).role).toBe("critic");
    const systemPrompt = String(fake.calls[0]!.messages[0]!.content);
    expect(systemPrompt).toContain("复核员");
  });

  it("不传 role 时用通用助手，系统提示词不带角色段", async () => {
    const fake = new FakeLLM([finalResponse("结论")]);
    const result = await makeRegistry(fake)
      .get(SUBAGENT_TOOL_NAME)
      .run({ task: "查一下" });

    expect((result.data as { role: string }).role).toBe("general");
    expect(String(fake.calls[0]!.messages[0]!.content)).not.toContain("## 角色");
  });

  it("未知角色直接报错并列出候选", async () => {
    const result = await makeRegistry(new FakeLLM([]))
      .get(SUBAGENT_TOOL_NAME)
      .run({ task: "查一下", role: "hacker" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("未知角色");
    expect(result.error).toContain("critic");
  });
});

describe("run_subagents 并行派发", () => {
  it("多个子任务真的同时在跑", async () => {
    const probe = new ConcurrencyProbe(20);
    const result = await makeRegistry(probe)
      .get(SUBAGENT_PARALLEL_TOOL_NAME)
      .run({ tasks: [{ task: "A" }, { task: "B" }, { task: "C" }] });

    expect(result.ok).toBe(true);
    const data = result.data as { succeeded: number; total: number };
    expect(data.total).toBe(3);
    expect(data.succeeded).toBe(3);
    // 串行的话最大并发只会是 1
    expect(probe.maxInFlight).toBe(3);
  });

  it("每个子任务的结论与自己的任务对应", async () => {
    const probe = new ConcurrencyProbe(5);
    const result = await makeRegistry(probe)
      .get(SUBAGENT_PARALLEL_TOOL_NAME)
      .run({ tasks: [{ task: "甲" }, { task: "乙" }] });

    const results = (result.data as { results: Array<{ task: string; answer: string }> })
      .results;
    for (const item of results) {
      expect(item.answer).toBe(`结论: ${item.task}`);
    }
  });

  it("可以给同批不同子任务指定不同角色", async () => {
    const probe = new ConcurrencyProbe(5);
    const result = await makeRegistry(probe)
      .get(SUBAGENT_PARALLEL_TOOL_NAME)
      .run({
        tasks: [
          { task: "调研", role: "researcher" },
          { task: "复核", role: "critic" },
        ],
      });

    const results = (
      result.data as { results: Array<{ role: string }> }
    ).results;
    expect(results.map((item) => item.role).sort()).toEqual(["critic", "researcher"]);
    expect(probe.systemPrompts.some((text) => text.includes("调研员"))).toBe(true);
    expect(probe.systemPrompts.some((text) => text.includes("复核员"))).toBe(true);
  });

  it("一个子任务失败不影响其他子任务的产出", async () => {
    const probe = new ConcurrencyProbe(5, "会失败");
    const result = await makeRegistry(probe)
      .get(SUBAGENT_PARALLEL_TOOL_NAME)
      .run({ tasks: [{ task: "正常任务" }, { task: "会失败的任务" }] });

    const data = result.data as {
      succeeded: number;
      total: number;
      results: Array<{ ok: boolean; error?: string }>;
    };
    expect(data.succeeded).toBe(1);
    expect(data.total).toBe(2);
    expect(data.results.filter((item) => !item.ok)[0]?.error).toContain("模拟模型失败");
  });

  it("子任务数量越界被参数校验拦下", async () => {
    const tool = makeRegistry(new FakeLLM([])).get(SUBAGENT_PARALLEL_TOOL_NAME);

    const tooFew = await tool.run({ tasks: [{ task: "只有一个" }] });
    expect(tooFew.ok).toBe(false);
    expect(tooFew.error).toContain("参数校验失败");

    const tooMany = await tool.run({
      tasks: Array.from({ length: 6 }, (_, index) => ({ task: `任务${index}` })),
    });
    expect(tooMany.ok).toBe(false);
  });

  it("并行时中继事件带 sub_role / sub_label，能分辨是谁做的", async () => {
    const parentBus = new EventBus();
    const events: Event[] = [];
    parentBus.subscribe(WILDCARD, async (event) => {
      events.push(event);
    });

    const probe = new ConcurrencyProbe(5);
    const registry = makeRegistry(probe);
    // 必须走 ToolRuntime：作用域是在那里注入的（直接调 tool.run 拿不到父总线）
    const runtime = new ToolRuntime(registry, 4, 10);
    const context = new AgentContext();
    await runtime.executeBatch(
      [
        {
          id: "call_parallel",
          name: SUBAGENT_PARALLEL_TOOL_NAME,
          arguments: {
            tasks: [
              { task: "第一批资料", role: "researcher" },
              { task: "第二批资料", role: "critic" },
            ],
          },
        },
      ],
      context.runId,
      parentBus,
      context.signal,
    );

    const relayed = events.filter((event) => event.payload.from_subagent === true);
    expect(relayed.length).toBeGreaterThan(0);
    // run 级事件不参与区分，只看模型调用
    const llmStarts = relayed.filter((event) => event.type === "llm_start");
    expect(llmStarts.length).toBeGreaterThanOrEqual(2);
    expect(new Set(llmStarts.map((event) => event.payload.sub_role))).toEqual(
      new Set(["researcher", "critic"]),
    );
    // 每个子 agent 有独立的 sub_run_id，事件才不会被搅在一起
    expect(new Set(llmStarts.map((event) => event.payload.sub_run_id)).size).toBe(2);
  });
});
