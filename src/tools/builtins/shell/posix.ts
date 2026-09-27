/**
 * POSIX 适配器：Linux / macOS 上的通用执行通道。
 *
 * 与 PowerShell 侧最关键的差别在 readonly 档：这里**不把命令交给 shell 解释**，
 * 而是拆成 argv 直接 execFile。于是管道、重定向、变量、命令替换、子 shell
 * 这些在 POSIX 上无穷列举的写法，在**机制层面根本不存在**——
 * 校验只需要处理「命令名」和「少数会写盘的选项」。
 */

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
