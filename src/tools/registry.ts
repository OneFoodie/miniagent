/** 工具注册表：集中管理工具，生成模型侧 tools 载荷。 */

import { ToolError } from "../core/errors.js";
import type { BaseTool } from "./base.js";

export class ToolRegistry {
  private tools = new Map<string, BaseTool>();

  register(tool: BaseTool): void {
    if (this.tools.has(tool.name)) {
      throw new ToolError(`工具名重复注册: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): BaseTool {
    const tool = this.tools.get(name);
    if (!tool) throw new ToolError(`模型调用了未注册的工具: ${name}`);
    return tool;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  all(): BaseTool[] {
    return [...this.tools.values()];
  }

  /** 生成传给 DeepSeek 的完整 tools 参数 */
  toolPayload(): Record<string, unknown>[] {
    return this.all().map((tool) => tool.toPayload());
  }
}
