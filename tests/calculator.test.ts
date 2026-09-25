/** 计算器工具测试。 */

import { describe, expect, it } from "vitest";
import { calculator } from "../src/tools/builtins/calculator.js";

describe("calculator", () => {
  it("基础四则运算", async () => {
    const result = await calculator.run({ expression: "(1+2)*3" });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ result: 9 });
  });

  it("幂运算与常量", async () => {
    const result = await calculator.run({ expression: "2**10 + pi - pi" });
    expect(result.ok).toBe(true);
    expect((result.data as { result: number }).result).toBeCloseTo(1024);
  });

  it("语法错误被报告", async () => {
    const result = await calculator.run({ expression: "1 +" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("期望");
  });

  it("非白名单结构被拒绝", async () => {
    const result = await calculator.run({ expression: "abc" });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("参数校验失败", async () => {
    const result = await calculator.run({ expr: "1+1" }); // 字段名错误
    expect(result.ok).toBe(false);
    expect(result.error).toContain("参数校验失败");
  });
});
