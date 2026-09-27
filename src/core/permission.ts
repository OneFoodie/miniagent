/**
 * 会话级权限档位：决定「谁来裁决一条敏感工具调用能不能执行」。
 *
 * 为什么单独成模块、而不是并进 config.ts：档位是**按请求**传入的运行期选择，
 * 与 Settings（启动时读一次的环境配置）不是同一类东西。配置里只有「哪些工具算敏感」
 * （approvalTools），档位由客户端每次请求带上——服务端因此保持无状态。
 */

import { ConfigError } from "./errors.js";
import type { ToolCall } from "./types.js";

export type PermissionMode = "manual" | "ai" | "full";

/** 合法档位；顺序即报错信息里列出的候选顺序 */
const MODES: readonly PermissionMode[] = ["manual", "ai", "full"];

/**
 * 解析请求里传来的档位。
 *
 * 空值/未定义 → `manual`（最保守的一档，不放大任何权限）。
 * 非法值**直接报错**而不是回退默认：与 config.ts 的 readShellMode 同一理由——
 * 把 `ait` 这类拼错静默当成 manual，会让用户「以为开了 AI 审批、其实还在手动挂起」。
 * 大小写不敏感，容忍前后空白（前端可能从 localStorage 原样带回）。
 */
export function parsePermissionMode(value: unknown): PermissionMode {
  if (value === undefined || value === null) return "manual";
  if (typeof value !== "string") {
    throw new ConfigError(`权限档位需要字符串，收到: ${typeof value}`);
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "") return "manual";
  if ((MODES as readonly string[]).includes(normalized)) {
    return normalized as PermissionMode;
  }
  throw new ConfigError(`未知的权限档位: ${value}；可选: ${MODES.join(" / ")}`);
}

/** 中文一句话说明，供 UI 下拉与启动日志展示 */
export function describePermissionMode(mode: PermissionMode): string {
  switch (mode) {
    case "manual":
      return "手动审批：敏感工具挂起，等人在审批卡片上点批准";
    case "ai":
      return "自动 AI 审批：由 AI 裁决敏感工具，不打扰人（是便利层，不是安全防线）";
    case "full":
      return "完全访问：不再审批，敏感工具直接执行";
  }
}

/** AI 裁决结果：verdict 是结论，reason 是要进轨迹、供人事后核对的理由 */
export interface AiVerdict {
  verdict: "approve" | "deny";
  reason: string;
}

/**
 * 「谁能裁决一次工具调用」的最小接口。
 *
 * 定义在 core 而不是 agent 层：工具作用域（core/events.ts 的 ToolScope）要把审批器
 * 下传给子 agent，而 core 不能反向依赖 agent 层的具体实现类。AiApprover 实现它即可，
 * 于是 AgentOptions / ServerDeps 与测试替身都只依赖这个接口。
 */
export interface ToolApprover {
  judge(call: ToolCall, question: string, signal: AbortSignal): Promise<AiVerdict>;
}

/**
 * 白名单的只读查询面：判定只需要 `has()`。
 *
 * 收窄成这个接口，是为了让 core 层的 ToolScope 能把白名单随工具作用域下传给子 agent，
 * 而不必（也不该）让 core 反向依赖 agent/allowlist 的具体类。ApprovalAllowlist 实现它。
 */
export interface AllowlistLookup {
  has(tool: string, args: Record<string, unknown>): boolean;
}
