/** 并发运行时测试：并发确实发生、故障隔离、超时与未注册工具处理。 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { EventBus } from "../src/core/events.js";
import type { ToolCall } from "../src/core/types.js";
import { defineTool } from "../src/tools/base.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { ToolRuntime } from "../src/tools/runtime.js";

interface ConcurrencyTracker {
  active: number;
  maxActive: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function slowTool(tracker: ConcurrencyTracker) {
  return defineTool({
    name: "slow_task",
    description: "睡眠指定毫秒并记录同时执行的任务数。",
    args: z.object({ delay: z.number() }),
    handler: async ({ delay }) => {
      tracker.active++;
      tracker.maxActive = Math.max(tracker.maxActive, tracker.active);
      await sleep(delay);
      tracker.active--;
      return { slept: delay };
    },
  });
}

const boom = defineTool({
  name: "boom",
  description: "总是抛出异常的工具。",
  args: z.object({}),
  handler: async () => {
    throw new Error("故意失败");
  },
});

const fine = defineTool({
  name: "fine",
  description: "正常返回的工具。",
  args: z.object({ value: z.number() }),
  handler: async ({ value }) => ({ value }),
});

function makeRuntime(
  tracker: ConcurrencyTracker,
  timeout = 30,
  concurrency = 8,
): ToolRuntime {
  const registry = new ToolRegistry();
  registry.register(slowTool(tracker));
  registry.register(boom);
  registry.register(fine);
  return new ToolRuntime(registry, concurrency, timeout);
}

function call(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id, name, arguments: args };
}

describe("ToolRuntime", () => {
  const signal = new AbortController().signal;

  it("工具真并发执行", async () => {
    const tracker: ConcurrencyTracker = { active: 0, maxActive: 0 };
    const runtime = makeRuntime(tracker);
    const calls = Array.from({ length: 4 }, (_, i) =>
      call(`c${i}`, "slow_task", { delay: 100 }),
    );

    const results = await runtime.executeBatch(calls, "r1", new EventBus(), signal);
    expect(results).toHaveLength(4);
    expect(results.every(([, r]) => r.ok)).toBe(true);
    // 4 个任务应同时在执行，证明是真并发而非串行
    expect(tracker.maxActive).toBe(4);
  });

  it("故障隔离", async () => {
    const tracker = { active: 0, maxActive: 0 };
    const runtime = makeRuntime(tracker);
    const results = new Map(
      await runtime.executeBatch(
        [call("bad", "boom"), call("good", "fine", { value: 42 })],
        "r2",
        new EventBus(),
        signal,
      ),
    );

    expect(results.get("bad")!.ok).toBe(false);
    expect(results.get("bad")!.error).toContain("故意失败");
    expect(results.get("good")!.ok).toBe(true);
    expect(results.get("good")!.data).toMatchObject({ value: 42 });
  });

  it("超时按单个工具生效", async () => {
    const tracker = { active: 0, maxActive: 0 };
    const runtime = makeRuntime(tracker, 0.05);
    const results = new Map(
      await runtime.executeBatch(
        [call("slow", "slow_task", { delay: 500 })],
        "r3",
        new EventBus(),
        signal,
      ),
    );
    expect(results.get("slow")!.ok).toBe(false);
    expect(results.get("slow")!.error).toContain("超时");
  });

  it("未注册工具不影响整批", async () => {
    const tracker = { active: 0, maxActive: 0 };
    const runtime = makeRuntime(tracker);
    const results = new Map(
      await runtime.executeBatch(
        [call("ghost", "does_not_exist"), call("ok", "fine", { value: 1 })],
        "r4",
        new EventBus(),
        signal,
      ),
    );
    expect(results.get("ghost")!.ok).toBe(false);
    expect(results.get("ghost")!.error).toContain("不存在");
    expect(results.get("ok")!.ok).toBe(true);
  });

  it("信号量限制并发度", async () => {
    const tracker = { active: 0, maxActive: 0 };
    const runtime = makeRuntime(tracker, 30, 2);
    const calls = Array.from({ length: 4 }, (_, i) =>
      call(`c${i}`, "slow_task", { delay: 50 }),
    );
    await runtime.executeBatch(calls, "r5", new EventBus(), signal);
    expect(tracker.maxActive).toBe(2);
  });
});
