/** 内置工具集合与统一注册入口。 */

import type { Settings } from "../../core/config.js";
import type { ToolRegistry } from "../registry.js";
import { calculator } from "./calculator.js";
import { httpFetch } from "./httpFetch.js";
import { registerFileTools } from "./files.js";
import { POWERSHELL_TOOL_NAME, registerPowershell } from "./shell/index.js";
import { webSearch } from "./webSearch.js";

/** 注册框架全部内置工具 */
export async function registerBuiltins(
  registry: ToolRegistry,
  settings: Settings,
): Promise<void> {
  registry.register(calculator);
  registry.register(httpFetch);
  registry.register(webSearch);
  await registerFileTools(registry, settings.workspace);
  // 通用执行通道：无沙箱，是否注册、放行到什么程度由权限档位决定（默认 readonly）
  await registerPowershell(registry, settings);
}

/**
 * 配置变更后重建受影响的工具。
 *
 * 为什么需要它：settings 是活引用（原地改即生效），但**工具注册状态不是**——
 * powershell 的档位、文件工具的 workspace 都在注册时被闭包捕获，改 settings 对
 * 已注册的 handler 无效。而 off 档下 registerPowershell 直接 return，
 * 所以「关→开」必须新增注册、「开→关」必须删除，注册表得支持注销。
 *
 * 只重建这两个工具：calculator / webSearch / 技能工具 / MCP 工具都不依赖这两项配置。
 * 子 agent 不受影响——它每次派发都通过 childRegistryOf 重新读父注册表。
 */
export async function reapplyTools(
  registry: ToolRegistry,
  settings: Settings,
  changed: Iterable<string>,
): Promise<void> {
  const keys = new Set(changed);
  const workspaceChanged = keys.has("workspace");
  if (!workspaceChanged && !keys.has("powershellMode")) return;

  if (workspaceChanged) {
    // 文件工具的根目录在闭包里，必须重建
    registry.unregister("write_file");
    registry.unregister("read_file");
    await registerFileTools(registry, settings.workspace);
  }
  // powershell 的 cwd 也绑在 workspace 上，所以 workspace 变化时它也要重建
  registry.unregister(POWERSHELL_TOOL_NAME);
  await registerPowershell(registry, settings);
}
