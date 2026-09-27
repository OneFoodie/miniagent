/**
 * POSIX 适配器：Linux / macOS 上的通用执行通道。
 *
 * 与 PowerShell 侧最关键的差别在 readonly 档：这里**不把命令交给 shell 解释**，
 * 而是拆成 argv 直接 execFile。于是管道、重定向、变量、命令替换、子 shell
 * 这些在 POSIX 上无穷列举的写法，在**机制层面根本不存在**——
 * 校验只需要处理「命令名」和「少数会写盘的选项」。
 */

import { ToolError } from "../../../core/errors.js";
import { execWithTimeout } from "./exec.js";
import type { RunContext, RunOutcome, ShellAdapter } from "./types.js";

/**
 * readonly 档放行的命令：**每个都是纯读**。
 *
 * 刻意不纳入的，以及各自的理由（有一条能写盘的路就够了）：
 *   find   -exec / -delete 能执行、能删
 *   git    config / checkout / clean 能写
 *   sed    -i 就地改写
 *   awk    print > file 能写
 *   xargs  能拼出任意命令
 *   tee    本身就是写
 *   env / printenv   环境变量信息面（凭据已被 buildChildEnv 过滤，但仍是泄露面）
 */
const READONLY_COMMANDS = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "pwd",
  "date",
  "whoami",
  "id",
  "uname",
  "df",
  "du",
  "stat",
  "file",
  "which",
  "echo",
  "sort",
  "uniq",
  "cut",
  "grep",
]);

/**
 * 命令本身只读，但某个选项会写盘或改状态。
 * 与 PowerShell 侧的 FORBIDDEN_PARAMS 是同一套思路：白名单挡不住的，用它补。
 */
const FORBIDDEN_OPTIONS: Record<string, string[]> = {
  sort: ["-o", "--output"],
  date: ["-s", "--set"],
};

/**
 * readonly 档校验：拆 argv → 查命令名 → 查危险选项。
 * 纯函数，便于穷举；通过时把 argv 一并交出去，避免调用方再拆一次。
 */
export function checkReadonlyCommand(
  command: string,
): { ok: true; argv: string[] } | { ok: false; reason: string } {
  const tokenized = tokenizeCommand(command);
  if (!tokenized.ok) return tokenized;

  const [name, ...args] = tokenized.argv;
  if (!name) return { ok: false, reason: "命令为空" };
  if (!READONLY_COMMANDS.has(name)) {
    return {
      ok: false,
      reason:
        `只读档只放行只读命令，'${name}' 不在白名单内；确有需要请把档位切到 full` +
        `（readonly 档也不支持管道、重定向、通配符与变量）`,
    };
  }
  for (const option of FORBIDDEN_OPTIONS[name] ?? []) {
    if (args.some((arg) => arg === option || arg.startsWith(`${option}=`))) {
      return { ok: false, reason: `只读档不允许 ${name} 的 ${option} 选项（它会写盘）` };
    }
  }
  return { ok: true, argv: tokenized.argv };
}


/**
 * 把一条命令拆成 argv。
 *
 * 只做「引号分组」与「反斜杠转义」两件事，**不解析**变量、通配符、重定向、管道：
 * 这些都是 shell 的活，而 readonly 档不走 shell。
 *
 * 引号规则按 POSIX 的常见形态实现：
 *   单引号内一切原样
 *   双引号内只认 \" 与 \\ 两种转义，其余反斜杠原样保留
 *   出现换行直接判非法（拒绝一切跨行命令，保持行为可预测）
 */
export function tokenizeCommand(
  command: string,
): { ok: true; argv: string[] } | { ok: false; reason: string } {
  const argv: string[] = [];
  let current = "";
  /** 是否见过引号或字符：用来区分 `echo ''`（一个空参数）与 `echo`（没有参数） */
  let touched = false;
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;

    if (char === "\n" || char === "\r") {
      return { ok: false, reason: "命令不能包含换行" };
    }

    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
      continue;
    }

    if (quote === '"') {
      if (char === '"') {
        quote = null;
        continue;
      }
      if (char === "\\" && index + 1 < command.length) {
        const next = command[index + 1]!;
        if (next === '"' || next === "\\") {
          current += next;
          index += 1;
          continue;
        }
        current += char;
        continue;
      }
      current += char;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      touched = true;
      continue;
    }
    if (char === "\\" && index + 1 < command.length) {
      current += command[index + 1]!;
      touched = true;
      index += 1;
      continue;
    }
    if (/\s/.test(char)) {
      if (touched) {
        argv.push(current);
        current = "";
        touched = false;
      }
      continue;
    }
    current += char;
    touched = true;
  }

  if (quote !== null) return { ok: false, reason: `引号 ${quote} 没有闭合` };
  if (touched) argv.push(current);

  if (argv.length === 0) return { ok: false, reason: "命令为空" };
  return { ok: true, argv };
}

export const posixAdapter: ShellAdapter = {
  executable(configured: string): string {
    return configured || "bash";
  },

  async runReadonly(command: string, ctx: RunContext): Promise<RunOutcome> {
    const check = checkReadonlyCommand(command);
    if (!check.ok) {
      // 直接抛：校验不过不该消耗一次进程启动
      throw new ToolError(`只读档拒绝执行：${check.reason}`);
    }
    const [name, ...args] = check.argv;
    // 关键：execFile(名字, argv) 而不是 bash -c。命令名必须是白名单里的裸名字，
    // 所以写 /bin/ls 也会因为名字不匹配而被上面的白名单拒掉。
    return execWithTimeout(name!, args, ctx, posixAdapter.missingExecutableHint(name!));
  },

  async runFull(command: string, ctx: RunContext): Promise<RunOutcome> {
    // full 档才经过 shell：管道、重定向、&& 这些真本事都在这里
    return execWithTimeout(
      ctx.executable,
      ["-c", command],
      ctx,
      posixAdapter.missingExecutableHint(ctx.executable),
    );
  },

  commandExample(): string {
    return "date -u、ls -la、grep -n TODO -r . 、git status";
  },

  usageHint(): string {
    return "命令是 POSIX shell（bash）语法。";
  },

  readonlyHint(): string {
    return "只允许只读命令，且不经过 shell：不支持管道、重定向、通配符展开与变量";
  },

  missingExecutableHint(executable: string): string {
    return (
      `找不到可执行文件 ${executable}：请安装 bash、` +
      `或用 MINIAGENT_SHELL_EXECUTABLE 指定（如 sh）；` +
      `不需要这个工具时可以设 MINIAGENT_SHELL_MODE=off`
    );
  },
};
