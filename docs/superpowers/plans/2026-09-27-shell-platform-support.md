# 通用执行通道平台无关化 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把只会跑 PowerShell 的通用执行通道做成平台无关：Windows 用 PowerShell，Linux/macOS 用系统自带的 bash；工具更名为 `shell`。

**Architecture:** 把原 `src/tools/builtins/powershell.ts`（376 行）拆成 `src/tools/builtins/shell/` 目录——`types.ts` 定接口、`exec.ts` 放共用执行与错误翻译、`powershell.ts` / `posix.ts` 各管一套语法与白名单、`index.ts` 注册工具并按平台选适配器。POSIX 的 readonly 档**不经过 shell**，把命令拆成 argv 直接 `execFile`，于是管道/重定向/变量在机制层面不存在。

**Tech Stack:** TypeScript 5 + Node 22 ESM、`node:child_process` 的 `execFile`、vitest。

**Spec:** [docs/superpowers/specs/2026-09-27-shell-platform-support-design.md](../specs/2026-09-27-shell-platform-support-design.md)

**与 spec 的一处偏差：** spec 第 2.1 节写 4 个文件，实际拆成 5 个——多出一个 `exec.ts`。原因是共用的执行辅助（`execWithTimeout` / `buildChildEnv` / `preview`）若放进 `adapter.ts`，会形成 `adapter → powershell → adapter` 的循环导入。放进独立的 `exec.ts` 后依赖是单向的：`types ← exec ← {powershell, posix} ← index`。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/tools/builtins/shell/types.ts` | **新建**。`RunOutcome` / `RunContext` / `ShellAdapter` 接口 |
| `src/tools/builtins/shell/exec.ts` | **新建**。`execWithTimeout`（超时+取消+错误翻译）、`buildChildEnv`、`preview` |
| `src/tools/builtins/shell/powershell.ts` | **新建**。Windows 适配器：包装语法 + cmdlet 白名单 |
| `src/tools/builtins/shell/posix.ts` | **新建**。POSIX 适配器：`tokenizeCommand` + 只读白名单 + argv 直执 / `bash -c` |
| `src/tools/builtins/shell/index.ts` | **新建**。`registerShell`、`describeShell`、`selectAdapter`、工具名常量 |
| `src/tools/builtins/powershell.ts` | **删除**（内容迁入 shell/） |
| `src/core/config.ts` | `ShellMode`、三个字段改名、新旧环境变量、`approvalTools` 映射 |
| `src/core/configSchema.ts` | field key/type 改 `shellMode` |
| `src/tools/builtins/index.ts` | 改从 `./shell/index.js` 引入 |
| `src/server/server.ts`、`src/cli.ts` | `describeShell`、`settings.shellMode` |
| `src/prompts/system.ts` | 工具名 + 平台化提示 |
| `public/app.js` | 三处 `field.type === "powershellMode"` 常量 |
| `README.md`、`.env.example`、`docker-compose.yml` | 文案与环境变量名 |
| `tests/shell.test.ts` | 由 `tests/powershell.test.ts` 改名并扩展 |
| `tests/{builtins,configSchema,server,prompt,skills}.test.ts` | 字段名与工具名同步 |

**任务顺序的用意**：Task 1–4 保持工具名与环境变量**不变**，只做结构与能力；Task 5 才一次性改名。这样每个任务结束时 `npm test` 都是全绿的，不会出现「改到一半编译不过」的中间态。

---

## Task 1: 抽出 shell/ 目录（纯重构，行为不变）

**Files:**
- Create: `src/tools/builtins/shell/types.ts`
- Create: `src/tools/builtins/shell/exec.ts`
- Create: `src/tools/builtins/shell/powershell.ts`
- Create: `src/tools/builtins/shell/index.ts`
- Delete: `src/tools/builtins/powershell.ts`
- Modify: `src/tools/builtins/index.ts`
- Modify: `src/server/server.ts:71`、`src/cli.ts:35`
- Modify: `tests/powershell.test.ts`（import 路径）

- [ ] **Step 1: 建 `shell/types.ts`**

```ts
/** 通用执行通道的适配器契约：把「一条命令」翻译成各平台的执行方式。 */

import type { Settings } from "../../../core/config.js";

/** 一次执行的原始结果：适配器只负责跑，不管档位策略 */
export interface RunOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunContext {
  /** 工作目录，固定为 workspace */
  cwd: string;
  /** 本次执行的超时（秒） */
  timeoutSeconds: number;
  /** 用户取消信号 */
  signal: AbortSignal;
  /** 已解析的可执行文件；POSIX readonly 不用它（走白名单里的裸命令名） */
  executable: string;
}

/**
 * 平台适配器。
 *
 * readonly 与 full 分成两个方法而不是一个带 flag 的方法：两者的危险程度差一个量级，
 * 分开后「readonly 走了 full 的实现」这种错误在类型层面就写不出来。
 */
export interface ShellAdapter {
  /** 解析可执行文件：留空时各平台给默认值 */
  executable(configured: string): string;
  /**
   * readonly 档。由平台自己保证「不可能写」：
   *   Windows 靠元字符黑名单 + cmdlet 白名单拦
   *   POSIX   靠不经 shell、直接 exec argv 让写机制不存在
   */
  runReadonly(command: string, ctx: RunContext): Promise<RunOutcome>;
  /** full 档：命令不受限 */
  runFull(command: string, ctx: RunContext): Promise<RunOutcome>;
  /** 工具描述里的参数示例，如 "Get-Date" / "date -u" */
  commandExample(): string;
  /** 工具描述里的平台使用提示（语法与「不能用什么」） */
  usageHint(): string;
  /** 档位说明，供 describeShell 拼日志 */
  readonlyHint(): string;
  /** ENOENT 时给「下一步该做什么」的安装提示 */
  missingExecutableHint(executable: string): string;
}
```

- [ ] **Step 2: 建 `shell/exec.ts`**

```ts
/**
 * 共用的执行辅助：超时、取消与错误翻译。
 *
 * 为什么单独一个文件而不是放进 adapter.ts：各平台适配器都要用它，
 * 若放在 adapter.ts 会形成 adapter → powershell → adapter 的循环导入。
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
        `输出超过 ${MAX_OUTPUT_BYTES} 字节已中断；请加上筛选条件（如 Select-String、-First）再试`,
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
```

- [ ] **Step 3: 建 `shell/powershell.ts`（Windows 适配器）**

内容 = 原文件里 PowerShell 专属的部分。**逐字保留**原来的常量与校验逻辑，只改成适配器形状。

```ts
/**
 * PowerShell 适配器：Windows 上的通用执行通道。
 *
 * 与 POSIX 侧的关键差别：readonly 档靠「元字符黑名单 + cmdlet 白名单」**拦**住写操作，
 * 属于防误用而非沙箱（`Get-ChildItem C:\` 照样能读沙箱外）。
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
  ";", "|", "&", ">", "<", "`", "$", "(", ")", "{", "}", "[", "]", "#", "%", "\n", "\r",
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
```

- [ ] **Step 4: 建 `shell/index.ts`（注册 + 档位 + 描述）**

```ts
/**
 * 通用执行通道：把本机 shell 交给模型。
 *
 * 工具名在 Task 5 会从 `powershell` 改为 `shell`；本任务先只做目录拆分，行为与改名前的完全一致。
 *
 * 这个工具的性质与其余内置工具**不同**：
 *   read_file / write_file  路径锁在 workspace 之内（越界直接报错）
 *   本工具                  **没有沙箱**：子进程权限 = 本进程权限
 *
 * 所以风险用「权限档位」显式化，而不是靠默认值猜：
 *   off      不注册此工具
 *   readonly 各平台用各自的方式限制「只能读」（默认档）
 *   full     不限制，等价于把整台机器交给模型
 *
 * full 档下强烈建议 `MINIAGENT_APPROVAL_TOOLS=powershell`：本框架的人工审批是整批挂起，
 * 能让每次执行都过一次人的眼睛。
 */

import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import type { Settings } from "../../../core/config.js";
import { defineTool } from "../base.js";
import type { ToolRegistry } from "../registry.js";
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

/** 按平台选适配器。收参数而不是内部读 process.platform，测试才能直接构造两种适配器 */
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
    mode === "readonly" ? `当前是 readonly 档：${adapter.readonlyHint()}。` : "当前是 full 档：命令不受限制。";
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
```

> `selectAdapter` 里两个分支都返回 `powershellAdapter` 是有意的：Task 1 只搬结构，Task 3 才把 `posixAdapter` 接进来。

- [ ] **Step 5: 删除旧文件并改引用**

```bash
git rm src/tools/builtins/powershell.ts
```

`src/tools/builtins/index.ts`：把 `from "./powershell.js"` 改为 `from "./shell/index.js"`（其余不动）。

`src/server/server.ts:71` 与 `src/cli.ts:35`：`from "../tools/builtins/powershell.js"` → `from "../tools/builtins/shell/index.js"`，并把 `describePowershell` 全部替换为 `describeShell`。

`tests/powershell.test.ts`：导出项搬家了，import 要拆成三条——`buildChildEnv` 来自 `shell/exec.js`，`checkReadonlyCommand` 来自 `shell/powershell.js`，`POWERSHELL_TOOL_NAME` / `registerPowershell` 来自 `shell/index.js`。原先的 `resolvePowershellExecutable("")` 断言改为 `powershellAdapter.executable("")`（`powershellAdapter` 从 `shell/powershell.js` 引入），`hasPowerShell()` 里的调用同步替换。

- [ ] **Step 6: 跑全量检查确认行为未变**

Run: `npm run typecheck && npm run lint && npm test`
Expected: 全绿，用例数与重构前一致（430 项）

- [ ] **Step 7: 提交**

```bash
git add src/tools/builtins/shell src/tools/builtins/index.ts src/server/server.ts src/cli.ts tests/powershell.test.ts
git commit -m "把通用执行通道拆成 shell/ 目录：接口、共用执行、PowerShell 适配器"
```

---

## Task 2: POSIX 词法器

**Files:**
- Create: `src/tools/builtins/shell/posix.ts`（本任务只放 `tokenizeCommand`）
- Create: `tests/shell.test.ts`（本任务开始建，先放词法器用例；`tests/powershell.test.ts` 的内容在 Task 3 合并进来）

- [ ] **Step 1: 先写 `posix.ts` 的骨架与词法器**

```ts
/**
 * POSIX 适配器：Linux / macOS 上的通用执行通道。
 *
 * 与 PowerShell 侧最关键的差别在 readonly 档：这里**不把命令交给 shell 解释**，
 * 而是拆成 argv 直接 execFile。于是管道、重定向、变量、命令替换、子 shell
 * 这些在 POSIX 上无穷列举的写法，在**机制层面根本不存在**——
 * 黑名单只需要处理「命令名」和「少数会写盘的选项」。
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
 *   引号内出现换行直接判非法（拒绝一切跨行命令，保持行为可预测）
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
```

- [ ] **Step 2: 建 `tests/shell.test.ts` 写词法器用例**

```ts
/**
 * 通用执行通道：平台无关逻辑（词法、白名单、档位）+ 各平台真实执行。
 *
 * 安全相关的逻辑全部用**纯函数**覆盖，任何平台都能跑；
 * 真实执行按平台分组，跑不起来的平台自动跳过。
 */

import { describe, expect, it } from "vitest";

import { tokenizeCommand } from "../src/tools/builtins/shell/posix.js";

describe("POSIX 词法器", () => {
  it("按空白拆分并保留引号内的空格", () => {
    expect(tokenizeCommand("ls -la /tmp")).toEqual({ ok: true, argv: ["ls", "-la", "/tmp"] });
    expect(tokenizeCommand('grep "a b" f')).toEqual({ ok: true, argv: ["grep", "a b", "f"] });
    expect(tokenizeCommand("grep 'a b' f")).toEqual({ ok: true, argv: ["grep", "a b", "f"] });
  });

  it("通配符原样保留（readonly 不经 shell，不会被展开）", () => {
    expect(tokenizeCommand("ls *.txt")).toEqual({ ok: true, argv: ["ls", "*.txt"] });
    expect(tokenizeCommand("ls $HOME x")).toEqual({ ok: true, argv: ["ls", "$HOME", "x"] });
    expect(tokenizeCommand("ls a|b")).toEqual({ ok: true, argv: ["ls", "a|b"] });
  });

  it("反斜杠转义：引号外转义下一个字符，单引号内原样", () => {
    expect(tokenizeCommand("grep a\\ b f")).toEqual({ ok: true, argv: ["grep", "a b", "f"] });
    expect(tokenizeCommand("grep 'a\\b' f")).toEqual({ ok: true, argv: ["grep", "a\\b", "f"] });
    // 双引号内只认 \" 与 \\，其余反斜杠原样保留
    expect(tokenizeCommand('grep "a\\tb" f')).toEqual({ ok: true, argv: ["grep", "a\\tb", "f"] });
    expect(tokenizeCommand('grep "a\\"b" f')).toEqual({ ok: true, argv: ["grep", 'a"b', "f"] });
  });

  it("连续空白不产生空参数，但显式空引号算一个空参数", () => {
    expect(tokenizeCommand("ls    -la")).toEqual({ ok: true, argv: ["ls", "-la"] });
    expect(tokenizeCommand("ls '' x")).toEqual({ ok: true, argv: ["ls", "", "x"] });
  });

  it("空命令与未闭合引号被拒", () => {
    expect(tokenizeCommand("   ").ok).toBe(false);
    expect(tokenizeCommand("").ok).toBe(false);
    expect(tokenizeCommand('grep "abc').ok).toBe(false);
    expect(tokenizeCommand("grep 'abc").ok).toBe(false);
  });

  it("拒绝换行，避免跨行命令", () => {
    expect(tokenizeCommand("ls\ncat f").ok).toBe(false);
    expect(tokenizeCommand("grep 'a\nb' f").ok).toBe(false);
  });
});
```

- [ ] **Step 3: 跑测试**

Run: `npx vitest run tests/shell.test.ts`
Expected: PASS（6 个用例）

- [ ] **Step 4: 提交**

```bash
git add src/tools/builtins/shell/posix.ts tests/shell.test.ts
git commit -m "新增 POSIX 命令词法器：不解析变量与通配符，只做引号分组与转义"
```

---

## Task 3: POSIX 适配器接线

**Files:**
- Modify: `src/tools/builtins/shell/posix.ts`（补白名单、readonly、full、适配器对象）
- Modify: `src/tools/builtins/shell/index.ts`（`selectAdapter` 接 posix）
- Modify: `tests/shell.test.ts`（补 POSIX 用例，并把 `tests/powershell.test.ts` 的内容并入；并入后删除原文件）

- [ ] **Step 1: 在 `posix.ts` 追加白名单与适配器**

```ts
import { ToolError } from "../../../core/errors.js";
import { execWithTimeout } from "./exec.js";
import type { RunContext, RunOutcome, ShellAdapter } from "./types.js";

/**
 * readonly 档放行的命令：**每个都是纯读**。
 *
 * 刻意不纳入的，以及各自的理由（一条能写盘的路就够了）：
 *   find   -exec / -delete 能执行、能删
 *   git    config / checkout / clean 能写
 *   sed    -i 就地改写
 *   awk    print > file 能写
 *   xargs  能拼出任意命令
 *   tee    本身就是写
 *   env / printenv   环境变量信息面（凭据已被 buildChildEnv 过滤，但仍是泄露面）
 */
const READONLY_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "wc", "pwd", "date", "whoami", "id", "uname",
  "df", "du", "stat", "file", "which", "echo", "sort", "uniq", "cut", "grep",
]);

/**
 * 命令本身只读，但某个选项会写盘或改状态。
 * 与 PowerShell 侧的 FORBIDDEN_PARAMS 是同一套思路：白名单挡不住的，用它补。
 */
const FORBIDDEN_OPTIONS: Record<string, string[]> = {
  sort: ["-o", "--output"],
  date: ["-s", "--set"],
};

/** readonly 档的校验结果；纯函数，便于穷举 */
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
```

再追加适配器对象：

```ts
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
    // 所以写 /bin/ls 也会因为名字不匹配被上面的白名单拒掉。
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
      `或用 MINIAGENT_POWERSHELL_EXECUTABLE 指定（如 sh）；` +
      `不需要这个工具时可以设 MINIAGENT_POWERSHELL_MODE=off`
    );
  },
};
```

- [ ] **Step 2: `index.ts` 把 posix 接进 `selectAdapter`**

```ts
import { posixAdapter } from "./posix.js";

export function selectAdapter(platform: NodeJS.Platform): ShellAdapter {
  return platform === "win32" ? powershellAdapter : posixAdapter;
}
```

- [ ] **Step 3: 把 `tests/powershell.test.ts` 并入 `tests/shell.test.ts`**

不拆成两个文件：拆开会让 `makeTool` / `testSettings` 两份夹具重复，而它们本来就是平台无关的。最终只要一个 `tests/shell.test.ts`，按平台分组：

1. 把 `tests/powershell.test.ts` 里的 `testSettings` / `makeTool` / `hasPowerShell` / `available` 整体挪进 `tests/shell.test.ts`，import 合并去重。
2. 平台无关的块保持普通 `describe`：`子进程环境过滤`、`档位与注册`（除下一条）。
3. 两块**只在 Windows 有意义**的，加守卫：
   - `describe("readonly 档：白名单与元字符校验")` → `describe.skipIf(process.platform !== "win32")("PowerShell readonly 档：白名单与元字符校验")`
   - `describe.skipIf(!available)("真实执行")` → `describe.skipIf(process.platform !== "win32" || !available)("PowerShell 真实执行")`
4. 「可执行文件可配置」用例改为断言 `powershellAdapter.executable("")`。
5. 删除 `tests/powershell.test.ts`：`git rm tests/powershell.test.ts`

- [ ] **Step 4: 在 `tests/shell.test.ts` 补 POSIX 用例**

```ts
describe("POSIX readonly 白名单", () => {
  it("放行只读命令", () => {
    for (const command of ["date", "date -u", "ls -la", "whoami", "grep -n TODO f"]) {
      expect(checkReadonlyCommand(command).ok, command).toBe(true);
    }
  });

  it("拒绝不在白名单的命令（含带路径的同名命令）", () => {
    for (const command of [
      "find . -type f",
      "git status",
      "sed -n 1p f",
      "awk '{print}' f",
      "xargs rm",
      "tee out.txt",
      "env",
      "/bin/ls -la",
      "rm -rf /tmp/x",
    ]) {
      const result = checkReadonlyCommand(command);
      expect(result.ok, command).toBe(false);
      expect(result.reason, command).toBeTruthy();
    }
  });

  it("拒绝会写盘的选项", () => {
    expect(checkReadonlyCommand("sort -o /tmp/x f").ok).toBe(false);
    expect(checkReadonlyCommand("sort --output=/tmp/x f").ok).toBe(false);
    expect(checkReadonlyCommand("date -s '2020-01-01'").ok).toBe(false);
  });

  it("管道与重定向不是被黑名单拦的，而是 argv 里不存在这种机制", () => {
    // `ls | cat` 在 POSIX readonly 下会拆成 argv ["ls","|","cat"]，
    // 于是 execFile 试图把 "|" 与 "cat" 当参数传给 ls —— 白名单只认命令名，所以放行到 ls；
    // 真正拦住它的是「ls 不认识这些参数」。这里只断言命令名仍是 ls，
    // 以此固化「没有 shell 参与」这个前提。
    const result = checkReadonlyCommand("ls | cat");
    expect(result.ok).toBe(true);
    expect(result.ok && result.argv).toEqual(["ls", "|", "cat"]);
  });
});
```

```ts
describe.skipIf(process.platform === "win32")("POSIX 真实执行", () => {
  it("readonly 档能取到时间与用户名（不走 shell）", async () => {
    const tool = await makeTool({ powershellMode: "readonly" });
    const date = await tool.run({ command: "date" });
    expect(date.ok).toBe(true);
    expect((date.data as { stdout: string }).stdout).toMatch(/\d{4}/);

    const who = await tool.run({ command: "whoami" });
    expect(who.ok).toBe(true);
  });

  it("readonly 档不展开通配符：*.txt 会字面传给命令", async () => {
    const tool = await makeTool({ powershellMode: "readonly" });
    const result = await tool.run({ command: "ls *.txt" });
    // 目录里没有字面名为 *.txt 的文件，所以是失败；关键是失败原因来自 ls 找不到该名字
    expect(result.ok).toBe(false);
  });

  it("full 档真的经过 shell：管道可用", async () => {
    const tool = await makeTool({ powershellMode: "full" });
    const result = await tool.run({ command: "echo hello | tr a-z A-Z" });
    expect(result.ok).toBe(true);
    expect((result.data as { stdout: string }).stdout).toBe("HELLO");
  });

  it("非零退出码转成失败", async () => {
    const tool = await makeTool({ powershellMode: "full" });
    const result = await tool.run({ command: "exit 3" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("退出码 3");
  });

  it("命令超时会被真正终止", async () => {
    const tool = await makeTool({ powershellMode: "full", powershellTimeout: 1 });
    const result = await tool.run({ command: "sleep 30" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("超过 1s");
  });
});
```

其中 `makeTool` 与 `testSettings` 用 Step 3 已经并入的那一份，不要再复制。

- [ ] **Step 5: 跑测试**

Run: `npx vitest run tests/shell.test.ts`
Expected: PASS（POSIX 真跑用例在本机 Windows 上跳过，PowerShell 用例全跑）

- [ ] **Step 6: 全量检查并提交**

Run: `npm run typecheck && npm run lint && npm test`
Expected: 全绿

```bash
git add src/tools/builtins/shell tests/shell.test.ts
git rm tests/powershell.test.ts
git commit -m "接入 POSIX 适配器：readonly 不经 shell 直执 argv，full 走 bash -c"
```

---

## Task 4: 提示词平台化

**Files:**
- Modify: `src/prompts/system.ts:68-82`
- Modify: `tests/prompt.test.ts:94-138`

- [ ] **Step 1: 改 `system.ts`**

把 `if (context.toolNames.includes("powershell"))` 整块替换为：

```ts
    if (context.toolNames.includes("powershell")) {
      // 工具名与语法示例都要按平台给：Linux 上说要「用 Get-Date」会把模型带错
      const windows = process.platform === "win32";
      const timeExample = windows ? "Get-Date" : "date";
      lines.push(
        `- 需要当前日期时间、本机环境信息或要跑命令行工具（git 等）时用 powershell（如 ${timeExample}）。`,
        "- 你的知识不含实时时间；问到「现在」必须实际调用工具，不要凭记忆或推测作答。",
      );
      // 有了脚本这条通道，「循环 / 批量计算 / 反复试错」就不必硬凑工具调用来表达
      if (context.toolNames.includes("write_file")) {
        lines.push(
          "- 需要循环、批量计算或反复试错时，别硬凑工具调用：用 write_file 把脚本写到 scripts/，",
          "  再用 powershell 执行（node scripts/x.js / python scripts/x.py），按 stdout 判断结果。",
        );
        if (windows) {
          lines.push(
            "- Windows 上写 python（或 py），不要写 python3——它常是应用商店的占位符，跑起来没有任何输出。",
          );
        } else {
          lines.push("- 这个平台上解释器叫 python3，不要写 python。");
        }
        lines.push(
          "- 脚本的当前目录就是工作区根；输出过长会自动存成文件并把路径给你，用 read_file 分段读。",
        );
      }
    }
```

- [ ] **Step 2: 改 `tests/prompt.test.ts` 让断言按平台取**

```ts
  it("注册了 powershell 才提示「时间要靠工具取」，否则不提", () => {
    // 模型的训练数据里没有"现在"，不给工具就不该鼓励它去猜时间
    const withTool = createDefaultPromptBuilder().build({
      ...baseContext,
      toolNames: ["powershell"],
    }).text;
    expect(withTool).toContain(process.platform === "win32" ? "Get-Date" : "date");
```

并把断言 `expect(shellOnly).not.toContain("不要写 python3")` 保持不变（该提示只在 win32 且注册了 write_file 时出现），另加一条：

```ts
    // python 提示要分平台：Linux 上 python3 才是正统名字
    if (process.platform === "win32") {
      expect(full).toContain("不要写 python3");
      expect(full).not.toContain("解释器叫 python3");
    } else {
      expect(full).toContain("解释器叫 python3");
      expect(full).not.toContain("不要写 python3");
    }
```

- [ ] **Step 3: 跑测试**

Run: `npx vitest run tests/prompt.test.ts`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add src/prompts/system.ts tests/prompt.test.ts
git commit -m "提示词平台化：时间示例与 python 提示按平台给"
```

---

## Task 5: 改名为 shell（含环境变量与审批映射）

**Files:**
- Modify: `src/core/config.ts`
- Modify: `src/core/configSchema.ts`
- Modify: `src/tools/builtins/shell/{index,powershell,posix}.ts`
- Modify: `src/tools/builtins/index.ts`、`src/server/server.ts`、`src/cli.ts`
- Modify: `public/app.js`
- Modify: 各测试文件

- [ ] **Step 1: `config.ts` 改名与兼容**

类型与字段：

```ts
/** 通用执行通道（shell 工具）的权限档位。 */
export type ShellMode = "off" | "readonly" | "full";
```

`interface Settings` 里三个字段改为（注释同步更新为平台中性）：

```ts
  /**
   * 通用执行通道（shell 工具）的权限档位：
   *   off      不注册该工具
   *   readonly 只放行只读命令，单条、不可写（默认）
   *   full     不限制——建议同时把 shell 加进 MINIAGENT_APPROVAL_TOOLS
   *
   * 这个工具**没有沙箱**（子进程权限 = 本进程权限），档位是唯一的约束手段。
   */
  shellMode: ShellMode;
  /** 单条命令的超时（秒） */
  shellTimeout: number;
  /** 可执行文件；留空则 Windows 用 powershell、其它平台用 bash */
  shellExecutable: string;
```

读取函数：

```ts
/** 权限档位只认三个值：写错就报错，避免「以为关了其实开着」 */
function readShellMode(): ShellMode {
  // 新名优先，旧名兜底：服务器与本地 .env 都还写着 MINIAGENT_POWERSHELL_MODE，
  // 静默失效会让档位悄悄回到默认 readonly
  const value = readString(
    "MINIAGENT_SHELL_MODE",
    readString("MINIAGENT_POWERSHELL_MODE", "readonly"),
  ).toLowerCase();
  if (value === "off" || value === "readonly" || value === "full") return value;
  throw new Error(
    `环境变量 MINIAGENT_SHELL_MODE 只能是 off / readonly / full，收到: ${value}`,
  );
}

/**
 * 审批名单：把旧工具名映射成新的。
 *
 * 审批是按**工具名**匹配的，工具从 powershell 改名成 shell 后，
 * `MINIAGENT_APPROVAL_TOOLS=powershell` 会静默失效——而这条通常正是
 * 用户为了开 full 档才配的，恰恰是最需要审批的场景。所以这里做映射并留一条日志。
 */
function readApprovalTools(): string[] {
  const tools = readList("MINIAGENT_APPROVAL_TOOLS", []);
  const renamed = tools.map((name) => (name === "powershell" ? "shell" : name));
  if (renamed.some((name, index) => name !== tools[index])) {
    getLogger("miniagent.config").warning(
      "审批名单里的旧工具名 powershell 已视为 shell（工具已改名）",
    );
  }
  return renamed;
}
```

`loadSettings()` 里：

```ts
    shellMode: readShellMode(),
    shellTimeout: readNumber("MINIAGENT_SHELL_TIMEOUT", readNumber("MINIAGENT_POWERSHELL_TIMEOUT", 30)),
    shellExecutable: readString(
      "MINIAGENT_SHELL_EXECUTABLE",
      readString("MINIAGENT_POWERSHELL_EXECUTABLE", ""),
    ),
```

以及 `approvalTools: readApprovalTools(),`。顶部新增 `import { getLogger } from "./logging.js";`。

- [ ] **Step 2: `configSchema.ts` 改名**

- `import type { ShellMode, Settings }`，`MODE_VALUES: ShellMode[]`
- `ConfigFieldType` 里 `"powershellMode"` → `"shellMode"`
- 字段定义：

```ts
  {
    key: "shellMode",
    env: "MINIAGENT_SHELL_MODE",
    group: "sandbox",
    label: "通用执行通道",
    type: "shellMode",
    description: "off 不注册该工具；full 完全不受限。开关口径：开=full，关=off",
  },
```

- `case "shellMode"` 与 `normalized[key] = value as ShellMode`
- `file` 模块顶部注释里提到的「powershell」文案同步为「shell」

- [ ] **Step 3: shell/ 三个文件改名文案**

- `index.ts`：`POWERSHELL_TOOL_NAME` → `SHELL_TOOL_NAME`，值 `"shell"`；`registerPowershell` → `registerShell`；`settings.powershellMode/Timeout/Executable` → `shell*`；`approvalTools` 建议文案里的工具名改 `shell`
- `powershell.ts` / `posix.ts`：`missingExecutableHint` 里的环境变量名改 `MINIAGENT_SHELL_EXECUTABLE` / `MINIAGENT_SHELL_MODE`
- `exec.ts`：`maxBuffer` 的错误建议里 `Select-String` 改成平台中性的「加筛选条件（head / grep / -First）」

- [ ] **Step 4: 调用方同步**

- `src/tools/builtins/index.ts`：`SHELL_TOOL_NAME`、`registerShell`、`reapplyTools` 里 `keys.has("shellMode")`
- `src/server/server.ts`：`describeShell`；`settings.shellMode`；`readonlyModeNote` 判断改 `shellMode`；注释里的 `powershellMode` 改 `shellMode`
- `src/cli.ts`：`describeShell`
- `public/app.js`：三处 `field.type === "powershellMode"` → `"shellMode"`

- [ ] **Step 5: 测试同步**

- `tests/shell.test.ts`（已在 Task 3 由 `tests/powershell.test.ts` 并入）：`POWERSHELL_TOOL_NAME` → `SHELL_TOOL_NAME`、`registerPowershell` → `registerShell`、`powershellMode/Timeout` → `shell*`；「档位写错时报错」用例的 `MINIAGENT_POWERSHELL_MODE` → `MINIAGENT_SHELL_MODE`，错误断言正则改 `/MINIAGENT_SHELL_MODE/`
- `tests/builtins.test.ts`：`powershellMode` → `shellMode`，`has("powershell")` → `has("shell")`
- `tests/configSchema.test.ts`：字段名与 `MINIAGENT_ADMIN_TOKEN` 相关断言里的 `powershellMode` → `shellMode`
- `tests/server.test.ts`：`powershellMode` → `shellMode`，`has("powershell")` → `has("shell")`，`MINIAGENT_POWERSHELL_MODE` 断言改 `MINIAGENT_SHELL_MODE`
- `tests/skills.test.ts`：夹具里的工具名 `powershell` → `shell`
- `tests/prompt.test.ts`：`toolNames: ["powershell"]` → `["shell"]`

- [ ] **Step 6: 新增兼容与映射用例**

在 `tests/shell.test.ts` 追加：

```ts
describe("改名兼容", () => {
  it("只设旧环境变量时仍然生效（新名优先）", () => {
    process.env.MINIAGENT_DEEPSEEK_API_KEY = "test-key";
    const originalShell = process.env.MINIAGENT_SHELL_MODE;
    delete process.env.MINIAGENT_SHELL_MODE;
    process.env.MINIAGENT_POWERSHELL_MODE = "full";
    try {
      expect(loadSettings().shellMode).toBe("full");
    } finally {
      delete process.env.MINIAGENT_POWERSHELL_MODE;
      if (originalShell !== undefined) process.env.MINIAGENT_SHELL_MODE = originalShell;
    }
  });

  it("审批名单里的旧工具名被映射为 shell", () => {
    process.env.MINIAGENT_DEEPSEEK_API_KEY = "test-key";
    const original = process.env.MINIAGENT_APPROVAL_TOOLS;
    process.env.MINIAGENT_APPROVAL_TOOLS = "powershell,write_file";
    try {
      expect(loadSettings().approvalTools).toEqual(["shell", "write_file"]);
    } finally {
      if (original === undefined) delete process.env.MINIAGENT_APPROVAL_TOOLS;
      else process.env.MINIAGENT_APPROVAL_TOOLS = original;
    }
  });
});
```

- [ ] **Step 7: 全量检查**

Run: `npm run typecheck && npm run lint && npm test`
Expected: 全绿；再用 `npm run build` 确认产物可编译

- [ ] **Step 8: 确认再无遗留旧名**

Run: `npx eslint . ; git grep -n "POWERSHELL" -- src tests public`（应只剩 `powershellAdapter`、`tests/shell-windows.test.ts` 里 Windows 专属的 `powershell` 字面量、以及 `powershellAdapter` 的默认可执行文件名）

- [ ] **Step 9: 提交**

```bash
git add -A src tests public
git commit -m "通用执行通道更名为 shell：新旧环境变量兼容，审批名单里旧工具名映射为 shell"
```

---

## Task 6: 文档、服务器 .env 与上线验证

**Files:**
- Modify: `README.md`、`.env.example`、`docker-compose.yml`
- 服务器：`/opt/miniagent/.env`

- [ ] **Step 1: `.env.example`**

把 powershell 那一段（第 45–56 行附近）整段替换：

```bash
# 通用执行通道（shell 工具）：把本机 shell 交给模型
#   注意：这个工具**没有沙箱**——子进程权限 = 本进程权限，能读写 workspace 之外的路径
#   平台：Windows 用 PowerShell（默认 powershell），Linux / macOS 用 bash
#   档位：off 不注册 | readonly 只放行只读命令（默认）| full 不限制
#   readonly 在两个平台上的实现不同，但边界一样：**保证不写，不保证读不到沙箱外**
#     Windows  元字符黑名单 + 只读 cmdlet 白名单
#     POSIX    **不经过 shell**，把命令拆成 argv 直接执行 —— 管道/重定向/通配符/变量在机制上不存在
#   切到 full 时建议同时把 shell 加进 MINIAGENT_APPROVAL_TOOLS，让每次执行都过人工审批
# MINIAGENT_SHELL_MODE=readonly
# 单条命令的超时（秒）：作为默认值；单次执行可用工具的 timeout_seconds 参数调大，
#   full 档上限取「本值」与 300 的较大者，readonly 档不接受调大
# MINIAGENT_SHELL_TIMEOUT=30
# 可执行文件：留空则 Windows 用 powershell、其它平台用 bash（也可填 sh）
# MINIAGENT_SHELL_EXECUTABLE=
# 旧名 MINIAGENT_POWERSHELL_MODE / _TIMEOUT / _EXECUTABLE 仍可读取（新名优先）
```

- [ ] **Step 2: `docker-compose.yml`**

```yaml
      # 容器里有 bash，这条通道是可用的；默认仍然关掉——它是无沙箱的通用执行能力，
      # 要不要给由使用者决定（要开就改成 readonly / full）
      MINIAGENT_SHELL_MODE: "off"
```

- [ ] **Step 3: `README.md`**

更新该工具小节（现写「其它平台用 pwsh」）为：平台（Windows PowerShell / 其它 bash）、档位语义、readonly 在两个平台的不同实现与相同边界、`shell` 工具名与旧环境变量名仍可读、`MINIAGENT_APPROVAL_TOOLS` 要写 `shell`。

- [ ] **Step 4: 服务器 `.env` 迁移（保持 off）**

```bash
ssh root@47.104.106.151 "cd /opt/miniagent && cp -a .env .env.bak.\$(date +%Y%m%d%H%M) && \
  sed -i 's/^MINIAGENT_POWERSHELL_MODE=/MINIAGENT_SHELL_MODE=/' .env && \
  grep -E '^MINIAGENT_SHELL_MODE=' .env"
```
Expected: 打印 `MINIAGENT_SHELL_MODE=off`

- [ ] **Step 5: 提交、推送、等 CI 部署**

```bash
git add README.md .env.example docker-compose.yml
git commit -m "文档与部署同步 shell 工具的平台说明"
git push origin main
```

- [ ] **Step 6: 部署后核对（服务器侧）**

```bash
# 服务被 CI 重启、且没崩
ssh root@47.104.106.151 "systemctl is-active miniagent; systemctl show miniagent -p ActiveEnterTimestamp --value"
# 启动日志里的档位描述应变成未启用，且没有 pwsh 相关的报错
ssh root@47.104.106.151 "journalctl -u miniagent --since '-5min' --no-pager | grep -E '通用执行|shell'"
# 工具清单里不该出现 shell（档位是 off）
curl -s http://47.104.106.151:8881/health | tr ',' '\n' | grep -c shell  || true
```
Expected: `active`；日志有「通用执行: 未启用（通用执行通道关闭）」；`/health` 的 `tools` 里没有 `shell`

- [ ] **Step 7: 本机临时开一次 readonly 自测（不碰线上）**

本地以 `MINIAGENT_SHELL_MODE=readonly` 起服务，确认 `tools` 里出现 `shell`，且让模型跑一条 `date` 能成功、跑 `ls | cat` 被拒。验证完把本地 `.env` 改回原值。

---

## 自审记录

- **spec 覆盖**：模块拆分 → Task 1；词法器与 argv 直执 → Task 2/3；POSIX 白名单与取舍 → Task 3；命名与兼容（含审批映射）→ Task 5；提示词平台化 → Task 4；文档与服务器 → Task 6；测试表逐条 → 各任务内。
- **类型一致性**：`ShellAdapter` 的五个方法（`executable` / `runReadonly` / `runFull` / `commandExample` / `usageHint` / `readonlyHint` / `missingExecutableHint`）在 Task 1 定义，Task 1 与 Task 3 各实现一次，签名一致；`RunContext.executable` 由 `index.ts` 填、两个适配器读；`checkReadonlyCommand` 在 PowerShell 侧返回 `{ok, reason}`、POSIX 侧返回 `{ok, argv}`，两者是各自模块内的导出，不共享签名（刻意如此：POSIX 的产出要拿来当 argv 用）。
- **Task 顺序保证每步全绿**：Task 1–4 不改工具名与环境变量，Task 5 一次改完。
- **已知偏差**：多拆一个 `exec.ts`（理由见开头）。
