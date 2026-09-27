/**
 * 共用的执行辅助：超时、取消与错误翻译。
 *
 * 为什么单独一个文件而不是放进 types.ts 旁边：各平台适配器都要用它，
 * 若放在同一个模块里会形成 adapter → powershell → adapter 的循环导入。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { ToolError } from "../../../core/errors.js";
import type { RunContext, RunOutcome } from "./types.js";

const execFileAsync = promisify(execFile);

/** 全档位共用的输出上限：超过就中断并让模型改用更精确的筛选（避免把几百 MB 灌进上下文） */
export const MAX_OUTPUT_BYTES = 1024 * 1024;

/** 失败时回给模型的标准输出/错误预览长度 */
const FAILURE_PREVIEW_CHARS = 800;

function preview(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > FAILURE_PREVIEW_CHARS
    ? `${trimmed.slice(0, FAILURE_PREVIEW_CHARS)}…（已截断）`
    : trimmed;
}

/**
 * 子进程环境：剔除凭据类变量。
 *
 * 起因很具体：readonly 档放行了列目录类命令，而把环境变量全打出来是它们的常规用法——
 * 包括 `MINIAGENT_API_KEY`。模型读到的内容会进对话、进轨迹、进会话历史，
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

/**
 * 跑一个子进程，统一处理超时、取消与失败翻译。
 *
 * 超时/取消都走同一个 AbortController：运行时给的 signal 只覆盖「用户取消」，
 * 而工具的硬超时不会杀死底层进程（见 tools/runtime.ts 的说明），
 * 所以这里自带一个定时器，保证进程真的被终止，而不是留下孤儿。
 */
export async function execWithTimeout(
  executable: string,
  args: string[],
  ctx: RunContext,
  missingHint: string,
): Promise<RunOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.timeoutSeconds * 1000);
  const forwardAbort = (): void => controller.abort();
  ctx.signal.addEventListener("abort", forwardAbort, { once: true });

  try {
    const result = await execFileAsync(executable, args, {
      cwd: ctx.cwd,
      env: buildChildEnv(process.env),
      maxBuffer: MAX_OUTPUT_BYTES,
      signal: controller.signal,
      windowsHide: true,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ToolError(
        ctx.signal.aborted
          ? "命令已被取消"
          : `命令执行超过 ${ctx.timeoutSeconds}s，已终止该进程（缩小范围或改用更精确的筛选）`,
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
        `输出超过 ${MAX_OUTPUT_BYTES} 字节已中断；请加上筛选条件（head / grep / Select-String）再试`,
      );
    }
    if (failure.code === "ENOENT") {
      // 说清「下一步做什么」，而不是把 spawn 的 errno 直接甩给模型
      throw new ToolError(missingHint);
    }
    throw new ToolError(`无法执行 ${executable}: ${failure.message}`);
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener("abort", forwardAbort);
  }
}
