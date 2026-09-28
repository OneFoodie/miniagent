# 会话内用户提问工具（ask_user）设计

日期：2026-09-27
状态：设计待确认
关联：[人工审批的网页支持与命令级放行设计](./2026-09-27-approval-allowlist-design.md)、[会话级权限档位与 AI 审批设计](./2026-09-27-permission-modes-design.md)

## 1. 需求

会话过程中，模型有时需要用户先做一个决定才能继续（选哪个方案、要不要包含某部分、目标平台是哪个）。
现在它只能把这个疑问写在回答里，然后**结束这一轮**——用户得再发一条消息，模型才能接着往下跑。

需求是：像 Trae 里那样，在会话中间给用户弹出**单选/勾选项**，用户点完就继续跑。

## 2. 机制：复用审批那根脊椎

这个能力与「人工审批」在结构上完全同构，只是问的内容不同：

| | 人工审批 | 用户提问 |
|---|---|---|
| 触发 | 敏感工具调用 | `ask_user` 工具调用 |
| 挂起 | 抛 `ApprovalRequiredError`，现场落存档 | 抛 `QuestionRequiredError`，现场落存档 |
| 通知前端 | SSE `approval_required` | SSE `question_required` |
| 用户动作 | 批准 / 拒绝（+ 记住） | 选择 / 跳过 |
| 落决定 | `POST /api/approve` → `recordApproval()` | `POST /api/answer` → `recordAnswer()` |
| 继续 | 再发 `POST /api/chat {resume_run_id}` | 同左 |

于是**不新增任何基础设施**：checkpoint、续跑、SSE、`runTurn` 循环都沿用既有实现。
新增的只是「存档里多一个 `answers` 字段」「`act()` 多一条裁决分支」「前端多一种卡片」。

## 3. 工具契约

工具名 `ask_user`。参数刻意**不允许**只有题干——没有选项就退化成一个慢吞吞的对话框，
而本需求要的正是「几个选项点一下」。

```ts
z.object({
  questions: z.array(
    z.object({
      question: z.string().describe("要问用户的问题，一句话说清"),
      options: z
        .array(
          z.object({
            label: z.string().describe("选项短标签，2-8 个字"),
            description: z.string().optional().describe("这个选项是什么意思、选了会怎样"),
          }),
        )
        .min(2)
        .max(6)
        .describe("2-6 个候选，第一个是你推荐的"),
      multiple: z.boolean().optional().describe("true = 多选（勾选框），默认单选"),
    }),
  )
    .min(1)
    .max(4)
    .describe("一次最多问 4 个问题，只问真正影响下一步的"),
})
```

三条已确认的取舍：

1. **一次 1-4 个问题，一次提交。** 对齐 Trae。若只允许一次问一个，模型要问三件事就得挂起-续跑三个来回，
   每次都写一次存档、重连一次 SSE，代价全花在往返上。
2. **每题都带「其他」输入框。** 选项是模型的猜测，猜不中时用户得能直接写。单选时「其他」与选项互斥，
   多选时可以与选项并存。因此不需要 `allow_other` 开关——它恒为真。
3. **有「跳过」按钮。** 没有它，一个用户不想回答的问题会让这次运行永远挂在磁盘上。
   跳过是**整卡跳过**（一次提交所有回答，所以不做单题跳过）。

### 3.1 handler 永远不会被执行

`ask_user` 是「挂起型工具」：执行它的含义就是「没有人的回答」，那是逻辑漏洞而不是一种结果。
`Agent.act()` 会在调用运行时之前拦截它，因此 handler 直接抛错：

```ts
handler: async () => {
  throw new ToolError("ask_user 只能由运行期挂起处理，不应被直接执行");
}
```

它照常注册进工具表，模型才看得到这个函数签名。

## 4. 裁决顺序（`Agent.act()`）

新增一种结局 `{ kind: "needs-answer"; call }`，插在审批之后：

```
1. 逐个调用跑审批裁决（既有逻辑，含 AI 裁决）
2. 若存在 ask-human          → 返回 needs-approval（挂起等批准）
3. 若存在未回答的 ask_user    → 返回 needs-answer（挂起等回答）
4. 其余照常执行
```

**为什么审批排在提问前面**：一次只挂起一件事。审批被拒会让整批调用都不执行，
先问用户问题可能是白问；反过来先过安全关，再问业务问题，代价最小。

**`ask_user` 不进 `toRun`**：

- 有答案 → 由 `answers[call.id]` 直接构造工具结果，不经过运行时（因此不会有 `tool_start` 事件，
  这是对的——它没有「被执行」，而是「被回答」）；
- 没答案 → 第 3 步已返回，走不到这里。

**`ask_user` 不受权限档位管辖**：它不执行任何外部动作，三档下都可用，也不进 `approvalTools`。
实现上这一点由 `decideApproval()` 在**审批名单判断之前**无条件放行它来保证——
「批准一个提问」是句没有意义的话；若有人把它误写进 `MINIAGENT_APPROVAL_TOOLS`，
不加这条就会变成一种没人看得懂的挂起。

### 4.1 工具结果的形态

```json
{
  "answers": [
    { "question": "目标平台是哪个？", "selected": ["Linux"], "other": "还有一个 ARM 板子" }
  ],
  "skipped": false
}
```

跳过时回灌 `{ "skipped": true }`，并附一句「用户选择跳过，请勿重复追问同一问题，直接按你的判断继续或说明无法确定」。
这句提示是必要的：否则模型往往会把同一个问题再问一遍，而用户刚明确表示不想回答。

## 5. 存档扩展

`RunCheckpoint` 加两个可选字段（放在既有的 `pendingApproval` 旁边，不合并成联合类型）：

```ts
/** 已收到的用户回答：callId → 答案 */
answers?: Record<string, AskAnswer>;
/** 当前等待回答的调用；为空表示不是「等回答」状态 */
pendingQuestion?: PendingQuestion;   // { callId, tool, arguments }
```

**为什么不把 `pendingApproval` 泛化成 `pending: {kind, ...}`**：存档是磁盘上的既有数据，
改名会让部署那一刻正在挂起的运行读不出来。加字段则新旧存档都能读（旧存档缺 `answers`，
按空对象处理），与本项目其它可选项的处理方式一致。

新增函数，与 `recordApproval` 同形：

```ts
export async function recordAnswer(
  dir: string,
  runId: string,
  answer: AskAnswer,
): Promise<PendingQuestion | undefined>;
```

`CheckpointSummary` 也带上 `pendingQuestion`，`GET /api/runs` 才能显示「这次在等人回答」。

## 6. 接口契约

### 6.1 `POST /api/answer`

```json
{ "run_id": "…", "answers": [ { "question": "…", "selected": ["Linux"], "other": "…" } ], "skipped": false }
```

| 情况 | 响应 |
|---|---|
| 正常 | `200 { ok: true, question: { callId, tool, arguments } }` |
| 该运行没有待回答项 | `404 { ok: false, error }` |
| `run_id` 非法 / `answers` 形状不对 | `400 { ok: false, error }` |

**不校验管理令牌。** 与 `/api/chat` 的续跑一致：回答问题是把用户的话交给模型，不放大任何权限
（它不能改档位、不能放行命令）。而 `/api/approve` 必须校验，因为「批准」等于放行本机执行。

服务端只做**形状校验**（数组、`question` 是字符串、`selected` 是字符串数组、`other` 可选字符串），
不校验 `selected` 里的值是否真在模型给的选项里——用户可能选「其他」，模型也可能中途改主意，
而且这本来就不是安全边界。请求体另有 256KB 上限兜底。

### 6.2 SSE 新增 `question_required`

由 `handleChat` 捕获 `QuestionRequiredError` 后发出，与 `approval_required` 并列：

```json
{ "run_id": "…", "call_id": "…", "tool": "ask_user", "questions": [ /* 原样回带 */ ], "session_id": "…" }
```

### 6.3 轨迹事件

新增两个事件类型，便于「查看原始轨迹」时核对「问了什么、答了什么」：

- `QuestionAsked` — payload 含 `call_id` 与 `questions`；
- `QuestionAnswered` — payload 含 `call_id`、`answers`、`skipped`。

`QuestionAnswered` 只能在 `Agent.act()` 里发（存档与事件都在同一处），不能在 `/api/answer` 里发——
server 的事件总线是按请求创建的，`/api/answer` 那一次请求里没有这条总线。

## 7. 提示词

`tool_policy` 段（`src/prompts/system.ts`）在 `toolNames` 含 `ask_user` 时追加，版本 `1.9.0` → `1.10.0`：

- 需要**只有用户才知道**的信息（偏好、目标、优先级、取舍）且工具查不到时，用 `ask_user` 提问，不要替用户假设；
- 能给选项就给选项（schema 已强制 2-6 个），`description` 用来解释后果，最推荐的放第一个；
- 一次最多 4 个问题，只问真正卡住下一步的；能自己查到的不要问；
- **回答完就结束的任务不要用它**——那种情况直接在回答里问即可，挂起等一次点击反而更慢。

## 8. 前端

`createAssistantCard` 新增一组方法与卡片区块（与审批卡片同一位置）：

```js
card.askQuestion(info)      // 渲染卡片，返回 Promise<answer|null>；null = 跳过
card.setQuestionStatus(msg, isError)
card.clearQuestion()        // 移除卡片，替换为「已提交」的静态摘要
```

卡片结构（**一屏只显示一道题**，切题时就地重建，不另开卡片）：

```
┌ 需要你确认        [▲] 2 / 3 [▼] ┐
│ 目标平台是哪个？          单选    │
│  ◉ Linux   ○ Windows  ○ macOS   │
│  ┌ 其他：____________________┐   │
│                                  │
│  [ 提交 ]        [ 跳过 ]        │
└──────────────────────────────────┘
```

为什么必须一屏一题：3 题 × 5 个带说明的选项实测有 1268px，可视区只有 651px。
一次全铺开的后果是用户既看不全题干、也不知道还剩几题；而如果每答一题就新开一张卡，
一次问答又会被拆成时间线上的好几个节点。所以是「同一张卡、就地翻页」。

导航与推进规则：

| 情况 | 行为 |
|---|---|
| 单选题点中某个选项 | 视为这题答完，延迟 220ms 自动进入下一题 |
| 多选题 | **不自动前进**（没法判断「选完了」），点「下一题」 |
| 「其他」输入框 | **不自动前进**（还在打字），填完点「下一题」 |
| 当前题未作答 | 「下一题」置灰——这就是「结束一题才能进入下一题」 |
| 最后一题答完 | **不自动提交**，只把「提交」点亮；否则用户没机会改用「其他」 |
| 只有一道题 | 整块导航隐藏（没有可切换的对象，留两个点不动的箭头是噪音） |

其余不变：

- 选项行整体可点（`label` 包住 input），`description` 显示为选项下方的灰字；
- 单选题用 `radio`（同组同名），多选题用 `checkbox`；切题时按当前题的 `multiple` 重建控件；
- 「其他」输入框有内容时，单选下自动取消同组其它选择——避免「既选了 A 又写了 B」这种自相矛盾的答案；
  多选下两者并存（既要 A 又要补充说明）；
- **每题都必须有答案**（选了选项或填了「其他」）才允许提交，「跳过」始终可点；
- 每题的作答状态（选中集合 + 「其他」的文字）留在 JS 里、不留在 DOM 上：
  切题会把输入框整块重建，存 DOM 引用一重建就失效；
- 提交后卡片收敛成静态摘要（「你的回答：Linux；要图表」），并把 `answer` 交回 `runTurn` 循环。

三处实现时才暴露的细节（都来自实测）：

1. **卡片可能比可视区还高**。线程是「钉到底」的，于是卡片一出现，标题与题干恰好在屏幕外，
   用户看到的是一张没头没尾的卡片。所以卡片渲染完改用 `scrollCardIntoView()`：
   装得下仍钉底，装不下就把卡片顶部对齐到可视区顶部。
   （一屏一题大幅降低了它的触发概率，但没有消除：单题 6 个带说明的选项仍然可能超高。）
2. **摘要必须插在答案区之前**。卡片 DOM 是固定结构（`.steps` / `.stream` / `.status-line` / `.answer`），
   而 `addNote()` 之类是直接 append 到卡片末尾的；续跑产出的答案固定落进 `.answer`，
   直接 append 的摘要就会被挤到答案**下面**，读起来像问答倒过来（实测踩到过）。
   因此摘要用 `insertBefore(note, answerEl)`。
3. **自动前进要记住出发时的题号**。那 220ms 里用户可能自己点了「下一题」，
   回调里若直接 `go(index + 1)` 就会多跳一题；改成先记 `from`、回调里确认 `index` 没变再走。

`runTurn` 循环比现在多一个分支：

```js
const outcome = await streamChat(payload, card, resumeRunId);
if (outcome.kind === "approval") { /* 既有 */ }
if (outcome.kind === "question") {
  const answer = await card.askQuestion(outcome.info);
  const result = await sendAnswer(outcome.info.run_id, answer);   // answer=null → skipped
  if (!result.ok) { card.setQuestionStatus(result.error, true); return; }
  card.clearQuestion();
  resumeRunId = outcome.info.run_id;
  payload = "";
  continue;
}
return;
```

## 9. 改动清单

| 文件 | 改动 |
|---|---|
| `src/tools/builtins/askUser.ts` | **新建**：`ask_user` 工具定义（schema + 永不被执行的 handler） |
| `src/tools/builtins/index.ts` | 注册 `ask_user` |
| `src/core/errors.ts` | 新增 `QuestionRequiredError`（带 `runId` 与 `call`） |
| `src/core/events.ts` | 新增 `QuestionAsked` / `QuestionAnswered` |
| `src/agent/checkpoint.ts` | `answers` / `pendingQuestion` 字段 + `AskAnswer` 类型 + `recordAnswer()` |
| `src/agent/agent.ts` | `ActOutcome` 加 `needs-answer`；`act()` 拦截 `ask_user` 并用答案构造结果；`resume()` 读 `answers`；`loop()` 落 `pendingQuestion` |
| `src/prompts/system.ts` | `tool_policy` 追加上问询引导，版本 1.10.0 |
| `src/server/server.ts` | 新增 `POST /api/answer`；`handleChat` 转发 `question_required` 事件 |
| `public/app.js` | 卡片提问区块 + `sendAnswer()` + `runTurn` 新分支 |
| `public/styles.css` | `.question-card` 及选项行样式 |
| `README.md` | 工具清单与 Web 控制台一段里补上这个能力 |
| `tests/askUser.test.ts` | **新建** |
| `tests/checkpoint.test.ts` | `recordAnswer` 的用例 |
| `tests/server.test.ts` | `/api/answer` 与 `question_required` 的用例 |

## 10. 测试

| 用例 | 断言 |
|---|---|
| schema 校验 | 无 `questions`、选项少于 2 个、超过 4 个问题 → 参数校验失败 |
| handler 被直接执行 | 抛 `ToolError`（防回归：拦截逻辑一旦漏了，这里会暴露） |
| 挂起 | `run()` 抛 `QuestionRequiredError`，存档里有 `pendingQuestion` |
| 续跑作答 | `recordAnswer` 后 `resume()` 不执行 `ask_user` 的 handler，工具结果为答案 JSON |
| 跳过 | `{skipped:true}` 时工具结果含跳过提示，且不含用户答案 |
| 同批含审批 + 提问 | 先返回 `needs-approval`（审批优先） |
| 一轮问两次 | 第一次挂起 → 作答 → 第二次挂起 → 作答 → 完成（顺序不串） |
| 事件 | 轨迹里有 `question_asked` 与 `question_answered` |
| `POST /api/answer` | 正常 200；无待答 404；`answers` 形状不对 400；`run_id` 非法 400 |
| 无令牌 | `/api/answer` 不带令牌也能成功（与续跑一致） |
| SSE | 收到 `question_required`，含 `call_id` 与 `questions` |

## 11. 非目标

- **不做超时自动放弃**：挂起的运行留在 `/api/runs` 里，与待审批的运行同一种命运，用户可以选择续跑或忽略。
- **不做单题跳过**：一次提交所有回答，跳过即整卡跳过。
- **不把答案写进长期记忆**：会话落盘已经把「用户答了什么」记进历史，长期记忆的写入时机不变。
- **不用它代替审批**：`ask_user` 不是安全控制，它只是收集信息；放行命令仍然走审批。
- **不做答案的合法性校验**：`selected` 不校验是否为模型给出的选项之一（见 6.1）。
