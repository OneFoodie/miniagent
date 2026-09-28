# 会话级权限档位与 AI 审批设计

日期：2026-09-27
状态：设计已确认，进入实现
关联：[人工审批的网页支持与命令级放行设计](./2026-09-27-approval-allowlist-design.md)（本文的基础层）、[通用执行通道平台无关化设计](./2026-09-27-shell-platform-support-design.md)

## 1. 需求

在输入框附近加一个**权限档位下拉**，三档：

| 档位 | 含义 |
|---|---|
| **手动审批**（默认） | 每条敏感命令都挂起，等人在审批卡片上点批准 |
| **自动AI审批** | 由 AI 全权裁决，不打扰人 |
| **完全访问** | 不审批，直接执行 |

用户的原话是「不应该仅支持在沙箱内执行」——输入框下方现在写着「工具在沙箱内执行」
（`index.html` 的 `.dock-hint`），而这句其实只对文件工具成立，`shell` 工具根本没有沙箱。
这个下拉就是把「现在能干什么、谁来把关」显式化。

## 2. 三档的确切语义

### 2.1 为什么三档统一用 `shell=full`

设计时先试过「手动审批 = shell readonly + 问人」，但这里有个**死结**：

- `readonly` 的校验发生在**执行时**（`checkReadonlyCommand` 在工具 handler 里）；
- 审批发生在**执行前**（`Agent.act()` 里判定后直接抛 `ApprovalRequiredError`）。

所以一条不在只读白名单里的命令会被 `readonly` 直接拒掉，**根本到不了审批卡片**——
「手动审批」会退化成「只能批准只读命令」，与这一档的本意相反。

因此三档**都是 `shell=full`**，区别只在「谁来决定要不要执行」：

| 档位 | shell | 谁裁决 | 效果 |
|---|---|---|---|
| 手动审批 | full | 人 | 敏感命令挂起，等批准 |
| 自动AI审批 | full | AI | AI 裁决，不打扰人 |
| 完全访问 | full | 无人 | 直接执行 |

`readonly` 不在这条梯子上，它作为**配置菜单里的独立预设**保留（「连问都不用问，但只准读」）。

### 2.2 判定顺序

「哪些工具算敏感」仍由既有的 `MINIAGENT_APPROVAL_TOOLS` 决定；档位只决定裁决者。

```
decideApproval(call)
  ├ 会话档位 = 完全访问          → 放行（不需要审批）
  ├ 白名单命中 (tool, 参数)       → 放行（人工放行过的两种档位下都免问）
  ├ approvalTools 不含该工具      → 放行
  ├ 会话档位 = 手动审批           → 挂起，等人工（既有机制）
  └ 会话档位 = 自动AI审批         → 交 AI 裁决
```

`Agent.needsApproval(call)` 的返回值因此从布尔升级为一个小枚举：`allow | ask-human | ask-ai`。
`act()` 据此分三条路：直接执行 / 抛 `ApprovalRequiredError` / 先问 AI 再决定。

## 3. 作用域与鉴权

- 档位**按会话**，存在 `sessionStorage`（与刚修好的会话隔离同一套键空间）。
- 每次 `POST /api/chat` 带 `permission_mode` 与 `X-Admin-Token`；**三档统一校验令牌**，
  缺失或不对则 401/403。统一令牌让前后端逻辑更简单——不需要区分"哪档要令牌哪档不要"。
- 未配令牌时，任何档位的 `/api/chat` 请求都会 403。前端下拉仍显示手动审批作为最保守 UI 默认，
  但发送会失败并引导用户去配置菜单填令牌。
- 服务端**无状态**：不新增持久化，不需要新的 GET 接口。刷新页面由 `sessionStorage` 恢复。

## 4. 三处必须说清的代价

### 4.1 「AI 全权裁决」不是安全防线

它是**减少打扰的便利层**：AI 说行就跑，判错的后果没人拦。所以：

- 下拉选项与 README 都要明写这一点，不能让它看起来像「自动化的安全审查」；
- 每次裁决的**理由**必须进轨迹，并在时间线上显示为一步，让它可被事后核对。

### 4.2 AI 调用失败 → 拒绝

不降级成「问人」（这一档的承诺就是不打扰人），也不放行（那等于失败即全开）。
把「审批服务不可用」作为工具结果回灌给模型，让它换条路；轨迹里记明是失败而非裁决。

### 4.3 下拉会把全局 `shellMode` 写回 `full`

否则选了档位也跑不动（`shellMode=off` 时工具根本没注册）。后果是**配置菜单里的
`shellMode` 会被下拉覆盖**——两处管同一件事。处理办法是**显式提示**而不是静默改：
切换档位后在下拉下方显示「已同时把执行通道切到 full」。

写回的时机：首次把档位切到非 `off` 需要它时。因为三档都要 full，这个写回是幂等的。

## 5. 组件

| 组件 | 位置 | 职责 |
|---|---|---|
| `PermissionMode` 类型 | `src/core/permission.ts`（新建） | `"manual" \| "ai" \| "full"` + 解析/校验（类似 `readShellMode`）+ 中文描述 |
| `ApprovalDecision` 枚举 | `src/agent/agent.ts` | `allow \| ask-human \| ask-ai`，由 `decideApproval()` 产出 |
| `AiApprover` | `src/agent/aiApprover.ts`（新建） | 拿工具名 + 参数 + 当前问题，用同一个 LLM 判一次，返回 `{verdict, reason}` |
| 审批事件 | `src/core/events.ts` | 新增 `ApprovalAiVerdict`，记录裁决与理由 |
| 下拉 UI | `public/index.html` + `app.js` + `styles.css` | 输入框上方的 `.dock-hint` 那一行，改成「权限档位下拉 + 提示」 |
| 请求参数 | `src/server/server.ts` | `/api/chat` 读 `permission_mode` 并校验令牌；传给 Agent |

### 5.1 AI 裁决器的契约

```ts
export interface AiVerdict {
  verdict: "approve" | "deny";
  reason: string;
}

export class AiApprover {
  constructor(private readonly llm: BaseLLM, private readonly settings: Settings) {}
  /** 判定一次工具调用。**任何异常都不向外抛**：调用方按「拒绝」处理并记录原因 */
  async judge(call: ToolCall, question: string, signal: AbortSignal): Promise<AiVerdict>;
}
```

判定提示词要点（写在 `src/prompts/` 里，与既有提示词分段风格一致）：

- 输入：用户当前问题、工具名、完整参数；
- 要求输出严格的 JSON：`{"verdict":"approve"|"deny","reason":"不超过 40 字"}`；
- 判「拒绝」的情形：不可逆的破坏性操作（删库、格式化、批量删除）、越出用户意图范围的操作、
  明显与当前任务无关的操作、会外发敏感数据的操作；
- 判「放行」的情形：只读查询、与用户明确要求一致的操作、可逆且影响范围可控的操作；
- 解析失败（模型没给合法 JSON）→ 视为**拒绝**，理由是「裁决输出不可解析」。

## 6. 改动清单

| 文件 | 改动 |
|---|---|
| `src/core/permission.ts` | **新建**：`PermissionMode`、`parsePermissionMode()`、`describePermissionMode()` |
| `src/agent/aiApprover.ts` | **新建**：`AiApprover.judge()` |
| `src/agent/agent.ts` | `decideApproval(call)` 三态；`act()` 三条路；extra 接受 `permissionMode` 与 `aiApprover` |
| `src/core/events.ts` | 加 `ApprovalAiVerdict` 事件 |
| `src/server/server.ts` | `/api/chat` 解析 `permission_mode` 并**三档统一校验** `X-Admin-Token`；把 `aiApprover` 与档位传给 Agent；`run_started` 回带生效档位 |
| `src/tools/builtins/subagent.ts` | 子 agent 沿用父 run 的档位（子 agent 的工具调用同样受管辖） |
| `public/index.html` | `.dock-hint` 一行改为「权限档位下拉 + 提示文字」 |
| `public/app.js` | 档位状态（sessionStorage）+ 下拉渲染 + 令牌门禁 + 切换时写回 `shellMode` + 监听 AI 裁决事件渲染成一步 |
| `public/styles.css` | 下拉样式 |
| `README.md` | 三档说明 + 「AI 全权裁决不是安全防线」的明示 |
| `.env.example` | `MINIAGENT_APPROVAL_TOOLS` 的说明里提到三档 |
| `tests/permission.test.ts` | **新建** |
| `tests/aiApprover.test.ts` | **新建**（用 `FakeLLM` 覆盖：放行 / 拒绝 / 输出不可解析 / 抛异常） |
| `tests/checkpoint.test.ts` | 三档下的裁决路径（该文件已有 `approvalTools` 与 `ApprovalRequiredError` 的既有用例，审批相关测试都在这里） |

## 7. 测试

| 用例 | 断言 |
|---|---|
| `parsePermissionMode` | 三个合法值；大小写不敏感；非法值抛错并列出候选；空值给默认 `manual` |
| 档位 = 完全访问 | `decideApproval` 返回 `allow`，即使工具在 `approvalTools` 里 |
| 档位 = 手动审批 | 敏感工具返回 `ask-human` |
| 档位 = 自动AI审批 | 敏感工具返回 `ask-ai` |
| 白名单优先 | 白名单命中时，三档下都返回 `allow`（连 AI 都不调用） |
| 非敏感工具 | 三档下都 `allow` |
| `AiApprover` 放行 | FakeLLM 返回 `{"verdict":"approve",...}` → `approve` |
| `AiApprover` 拒绝 | 返回 `deny` → `deny`，理由透传 |
| `AiApprover` 输出不可解析 | 返回非 JSON → `deny`，理由含「不可解析」 |
| `AiApprover` LLM 抛错 | `judge()` 不抛，返回 `deny`，理由含失败原因 |
| 事件 | AI 裁决后轨迹里有 `approval_ai_verdict`，含 verdict 与 reason |
| 接口鉴权 | 三档统一无令牌 → 401；错令牌 → 401；对令牌 → 200；未配置令牌时三档都 403 |
| 非法档位值 | `/api/chat` 收到未知档位 → 400 |

## 8. 非目标

- **不改文件工具的沙箱**：`read_file` / `write_file` 始终锁在 `workspace` 内。
  放开它并不增加能力（`shell` 本来就能读任意路径），只是去掉唯一的约束。
- **不做第四档**：`readonly` 不进下拉，它继续作为配置菜单里的独立预设。
- **不做 AI 裁决的缓存**：同一命令重复出现时仍会重复问 AI。可以先靠白名单规避，
  不为它引入缓存层。
- **不做档位的服务端持久化**：档位随请求传递，服务端无状态；进程重启后由客户端恢复。
- **不给子 agent 单独的档位**：子 agent 沿用所属 run 的档位，避免出现「主流程严格、子 agent 宽松」。
