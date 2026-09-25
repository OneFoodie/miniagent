/**
 * 测试用 MCP 服务（stdio）：暴露两个工具，供 `tests/mcp.test.ts` 验证真实链路。
 *
 * 刻意用 SDK 的官方服务端实现，而不是自己糊一个 JSON-RPC：
 * 这样测的是「我们的客户端能不能和真正的 MCP 服务对话」，而不是自说自话。
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo-fixture", version: "1.0.0" });

server.registerTool(
  "echo",
  {
    description: "回显传入的文本",
    inputSchema: { text: z.string().describe("要回显的文本") },
  },
  async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
);

server.registerTool(
  "fail",
  { description: "总是返回错误，用来验证错误归一化" },
  async () => ({
    content: [{ type: "text", text: "这个工具故意失败了" }],
    isError: true,
  }),
);

await server.connect(new StdioServerTransport());
