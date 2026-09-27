# 通用执行通道的平台无关化（shell 工具）设计

日期：2026-09-27
状态：设计已确认，待评审
关联：[MiniAgent 框架设计（v1）](./2026-09-23-miniagent-design.md)、[UI 配置菜单与沙盒开关设计](./2026-09-27-ui-config-menu-design.md)

## 1. 需求

通用执行通道（原 `powershell` 工具）目前**只能在 Windows 上工作**。在 Linux/macOS 上：

- `resolvePowershellExecutable("")` 在非 win32 平台返回 `pwsh`，而 `pwsh` 通常没装 → 一旦启用档位就是 `ENOENT`；
- 即便装了 `pwsh`，`readonly` 档的白名单全是 PowerShell cmdlet，命令包装是 `& { [Console]::OutputEncoding = ...; ... }` 这种 PowerShell 语法——设计上就是 PowerShell 专用的，不是「缺个可执行文件」。

**目标**：让这条通道在两个平台上都是**一等公民**——Windows 用 PowerShell，Linux/macOS 用系统自带的 bash。换环境部署不再需要额外安装运行时。

**非目标（明确排除）**：不是「给线上那台公网实例打开执行权限」。见第 7 节。

### 1.1 现状事实（已实测核对）

| 检查项 | 结果 |
|---|---|
| 服务器 `pwsh` / `powershell` | **都缺失** |
| 服务器 `bash` | 有，GNU bash 4.4.20 |
| 服务器 `sh` | 有 |
| `yum list available powershell` | 官方源里没有（需另加微软源） |
| `process.platform` 分支 | 代码里只有一处平台判断（`server.ts` 的 `openBrowser`） |

服务器 systemd 加固（与本次设计交互）：

```
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=full
ReadWritePaths=/opt/miniagent/{workspace,traces,history,memory,checkpoints}
```

即：即便开启档位，子进程也只能写那几个目录、看不到 home、`/usr` `/etc` 只读。

### 1.2 鉴权现状（决定非目标）

配置接口 `/api/config` 有 `MINIAGENT_ADMIN_TOKEN` 保护；但**对话接口 `/api/chat` 没有任何鉴权**（已核对：`checkAdminAuth` 只在 `/api/config` 路由里被调用）。

因此公网实例上开关执行通道 = 把 shell 交给任何能打开网页的人。这是第 7 节把它列为非目标的直接原因。

## 2. 方案

### 2.1 模块结构

原 `src/tools/builtins/powershell.ts`（376 行）拆成目录，按「通用逻辑」与「平台差异」分层：

```
src/tools/builtins/shell/
  index.ts       注册 shell 工具：档位校验、超时计算、输出上限、错误翻译、describeShell
  adapter.ts     ShellAdapter 接口 + selectAdapter()
  powershell.ts  Windows 侧：包装语法、cmdlet 白名单、元字符黑名单
  posix.ts       Linux/macOS 侧：argv 直执、POSIX 白名单、危险选项黑名单
```

上移到 `index.ts` 的（与平台无关）：`buildChildEnv`、`preview`、输出上限与超时兜底、超时/取消的 AbortController 逻辑、退出码与 `maxBuffer` 的错误翻译、`describeShell`。

下沉到各适配器的：可执行文件解析、readonly 校验、命令包装、工具描述里的语法示例。

**为什么不放一个文件**：两套白名单 + 两套包装语法 + 两套描述混在一起会到 550 行以上。
**为什么不拆成两个完整工具文件**：档位判断、超时计算、错误翻译、describe 会重复约 150 行——那不是「三行相似代码」，重复的代价会真实发生（改一边忘一边）。

### 2.2 适配器接口

```ts
/** 一次执行的原始结果：适配器只负责跑，不管档位策略 */
export interface RunOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** 平台适配器：把「一条命令」翻译成该平台的执行方式 */
export interface ShellAdapter {
  /** 用于日志与 describeShell 的可执行文件标识 */
  executable(settings: Settings): string;
  /** readonly 档：必须由平台自己保证「不可能写」（见 2.4） */
  runReadonly(command: string, ctx: RunContext): Promise<RunOutcome>;
  /** full 档：命令不受限 */
  runFull(command: string, ctx: RunContext): Promise<RunOutcome>;
  /** 工具描述里的平台提示：语法示例与「不能用什么」 */
  describeUsage(): string;
  /** 工具描述里的参数示例 */
  commandExample(): string;
}

export interface RunContext {
  cwd: string;
  timeoutSeconds: number;
  signal: AbortSignal;
}

export function selectAdapter(platform: NodeJS.Platform): ShellAdapter {
  return platform === "win32" ? powershellAdapter : posixAdapter;
}
```

`selectAdapter` 收平台参数而不是内部读 `process.platform`，这样测试能直接构造两种适配器，不必 mock 平台。

### 2.3 执行路径

```
模型 → shell(command, timeout_seconds?)
  ├ off      工具不注册（与现在一致）
  ├ readonly
  │   ├ Windows 元字符黑名单 + cmdlet 白名单 → powershell -Command "& { ... }"
  │   └ POSIX   命令名白名单 + 危险选项黑名单 → execFile(argv)   ← 不经 shell
  └ full
      ├ Windows powershell -NoProfile -NonInteractive -Command <原样>
      └ POSIX   bash -c <原样>
  → 统一返回 { exit_code, stdout, stderr, cwd }
```

可执行文件默认值：

| 平台 | 默认 | 覆盖 |
|---|---|---|
| win32 | `powershell` | `MINIAGENT_SHELL_EXECUTABLE` |
| 其它 | `bash` | 同上（想用 `sh` 就设为 `sh`） |

`bash -c` 而非 `bash -lc`：不加载 profile，环境可预测（凭据已由 `buildChildEnv` 过滤）。

### 2.4 POSIX readonly：不经 shell

这是本设计最关键的一条。**不把命令交给 shell 解释**，而是拆成 `argv` 直接 `execFile`：

```
输入  ls -la /tmp        →  execFile("ls", ["-la", "/tmp"])
输入  ls | cat           →  照旧会被拒绝，但原因是「argv 里根本不存在管道这个机制」，
                            而不是「黑名单里有 | 这个字符」
输入  ls *.txt           →  execFile("ls", ["*.txt"])，通配符不被展开
```

好处：管道、重定向、`$变量`、`;` 连接、命令替换、子 shell —— 这些在 POSIX 上是无穷列举的，黑名单只能打补丁；直执 argv 让它们**在机制层面不存在**。

代价（必须写进工具描述，否则模型会困惑）：

- 通配符不展开：`ls *.txt` 会把字面量 `*.txt` 传给 `ls`；
- 引号只用于分组：`grep "a b" f` 传的是单个参数 `a b`；
- 想用管道/重定向就切 `full` 档。

**词法器**：拆 argv 需要处理 `'...'`、`"..."`、`\x`。自写约 30 行（零依赖，与项目「零框架」一致），独立成纯函数便于穷举测试：

```ts
/** 把一条命令拆成 argv；不解析变量、通配符、重定向。遇到未闭合引号返回错误 */
export function tokenizeCommand(command: string): { ok: true; argv: string[] } | { ok: false; reason: string };
```

### 2.5 POSIX readonly 白名单

**允许**（每个都是纯读）：

```
ls cat head tail wc pwd date whoami id uname df du stat file which echo sort uniq cut grep
```

**明确不纳入**，每个都有一条会写盘或能执行的路：

| 命令 | 排除原因 |
|---|---|
| `find` | `-exec` / `-delete` 能执行、能删 |
| `git` | `config` / `checkout` / `clean` 能写 |
| `sed` | `-i` 就地改写 |
| `awk` | `print > file` 能写 |
| `xargs` | 能拼出任意命令 |
| `tee` | 本身就是写 |
| `env` / `printenv` | 环境变量信息面（凭据已被 `buildChildEnv` 过滤，但仍是泄露面） |
| `cp` / `mv` / `rm` / `mkdir` / `chmod` | 显然的写操作 |

`sort` 允许，但 `-o`（写文件）加入**危险选项黑名单**，与现有 PowerShell 档的 `FORBIDDEN_PARAMS`（`-outfile` 等）机制一致。同类还有 `date -s`（改系统时间）。

**边界照旧写清**：readonly 保证「不写」，**不保证读不到 workspace 外**——`cat /etc/passwd` 仍然可以。这与 PowerShell 档现状完全一致，本次**不额外**加「禁止越界读」的限制（保持两档对称，YAGNI）。

### 2.6 命名与兼容

| 项 | 现在 | 改为 |
|---|---|---|
| 工具名 | `powershell` | `shell` |
| 环境变量 | `MINIAGENT_POWERSHELL_MODE` / `_TIMEOUT` / `_EXECUTABLE` | `MINIAGENT_SHELL_MODE` / `_TIMEOUT` / `_EXECUTABLE` |
| 类型 | `PowershellMode` | `ShellMode` |
| Settings 字段 | `powershellMode` / `powershellTimeout` / `powershellExecutable` | `shellMode` / `shellTimeout` / `shellExecutable` |
| 描述函数 | `describePowershell` | `describeShell` |
| configSchema | `key/type: "powershellMode"` | `key/type: "shellMode"`，env 改新名 |

**环境变量兼容**：旧名仍读取，新名优先（与 `config.ts` 里 `MINIAGENT_API_KEY` 优先于 `MINIAGENT_DEEPSEEK_API_KEY` 的既有做法一致）。理由：服务器与本地 `.env` 都有旧名，静默失效会让档位悄悄回到默认 `readonly`。

**⚠️ 审批配置必须做映射**：人工审批按**工具名**匹配。工具从 `powershell` 改名后，`MINIAGENT_APPROVAL_TOOLS=powershell` 会**静默失效**——用户以为每次执行都过人工审批，实际不生效（而且是在他为了开 `full` 档才配的这条，正是最需要审批的场景）。

处理：读取 `approvalTools` 时把 `powershell` 映射为 `shell`，并在启动日志里提示一次「已把审批配置里的 powershell 视为 shell」。这不是无谓的兼容 shim，是防安全配置静默失效。

### 2.7 提示词平台化

`src/prompts/system.ts` 现在硬编码工具名 `"powershell"`，并带一条 Windows 专属提示：

```
"- 需要当前日期时间、本机环境信息或要跑命令行工具（git 等）时用 powershell（如 Get-Date）。"
"- Windows 上写 python（或 py），不要写 python3——它常是应用商店的占位符，跑起来没有任何输出。"
```

改为：

- 工具名判断与提及统一用 `shell`；
- 语法示例按平台给（Windows `Get-Date` / POSIX `date`）；
- 那条 python 提示只在 Windows 下推入，POSIX 下换成对应提示（`python3` 是 Linux 上的正统名字，反而不能用 `python`）。

### 2.8 文档与部署

- 服务器 `/opt/miniagent/.env`：`MINIAGENT_POWERSHELL_MODE=off` 改为 `MINIAGENT_SHELL_MODE=off`，**保持 off**；
- `README.md`：更新该工具小节（现写「其它平台用 pwsh」）；
- `.env.example`、`docker-compose.yml` 同步；
- `docs/` 下的历史 spec 与 plan 是记录，**不改写**。

## 3. 改动清单

| 文件 | 改动 |
|---|---|
| `src/tools/builtins/shell/{index,adapter,powershell,posix}.ts` | **新建**：由原 `powershell.ts` 拆分而来 |
| `src/tools/builtins/powershell.ts` | **删除**（内容迁入 shell/） |
| `src/core/config.ts` | `PowershellMode`→`ShellMode`；三个字段改名；新旧环境变量名解析；`approvalTools` 映射 `powershell`→`shell` |
| `src/core/configSchema.ts` | field key/type 改 `shellMode`，env 改 `MINIAGENT_SHELL_MODE`，标签与说明改为平台中性 |
| `src/tools/builtins/index.ts` | 改从 `./shell/index.js` 引入；`reapplyTools` 里的字段名与常量同步 |
| `src/server/server.ts` | `describeShell`；`settings.shellMode`；注释里的 powershellMode |
| `src/cli.ts` | `describeShell` |
| `src/prompts/system.ts` | 工具名 + 平台化提示 |
| `public/app.js` | `powershellMode` 常量名与开关标签（schema 驱动，改动很小） |
| `README.md`、`.env.example`、`docker-compose.yml` | 文案与环境变量名 |
| `tests/shell.test.ts` | 由 `tests/powershell.test.ts` 改名并扩展 |
| `tests/{builtins,configSchema,server}.test.ts` | 字段名与工具名同步 |
| `tests/prompt.test.ts` | 断言改为按平台取（见下）；现有断言 `expect(withTool).toContain("Get-Date")` 在 POSIX 上会失败 |
| `tests/skills.test.ts` | 夹具文本里的工具名同步（纯文案，不参与校验） |

`tests/envFile.test.ts` **不动**：它里面的 `MINIAGENT_POWERSHELL_MODE` 只是 `.env` 改写用例的样本字符串，与真实配置项无关。

## 4. 测试

| 用例 | 断言 |
|---|---|
| 可执行文件默认值 | win32 → `powershell`；linux/darwin → `bash`；配置项覆盖生效 |
| 词法器（穷举） | 单双引号分组、`\x` 转义、连续空格、空命令、未闭合引号报错、`*.txt` 原样保留 |
| POSIX readonly 拒绝管道 | `ls \| cat` 被拒，且理由来自「不在白名单/非法字符」而非偶然 |
| POSIX readonly 危险选项 | `sort -o /tmp/x f` 被拒；`date -s ...` 被拒 |
| POSIX readonly 白名单 | `find .` / `git status` / `sed -n 1p f` 被拒（不在白名单） |
| POSIX readonly 真跑（仅 linux/darwin） | `date` / `whoami` 成功；`ls` 在 cwd 为 workspace 时列出内容 |
| POSIX full | `echo a \| tr a-z A-Z` 能跑通（证明真的经过 shell） |
| Windows 行为不变 | 现有 `powershell.test.ts` 用例全部保留并通过（仅 win32 跑） |
| 旧环境变量兼容 | 只设 `MINIAGENT_POWERSHELL_MODE=full` 时 `shellMode === "full"` |
| 审批映射 | `MINIAGENT_APPROVAL_TOOLS=powershell` → `approvalTools` 含 `shell` |
| 档位切换重注册 | `shellMode` 变化后 `registry.has("shell")` 正确反转（`reapplyTools`） |
| 提示词平台化 | 注册了 `shell` 时，win32 断言含 `Get-Date`、POSIX 断言含 `date`；`不要写 python3` 只在 win32 出现 |

## 5. 非目标

- **不给公网实例开档位**：`/api/chat` 无鉴权，开了就是公网 RCE（见 1.2）。本次只做「让通道在 Linux 上可用」，线上仍是 `off`。
- **不改 Windows 现有行为**：包装语法、cmdlet 白名单、超时上限全部保持。
- **不做 shell 自动探测**：`bash` 缺失时照旧报 `ENOENT` 并提示用 `MINIAGENT_SHELL_EXECUTABLE` 指定，不写「探测 sh/dash/zsh」的逻辑。
- **不给 POSIX readonly 加「禁止越界读」**：与 PowerShell 档保持对称，边界写进工具描述。
- **不改 `docs/` 下的历史 spec 与 plan**：它们是当时的记录。

## 6. 安全提示

- POSIX `full` 档 + `approvalTools` 不含 `shell` = 无限制命令执行。建议开 `full` 时同时把 `shell` 加进 `MINIAGENT_APPROVAL_TOOLS`。
- readonly 档在 POSIX 上是「机制上不能写」，比 PowerShell 档的「黑名单拦住写」更强；但两者都**不限制读取范围**。
- 服务器 systemd 的 `ProtectSystem=full` / `ProtectHome` / `ReadWritePaths` 是最后一道边界，与档位相互独立——改档位不会绕过它。
