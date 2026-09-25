/**
 * MCP 客户端：连接一个 MCP 服务，把它的远程工具适配成本项目的 `BaseTool`。
 *
 * 为什么做成「动态 import + 可选依赖」：MCP SDK 会连带拖进 express / hono / ajv / jose
 * 等近百个包。只有真的配了 `mcp.json` 才加载它，默认路径的依赖数量因此不变。
 *
 * 安全提醒：MCP 工具在**本进程之外**执行（stdio 子进程或远程服务），
 * 不受 `workspace` 文件沙箱约束，能力等同于那个进程本身的权限。接第三方 MCP 服务前先看清它要干什么。
 */

import { getLogger } from "../core/logging.js";
import type { ToolResult } from "../core/types.js";
import type { BaseTool } from "../tools/base.js";
import type { McpServerConfig } from "./config.js";

const logger = getLogger("miniagent.mcp.client");

/** 工具名前缀：`mcp__<服务名>__<工具名>`，与生态惯例一致，也避免与内置工具撞名 */
const TOOL_PREFIX = "mcp";

/** 握手与列举工具的等待上限：这两个动作不该让启动卡住 */
const HANDSHAKE_TIMEOUT_MS = 20_000;

/** MCP 侧的工具描述（只取我们需要的字段） */
export interface McpToolInfo {
  name: string;
  description: string;
  /** 已经是 JSON Schema，直接透传给模型，不需要 zod 中转 */
  inputSchema: Record<string, unknown>;
}

/** 拼出注册到本框架里的工具名 */
export function mcpToolName(server: string, tool: string): string {
  return `${TOOL_PREFIX}__${server}__${tool}`;
}

/** 把 MCP 的 content 数组压成一段文本；非文本内容明确标注而不是悄悄丢掉 */
export function contentToText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    const block = item as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "image") {
      parts.push(`[图片内容，MIME ${String(block.mimeType ?? "unknown")}]`);
    } else if (block.type === "resource") {
      const resource = block.resource as Record<string, unknown> | undefined;
      const uri = resource?.uri ?? resource?.text ?? "";
      parts.push(`[资源 ${String(uri).slice(0, 200)}]`);
    } else {
      parts.push(`[${String(block.type ?? "未知")} 类型内容]`);
    }
  }
  return parts.join("\n");
}

/** 一个已建立连接的 MCP 服务 */
export class McpConnection implements McpCaller {
  private constructor(
    readonly server: string,
    private readonly client: McpClientLike,
  ) {}

  static async connect(name: string, config: McpServerConfig): Promise<McpConnection> {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

    let transport: McpTransportLike;
    if (config.command) {
      const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env: config.env ? { ...process.env, ...config.env } as Record<string, string> : undefined,
      });
    } else {
      const { StreamableHTTPClientTransport } = await import(
        "@modelcontextprotocol/sdk/client/streamableHttp.js"
      );
      transport = new StreamableHTTPClientTransport(new URL(config.url!));
    }

    const client = new Client({ name: "miniagent", version: "0.1.0" }) as unknown as McpClientLike;
    await client.connect(transport, { timeout: HANDSHAKE_TIMEOUT_MS });
    logger.info(`MCP 服务已连接: ${name}`);
    return new McpConnection(name, client);
  }

  /** 列举该服务暴露的工具 */
  async listTools(): Promise<McpToolInfo[]> {
    const result = await this.client.listTools(undefined, { timeout: HANDSHAKE_TIMEOUT_MS });
    const tools = Array.isArray(result.tools) ? result.tools : [];
    return tools.map((tool) => ({
      name: String(tool.name),
      description: typeof tool.description === "string" ? tool.description : "",
      // 缺 schema 时给一个宽松的空对象，模型仍可尝试调用
      inputSchema: (tool.inputSchema as Record<string, unknown>) ?? {
        type: "object",
        properties: {},
      },
    }));
  }

  /** 调用远端工具，返回已归一化的结果 */
  async call(
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const result = await this.client.callTool(
      { name: tool, arguments: args },
      undefined,
      { signal },
    );
    const text = contentToText(result.content);
    if (result.isError === true) {
      return { ok: false, error: text || "MCP 工具返回错误（无内容）" };
    }
    // 有结构化产出时一并带上：模型对结构化数据更好用，纯文本作兜底
    const structured = result.structuredContent;
    return {
      ok: true,
      data: structured === undefined ? { text } : { text, structured },
    };
  }

  async close(): Promise<void> {
    try {
      await this.client.close();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warning(`关闭 MCP 服务失败（${this.server}）: ${reason}`);
    }
  }
}

/** 调用远端工具的最小能力：`McpTool` 只依赖它，因此可以塞假实现做单测 */
export interface McpCaller {
  call(
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult>;
}

/** 把 MCP 工具包成本框架的 BaseTool */
export class McpTool implements BaseTool {
  readonly name: string;
  readonly description: string;

  constructor(
    private readonly connection: McpCaller,
    server: string,
    private readonly info: McpToolInfo,
  ) {
    this.name = mcpToolName(server, info.name);
    const origin = info.description || info.name;
    // 标注来源：模型据此判断这是外部能力，排查时也知道该去看哪个服务
    this.description = `[MCP/${server}] ${origin}`;
  }

  async run(
    rawArguments: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    try {
      return await this.connection.call(this.info.name, rawArguments, signal);
    } catch (error) {
      // 协议层异常（连接断了、远端抛错）也要变成模型可见的结果，而不是让整轮崩掉
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `MCP 调用失败（${this.info.name}）: ${reason}` };
    }
  }

  /** 参数 schema 已经是 JSON Schema，无需 zod 往返转换 */
  toPayload(): Record<string, unknown> {
    return {
      type: "function",
      function: {
        name: this.name,
        description: this.description,
        parameters: this.info.inputSchema,
      },
    };
  }
}

/* ---------------- 仅用于收窄动态 import 的类型，避免把 SDK 类型带进编译产物 ---------------- */

interface McpClientLike {
  connect(transport: McpTransportLike, options?: { timeout?: number }): Promise<void>;
  listTools(
    params: undefined,
    options?: { timeout?: number },
  ): Promise<{ tools?: Array<Record<string, unknown>> }>;
  callTool(
    params: { name: string; arguments: Record<string, unknown> },
    resultSchema: undefined,
    options?: { signal?: AbortSignal },
  ): Promise<{
    content?: unknown;
    isError?: boolean;
    structuredContent?: unknown;
  }>;
  close(): Promise<void>;
}

interface McpTransportLike {
  start?(): Promise<void>;
  close?(): Promise<void>;
}
