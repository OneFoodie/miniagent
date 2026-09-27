/** 权限档位的解析与描述：写错就报错、非法值列出候选、缺省最保守。 */

import { describe, expect, it } from "vitest";

import { describePermissionMode, parsePermissionMode } from "../src/core/permission.js";

describe("parsePermissionMode", () => {
  it("三个合法值原样返回", () => {
    expect(parsePermissionMode("manual")).toBe("manual");
    expect(parsePermissionMode("ai")).toBe("ai");
    expect(parsePermissionMode("full")).toBe("full");
  });

  it("大小写不敏感、容忍空白", () => {
    expect(parsePermissionMode("FULL")).toBe("full");
    expect(parsePermissionMode(" Ai ")).toBe("ai");
  });

  it("空值/未定义给默认 manual（最保守的一档）", () => {
    expect(parsePermissionMode(undefined)).toBe("manual");
    expect(parsePermissionMode(null)).toBe("manual");
    expect(parsePermissionMode("")).toBe("manual");
    expect(parsePermissionMode("   ")).toBe("manual");
  });

  it("非法值抛错并列出候选", () => {
    expect(() => parsePermissionMode("ait")).toThrow(/manual \/ ai \/ full/);
    expect(() => parsePermissionMode("off")).toThrow(/未知的权限档位/);
  });

  it("非字符串直接报错，而不是静默回退", () => {
    expect(() => parsePermissionMode(1)).toThrow(/字符串/);
    expect(() => parsePermissionMode({})).toThrow(/字符串/);
  });
});

describe("describePermissionMode", () => {
  it("三档都有一句中文说明", () => {
    for (const mode of ["manual", "ai", "full"] as const) {
      const text = describePermissionMode(mode);
      expect(text.length).toBeGreaterThan(0);
      expect(text).toMatch(/[\u4e00-\u9fa5]/);
    }
  });
});
