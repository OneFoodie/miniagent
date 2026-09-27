/**
 * 命令级放行白名单：指纹（含 shell 的 timeout_seconds 例外）、JSONL 落盘与容错。
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ApprovalAllowlist } from "../src/agent/allowlist.js";

const tempDirs: string[] = [];

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "miniagent-allowlist-"));
  tempDirs.push(dir);
  return join(dir, "approvals", "allowlist.jsonl");
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})),
  );
});

describe("指纹判定", () => {
  it("键序无关：{a,b} 与 {b,a} 是同一条", async () => {
    const list = new ApprovalAllowlist(await tempFile());
    await list.add("shell", { a: 1, b: 2 });
    expect(list.has("shell", { b: 2, a: 1 })).toBe(true);
  });

  it("shell 的 timeout_seconds 不参与指纹", async () => {
    const list = new ApprovalAllowlist(await tempFile());
    await list.add("shell", { command: "date", timeout_seconds: 5 });
    expect(list.has("shell", { command: "date" })).toBe(true);
  });

  it("例外只针对 shell：别的工具的 timeout_seconds 仍参与指纹", async () => {
    const list = new ApprovalAllowlist(await tempFile());
    await list.add("other", { command: "x", timeout_seconds: 5 });
    expect(list.has("other", { command: "x" })).toBe(false);
    expect(list.has("other", { command: "x", timeout_seconds: 5 })).toBe(true);
  });

  it("不同命令不同指纹", async () => {
    const list = new ApprovalAllowlist(await tempFile());
    await list.add("shell", { command: "date" });
    expect(list.has("shell", { command: "date" })).toBe(true);
    expect(list.has("shell", { command: "date -u" })).toBe(false);
  });

  it("工具名不同即不同", async () => {
    const list = new ApprovalAllowlist(await tempFile());
    await list.add("shell", { command: "date" });
    expect(list.has("other", { command: "date" })).toBe(false);
  });
});

describe("落盘、重载与幂等", () => {
  it("add 后新建实例仍命中（落盘生效）", async () => {
    const file = await tempFile();
    const list = new ApprovalAllowlist(file);
    await list.add("shell", { command: "date" });

    // 父目录此前不存在，add 必须自己建出来
    expect(await readFile(file, "utf-8")).toContain("shell");

    const reloaded = new ApprovalAllowlist(file);
    await reloaded.load();
    expect(reloaded.has("shell", { command: "date" })).toBe(true);
  });

  it("remove 后不再命中，且重载也删掉了", async () => {
    const file = await tempFile();
    const list = new ApprovalAllowlist(file);
    await list.add("shell", { command: "date" });

    expect(await list.remove("shell", { command: "date" })).toBe(true);
    expect(list.has("shell", { command: "date" })).toBe(false);

    const reloaded = new ApprovalAllowlist(file);
    await reloaded.load();
    expect(reloaded.has("shell", { command: "date" })).toBe(false);
  });

  it("删不存在返回 false", async () => {
    const list = new ApprovalAllowlist(await tempFile());
    expect(await list.remove("shell", { command: "nope" })).toBe(false);
  });

  it("同一条 add 两次只留一条", async () => {
    const file = await tempFile();
    const list = new ApprovalAllowlist(file);
    await list.add("shell", { command: "date" });
    await list.add("shell", { command: "date" });

    expect(list.list()).toHaveLength(1);
    const reloaded = new ApprovalAllowlist(file);
    await reloaded.load();
    expect(reloaded.list()).toHaveLength(1);
  });

  it("list 返回带 addedAt 的条目", async () => {
    const list = new ApprovalAllowlist(await tempFile());
    await list.add("shell", { command: "date" });
    const entries = list.list();
    expect(entries[0]).toMatchObject({ tool: "shell", arguments: { command: "date" } });
    expect(typeof entries[0]!.addedAt).toBe("number");
  });
});

describe("容错（与 loadCheckpoint 同策略）", () => {
  it("文件不存在 → 空白名单，不抛错", async () => {
    const list = new ApprovalAllowlist(await tempFile());
    await expect(list.load()).resolves.toBeUndefined();
    expect(list.list()).toEqual([]);
    expect(list.has("shell", { command: "date" })).toBe(false);
  });

  it("内容损坏 → 当作空白名单（坏行被跳过），不抛错", async () => {
    const file = await tempFile();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, "{ 不是 JSON\n完全不是一行\n", "utf-8");

    const list = new ApprovalAllowlist(file);
    await expect(list.load()).resolves.toBeUndefined();
    expect(list.list()).toEqual([]);
  });

  it("坏行与好行混排时只保留好行", async () => {
    const file = await tempFile();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(file, ".."), { recursive: true });
    const good = JSON.stringify({ tool: "shell", arguments: { command: "date" }, addedAt: 1 });
    await writeFile(file, `{ 坏行\n${good}\n`, "utf-8");

    const list = new ApprovalAllowlist(file);
    await list.load();
    expect(list.has("shell", { command: "date" })).toBe(true);
  });
});
