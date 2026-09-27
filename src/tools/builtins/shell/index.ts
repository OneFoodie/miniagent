/**
 * 通用执行通道：把本机 shell 交给模型。
 *
 * 这个工具的性质与其余内置工具**不同**：
 *
 * | | 边界 |
 * |---|---|
 * | `read_file` / `write_file` | 路径锁在 `workspace` 之内（越界直接报错） |
 * | **本工具** | **没有沙箱**：子进程权限 = 本进程权限，能读写 workspace 之外的任何路径 |
 *
 * 所以风险用「权限档位」显式化，而不是靠默认值猜：
 *   `off`      不注册此工具
 *   `readonly` 各平台用各自的方式限制「只能读」（默认档）
 *   `full`     不限制，等价于把整台机器交给模型
 *
 * full 档下强烈建议 `MINIAGENT_APPROVAL_TOOLS=powershell`：本框架的人工审批是整批挂起，
 * 能让每次执行都过一次人的眼睛。
 */

import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import type { Settings } from "../../../core/config.js";
import { defineTool } from "../../base.js";
import type { ToolRegistry } from "../../registry.js";
import { powershellAdapter } from "./powershell.js";
import type { ShellAdapter } from "./types.js";

export const POWERSHELL_TOOL_NAME = "powershell";

/**
 * full 档允许单次执行的最长时间。
 *
 * 为什么需要它：写个脚本跑一遍（数据处理、批量文件、构建）天然比取一次时间要久，
 * 固定 30s 会把正常任务砍掉。但也不能不设上限——否则一个卡住的命令会让整轮对话
 * 挂在那里等人，模型还会以为「再等等就好了」。
 */
const MAX_EXEC_TIMEOUT_SECONDS = 300;

/** 工具自身超时与运行时超时的余量：让「命令超时」的报错先于「工具超时」出现 */
const TIMEOUT_HEADROOM_SECONDS = 5;

/**
 * 按平台选适配器。
 * 收平台参数而不是内部读 process.platform，测试才能直接构造两种适配器。
 */
export function selectAdapter(platform: NodeJS.Platform): ShellAdapter {
  return platform === "win32" ? powershellAdapter : powershellAdapter;
}

/**
 * 启动时打印当前档位。
 * full 档是有实际后果的选择（等于把整台机器交给模型），所以要把审批建议一并说出来，
 * 而不是等出事了再去读文档。
 */
export function describeShell(settings: Settings): string {
  const adapter = selectAdapter(process.platform);
  const executable = adapter.executable(settings.powershellExecutable);
  switch (settings.powershellMode) {
    case "off":
      return "未启用（通用执行通道关闭）";
    case "readonly":
      return `readonly 档 · ${executable} · ${adapter.readonlyHint()}`;
    default:
      return (
        `full 档 · ${executable} · 命令不受限制：` +
        `建议把 ${POWERSHELL_TOOL_NAME} 加进 MINIAGENT_APPROVAL_TOOLS 走人工审批`
      );
  }
}

export async function registerPowershell(
  registry: ToolRegistry,
  settings: Settings,
): Promise<void> {
  const mode = settings.powershellMode;
  if (mode === "off") return;

  const adapter = selectAdapter(process.platform);
  const executable = adapter.executable(settings.powershellExecutable);
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
      ? `当前是 readonly 档：${adapter.readonlyHint()}。`
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
        `在本机执行一条命令，返回 stdout / stderr 与退出码。${adapter.usageHint()}` +
        "适合：获取当前时间、查看系统与进程信息、跑 git 等命令行工具、批量查看文件、" +
        "执行刚用 write_file 写好的脚本（node scripts/x.js、python scripts/x.py）。" +
        "不适合：读写 workspace 内的普通文本文件（用 read_file / write_file，它们有沙箱且更省 token）。" +
        modeHint,
      args: z.object({
        command: z.string().min(1).describe(`要执行的命令，例如 ${adapter.commandExample()}`),
        timeout_seconds: z.number().int().positive().optional().describe(timeoutHint),
      }),
      // 比内部定时器长一点：让「命令超时」的报错先出现，而不是被运行时判成工具超时
      timeoutSeconds: maxTimeoutSeconds + TIMEOUT_HEADROOM_SECONDS,
      handler: async ({ command, timeout_seconds }, signal) => {
        // 请求值按档位上限截断：模型能为慢任务调大，但突破不了档位允许的天花板
        const timeout = Math.min(timeout_seconds ?? configuredTimeout, maxTimeoutSeconds);
        const ctx = { cwd, timeoutSeconds: timeout, signal, executable };
        const outcome =
          mode === "readonly"
            ? await adapter.runReadonly(command, ctx)
            : await adapter.runFull(command, ctx);
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
