/**
 * MCP（Model Context Protocol）服务配置。
 *
 * 用**生态通用格式**（与 Claude Desktop 等客户端一致），因此可以直接把别的工具里
 * 已有的 `mcpServers` 段落过来用：
 *
 * ```json
 * {
 *   "mcpServers": {
 *     "filesystem": {
 *       "command": "npx",
 *       "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"]
 *     },
 *     "remote": { "url": "https://example.com/mcp" }
 *   }
 * }
 * ```
 *
 * **不配置文件就等于不启用 MCP**：这保证了默认路径仍是不加载 MCP SDK 的零依赖运行。
 */

import { readFile } from "node:fs/promises";

import { getLogger } from "../core/logging.js";

const logger = getLogger("miniagent.mcp.config");

/** 单个 MCP 服务：要么给 command（stdio 起进程），要么给 url（远程 HTTP） */
export interface McpServerConfig {
  /** stdio：可执行文件 */
  command?: string;
  /** stdio：命令行参数 */
  args?: string[];
  /** stdio：附加环境变量（默认继承当前进程环境） */
  env?: Record<string, string>;
  /** 远程：Streamable HTTP 端点 */
  url?: string;
  /** 设为 false 可临时停用，不必删配置 */
  enabled?: boolean;
}

export interface McpConfig {
  /** 服务名 → 配置。服务名会进工具名，所以只允许安全字符 */
  mcpServers: Record<string, McpServerConfig>;
}

/** 服务名会拼进工具名（`mcp__<server>__<tool>`），限制字符集避免模型侧出现怪名字 */
const SAFE_SERVER_NAME = /^[A-Za-z0-9_-]+$/;

export interface LoadedMcpConfig {
  /** 通过校验、且 enabled 不为 false 的服务 */
  servers: Array<{ name: string; config: McpServerConfig }>;
  /** 被跳过的项及原因，供启动日志一次性提示 */
  skipped: Array<{ name: string; reason: string }>;
}

/**
 * 读取并校验 MCP 配置。
 * 文件不存在 → 返回空配置（不报错：没配 MCP 是完全正常的状态）。
 * 单项配置有误 → 跳过该项而不是整体失败：一个服务写错不该让整个 Agent 起不来。
 */
export async function loadMcpConfig(path: string): Promise<LoadedMcpConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    logger.info(`未找到 MCP 配置（${path}），跳过 MCP 工具加载`);
    return { servers: [], skipped: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warning(`MCP 配置不是合法 JSON，已忽略: ${reason}`);
    return { servers: [], skipped: [{ name: path, reason: "配置文件不是合法 JSON" }] };
  }

  const table = (parsed as McpConfig | null)?.mcpServers;
  if (typeof table !== "object" || table === null) {
    logger.warning(`MCP 配置缺少 mcpServers 字段，已忽略: ${path}`);
    return { servers: [], skipped: [{ name: path, reason: "缺少 mcpServers 字段" }] };
  }

  const servers: LoadedMcpConfig["servers"] = [];
  const skipped: LoadedMcpConfig["skipped"] = [];

  for (const [name, config] of Object.entries(table)) {
    if (!SAFE_SERVER_NAME.test(name)) {
      skipped.push({ name, reason: "服务名只允许字母、数字、下划线和短横线" });
      continue;
    }
    if (config.enabled === false) {
      skipped.push({ name, reason: "配置里 enabled=false" });
      continue;
    }
    const hasCommand = typeof config.command === "string" && config.command.length > 0;
    const hasUrl = typeof config.url === "string" && config.url.length > 0;
    if (hasCommand === hasUrl) {
      skipped.push({ name, reason: "必须且只能给 command 或 url 之一" });
      continue;
    }
    servers.push({ name, config });
  }

  return { servers, skipped };
}
