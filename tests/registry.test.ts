/** 工具注册表与 schema 生成测试。 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineTool } from "../src/tools/base.js";
import { ToolRegistry } from "../src/tools/registry.js";

const greet = defineTool({
  name: "greet",
  description: "向某人打招呼若干次。",
  args: z.object({
    name: z.string(),
    times: z.number().int().default(1),
  }),
  handler: async ({ name, times }) => ({ message: name.repeat(times) }),
});

describe("ToolRegistry", () => {
  it("注册并生成载荷", () => {
    const registry = new ToolRegistry();
    registry.register(greet);

    const payload = registry.toolPayload();
    expect(payload[0]).toMatchObject({ type: "function" });
    const fn = payload[0]!.function as {
      name: string;
      description: string;
      parameters: { properties: Record<string, unknown>; required: string[] };
    };
    expect(fn.name).toBe("greet");
    expect(fn.description).toContain("打招呼");
    expect(Object.keys(fn.parameters.properties).sort()).toEqual(["name", "times"]);
    expect(fn.parameters.required).toEqual(["name"]);
  });

  it("重复注册被拒绝", () => {
    const registry = new ToolRegistry();
    registry.register(greet);
    expect(() => registry.register(greet)).toThrow("重复注册");
  });

  it("查询不存在的工具抛错", () => {
    const registry = new ToolRegistry();
    expect(() => registry.get("not_exists")).toThrow("未注册");
  });
});
