/** 重注册：只有被闭包捕获的工具（powershell、文件工具）需要重建。 */

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadSettings, type Settings } from "../src/core/config.js";
import { reapplyTools } from "../src/tools/builtins/index.js";
import { ToolRegistry } from "../src/tools/registry.js";

process.env.MINIAGENT_DEEPSEEK_API_KEY = "test-key";

let tempDir = "";
let settings: Settings;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "miniagent-builtins-"));
  settings = {
    ...loadSettings(),
    workspace: join(tempDir, "ws-a"),
    powershellMode: "off",
    powershellExecutable: "",
  };
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("reapplyTools", () => {
  it("off → full 会把 powershell 注册进来", async () => {
    const registry = new ToolRegistry();
    await reapplyTools(registry, settings, ["powershellMode"]);
    expect(registry.has("powershell")).toBe(false);

    settings.powershellMode = "full";
    await reapplyTools(registry, settings, ["powershellMode"]);
    expect(registry.has("powershell")).toBe(true);
  });

  it("full → off 会把 powershell 移除，且不抛错", async () => {
    settings.powershellMode = "full";
    const registry = new ToolRegistry();
    await reapplyTools(registry, settings, ["powershellMode"]);
    expect(registry.has("powershell")).toBe(true);

    settings.powershellMode = "off";
    await reapplyTools(registry, settings, ["powershellMode"]);
    expect(registry.has("powershell")).toBe(false);
    // 再切一次：off 档下没有可删的，也不该抛
    await reapplyTools(registry, settings, ["powershellMode"]);
    expect(registry.has("powershell")).toBe(false);
  });

  it("改 workspace 后文件工具落在新根目录", async () => {
    const registry = new ToolRegistry();
    await reapplyTools(registry, settings, ["workspace"]);
    await registry.get("write_file").run({ path: "a.txt", content: "x" });
    expect(existsSync(join(tempDir, "ws-a", "a.txt"))).toBe(true);

    settings.workspace = join(tempDir, "ws-b");
    await reapplyTools(registry, settings, ["workspace"]);
    await registry.get("write_file").run({ path: "b.txt", content: "y" });
    expect(existsSync(join(tempDir, "ws-b", "b.txt"))).toBe(true);
    // 旧根不再被写入
    expect(existsSync(join(tempDir, "ws-a", "b.txt"))).toBe(false);
  });

  it("改 workspace 时 powershell 也要重注册（它的 cwd 绑在 workspace 上）", async () => {
    settings.powershellMode = "full";
    const registry = new ToolRegistry();
    await reapplyTools(registry, settings, ["workspace"]);
    expect(registry.has("powershell")).toBe(true);
  });

  it("不相关的变更不动工具表", async () => {
    const registry = new ToolRegistry();
    await reapplyTools(registry, settings, []);
    expect(registry.all()).toEqual([]);
  });
});
