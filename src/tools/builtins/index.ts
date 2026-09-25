/** 内置工具集合与统一注册入口。 */

import type { Settings } from "../../core/config.js";
import type { ToolRegistry } from "../registry.js";
import { calculator } from "./calculator.js";
import { httpFetch } from "./httpFetch.js";
import { registerFileTools } from "./files.js";
import { registerPowershell } from "./powershell.js";
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
