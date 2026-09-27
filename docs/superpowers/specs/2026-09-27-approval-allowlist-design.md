# 人工审批的网页支持与命令级放行设计

日期：2026-09-27
状态：设计已确认，待评审
关联：[MiniAgent 框架设计（v1）](./2026-09-23-miniagent-design.md)、[UI 配置菜单与沙盒开关设计](./2026-09-27-ui-config-menu-design.md)、[通用执行通道平台无关化设计](./2026-09-27-shell-platform-support-design.md)

## 1. 需求

三件事，一件比一件深：

1. **把 `shell` 加进 `MINIAGENT_APPROVAL_TOOLS`** —— 每次执行命令都先过人的眼睛；
2. **让网页端真的能审批** —— 目前在网页上这个能力是**缺失的**（见 1.1）；
3. **在询问时提供「加入白名单」** —— 放行过的命令以后不再问，并可在配置菜单里查看与撤回。

### 1.1 现状事实（已核对代码）

| 环节 | 现状 |
|---|---|
| 判定要不要审批 | `Agent.needsApproval(toolName)` → `settings.approvalTools.includes(toolName)` |
| 挂起 | 判定命中且未决 → 落 checkpoint → 抛 `ApprovalRequiredError(runId, call)` |
| 通知客户端 | 服务端发 SSE `approval_required {run_id, call_id, tool, arguments, session_id}` |
| **网页端** | **`public/app.js` 从未监听 `approval_required`** —— 撞到审批时运行静默停在 `done`，界面什么都不显示 |
| CLI | 有完整交互：`cli.ts` 的 `askApproval()` 打印待批调用后问 `y/N`，`runWithApproval()` 循环处理多轮挂起 |
| 做决定 | `POST /api/approve {run_id, approved}` → `recordApproval()` 写进存档的 `approvals[callId]` |
| 续跑 | 客户端再发一次 `POST /api/chat {resume_run_id, session_id}` |

服务端在 `approval_required` 处的注释写着「前端据此渲染批准/拒绝」，但前端这一半没实现。所以第 2 项是**主要工作量**，不是加个按钮。

另外，`/api/approve` 现在**没有任何鉴权**，而 `/api/chat` 也没有。这意味着公网实例上任何访客都能触发一次 shell 调用并自己点「批准」——审批就只是装饰。这一条决定了第 2 节的鉴权设计。

### 1.2 已确认的决策

| 项 | 决定 | 理由 |
|---|---|---|
| 白名单粒度 | **命令级**：工具名 + 完整参数精确匹配 | 放行 `date` 不等于放行 `date -s`（改系统时间）；粒度最小 |
| 存储 | `./approvals/allowlist.jsonl`，一行一条 | 命令里可能含逗号、引号、换行，逗号分隔的环境变量会断；它本质是运行期状态，与 `history/`、`memory/`、`checkpoints/` 同类 |
| 审批鉴权 | 需要 `X-Admin-Token`（与配置接口同一把） | 否则公网访客可以自己批，审批形同虚设 |
| 撤回 | 配置菜单里列出「已放行的命令」，可逐条删除 | 误放行一条危险命令时不用登服务器改文件 |

## 2. 方案

### 2.1 白名单要能被同步判定

`Agent.needsApproval()` 在工具批次的判定路径上，是**同步**的。所以白名单必须常驻内存：

```
ApprovalAllowlist 实例（main() 建一次）
  ├ 启动时读 JSONL 进内存 Set<指纹>
  ├ has(tool, args)  同步查内存
  ├ add/remove       改内存 + 追加/重写文件
  └ 挂在 ServerDeps 上，经 Agent 的 extra 传入；subagent 用同一实例
```

**为什么不做成 `Settings` 上的一个活 Set**：`Settings` 的语义是「启动时读一次的环境配置」，把会变、要落盘、要去重的运行期状态塞进去，会让 `loadSettings` 的职责变浑（还得处理落盘失败与并发）。**为什么不放进 checkpoint**：checkpoint 运行成功即删，白名单会跟着消失，达不到「持久化」。

### 2.2 数据模型与指纹

```ts
// src/agent/allowlist.ts
export interface AllowlistEntry {
  tool: string;                        // 如 "shell"
  arguments: Record<string, unknown>;  // 如 { command: "date" }
  addedAt: number;                     // 毫秒
}
```

判定用的**指纹** = `tool` + `\0` + 键排序后的稳定 JSON。于是 `{a:1,b:2}` 与 `{b:2,a:1}` 是同一条，避免因参数顺序不同而重复询问。

**一处刻意的例外**：`shell` 的 `timeout_seconds` **不参与指纹**。

它是执行细节（跑多久），不是「要做什么」。不剔除的话，模型这次给 `timeout_seconds: 5`、下次不给，就会被当成两条不同命令、要求放行两次——而这在模型自主决定超时的情况下会频繁发生。规则只针对 shell，写在 allowlist 模块里并注明理由。

### 2.3 判定路径

```
Agent.needsApproval(call)
  ├ settings.approvalTools 不含该工具         → 不需要审批
  ├ allowlist.has(call.name, call.arguments)  → 已放行，不需要审批
  └ 否则                                       → 需要审批
```

`needsApproval(toolName: string)` 改为 `needsApproval(call: ToolCall)`，`act()` 里那一处调用同步改。

### 2.4 接口

| 接口 | 变化 |
|---|---|
| `POST /api/approve` | **加令牌校验**（未配令牌 403 / 缺失或错误 401）。请求体加 `remember?: boolean`：`approved && remember` 时把 `(tool, arguments)` 写进白名单。响应加 `remembered: boolean` |
| `GET /api/allowlist` | 新增（带令牌）。返回 `{ entries: AllowlistEntry[] }` |
| `DELETE /api/allowlist` | 新增（带令牌）。请求体 `{ tool, arguments }`（按指纹删），返回 `{ removed: boolean }` |

`recordApproval()` 已经返回 `PendingApproval`（含 `tool` 与 `arguments`），直接拿来建条目，不用再读一次存档。

### 2.5 前端：审批卡片

在 `streamChat` 的事件 switch 里新增 `approval_required` 分支，在**同一张助手卡片内**渲染：

```
⚠ 需要人工审批
  shell
  { "command": "rm -rf /tmp/x" }
  run_id: xxx

  [批准]  [拒绝]  [批准并加入白名单]
```

点任一按钮 → `POST /api/approve {run_id, approved, remember}` → 成功后自动 `POST /api/chat {resume_run_id, session_id}`，**把续跑的流接回同一张卡片**，时间线继续往下走（而不是新开一张卡）。

令牌从 `localStorage` 读（配置面板已经在存）；401 时在卡片内提示去配置菜单填令牌；403 说明服务端没配令牌。

### 2.6 前端：配置菜单里的「已放行的命令」

配置面板目前由 `CONFIG_FIELDS` 的 schema 驱动渲染表单。白名单是**一组条目**而不是标量配置，所以作为**自定义区块**插在表单之后（不进 `CONFIG_FIELDS`）：调 `GET /api/allowlist`，逐条渲染 `tool` + 参数摘要 + 删除按钮，删除走 `DELETE /api/allowlist`。

### 2.7 配置

| 项 | 值 |
|---|---|
| 新增 `MINIAGENT_APPROVAL_ALLOWLIST_FILE` | 默认 `./approvals/allowlist.jsonl` |
| `.env` 的 `MINIAGENT_APPROVAL_TOOLS` | 加 `shell`（本地与服务器都改） |
| `.gitignore` | 加 `/approvals/`（运行期状态） |
| `docker-compose.yml` | 加该路径的环境变量（可选，默认值已可用） |

**部署注意**：服务用户要对部署目录有写权限才能建出 `approvals/`（并追加写入）。服务器上 `/opt/miniagent` 已经是 `775 root:miniagent`，所以能建；这与之前 `.env` 原子写踩过一次的权限问题是同一类——CI 的部署脚本里已有兜底 `chmod`，本次沿用。

## 3. 改动清单

| 文件 | 改动 |
|---|---|
| `src/agent/allowlist.ts` | **新建**：`ApprovalAllowlist`（load / has / add / remove / list）+ 指纹（含 shell 的 `timeout_seconds` 例外） |
| `src/core/config.ts` | 加 `approvalAllowlistFile` |
| `src/agent/agent.ts` | `needsApproval(call)`；extra 接受 `allowlist` |
| `src/tools/builtins/subagent.ts` | `SubagentDeps` 接受并把 `allowlist` 传给子 Agent |
| `src/server/server.ts` | `main()` 建实例进 `ServerDeps`；`/api/approve` 加令牌与 `remember`；新增 `GET/DELETE /api/allowlist` |
| `src/cli.ts` | 建实例并传给 Agent（CLI 的 `askApproval` 可顺带支持「白名单」选项，见 5 节非目标） |
| `public/app.js` | `approval_required` 卡片 + 续跑接回同卡；配置面板加「已放行的命令」区块 |
| `public/styles.css` | 审批卡片样式 |
| `.env`、服务器 `.env` | `MINIAGENT_APPROVAL_TOOLS` 加 `shell` |
| `.env.example`、`.gitignore`、`docker-compose.yml` | 新配置项与忽略规则 |
| `tests/allowlist.test.ts` | **新建** |
| `tests/server.test.ts` | 审批接口鉴权三态 + `remember` + 白名单接口 |

## 4. 测试

| 用例 | 断言 |
|---|---|
| 指纹：键序无关 | `{a:1,b:2}` 与 `{b:2,a:1}` 指纹相同 |
| 指纹：shell 的 `timeout_seconds` 被剔除 | `{command:"date"}` 与 `{command:"date",timeout_seconds:5}` 指纹相同 |
| 指纹：不同命令不同 | `{command:"date"}` 与 `{command:"date -u"}` 指纹不同 |
| 放行后的判定 | 放行 `date` 后 `date` 不再需要审批、`date -u` 仍需要 |
| 落盘与重载 | `add` 后新建实例仍 `has`；`remove` 后不再 `has` |
| 幂等 | 同一条 `add` 两次，`list()` 只有一条 |
| 容错 | 文件不存在 / 内容损坏 → 当作空白名单，不抛错（与 `loadCheckpoint` 同策略） |
| 接口鉴权 | 未配令牌 403、缺失或错令牌 401、正确 200（三个接口都要） |
| `remember` 生效 | `approved && remember` 后 `GET /api/allowlist` 多一条且字段正确 |
| `remember` 仅在批准时生效 | `approved:false, remember:true` 不写白名单 |
| 删除 | `DELETE` 后 `list` 少一条；删不存在的返回 `removed:false` |
| 判定链路 | 白名单命中时 `act()` 不再返回 `needs-approval` |

## 5. 非目标

- **不做「永久关闭整个工具的审批」**：一次点击就废掉整层防护，且「放行错了」的代价不对称。
- **不改 `/api/chat` 的鉴权**：本次只让审批接口受保护。结果是公网访客能触发 shell 调用、看到卡片，但没有令牌批不了——**线上应保持 `MINIAGENT_SHELL_MODE=off`**，因为即使有审批，让陌生人在你机器上触发命令本身就不必要。
- **不给 CLI 加「加入白名单」交互**：CLI 已有完整的 `y/N` 流程，本次只做网页端；CLI 仍然能用（只是没有 remembered 选项）。
- 不做白名单的过期时间、命中次数上限、正则/前缀匹配。
- 不做审批决定的独立审计日志（轨迹里已有 `approval` 相关事件）。
- 不做多用户/多角色：仍然只有一个管理令牌，审批人不区分身份。
