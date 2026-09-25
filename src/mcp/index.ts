/**
 * MCP 接入入口：读配置 → 连接各服务 → 把远端工具注册进工具表。
 *
 * 容错原则：**任何单个服务出问题都不该影响启动**。
 * 连不上、握手超时、列不出工具，都只记警告并跳过它，其余服务照常可用。
 */

import { getLogger } from "../core/logging.js";
import type { ToolRegistry } from "../tools/registry.js";
import { McpConnection, McpTool, mcpToolName } from "./client.js";
import { loadMcpConfig } from "./config.js";

const logger = getLogger("miniagent.mcp");

export interface McpRegistration {
  /** 成功连接的服务名 */
  servers: string[];
  /** 注册进来的工具数 */
  toolCount: number;
  /** 被跳过的配置项（服务名 + 原因） */
  skipped: Array<{ name: string; reason: string }>;
  /** 断开全部连接；进程退出前应调用，否则 stdio 子进程可能残留 */
  close(): Promise<void>;
}

/** 一个什么都没做的空句柄：没配 MCP 时用它，调用方不必到处判空 */
export const NO_MCP: McpRegistration = {
  servers: [],
  toolCount: 0,
  skipped: [],
  close: async () => {},
};

/**
 * 连接配置里的全部 MCP 服务并注册其工具。
 * @param configPath mcp.json 的路径；文件不存在即视为不启用
 */
export async function registerMcpTools(
  registry: ToolRegistry,
  configPath: string,
): Promise<McpRegistration> {
  const { servers, skipped } = await loadMcpConfig(configPath);
  if (servers.length === 0) {
    return { ...NO_MCP, skipped };
  }

  // 并发连接：stdio 起进程 + 握手是主要耗时，串行会让启动线性变慢
  const connected = await Promise.all(
    servers.map(async ({ name, config }) => {
      try {
        return await McpConnection.connect(name, config);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        logger.warning(`MCP 服务连接失败，已跳过（${name}）: ${reason}`);
        skipped.push({ name, reason: `连接失败: ${reason}` });
        return undefined;
      }
    }),
  );

  const active = connected.filter((item): item is McpConnection => item !== undefined);
  const healthy: string[] = [];
  let toolCount = 0;

  for (const connection of active) {
    let tools;
    try {
      tools = await connection.listTools();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warning(`MCP 服务列举工具失败，已跳过（${connection.server}）: ${reason}`);
      skipped.push({ name: connection.server, reason: `列举工具失败: ${reason}` });
      await connection.close();
      continue;
    }

    let registered = 0;
    for (const info of tools) {
      const name = mcpToolName(connection.server, info.name);
      // 注册表对重名是直接抛错的，这里先判断：外部服务不该因为撞名把整个启动搞挂
      if (registry.has(name)) {
        logger.warning(`MCP 工具与已有工具重名，已跳过: ${name}`);
        skipped.push({ name, reason: "与已有工具重名" });
        continue;
      }
      registry.register(new McpTool(connection, connection.server, info));
      registered += 1;
    }

    healthy.push(connection.server);
    toolCount += registered;
    logger.info(`MCP 服务就绪: ${connection.server}（注册 ${registered} 个工具）`);
  }

  // 一个服务都没连上时，让调用方拿到的是空句柄而不是半残状态
  return {
    servers: healthy,
    toolCount,
    skipped,
    close: async () => {
      await Promise.all(active.map((connection) => connection.close()));
    },
  };
}

/** 启动日志用的一句话描述 */
export function describeMcp(registration: McpRegistration): string {
  if (registration.servers.length === 0) return "未启用";
  return `${registration.servers.join("、")}（${registration.toolCount} 个工具）`;
}
