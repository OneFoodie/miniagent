/** .env 原地改写测试：保留注释与顺序，且必须能往返读回。 */

import { describe, expect, it } from "vitest";

import { writeEnvValues } from "../src/core/envFile.js";

const SAMPLE =
  [
    "# DeepSeek API Key（必填）",
    "MINIAGENT_DEEPSEEK_API_KEY=sk-old",
    "",
    "# 可选项（不填则使用默认值）",
    "# MINIAGENT_MAX_ITERATIONS=8",
    "MINIAGENT_MODEL=deepseek-flash",
    "# MINIAGENT_APPROVAL_TOOLS=powershell",
  ].join("\n") + "\n";

describe("writeEnvValues", () => {
  it("覆盖已生效的键，其余行原样", () => {
    const out = writeEnvValues(SAMPLE, { MINIAGENT_MODEL: "deepseek-chat" });
    expect(out).toContain("MINIAGENT_MODEL=deepseek-chat\n");
    expect(out).not.toContain("MINIAGENT_MODEL=deepseek-flash");
    // 注释与顺序没动
    expect(out.split("\n")[0]).toBe("# DeepSeek API Key（必填）");
    expect(out.split("\n")[1]).toBe("MINIAGENT_DEEPSEEK_API_KEY=sk-old");
    expect(out).toContain("# 可选项（不填则使用默认值）");
  });

  it("注释态的键被激活：注释保留，生效行插在其后", () => {
    const out = writeEnvValues(SAMPLE, { MINIAGENT_MAX_ITERATIONS: "12" });
    const lines = out.split("\n");
    const commentAt = lines.indexOf("# MINIAGENT_MAX_ITERATIONS=8");
    expect(commentAt).toBeGreaterThan(-1);
    expect(lines[commentAt + 1]).toBe("MINIAGENT_MAX_ITERATIONS=12");
  });

  it("注释态的键也被激活", () => {
    const out = writeEnvValues(SAMPLE, { MINIAGENT_APPROVAL_TOOLS: "powershell" });
    expect(out).toContain("# MINIAGENT_APPROVAL_TOOLS=powershell");
    expect(out.split("\n").at(-2)).toBe("MINIAGENT_APPROVAL_TOOLS=powershell");
  });

  it("新键追加到末尾", () => {
    const out = writeEnvValues(SAMPLE, { MINIAGENT_ADMIN_TOKEN: "s3cret" });
    expect(out.split("\n").at(-2)).toBe("MINIAGENT_ADMIN_TOKEN=s3cret");
    expect(out.split("\n").filter((l) => l.startsWith("MINIAGENT_ADMIN_TOKEN="))).toHaveLength(1);
  });

  it("值含 = 与 逗号也往返一致", () => {
    const out = writeEnvValues(SAMPLE, { MINIAGENT_APPROVAL_TOOLS: "write_file,powershell" });
    const line = out.split("\n").find((l) => l.startsWith("MINIAGENT_APPROVAL_TOOLS="));
    expect(line).toBe("MINIAGENT_APPROVAL_TOOLS=write_file,powershell");
  });

  it("原文件没有末尾换行时补上", () => {
    const out = writeEnvValues("MINIAGENT_MODEL=a", { MINIAGENT_MODEL: "b" });
    expect(out).toBe("MINIAGENT_MODEL=b\n");
  });

  it("空内容直接生成一行", () => {
    expect(writeEnvValues("", { MINIAGENT_MODEL: "b" })).toBe("MINIAGENT_MODEL=b\n");
  });

  it("同一键在文件里出现两次时都改掉，避免留下旧的生效值", () => {
    const out = writeEnvValues("MINIAGENT_MODEL=a\nMINIAGENT_MODEL=b\n", {
      MINIAGENT_MODEL: "c",
    });
    expect(out).toBe("MINIAGENT_MODEL=c\nMINIAGENT_MODEL=c\n");
  });

  it("updates 为空时原样返回", () => {
    expect(writeEnvValues(SAMPLE, {})).toBe(SAMPLE);
  });
});
