/**
 * PowerShell 适配器：Windows 上的通用执行通道。
 *
 * 与 POSIX 侧最关键的差别在 readonly 档：这里靠「元字符黑名单 + cmdlet 白名单」**拦**住写操作，
 * 属于防误用而不是沙箱——`Get-ChildItem C:\` 照样能列出沙箱外的目录。
 * 真要在同一台机器上防住有恶意的模型，唯一可靠的做法是不给这个工具（`off` 档）。
 */

import { ToolError } from "../../../core/errors.js";
import { execWithTimeout } from "./exec.js";
import type { RunContext, RunOutcome, ShellAdapter } from "./types.js";

/**
 * readonly 档放行的 cmdlet：**全部无副作用**。
 * 写文件、改状态、启进程、装东西的一律不在内——白名单是这条路唯一的防线。
 */
const READONLY_COMMANDS = new Set(
  [
    // 时间与本地信息（这个工具最初的动机）
    "Get-Date",
    "Get-TimeZone",
    "Get-Culture",
    "Get-Location",
    "Get-Host",
    "Get-ComputerInfo",
    "Get-Volume",
    "Get-PSDrive",
    "Get-Process",
    "Get-Service",
    // 读取与检索
    "Get-ChildItem",
    "Get-Content",
    "Get-Item",
    "Get-ItemProperty",
    "Get-ItemPropertyValue",
    "Get-FileHash",
    "Select-String",
    "Measure-Object",
    // 路径与存在性判断
    "Test-Path",
    "Resolve-Path",
    "Split-Path",
    "Join-Path",
    // 自省（看看有哪些命令、某个对象有什么成员）
    "Get-Command",
    "Get-Help",
    "Get-Member",
  ].map((name) => name.toLowerCase()),
);

/**
 * readonly 档禁止出现的字符。
 * 这些都是「把一条命令变成一段程序」的语法：连接、管道、重定向、子表达式、变量、类型字面量。
 * 一个 `;` 就能让白名单形同虚设，所以宁可误伤（连引号里的分号也拒），也不能放过。
 */
const FORBIDDEN_CHARS = [
  ";",
  "|",
  "&",
  ">",
  "<",
  "`",
  "$",
  "(",
  ")",
  "{",
  "}",
  "[",
  "]",
  "#",
  "%",
  "\n",
  "\r",
];

/** readonly 档禁止的参数：读命令上带了这些参数，结果就会写到别处去 */
const FORBIDDEN_PARAMS = [
  "-outfile",
  "-destination",
  "-redirectstandardoutput",
  "-redirectstandarderror",
];

/** readonly 档的命令校验结果 */
export interface CommandCheck {
  ok: boolean;
  reason?: string;
}

/** 校验一条命令是否满足 readonly 档要求；纯函数，便于穷举边界 */
export function checkReadonlyCommand(command: string): CommandCheck {
  const trimmed = command.trim();
  if (!trimmed) return { ok: false, reason: "命令为空" };

  for (const char of FORBIDDEN_CHARS) {
    if (trimmed.includes(char)) {
      return {
        ok: false,
        reason:
          `只读档不允许出现 ${JSON.stringify(char)}` +
          `（连接符、管道、重定向、子表达式、变量都会绕过白名单）`,
      };
    }
  }

  const name = trimmed.split(/\s+/)[0] ?? "";
  if (!READONLY_COMMANDS.has(name.toLowerCase())) {
    return {
      ok: false,
      reason: `只读档只放行只读 cmdlet，'${name}' 不在白名单内；确有需要请把档位切到 full`,
    };
  }

  const lower = trimmed.toLowerCase();
  const param = FORBIDDEN_PARAMS.find((item) => lower.includes(item));
  if (param) {
    return { ok: false, reason: `只读档不允许参数 ${param}` };
  }
  return { ok: true };
}

export const powershellAdapter: ShellAdapter = {
  executable(configured: string): string {
    if (configured) return configured;
    return process.platform === "win32" ? "powershell" : "pwsh";
  },

  async runReadonly(command: string, ctx: RunContext): Promise<RunOutcome> {
    const check = checkReadonlyCommand(command);
    if (!check.ok) {
      // 直接抛：参数校验/权限问题不该消耗一次进程启动
      throw new ToolError(`只读档拒绝执行：${check.reason}`);
    }
    return powershellAdapter.runFull(command, ctx);
  },

  async runFull(command: string, ctx: RunContext): Promise<RunOutcome> {
    // 输出编码必须显式设为 UTF-8：Windows PowerShell 默认按本地代码页输出，中文会变成乱码
    const wrapped = `& { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command} }`;
    return execWithTimeout(
      ctx.executable,
      ["-NoProfile", "-NonInteractive", "-Command", wrapped],
      ctx,
      powershellAdapter.missingExecutableHint(ctx.executable),
    );
  },

  commandExample(): string {
    return "Get-Date、Get-ChildItem -Path . -First 20、git status";
  },

  usageHint(): string {
    return "命令是 PowerShell 语法。";
  },

  readonlyHint(): string {
    return "只允许只读 cmdlet，且必须是单条简单命令（无管道、无连接符、无变量）";
  },

  missingExecutableHint(executable: string): string {
    return (
      `找不到可执行文件 ${executable}：请安装 PowerShell 7（pwsh）、` +
      `或用 MINIAGENT_POWERSHELL_EXECUTABLE 指定完整路径；` +
      `不需要这个工具时可以设 MINIAGENT_POWERSHELL_MODE=off`
    );
  },
};
