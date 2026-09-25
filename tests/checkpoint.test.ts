/**
 * 运行存档（断点续跑）与人工审批测试。
 *
 * 两类场景都要覆盖：
 *  - **挂起等审批**：批了才执行、拒了不执行且模型知情
 *  - **进程中断后续跑**：从 checkpoint 恢复，不重跑已完成的迭代
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Agent } from "../src/agent/agent.js";
import {
  listCheckpoints,
  loadCheckpoint,
  recordApproval,
  removeCheckpoint,
  saveCheckpoint,
  type RunCheckpoint,
} from "../src/agent/checkpoint.js";
import { loadSettings, type Settings } from "../src/core/config.js";
import {
  AgentLimitError,
  ApprovalRequiredError,
  MiniAgentError,
} from "../src/core/errors.js";
import { EventBus, EventType } from "../src/core/events.js";
import { calculator } from "../src/tools/builtins/calculator.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { FakeLLM, finalResponse, toolCallResponse } from "./fakes.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "miniagent-ckpt-"));
  tempDirs.push(dir);
  return dir;
}

async function testSettings(overrides: Partial<Settings> = {}): Promise<Settings> {
  process.env.MINIAGENT_DEEPSEEK_API_KEY = "test-key";
  const root = await tempDir();
  return {
    ...loadSettings(),
    checkpointDir: join(root, "checkpoints"),
    workspace: join(root, "workspace"),
    ...overrides,
  };
}

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(calculator);
  return registry;
}

/** 造一份最小可用的存档 */
function checkpoint(runId: string, overrides: Partial<RunCheckpoint> = {}): RunCheckpoint {
  return {
    runId,
    input: "原始问题",
    createdAt: 1,
    updatedAt: 1,
    iterations: 2,
    usage: { promptTokens: 10, completionTokens: 5 },
    messages: [
      { role: "system", content: "系统" },
      { role: "user", content: "原始问题" },
    ],
    promptVersions: ["identity@1.0.0"],
    approvals: {},
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})),
  );
});

describe("运行存档的读写", () => {
  it("存 → 取 → 删 往返一致", async () => {
    const dir = await tempDir();
    await saveCheckpoint(dir, checkpoint("run_a"));

    const loaded = await loadCheckpoint(dir, "run_a");
    expect(loaded?.runId).toBe("run_a");
    expect(loaded?.iterations).toBe(2);
    expect(loaded?.messages).toHaveLength(2);

    await removeCheckpoint(dir, "run_a");
    expect(await loadCheckpoint(dir, "run_a")).toBeUndefined();
  });

  it("非法 runId 被拒绝，防止路径穿越", async () => {
    const dir = await tempDir();
    await expect(saveCheckpoint(dir, checkpoint("../../etc/passwd"))).rejects.toThrow("非法");
  });

  it("存档损坏时当作不存在，而不是抛错", async () => {
    const dir = await tempDir();
    await saveCheckpoint(dir, checkpoint("run_bad"));
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "run_bad.json"), "{ 不是 JSON", "utf-8");

    expect(await loadCheckpoint(dir, "run_bad")).toBeUndefined();
  });

  it("列表按最近更新倒序，并带出挂起信息", async () => {
    const dir = await tempDir();
    await saveCheckpoint(dir, { ...checkpoint("old"), updatedAt: 1 });
    await saveCheckpoint(dir, {
      ...checkpoint("new"),
      updatedAt: 999,
      pendingApproval: { callId: "c1", tool: "write_file", arguments: {} },
    });

    const list = await listCheckpoints(dir);
    expect(list.map((item) => item.runId)).toEqual(["new", "old"]);
    expect(list[0]!.pendingApproval?.tool).toBe("write_file");
  });

  it("记录审批决定会落盘（决定与续跑是两次请求）", async () => {
    const dir = await tempDir();
    await saveCheckpoint(dir, {
      ...checkpoint("run_c"),
      pendingApproval: { callId: "c1", tool: "calculator", arguments: {} },
    });

    const call = await recordApproval(dir, "run_c", false);
    expect(call?.callId).toBe("c1");
    expect((await loadCheckpoint(dir, "run_c"))?.approvals).toEqual({ c1: false });
  });
});

describe("人工审批（HITL）", () => {
  it("命中审批名单即挂起，不执行工具，并留下待批存档", async () => {
    const settings = await testSettings({ approvalTools: ["calculator"] });
    const fake = new FakeLLM([
      toolCallResponse([["c1", "calculator", { expression: "1+1" }]]),
    ]);
    const agent = new Agent(fake, makeRegistry(), settings, new EventBus());

    const error = await agent.run("算一下").catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ApprovalRequiredError);
    const approval = error as ApprovalRequiredError;
    expect(approval.call.name).toBe("calculator");
    expect(approval.call.id).toBe("c1");

    // 现场已落盘：恢复所需的一切都在
    const saved = await loadCheckpoint(settings.checkpointDir, approval.runId);
    expect(saved?.pendingApproval?.callId).toBe("c1");
    expect(saved?.iterations).toBe(0);
  });

  it("批准后接着执行，工具结果正常回灌", async () => {
    const settings = await testSettings({ approvalTools: ["calculator"] });
    const fake = new FakeLLM([
      toolCallResponse([["c1", "calculator", { expression: "1+1" }]]),
      finalResponse("等于 2"),
    ]);
    const registry = makeRegistry();
    const bus = new EventBus();
    const finished: string[] = [];
    bus.subscribe(EventType.ToolEnd, async (event) => {
      finished.push(String(event.payload.name));
    });

    const agent = new Agent(fake, registry, settings, bus);
    const runId = await agent
      .run("算一下")
      .then(() => "")
      .catch((err: unknown) => (err as ApprovalRequiredError).runId);

    const result = await agent.resume(runId, { approved: true });

    expect(result.answer).toBe("等于 2");
    expect(finished).toEqual(["calculator"]);
    // 成功即清档
    expect(await loadCheckpoint(settings.checkpointDir, runId)).toBeUndefined();
  });

  it("拒绝后不执行工具，并把「被人拒绝」如实告诉模型", async () => {
    const settings = await testSettings({ approvalTools: ["calculator"] });
    const fake = new FakeLLM([
      toolCallResponse([["c1", "calculator", { expression: "1+1" }]]),
      finalResponse("那我换个办法"),
    ]);
    const bus = new EventBus();
    const ran: string[] = [];
    bus.subscribe(EventType.ToolEnd, async (event) => {
      ran.push(String(event.payload.name));
    });

    const agent = new Agent(fake, makeRegistry(), settings, bus);
    const runId = await agent
      .run("算一下")
      .then(() => "")
      .catch((err: unknown) => (err as ApprovalRequiredError).runId);

    const result = await agent.resume(runId, { approved: false });

    expect(result.answer).toBe("那我换个办法");
    // 工具一次都没跑
    expect(ran).toEqual([]);
    const toolMessage = result.messages.find((message) => message.role === "tool");
    expect(toolMessage?.content).toContain("拒绝");
  });

  it("审批记录是持久化的：先记决定、再另起一个 Agent 续跑也能生效", async () => {
    const settings = await testSettings({ approvalTools: ["calculator"] });
    const first = new FakeLLM([
      toolCallResponse([["c1", "calculator", { expression: "2*3" }]]),
    ]);
    const runId = await new Agent(first, makeRegistry(), settings, new EventBus())
      .run("算一下")
      .then(() => "")
      .catch((err: unknown) => (err as ApprovalRequiredError).runId);

    // 模拟「决定与续跑是两次请求，中间进程重启」：换一个全新的 Agent 实例
    await recordApproval(settings.checkpointDir, runId, true);
    const second = new FakeLLM([finalResponse("等于 6")]);
    const result = await new Agent(second, makeRegistry(), settings, new EventBus()).resume(
      runId,
    );

    expect(result.answer).toBe("等于 6");
  });
});

describe("断点续跑", () => {
  it("从最后一轮的工具结果处接着跑，不重跑已完成的迭代", async () => {
    // 第一段：只允许 1 轮，于是第 1 轮跑完（存档已写）后因超轮次失败
    const settings = await testSettings({ maxIterations: 1 });
    const first = new FakeLLM([
      toolCallResponse([["c1", "calculator", { expression: "3*3" }]]),
    ]);
    const runId = await new Agent(first, makeRegistry(), settings, new EventBus())
      .run("算一下")
      .then(() => "")
      .catch((err: unknown) => {
        expect(err).toBeInstanceOf(AgentLimitError);
        return "";
      });
    expect(runId).toBe("");

    const list = await listCheckpoints(settings.checkpointDir);
    expect(list).toHaveLength(1);
    const saved = list[0]!;
    expect(saved.iterations).toBe(1);
    // 不是等审批，是「中断后待续跑」
    expect(saved.pendingApproval).toBeUndefined();

    // 第二段：放宽轮次上限后续跑；模型只需要给出最终答案（不用重跑第 1 轮）
    const resumed = new Agent(
      new FakeLLM([finalResponse("等于 9")]),
      makeRegistry(),
      await testSettings({ maxIterations: 3, checkpointDir: settings.checkpointDir }),
      new EventBus(),
    );
    const result = await resumed.resume(saved.runId);

    expect(result.answer).toBe("等于 9");
    // 恢复时沿用原 runId 与已完成的轮数
    expect(result.context.runId).toBe(saved.runId);
    // 已完成 1 轮工具迭代；收尾的最终作答不计入 iterations（口径与原实现一致）
    expect(result.context.iterations).toBe(1);
    // 原存档里的工具结果仍然在消息序列里
    expect(result.messages.some((message) => message.role === "tool")).toBe(true);
    // 挂起前的执行事实也跟着续跑过来：否则这一轮会「忘记自己上一轮做过什么」
    expect(result.context.tools).toEqual([{ name: "calculator", ok: true }]);
  });

  it("成功运行不留存档——磁盘上只留需要人看一眼的运行", async () => {
    const settings = await testSettings();
    const agent = new Agent(
      new FakeLLM([finalResponse("直接回答")]),
      makeRegistry(),
      settings,
      new EventBus(),
    );
    const result = await agent.run("你好");

    expect(await listCheckpoints(settings.checkpointDir)).toEqual([]);
    // 存档目录里确实什么都没有
    await expect(readFile(join(settings.checkpointDir, `${result.context.runId}.json`))).rejects.toThrow();
  });

  it("关掉存档开关后不写盘，续跑会被明确拒绝", async () => {
    const settings = await testSettings({ checkpointEnabled: false });
    const agent = new Agent(
      new FakeLLM([finalResponse("回答")]),
      makeRegistry(),
      settings,
      new EventBus(),
    );
    await agent.run("你好");

    await expect(agent.resume("whatever")).rejects.toBeInstanceOf(MiniAgentError);
  });

  it("存档不存在时续跑给出清晰错误", async () => {
    const settings = await testSettings();
    const agent = new Agent(
      new FakeLLM([finalResponse("回答")]),
      makeRegistry(),
      settings,
      new EventBus(),
    );
    await expect(agent.resume("no_such_run")).rejects.toThrow("找不到可续跑的运行存档");
  });
});
