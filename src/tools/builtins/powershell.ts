/**
 * PowerShell 工具：把本机 shell 作为通用执行通道交给模型。
 *
 * 为什么需要它：`Get-Date`、git 状态、系统信息、批量文件查看这类需求，不值得各写一个工具，
 * 一个 shell 就能全覆盖。但它的性质与其余内置工具**不同**：
 *
 * | | 边界 |
 * |---|---|
 * | `read_file` / `write_file` | 路径锁在 `workspace` 之内（越界直接报错） |
 * | **本工具** | **没有沙箱**：子进程权限 = 本进程权限，能读写 workspace 之外的任何路径 |
 *
 * 所以风险用「权限档位」显式化，而不是靠默认值猜：
 *   `off`      不注册此工具
 *   `readonly` 只放行白名单里的只读 cmdlet，且输入必须是**单条简单命令**（默认档）
 *   `full`     不限制，等价于把整台机器交给模型
 *
 * **readonly 档的边界要说清楚**：它保证的是「不写」，**不保证「不读出沙箱外的东西」**——
 * `Get-ChildItem C:\` 照样能列出沙箱外的目录。要读 workspace 内的文件请用 `read_file`。
 * 校验手段是「白名单命令名 + 拒绝元字符」，属于**防误用**，不是防对手的沙箱：
 * 真要在同一台机器上防住有恶意的模型，唯一可靠的做法是不给这个工具（`off`）。
 *
 * full 档下强烈建议 `MINIAGENT_APPROVAL_TOOLS=powershell`：本框架的人工审批是整批挂起，
 * 能让每次执行都过一次人的眼睛。
 */

import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import type { Settings } from "../../core/config.js";
import { ToolError } from "../../core/errors.js";
import { defineTool } from "../base.js";
import type { ToolRegistry } from "../registry.js";

const execFileAsync = promisify(execFile);

export const POWERSHELL_TOOL_NAME = "powershell";

/** 全档位共用的输出上限：超过就中断并让模型改用更精确的筛选（避免把几百 MB 灌进上下文） */
const MAX_OUTPUT_BYTES = 1024 * 1024;

/** 工具自身超时与运行时超时的余量：让「命令超时」的报错先于「工具超时」出现 */
const TIMEOUT_HEADROOM_SECONDS = 5;

/**
 * full 档允许单次执行的最长时间。
 *
 * 为什么需要它：写个脚本跑一遍（数据处理、批量文件、构建）天然比取一次时间要久，
 * 固定 30s 会把正常任务砍掉。但也不能不设上限——否则一个卡住的命令会让整轮对话
 * 挂在那里等人，模型还会以为「再等等就好了」。
 */
const MAX_EXEC_TIMEOUT_SECONDS = 300;

/** 失败时回给模型的标准输出/错误预览长度 */
const FAILURE_PREVIEW_CHARS = 800;

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

/**
 * 子进程环境：剔除凭据类变量。
 *
 * 起因很具体：readonly 档放行了 `Get-ChildItem`，而 `Get-ChildItem env:` 就能把环境变量
 * 全打出来——包括 `MINIAGENT_API_KEY`。模型读到的内容会进对话、进轨迹、进会话历史，
 * 等于把 Key 主动送进日志。所以这里按名字过滤掉凭据类变量。
 *
 * 说明：这是按名字的启发式过滤（KEY / TOKEN / SECRET / PASSWORD / CREDENTIAL），
 * 能挡住常见命名，不承诺挡住一切；真正的隔离要靠不开启这个工具。
 */
export function buildChildEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const secretPattern = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (secretPattern.test(key)) continue;
    env[key] = value;
  }
  return env;
}

/** 解析可执行文件：留空时 Windows 用内置的 powershell，其它平台用 PowerShell 7 的 pwsh */
export function resolvePowershellExecutable(configured: string): string {
  if (configured) return configured;
  return process.platform === "win32" ? "powershell" : "pwsh";
}

/**
 * 启动时打印当前档位。
 * full 档是有实际后果的选择（等于把整台机器交给模型），所以要把审批建议一并说出来，
 * 而不是等出事了再去读文档。
 */
export function describePowershell(settings: Settings): string {
  const executable = resolvePowershellExecutable(settings.powershellExecutable);
  switch (settings.powershellMode) {
    case "off":
      return "未启用（通用执行通道关闭）";
    case "readonly":
      return `readonly 档 · ${executable} · 仅只读 cmdlet，单条简单命令`;
    default:
      return (
        `full 档 · ${executable} · 命令不受限制：` +
        `建议把 powershell 加进 MINIAGENT_APPROVAL_TOOLS 走人工审批`
      );
  }
}

/** 把执行结果收敛成统一形状，避免把 Node 的错误结构透给模型 */
interface RunOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function preview(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > FAILURE_PREVIEW_CHARS
    ? `${trimmed.slice(0, FAILURE_PREVIEW_CHARS)}…（已截断）`
    : trimmed;
}

/**
 * 执行一条 PowerShell 命令。
 *
 * 超时/取消都走同一个 AbortController：运行时给的 signal 只覆盖「用户取消」，
 * 而工具的硬超时不会杀死底层进程（见 tools/runtime.ts 的说明），
 * 所以这里自带一个定时器，保证 PowerShell 进程真的被终止，而不是留下孤儿。
 */
async function runCommand(
  executable: string,
  command: string,
  timeoutSeconds: number,
  cwd: string,
  signal: AbortSignal,
): Promise<RunOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  const forwardAbort = (): void => controller.abort();
  signal.addEventListener("abort", forwardAbort, { once: true });

  // 输出编码必须显式设为 UTF-8：Windows PowerShell 默认按本地代码页输出，中文会变成乱码
  const wrapped = `& { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command} }`;

  try {
    const result = await execFileAsync(
      executable,
      ["-NoProfile", "-NonInteractive", "-Command", wrapped],
      {
        cwd,
        env: buildChildEnv(process.env),
        maxBuffer: MAX_OUTPUT_BYTES,
        signal: controller.signal,
        windowsHide: true,
      },
    );
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ToolError(
        signal.aborted
          ? "命令已被取消"
          : `命令执行超过 ${timeoutSeconds}s，已终止该进程（缩小范围或改用更精确的筛选）`,
      );
    }

    const failure = error as {
      code?: number | string;
      message: string;
      stdout?: string;
      stderr?: string;
    };
    if (typeof failure.code === "number") {
      // 非零退出：stderr 通常已经说明了原因，把它和 stdout 一起交给模型
      const detail = preview(`${failure.stderr || ""}\n${failure.stdout || ""}`) || "（无输出）";
      throw new ToolError(`命令退出码 ${failure.code}: ${detail}`);
    }
    if (failure.message.includes("maxBuffer")) {
      throw new ToolError(
        `输出超过 ${MAX_OUTPUT_BYTES} 字节已中断；请加上筛选条件（如 Select-String、-First）再试`,
      );
    }
    if (failure.code === "ENOENT") {
      // 说清「下一步做什么」，而不是把 spawn 的 errno 直接甩给模型
      throw new ToolError(
        `找不到可执行文件 ${executable}：请安装 PowerShell 7（pwsh）、` +
          `或用 MINIAGENT_POWERSHELL_EXECUTABLE 指定完整路径；` +
          `不需要这个工具时可以设 MINIAGENT_POWERSHELL_MODE=off`,
      );
    }
    throw new ToolError(`无法执行 ${executable}: ${failure.message}`);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", forwardAbort);
  }
}

export async function registerPowershell(
  registry: ToolRegistry,
  settings: Settings,
): Promise<void> {
  const mode = settings.powershellMode;
  if (mode === "off") return;

  const executable = resolvePowershellExecutable(settings.powershellExecutable);
  // 工作目录固定为 workspace：相对路径天然落在沙箱内，绝对路径则不受限（这一点在工具描述里写明）
  const cwd = resolve(settings.workspace);
  await mkdir(cwd, { recursive: true });

  // 单次能跑多久由档位决定：full 档要跑脚本/构建，允许调大；
  // readonly 档的用途是「取时间、看信息」，没有理由让它长时间占着进程。
  const configuredTimeout = settings.powershellTimeout;
  const maxTimeoutSeconds =
    mode === "full" ? Math.max(configuredTimeout, MAX_EXEC_TIMEOUT_SECONDS) : configuredTimeout;

  const modeHint =
    mode === "readonly"
      ? "当前是 readonly 档：只允许只读 cmdlet，且必须是单条简单命令（无管道、无连接符、无变量）。"
      : "当前是 full 档：命令不受限制。";
  const timeoutHint =
    mode === "full"
      ? `本次执行的超时（秒），默认 ${configuredTimeout}、上限 ${maxTimeoutSeconds}；` +
        "跑脚本、构建、装依赖这类慢任务时调大"
      : `本次执行的超时（秒）；readonly 档固定 ${configuredTimeout}，不接受调大`;

  registry.register(
    defineTool({
      name: POWERSHELL_TOOL_NAME,
      description:
        "在本机执行一条 PowerShell 命令，返回 stdout / stderr 与退出码。" +
        "适合：获取当前时间（Get-Date）、查看系统与进程信息、跑 git 等命令行工具、批量查看文件、" +
        "执行刚用 write_file 写好的脚本（node scripts/x.js、python scripts/x.py）。" +
        "不适合：读写 workspace 内的普通文本文件（用 read_file / write_file，它们有沙箱且更省 token）。" +
        modeHint,
      args: z.object({
        command: z
          .string()
          .min(1)
          .describe(
            "要执行的 PowerShell 命令，例如 Get-Date、Get-ChildItem -Path . -First 20、git status",
          ),
        timeout_seconds: z.number().int().positive().optional().describe(timeoutHint),
      }),
      // 比内部定时器长一点：让「命令超时」的报错先出现，而不是被运行时判成工具超时
      timeoutSeconds: maxTimeoutSeconds + TIMEOUT_HEADROOM_SECONDS,
      handler: async ({ command, timeout_seconds }, signal) => {
        if (mode === "readonly") {
          const check = checkReadonlyCommand(command);
          if (!check.ok) {
            // 直接抛：参数校验/权限问题不该消耗一次进程启动
            throw new ToolError(`只读档拒绝执行：${check.reason}`);
          }
        }
        // 请求值按档位上限截断：模型能为慢任务调大，但突破不了档位允许的天花板
        const timeout = Math.min(
          timeout_seconds ?? configuredTimeout,
          maxTimeoutSeconds,
        );
        const outcome = await runCommand(executable, command, timeout, cwd, signal);
        return {
          command,
          exit_code: outcome.exitCode,
          stdout: outcome.stdout.trim(),
          stderr: outcome.stderr.trim(),
          cwd,
        };
      },
    }),
  );
}
