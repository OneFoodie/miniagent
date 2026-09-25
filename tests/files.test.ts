/** 沙箱文件工具测试：正常读写与路径穿越拦截。 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { registerFileTools } from "../src/tools/builtins/files.js";
import { ToolRegistry } from "../src/tools/registry.js";

async function makeRegistry(): Promise<{ registry: ToolRegistry; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "miniagent-"));
  const registry = new ToolRegistry();
  await registerFileTools(registry, root);
  return { registry, root };
}

let currentRoot = "";

afterEach(async () => {
  if (currentRoot) await rm(currentRoot, { recursive: true, force: true });
});

describe("files", () => {
  it("写入后读取", async () => {
    const { registry, root } = await makeRegistry();
    currentRoot = root;

    const writeResult = await registry
      .get("write_file")
      .run({ path: "notes/a.txt", content: "你好" });
    expect(writeResult.ok).toBe(true);
    expect(writeResult.data).toMatchObject({
      bytes_written: Buffer.byteLength("你好", "utf-8"),
    });

    const readResult = await registry.get("read_file").run({ path: "notes/a.txt" });
    expect(readResult.ok).toBe(true);
    expect(readResult.data).toMatchObject({ text: "你好" });
  });

  it("读取不存在的文件", async () => {
    const { registry, root } = await makeRegistry();
    currentRoot = root;
    const result = await registry.get("read_file").run({ path: "nope.txt" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("不存在");
  });

  it("相对路径穿越被拦截", async () => {
    const { registry, root } = await makeRegistry();
    currentRoot = root;
    const result = await registry
      .get("write_file")
      .run({ path: "../escape.txt", content: "x" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("越界");
  });

  it("沙箱外绝对路径被拦截", async () => {
    const { registry, root } = await makeRegistry();
    currentRoot = root;
    const result = await registry
      .get("read_file")
      .run({ path: "C:/Windows/System32/drivers/etc/hosts" });
    expect(result.ok).toBe(false);
  });
});
