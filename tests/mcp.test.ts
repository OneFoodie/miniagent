/**
 * MCP 接入测试。
 *
 * 分两层：
 *  - 纯函数与适配器用假实现测（快、确定）
 *  - 连接链路起一个**真实的 MCP 服务子进程**（tests/fixtures/echo-mcp-server.mjs）测，
 *    否则「我们的客户端能不能跟真服务对话」这件事没有被验证过
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { contentToText, McpTool, mcpToolName, type McpCaller } from "../src/mcp/client.js";
import { loadMcpConfig } from "../src/mcp/config.js";
import { registerMcpTools } from "../src/mcp/index.js";
import type { ToolResult } from "../src/core/types.js";
import { ToolRegistry } from "../src/tools/registry.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_SERVER = join(here, "fixtures", "echo-mcp-server.mjs");

const tempDirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "miniagent-mcp-"));
  tempDirs.push(dir);
  return dir;
}

/** 写一份 mcp.json，内容为指向夹具服务的 stdio 配置 */
async function writeConfig(body: unknown): Promise<string> {
  const dir = await tempDir();
  const path = join(dir, "mcp.json");
  await writeFile(path, JSON.stringify(body), "utf-8");
  return path;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})),
  );
});

describe("MCP 配置加载", () => {
  it("文件不存在视为未启用，不报错", async () => {
    const result = await loadMcpConfig(join(tmpdir(), "definitely-missing-mcp.json"));
    expect(result.servers).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("非法 JSON 被跳过并给出原因", async () => {
    const dir = await tempDir();
    const path = join(dir, "mcp.json");
    await writeFile(path, "{ 不是 JSON", "utf-8");

    const result = await loadMcpConfig(path);
    expect(result.servers).toEqual([]);
    expect(result.skipped[0]!.reason).toContain("不是合法 JSON");
  });

  it("缺 mcpServers 字段时整体跳过", async () => {
    const path = await writeConfig({ servers: {} });
    expect((await loadMcpConfig(path)).servers).toEqual([]);
  });

  it("逐项校验：command/url 二选一、服务名安全、enabled 开关", async () => {
    const path = await writeConfig({
      mcpServers: {
        good: { command: "node", args: ["x.mjs"] },
        remote: { url: "https://example.com/mcp" },
        // 两个都给 → 拒
        both: { command: "node", url: "https://example.com/mcp" },
        // 都没给 → 拒
        neither: {},
        // 服务名会进工具名，必须安全
        "bad name!": { command: "node" },
        off: { command: "node", enabled: false },
      },
    });

    const result = await loadMcpConfig(path);
    expect(result.servers.map((item) => item.name).sort()).toEqual(["good", "remote"]);
    expect(result.skipped.map((item) => item.name).sort()).toEqual([
      "bad name!",
      "both",
      "neither",
      "off",
    ]);
  });
});

describe("MCP 结果归一化", () => {
  it("文本块直接拼接", () => {
    expect(contentToText([{ type: "text", text: "甲" }, { type: "text", text: "乙" }])).toBe(
      "甲\n乙",
    );
  });

  it("非文本块明确标注，而不是悄悄丢掉", () => {
    const text = contentToText([
      { type: "image", mimeType: "image/png" },
      { type: "resource", resource: { uri: "file:///a.txt" } },
      { type: "audio" },
    ]);
    expect(text).toContain("图片内容");
    expect(text).toContain("file:///a.txt");
    expect(text).toContain("audio");
  });

  it("非数组输入返回空串", () => {
    expect(contentToText(undefined)).toBe("");
  });

  it("工具名带服务前缀，避免与内置工具撞名", () => {
    expect(mcpToolName("filesystem", "read_file")).toBe("mcp__filesystem__read_file");
  });
});

describe("McpTool 适配", () => {
  /** 记录调用的假连接 */
  class FakeCaller implements McpCaller {
    readonly calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    constructor(private readonly result: ToolResult) {}

    async call(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
      this.calls.push({ tool, args });
      return this.result;
    }
  }

  const info = {
    name: "echo",
    description: "回显",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  };

  it("toPayload 直接透传远端 JSON Schema，不经过 zod", () => {
    const tool = new McpTool(new FakeCaller({ ok: true, data: {} }), "demo", info);
    const payload = tool.toPayload() as {
      type: string;
      function: { name: string; description: string; parameters: unknown };
    };

    expect(payload.type).toBe("function");
    expect(payload.function.name).toBe("mcp__demo__echo");
    // 来源写进描述：模型据此知道这是外部能力
    expect(payload.function.description).toContain("MCP/demo");
    expect(payload.function.parameters).toEqual(info.inputSchema);
  });

  it("调用时用远端原名，而不是带前缀的注册名", async () => {
    const caller = new FakeCaller({ ok: true, data: { text: "echo: 你好" } });
    const tool = new McpTool(caller, "demo", info);

    const result = await tool.run({ text: "你好" });
    expect(result.ok).toBe(true);
    expect(caller.calls).toEqual([{ tool: "echo", args: { text: "你好" } }]);
  });

  it("远端失败与连接异常都归一化为失败结果，不让整轮崩掉", async () => {
    const failing = new McpTool(
      new FakeCaller({ ok: false, error: "远端说不行" }),
      "demo",
      info,
    );
    expect((await failing.run({})).ok).toBe(false);

    const broken: McpCaller = {
      async call() {
        throw new Error("连接已断开");
      },
    };
    const result = await new McpTool(broken, "demo", info).run({});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("连接已断开");
  });
});

describe("MCP 端到端（真实子进程 + 真实协议）", () => {
  it("连接夹具服务、注册工具、并成功调用", async () => {
    const path = await writeConfig({
      mcpServers: {
        echo: { command: process.execPath, args: [FIXTURE_SERVER] },
      },
    });

    const registry = new ToolRegistry();
    const mcp = await registerMcpTools(registry, path);
    cleanups.push(() => mcp.close());

    expect(mcp.servers).toEqual(["echo"]);
    // 夹具暴露 echo 与 fail 两个工具
    expect(mcp.toolCount).toBe(2);
    expect(registry.has("mcp__echo__echo")).toBe(true);

    const result = await registry.get("mcp__echo__echo").run({ text: "你好" });
    expect(result.ok).toBe(true);
    expect((result.data as { text: string }).text).toBe("echo: 你好");

    // 服务端返回 isError 时必须是失败结果
    const failed = await registry.get("mcp__echo__fail").run({});
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("故意失败");
  }, 30_000);

  it("服务起不来时只记警告并跳过，不阻断其余流程", async () => {
    const path = await writeConfig({
      mcpServers: {
        broken: { command: "definitely-not-a-real-command-xyz" },
        good: { command: process.execPath, args: [FIXTURE_SERVER] },
      },
    });

    const registry = new ToolRegistry();
    const mcp = await registerMcpTools(registry, path);
    cleanups.push(() => mcp.close());

    // 坏的那个被跳过，好的那个照常可用
    expect(mcp.servers).toEqual(["good"]);
    expect(mcp.skipped.some((item) => item.name === "broken")).toBe(true);
    expect(registry.has("mcp__good__echo")).toBe(true);
  }, 30_000);
});
