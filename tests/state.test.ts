/**
 * 运行状态与循环路由。
 *
 * 这两处刻意做成纯函数（借鉴 LangGraph 的 state + reducer 与 conditional edges），
 * 好处就是这里能逐个分支穷举，不需要真跑一次 Agent。
 */

import { describe, expect, it } from "vitest";

import { routeAfterReason, routeAtLoopStart } from "../src/agent/routing.js";
import {
  REPEATED_FAILURE_THRESHOLD,
  createRunState,
  hasRepeatedFailure,
  rebuildRunState,
  recordToolResults,
  renderProgress,
  setPlan,
} from "../src/agent/state.js";

describe("RunState 归并", () => {
  it("空状态没有计划、计数为零", () => {
    expect(createRunState()).toEqual({ failures: {}, consecutiveFailures: 0 });
  });

  it("累计失败次数，并按批内顺序判断连续失败", () => {
    const state = recordToolResults(createRunState(), [
      { name: "web_search", ok: true },
      { name: "http_fetch", ok: false },
    ]);
    expect(state.failures).toEqual({ http_fetch: 1 });
    expect(state.consecutiveFailures).toBe(1);

    const again = recordToolResults(state, [{ name: "http_fetch", ok: false }]);
    expect(again.failures).toEqual({ http_fetch: 2 });
    expect(again.consecutiveFailures).toBe(2);
    expect(hasRepeatedFailure(again)).toBe(true);
  });

  it("出现成功即清空连续计数，累计失败次数保留", () => {
    const failed = recordToolResults(createRunState(), [{ name: "a", ok: false }]);
    const recovered = recordToolResults(failed, [{ name: "a", ok: true }]);

    expect(recovered.consecutiveFailures).toBe(0);
    expect(recovered.failures).toEqual({ a: 1 });
    expect(hasRepeatedFailure(recovered)).toBe(false);
  });

  it("换成另一个工具失败时，连续计数从头算", () => {
    const state = recordToolResults(createRunState(), [
      { name: "a", ok: false },
      { name: "b", ok: false },
    ]);
    // 不是同一个工具在反复失败，不该提示「换路子」
    expect(state.consecutiveFailures).toBe(1);
    expect(state.lastFailedTool).toBe("b");
  });

  it("空批次不改变状态（同一份引用即可）", () => {
    const state = createRunState();
    expect(recordToolResults(state, [])).toBe(state);
  });

  it("计划只认第一次，且不会凭空空写", () => {
    const first = setPlan(createRunState(), ["查文档", "算数"]);
    expect(first.plan).toEqual(["查文档", "算数"]);
    expect(setPlan(first, ["改口"]).plan).toEqual(["查文档", "算数"]);
    expect(setPlan(createRunState(), undefined).plan).toBeUndefined();
    expect(setPlan(createRunState(), []).plan).toBeUndefined();
  });
});

describe("rebuildRunState（兼容旧存档）", () => {
  it("存档里有状态就直接用", () => {
    const saved = rebuildRunState(
      { failures: { a: 2 }, consecutiveFailures: 1, plan: ["P"] },
      [],
    );
    expect(saved.plan).toEqual(["P"]);
    expect(saved.failures).toEqual({ a: 2 });
    expect(saved.consecutiveFailures).toBe(1);
  });

  it("旧存档没有 state 时，从已执行工具反推失败计数", () => {
    const rebuilt = rebuildRunState(undefined, [
      { name: "x", ok: false },
      { name: "x", ok: false },
    ]);
    expect(rebuilt.failures).toEqual({ x: 2 });
    expect(rebuilt.consecutiveFailures).toBe(2);
    // 计划反推不出来，如实为空——不编造
    expect(rebuilt.plan).toBeUndefined();
  });
});

describe("renderProgress（提示词里的进度段）", () => {
  it("渲染步数、计划、已执行与反复失败的引导", () => {
    const state = recordToolResults(
      setPlan(createRunState(), ["查文档", "取行情"]),
      [
        { name: "http_fetch", ok: false },
        { name: "http_fetch", ok: false },
      ],
    );
    const text = renderProgress({
      step: 2,
      maxSteps: 8,
      tools: [
        { name: "web_search", ok: true },
        { name: "http_fetch", ok: false },
        { name: "http_fetch", ok: false },
      ],
      state,
    });

    expect(text).toContain("已用 2/8 步");
    expect(text).toContain("计划：1) 查文档；2) 取行情");
    expect(text).toContain("web_search 成功");
    expect(text).toContain("http_fetch×2 失败");
    expect(text).toContain("先说明失败原因再换思路");
  });

  it("没有计划与执行记录时只给步数", () => {
    const text = renderProgress({
      step: 0,
      maxSteps: 8,
      tools: [],
      state: createRunState(),
    });
    expect(text).toBe("已用 0/8 步。");
    // 阈值若被改成 1，上面那条「换路子」引导就会在首次失败时出现，与设计不符
    expect(REPEATED_FAILURE_THRESHOLD).toBeGreaterThan(1);
  });

  it("未达连续失败阈值时不出现换路子的引导", () => {
    const state = recordToolResults(createRunState(), [{ name: "a", ok: false }]);
    const text = renderProgress({
      step: 1,
      maxSteps: 8,
      tools: [{ name: "a", ok: false }],
      state,
    });
    expect(text).toContain("a 失败");
    expect(text).not.toContain("换思路");
  });
});

describe("循环路由", () => {
  it("取消优先于一切", () => {
    expect(routeAtLoopStart({ step: 0, maxSteps: 8, cancelled: true })).toBe("cancelled");
    expect(routeAtLoopStart({ step: 8, maxSteps: 8, cancelled: true })).toBe("cancelled");
  });

  it("还有余量就继续，用尽则转收尾", () => {
    expect(routeAtLoopStart({ step: 0, maxSteps: 3, cancelled: false })).toBe("continue");
    expect(routeAtLoopStart({ step: 2, maxSteps: 3, cancelled: false })).toBe("continue");
    // 用尽不是抛错，而是去收尾作答
    expect(routeAtLoopStart({ step: 3, maxSteps: 3, cancelled: false })).toBe("wrap-up");
  });

  it("模型没给工具调用就是要交答案", () => {
    expect(routeAfterReason({ toolCallCount: 0 })).toBe("finish");
    expect(routeAfterReason({ toolCallCount: 1 })).toBe("act");
  });
});
