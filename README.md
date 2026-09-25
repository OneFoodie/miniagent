# MiniAgent

从零手写的教学级 Agent 框架：**TypeScript 5 + Node.js 22+**，运行时不依赖任何框架。

- **ReAct 主循环** — reason → act → observe；同批工具调用并发执行，带信号量限流、独立超时、故障隔离
- **多模型服务商** — 只依赖 OpenAI 兼容协议：DeepSeek / OpenAI / Moonshot / 通义 / 智谱 / Ollama / 自建网关，换一家只改一个变量
- **token 级流式** — SSE 增量逐字透出，tool_calls 分片按下标累积
- **MCP 工具来源** — 配 `mcp.json` 即可把远端 MCP 服务端的工具接成内置工具（不配则不加载 SDK）
- **持久化执行** — 每轮落运行存档；进程被杀可续跑，敏感工具可挂起等人工批准
- **通用执行通道** — `powershell` 工具：取时间、看系统信息、跑 CLI，也能**写脚本直接执行**（node / python，单次超时可调）；带权限档位，默认只读白名单，可切 `full`
- **技能（Skills）** — 技能 = 目录 + `SKILL.md`（元信息 + 操作指引），正文按需 `load_skill` 渐进式披露；模型可用 `create_skill` **自己写新技能并立即生效**
- **上下文处理** — 滑窗 + 阈值摘要（指令类内容逐字保护）/ 工具结果超限时卸载到文件可回读 / 子 agent 隔离
- **三层记忆** — token 滑窗 + 阈值摘要 / 生命周期长期记忆（置信度·矛盾消解·遗忘·巩固）/ 外部知识库（词面、语义或混合检索）
- **子 agent 角色化** — 调研员 / 分析员 / 复核员三种身份（角色同时决定提示词与工具白名单），并可并行派发
- **可观测** — 事件总线 → JSONL 轨迹 / Prometheus 指标 / OTLP（OpenTelemetry GenAI 语义约定）/ SSE 实时推送
- **Web 控制台** — 步骤时间线、模型思考内容、实时流式文本、原始轨迹、会话历史（零前端框架）；答案支持**表格 / 图片 / 流程图 / HTML 之外的行内格式**
- **评测** — 规则裁判 + LLM 裁判，输出量化报告，可用于回归

**在线演示**：[http://wangjunqing.cn:8881/](http://wangjunqing.cn:8881/) —— 跑在阿里云 Alibaba Cloud Linux 3（2 核 2G）上，
systemd 常驻、以非 root 用户运行，知识库用零依赖的词面后端（`lexical`）。
该实例**未加鉴权**，只作演示；不要把带真实数据或 API Key 的实例这样直接暴露在公网。

设计文档见 [docs/superpowers/specs/2026-09-23-miniagent-design.md](docs/superpowers/specs/2026-09-23-miniagent-design.md)；
与市场主流框架的差距比对与取舍见 [能力差距收敛与市场适配评估](docs/designs/2026-09-25-能力差距收敛与市场适配评估.md)。

## 快速开始

```bash
npm install
cp .env.example .env          # Windows: Copy-Item .env.example .env
# 编辑 .env，填入 MINIAGENT_DEEPSEEK_API_KEY
npm start                     # → http://localhost:3000
```

## 命令

| 命令 | 作用 |
|---|---|
| `npm start` | Web 控制台（`node:http` + SSE） |
| `npm run cli` | 命令行对话（支持 `/runs` `/resume <run_id>`，撞上审批就地问 y/N） |
| `npm run knowledge:add <文件或目录>` | 把 PDF / Word / Excel / CSV 转成 Markdown 入库 |
| `npm run knowledge:reindex` | 全量重建向量索引；加 `--check` 只对账、报告索引与磁盘的漂移 |
| `npm run model:fetch` | 下载向量后端用的本地 embedding 模型（支持断点续传，可反复执行） |
| `npm run eval` | 跑评测集，输出 JSON 报告到 `eval_reports/` |
| `npm run trace:replay -- <runId>` | 把某次运行的 JSONL 轨迹渲染成可读时间线（`--full` 看全文，`--json` 出原始数据） |
| `npm run build` / `npm run start:dist` | 编译到 `dist/` 并以编译产物启动（容器里走这条路径） |
| `npm test` | 单元测试（vitest） |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` / `npm run lint:fix` | ESLint（含行宽 100） |

`npm start` 用 `PORT` 换端口：`$env:PORT=3001; npm start`。

## 常用配置

全部走环境变量，见 [.env.example](.env.example)。最常改的几项：

| 变量 | 默认 | 说明 |
|---|---|---|
| `MINIAGENT_PROVIDER` | `deepseek` | 服务商预设：`deepseek`/`openai`/`moonshot`/`dashscope`/`zhipu`/`ollama`/`custom` |
| `MINIAGENT_API_KEY` | 空 | API Key（`MINIAGENT_DEEPSEEK_API_KEY` 仍兼容）；localhost 端点可不填 |
| `MINIAGENT_BASE_URL` / `MINIAGENT_MODEL` | 取预设 | 覆盖预设的接入点与模型名（自建网关走这两项） |
| `MINIAGENT_STREAM_ENABLED` | `true` | 是否用 token 级流式请求 |
| `MINIAGENT_MAX_ITERATIONS` | `8` | 单轮最多迭代次数 |
| `MINIAGENT_MODEL_CONTEXT_TOKENS` | `131072` | 模型上下文窗口；历史预算按它推导 |
| `MINIAGENT_MEMORY_BUDGET_RATIO` | `0.25` | 历史预算占窗口的比例（换模型只需改上面那项） |
| `MINIAGENT_MEMORY_BACKEND` | 自动 | `jsonl` / `lifecycle` / `memos` |
| `MINIAGENT_KNOWLEDGE_DIR` | `./knowledge` | 知识库目录，可配多个（逗号分隔） |
| `MINIAGENT_KNOWLEDGE_BACKEND` | `lexical` | 检索引擎：`lexical`（词面）/ `vector`（语义）/ `hybrid`（两路 RRF 融合，需先跑 `model:fetch`） |
| `MINIAGENT_TOOL_RESULT_MAX_CHARS` | `4000` | 工具结果内联上限；超限则卸载到 `workspace/offload/` 可回读，`0` 表示不限 |
| `MINIAGENT_OFFLOAD_KEEP_RUNS` | `50` | 卸载产物保留多少个 run，更早的自动删除（`0` 表示不清理） |
| `MINIAGENT_SUBAGENT_TIMEOUT` | `180` | 子 agent 单次执行上限（秒） |
| `MINIAGENT_POWERSHELL_MODE` | `readonly` | 通用执行通道档位：`off` / `readonly`（只读白名单）/ `full` |
| `MINIAGENT_POWERSHELL_TIMEOUT` | `30` | 单条 shell 命令的默认超时（秒）；单次可用 `timeout_seconds` 调大，full 档上限 300s |
| `MINIAGENT_APPROVAL_TOOLS` | 空 | 需要人工审批的工具名（逗号分隔），命中即挂起等人批 |
| `MINIAGENT_MCP_CONFIG` | `./mcp.json` | MCP 服务端配置；文件不存在则不加载 MCP SDK |
| `MINIAGENT_SKILLS_DIR` | `./skills` | 技能包目录；模型可用 `create_skill` 往里写新技能 |
| `MINIAGENT_OTEL_ENABLED` | `false` | 是否按 GenAI 语义约定发 OTLP（span + 指标） |

## 接入模型服务商

客户端只依赖 OpenAI 兼容协议（`POST {baseUrl}/chat/completions` + tool calling），
所以换服务商只需要选预设或给两个变量：

```bash
# 例子：换成通义千问
MINIAGENT_PROVIDER=dashscope
MINIAGENT_API_KEY=sk-xxx

# 例子：换成本地 Ollama（localhost 端点不校验 Key）
MINIAGENT_PROVIDER=ollama
MINIAGENT_MODEL=qwen2.5:7b    # ollama 无默认模型名，必须显式指定

# 例子：自建网关 / 未列出的服务商
MINIAGENT_PROVIDER=custom
MINIAGENT_BASE_URL=https://gateway.internal/v1
MINIAGENT_MODEL=my-finetune
```

预设只提供**接入点与默认模型名**（`src/core/providers.ts`），不是一家一个适配器。
配置错在启动时就报错：未知 provider 会列出候选，缺接入点/模型名会直说是哪个变量。

## 通用执行通道（PowerShell）

模型的知识里没有「现在」，也没有你机器上的任何状态。`powershell` 工具把本机 shell 交出去，覆盖
「取当前时间（`Get-Date`）、看系统与进程信息、跑 git 等命令行工具、批量查看文件」这类需求——
不值得为每一个都写一个专用工具。

**它的性质与其余内置工具不同：没有沙箱。**

| | 边界 |
|---|---|
| `read_file` / `write_file` | 路径锁在 `workspace` 之内，越界直接报错 |
| `powershell` | 子进程权限 = server 进程权限，能读写 workspace 之外的任何路径 |

所以用**权限档位**把风险显式化（`MINIAGENT_POWERSHELL_MODE`）：

| 档位 | 行为 | 适用 |
|---|---|---|
| `off` | 不注册该工具 | 不放心的场景（最稳） |
| **`readonly`（默认）** | 只放行白名单里的只读 cmdlet，且输入必须是**单条简单命令**（无管道、无连接符、无变量、无重定向） | 取时间、看系统信息 |
| `full` | 不限制 | 需要真正跑脚本时；建议同时把 `powershell` 加进 `MINIAGENT_APPROVAL_TOOLS` |

readonly 档的两条边界要说清楚，避免误判安全等级：

- 它保证的是**「不写」**，不保证**「不读出沙箱外的东西」**——`Get-ChildItem C:\` 照样能列出沙箱外的目录；
- 校验手段是「白名单命令名 + 拒绝元字符」，属于**防误用**，不是防对手的沙箱。真要防住有恶意的模型，
  唯一可靠的做法是 `off`。

另外两处细节：子进程环境会**按名字剔除凭据类变量**（`KEY`/`TOKEN`/`SECRET`/`PASSWORD`/`CREDENTIAL`），
否则 `Get-ChildItem env:` 就能把 API Key 读进对话和轨迹；输出上限 1 MB，超限中断并提示加筛选条件。

**写脚本 → 执行 → 看结果**：`write_file` 的沙箱根和 `powershell` 的工作目录都是 `workspace`，
所以这是一条现成链路——`write_file("scripts/x.py", ...)` 之后 `python scripts/x.py` 即可，
相对路径天然落在工作区内。full 档下单次执行可以用 `timeout_seconds` 调大超时
（默认取 `MINIAGENT_POWERSHELL_TIMEOUT`，上限是它与 300s 中的较大者），readonly 档不接受调大。
Windows 上写 `python`（或 `py`）而不是 `python3`——后者常是应用商店的占位符，跑起来没有任何输出。
这条工作法会写进系统提示词（仅在同时具备 `powershell` 与 `write_file` 时），所以循环、批量计算、
反复试错这类任务模型会自己去写脚本，不必硬凑工具调用。

## 技能（Skills）

技能 = `skills/<name>/` 目录：`SKILL.md` 的 frontmatter 放元信息（`name` / `description` / `when_to_use` / `tools`），
正文放操作指引；`resources/` 可放模板等附件。

**渐进式披露**：系统提示词里只有技能目录摘要，正文要等模型调 `load_skill` 才取回——技能可以写得很详细而不吃常驻上下文。
附件用 `load_skill(name, resource=...)` 读：技能目录不在文件沙箱内，`read_file` 够不到。

**模型可以自己造技能**。`create_skill` 把一套跑通的做法写进技能目录，写完**立即重扫注册表**：

| 时间点 | 效果 |
|---|---|
| 当轮 | 就能用 `load_skill` 读回，并可马上按正文执行 |
| 下一轮起 | 进入系统提示词的「可用技能」，参与技能匹配 |

技能名同时是目录名：只允许字母或数字开头、由字母数字与 `. _ -` 组成（这是挡目录穿越的唯一防线）。
同名技能会被覆盖，返回值里 `replaced: true` 会明说；技能目录跨会话长期生效，写错会一直影响后续所有会话。

至于「自己执行」，两条路都靠 `powershell`：正文写清步骤、模型照着自己调工具走一遍（技能的本义），
或技能里放 `scripts/*.ps1`、正文写明用 `powershell` 跑它。

## 断点续跑与人工审批

每轮工具结果回灌后落一次运行存档（`checkpoints/<runId>.json`），**成功即删档**，
所以磁盘上只留「确实需要人看一眼」的运行。

```bash
# 需要审批的工具：命中即暂停，不执行
MINIAGENT_APPROVAL_TOOLS=write_file

# CLI：列出可续跑的运行 / 接着跑
你 > /runs
你 > /resume <run_id>

# HTTP：列运行、写审批决定、再续跑（两步之间进程重启也不丢决定）
curl localhost:3000/api/runs
curl -X POST localhost:3000/api/approve -d '{"run_id":"...","approved":true}'
curl -X POST localhost:3000/api/chat    -d '{"message":"","resume_run_id":"..."}'
```

审批以**整批**为单位：同一批工具基于同一份判断发起，批准一个而偷跑另一个没有意义。
被拒的调用不执行，但会把「用户拒绝」作为工具结果回灌，让模型改走别的路。

## MCP 工具

```bash
cp mcp.example.json mcp.json     # 然后按需改
npm start                        # 启动日志会打印已连接的服务与注册的工具数
```

远端工具注册为 `mcp__<server>__<tool>`，与内置工具不会撞名。
**未配置 `mcp.json` 时 MCP SDK 完全不加载**——它依赖 79 个包，不进默认路径。

安全边界：MCP 工具在**本进程之外**执行，**不受 `workspace` 文件沙箱约束**。
需要沙箱的工具应走内置实现，或把整个 MCP 服务放进容器。

## 可观测

| 出口 | 说明 |
|---|---|
| JSONL 轨迹 | `traces/<runId>.jsonl` 逐事件落盘，`npm run trace:replay` 可读；流式增量不落盘（避免膨胀） |
| `/metrics` | Prometheus 文本（默认）或 `?format=json`；含成功率、工具与模型错误率、token、时延分位 |
| OTLP | 打开 `MINIAGENT_OTEL_ENABLED=true` 后按 **GenAI 语义约定**发 span 到 `/v1/traces`、指标到 `/v1/metrics` |

OTLP 导出是**手写 OTLP/JSON 编码**，不引 `@opentelemetry/sdk-*`（同「零框架」原则）。
端点/服务名优先读 `MINIAGENT_OTEL_*`，回退到官方变量 `OTEL_EXPORTER_OTLP_ENDPOINT` /
`OTEL_SERVICE_NAME` / `OTEL_EXPORTER_OTLP_HEADERS`——容器里通常已经按规范注入了后者。
子 agent 的 span 挂在父运行的根 span 下，用 `miniagent.sub_role` 标出是哪个角色做的。

## 答案渲染支持哪些格式

控制台手写了一个轻量 Markdown 渲染器（[public/markdown.js](public/markdown.js)，纯函数、有单测），不引解析器也不引前端框架：

| 输入 | 渲染结果 |
|---|---|
| Markdown 表格（含 `:--:` 对齐） | 带边框的真表格，窄屏横向滚动；列数不齐时按表头补齐/截断，不会整张崩掉 |
| `![说明](URL)` / `[说明](URL)` | 图片与链接（新窗口打开） |
| ` ```mermaid ` | 流程图，由 mermaid 渲染成 SVG |
| ` ```svg ` | 矢量图，走 `<img src="data:image/svg+xml,…">` |
| 标题 h1–h4 / 有序无序列表 / 引用 / 分隔线 / 粗体斜体 / 行内代码 / 围栏代码块 | 均已支持；段内单换行按软换行处理 |

安全上有三条硬约束，都有测试盯着：

- **先转义再拼标签**（含引号），所以模型输出里的 HTML 不会被执行，也不可能从属性里逃逸；
- **URL 白名单**：`javascript:` / `vbscript:` 一律拒绝，`data:` 只允许出现在图片位置（链接位置等于 XSS 入口）；
- **SVG 走 `<img>` + data: URL**：SVG 里的脚本在 img 上下文不会执行，等于天然沙箱，因此不必自己写 SVG 消毒器。

mermaid 是**按需**从 CDN 加载的（页面里真出现图表时才取一次），加载失败会**降级**为「提示 + 可复制的源码」而不丢内容；
完全离线场景下表格、图片、SVG 都不受影响，只有 mermaid 图会走降级分支。

## 上下文处理

对应业界 context engineering 的四类做法：

| 类别 | 本项目的实现 |
|---|---|
| **Reduce 压缩** | ① 历史：token 滑窗（预算 = 窗口 × 比例）+ 超阈值 LLM 摘要；摘要要求把用户提出的指令与约束**逐字引用**，不让压缩抹掉可执行性。② 循环内：工具结果整体超预算时，把**最早**的若干条折叠成占位符（本批结果永不折叠），只改正文不动结构，因此不破坏 `tool_calls` 配对 |
| **Offload 卸载** | 工具结果超限时写入 `workspace/offload/<runId>/`，上下文里只留预览 + 路径，agent 可 `read_file` 取回；写盘失败才退化为截断。产物按 run 保留最近 50 个，更早的自动清理 |
| **Retrieve 按需** | 长期记忆按问题召回 Top-3、知识库由模型自主调 `search_knowledge`、技能正文靠 `load_skill` 拉取 |
| **Isolate 隔离** | `run_subagent` 把需要大量探索的子任务隔离出去，子 agent 有独立上下文与工具（递归深度为 1），父只拿结论与用量。**但它的中间步骤会中继到父轨迹**（`↳` 标记），隔离的是上下文而不是可观测性。子 agent 可选**角色**（researcher / analyst / critic，角色同时决定提示词与工具白名单，复核员拿不到写权限）；`run_subagents` 可**并行派发** 2-5 个互不依赖的子任务，一个失败不影响其他 |

### 执行事实随轮次持久化

跨轮次时，「我说过什么」会留在历史里，但「我做过什么」不会——工具结果只落在 `traces/`（在沙箱之外，
模型读不到）。这导致过一次真实误判：**上一轮真的调用过 `mcp__echo__echo`，下一轮却因为工具清单里
没有它（`mcp.json` 被移除），模型推翻自己、声称此前是编造的。**

修法是两半，缺一不可：

- **给证据**：每轮把「实际调用了哪些工具、成没成」存进会话（`SessionTurn.tools`，运行存档也带一份），
  下一轮由**运行期**把它写进系统提示词的证据小节：`〔上一轮实际执行〕mcp__echo__echo 成功`。
- **改推断规则**：同处明确「工具清单只描述当前环境，不代表过去」，同时反过来要求
  「**只有真的收到过工具返回才可以说「已调用」**」。只加前半句会把真正的编造一起保护起来。

**为什么不拼在历史消息里（第一版做法，实测失败）**：把台账拼在上一轮 assistant 消息后面时，
模型说「这行是我自己敲的，也是我编的，不是系统记录的真实执行台账」，照样否认。
挂在 assistant 名下就等于它自己的话——证据必须来自**它无法声称是自己写的**那个通道，
也就是系统提示词。

## 架构

```
User → Server → Agent →（记忆裁剪 + 长期召回 + 知识库检索）
     → PromptBuilder（含角色段）→ LLM（OpenAI 兼容，token 级流式）
     → ToolRuntime（并发执行；内置 / MCP / 子 agent）→ 结果回灌 → 每轮落一次存档 → 循环 → Answer
```

每个动作向 EventBus 发事件，Tracer / Metrics / OTel / SSE 各自订阅，业务与可观测性完全解耦。

```
src/
├── core/           # types / errors / events(事件总线) / config / providers(provider 预设) / logging
├── llm/            # base(接口 + 流式增量类型) / openai(OpenAI 兼容 client + retry + SSE 解析)
├── mcp/            # config(mcp.json 校验) / client(连接与工具适配) / index(注册与容错)
├── tools/          # defineTool / registry / runtime(并发) / semaphore / builtins/
├── agent/          # context(取消与用量) / agent(门面与主循环) / checkpoint(运行存档与续跑)
├── prompts/        # builder(分段组装) / system(段定义) / roles(角色预设与工具白名单)
├── memory/         # buffer(滑窗) / summary / textIndex(TF-IDF) / scoring
│                   # lifecycle(生命周期记忆) / store / memos / base
├── knowledge/      # base(接口) / chunker / store(多目录扫描) / index
│                   # lexical(词面 TF-IDF) / embedding(本地 ONNX 模型) / vector(LanceDB)
├── skills/         # loader（可原地重扫）/ frontmatter / load_skill + create_skill 元工具
├── history/        # 会话持久化（追加写 JSONL + 独立元信息 + 导入导出）
├── observability/  # tracer(JSONL 轨迹) / metrics(计数与分位) / otel(OTLP/HTTP 手写编码)
├── eval/           # types / judge(规则 + LLM 裁判) / runner
├── server/         # server(HTTP + SSE)
└── cli.ts
```

## 知识库

知识库走**模型自主检索**：注册成 `search_knowledge` 工具，由模型判断该不该查，而不是每轮硬注入。

```bash
# 1. 放纯文本（.md/.txt/.json/.csv/代码等），或用入库命令转二进制格式
npm run knowledge:add D:\资料\产品手册.pdf

# 2. 改完文档不用重启 —— 检索前按「路径 + mtime」比对指纹，变了才重建索引
```

`knowledge:add` 的分派：PDF / Excel / CSV 走 Python（`pdfplumber` / `openpyxl`），Word / HTML / ePub / ODT / RTF 走 `pandoc`，其余文本直接复制。

### 三种检索引擎

| 后端 | 依赖 | 适用 |
|---|---|---|
| `lexical`（默认） | 无 | 词面 TF-IDF。零依赖、开箱可跑；**中文查英文文档会零召回，同义改写也召不回** |
| `vector` | 可选依赖 + 380 MB 权重 | 语义向量检索，跨语言与同义改写都能召回 |
| `hybrid` | 同上 | 词面 + 语义两路召回，**RRF 融合**。精确 token（代号 / 编号）与同义改写都不漏，推荐用于正式场景 |

`hybrid` 用 RRF（Reciprocal Rank Fusion）把两路排名融合：只比较**排名**、不比较分数，
因此不必把词面的余弦分与向量的 `1 - distance` 对齐量纲。任一路失败会自动降级为另一路。
返回的 `score` 是「融合分 / 理论满分」——**两路都排第一得 1.0，只有一路排第一得 0.5**，
所以分数偏低说明另一路没有佐证同一个片段。

```bash
npm run model:fetch                        # 下载 embedding 模型到 ./models（约 380 MB，支持断点续传）
# .env 里改：
#   MINIAGENT_KNOWLEDGE_BACKEND=hybrid
#   MINIAGENT_EMBEDDING_REMOTE_HOST=https://hf-mirror.com   # 直连 huggingface.co 会超时
```

**连不上 HuggingFace 也连不上镜像时**，可以直接取发布好的权重包——它作为 Release 附件分发，
不进 git 历史（`.gitignore` 排除了 `models/`）：

```bash
tar -xf paraphrase-multilingual-MiniLM-L12-v2.tar -C models/
```

整包约 410 MB，解压后是 `./models/Xenova/paraphrase-multilingual-MiniLM-L12-v2/`，
与 `npm run model:fetch` 的落点完全一致（精度 q4，对应 `MINIAGENT_EMBEDDING_DTYPE=q4`）。
下载：[Releases · v0.1](https://github.com/OneFoodie/miniagent/releases/tag/v0.1)，
SHA256 `9f699af82e3bd51f8617ecc546c8ea7ce31afa95f7f9661f6b6b7f4954e32272`。

模型就位后**完全离线加载**，不再走网络。索引落在 `./vector-db`（可删，删了下次检索全量重建）。

**首次检索要等索引同步**：改过的文档会在下一次检索时重新嵌入，本地 CPU 上是分钟级操作
（实测 2 个文档变更 / 113 个片段约 42s）。所以 `search_knowledge` 单独设了 180s 超时，
而不是沿用工具默认的 30s——否则这次检索会被判为失败，而它其实马上就要成功。
想避免这种等待，改完文档先手动跑一次 `npm run knowledge:reindex`。

想调整两路话语权，用权重旋钮：`MINIAGENT_HYBRID_LEXICAL_WEIGHT`（精确匹配优先就调大）、
`MINIAGENT_HYBRID_VECTOR_WEIGHT`（同义召回优先就调大）、`MINIAGENT_HYBRID_RRF_K`（默认 60）。

### 依赖按环境裁剪

三套后端里只有 `lexical` 是**零额外依赖**的。语义后端要的两个包（`@lancedb/lancedb`、
`@huggingface/transformers`）声明在 **`optionalDependencies`**，于是两类环境都成立：

| 环境 | 安装方式 | 结果 |
|---|---|---|
| 完整（开发机 / 有资源的服务器） | `npm ci` | 三套后端都能用 |
| 轻量（小内存机器 / 精简容器） | `npm ci --omit=dev --omit=optional` | 只有词面后端；实测 **102 个包 / 15.6 MB / 2 秒**装完，`lexical` 检索照常工作 |

放 `optionalDependencies` 而不是 `dependencies` 有具体原因：`onnxruntime-node`（transformers
的传递依赖）在 postinstall 里要下载预编译二进制，受限网络下会失败——**放在 `dependencies` 里
会让整个 `npm ci` 失败，服务直接装不上**；作为可选依赖，安装失败只意味着「语义后端不可用」。
运行期真要使用语义后端时会得到明确提示（装依赖 / 换回词面后端），而不是 Node 原生那句
`Cannot find package`。

两条使用前提：

- 轻量环境**只能运行、不能编译**：`vector.ts` 的类型导入需要该包存在，缺包时 `tsc` 报 TS2307。
  所以 `dist/` 在完整环境编译好再传过去（容器与服务器部署都是这个路子）。
- 语义后端还需要 380 MB 的模型权重，`--omit=optional` 的机器本来就跑不动它，
  这两个约束是配套的。

容器要瘦身同理：在 [Dockerfile](Dockerfile) 的 deps 阶段把 `npm ci --omit=dev` 改成
`npm ci --omit=dev --omit=optional`，镜像会小几百 MB（容器里默认用 `lexical`）。

### 三路实测对比

**语料是受控构造的双语夹具**（3 个文件：英文 `security.md` 讲 Key rotation、中文 `governance.md` 讲日志保留、
中文 `billing.md` 讲计费）——之所以要构造，是因为**项目自有语料全是中文，无法体现跨语言差异**：

| 查询 | `lexical` | `vector` | `hybrid` |
|---|---|---|---|
| 密钥多久轮换一次？（中文查英文文档） | 无命中 | `security.md>Key rotation` 0.554 | `security.md>Key rotation` 0.500 |
| 日志要保存多久？（同义改写） | `governance.md` 0.107 | `governance.md` 0.754 | `governance.md` **1.000** |
| How long are audit logs kept?（英文查中文文档） | 无命中 | `governance.md>日志保留` 0.658 | `governance.md>日志保留` 0.500 |

读法：跨语言的两条里 `hybrid` 拿 0.5，是因为只有语义通道命中（词面通道零召回），
而不是融合变差了；同义改写那条 1.0，是因为两路都把同一个片段排在第一，互为佐证。

在项目自有语料（`./docs` + `./knowledge`，4 个中文文档）上三路的差距没有这么明显——
那份语料不含「密钥轮换」「日志保留」这类内容，三路都召不回本来就不存在的东西。

代价：CPU 嵌入让首次索引变慢（本项目 docs 全量约 5.7s），所以增量索引是必需的——未改动的文件不会重复嵌入。设计取舍见 [知识库存储升级设计](docs/designs/2026-09-24-知识库存储升级设计.md)。

## 容器化

```bash
docker compose up --build      # → http://localhost:3000
```

镜像三步构建：装生产依赖 → `tsc` 编译 → 运行层只带 `dist/` 与生产依赖，以非 root（`node`）用户启动，
并用 `/health` 做健康检查。知识库、模型与运行产物全部走卷挂载，改文档不用重建镜像。

未验证项：本机没有 Docker，镜像**未经实际构建验证**（`npm run build` + `npm run start:dist` 已验证可跑）。

## 评测

```bash
npm run eval                          # 全部用例（真实调用模型）
npm run eval -- --limit 2             # 冒烟
npm run eval -- --judge               # 追加 LLM 裁判（结果按问答缓存）
```

用例是 JSON（不引入 YAML 依赖），见 [eval/cases/basic.json](eval/cases/basic.json)。报告含成功率、工具正确率、平均 token、时延 p50/p95、平均迭代数。

评测**不挂长期记忆**——它是有状态的，会把上一轮召回带进下一轮，导致同一条用例两次跑出不同结果，回归比对就失去意义。

## 关于测试快照

提示词有全文快照（`tests/__snapshots__/`）作为防漂移闸门。若环境里设了 `CI=true`（vitest 在 CI 模式不写新快照），新增快照需显式生成：

```bash
npx vitest run -u
```

## 已知限制

| 限制 | 说明 |
|---|---|
| 语义检索需另装模型 | `vector` / `hybrid` 后端要 380 MB 的 ONNX 模型（`npm run model:fetch`），且 CPU 嵌入让首次建索引有秒级开销（本项目 111 个片段全量重建约 17s）；默认仍是零依赖的 `lexical` |
| 向量索引无分区 | 单机 LanceDB 全量常驻，已具备重建与对账（`knowledge:reindex [--check]`），但没有分区/增量压缩流程；规模压力与选型取舍见 [设计文档](docs/designs/2026-09-24-知识库存储升级设计.md) |
| 镜像未经验证 | Dockerfile / compose 已写好但本机无 Docker，未经构建验证 |
| 循环内折叠只看预算 | 折叠按「工具结果总量 vs 预算」判定，不看单个片段是否已被后续推理消化；最新一批永不折叠，因此极端情况下仍可能略超预算 |
| 知识库 vs 记忆优先级 | 知识库文档与长期记忆给出不同说法时没有优先级定义 |
| OTLP 未过真实 collector | 已验证报文符合 OTLP/JSON 结构（含 span 树、GenAI 属性、直方图分桶），但没接过 Jaeger/Tempo；只支持 JSON 编码，未实现 protobuf |
| 运行存档是单机文件 | `checkpoints/` 是本地路径，多实例共享未完成运行需要共享卷或另加后端 |
| 指标跨实例靠 collector | 本进程的 `/metrics` 仍是进程内累计（重启清零）；跨实例聚合依赖 OTLP 推到 collector，项目自身不提供中心化存储 |
| 并行子 agent 的 UI 配对是近似 | 前端按工具名配对 `tool_start` / `tool_end`，同名工具并发时可能配错显示位置（不影响轨迹文件与指标） |
| powershell 的 readonly 是「防误用」 | 白名单命令名 + 拒绝元字符，能挡住绝大多数误操作与模型越界；但**不是对抗有恶意模型的沙箱**，也能读到 workspace 之外的路径。需要硬隔离就设 `MINIAGENT_POWERSHELL_MODE=off` |
| mermaid 需联网 | 流程图渲染按需从 jsdelivr 取 mermaid（页面本来也从 Google Fonts 取字体）；取不到时降级成「提示 + 源码」，不会静默丢内容。要彻底离线可用，就把它从 `app.js` 的 `loadMermaid` 里去掉，只用 ` ```svg ` |
| 控制台有一条无害的 console 报错 | SSE 收到 `done` 后不再读响应体，浏览器记一条 `net::ERR_ABORTED`。代码里已显式容忍（[app.js](public/app.js) 的 `streamChat` catch 分支），不影响渲染；清掉它需要在 `done` 分支补 `reader.cancel()`，但那会触发服务端的连接关闭回调，收益不抵风险，故保留 |
| 提示词口径可能与配置不一致 | `principles` 段写死「整个会话最多调用 8 次工具」，而实际限制是 `MINIAGENT_MAX_ITERATIONS` 的**迭代轮数**（每轮可并发多个工具），且计数每次提问都会重置；段文本不随配置联动。明细见[设计文档](docs/superpowers/specs/2026-09-23-miniagent-design.md) 第 7.1 与第 10 节 |
| 采样参数不可配 | 请求体不发 `temperature` / `top_p` / `max_tokens` / `stop`，随机性与输出长度上限全由服务商默认值决定 |
| 身份与输出口径写死 | `identity` 段固定「研究助手」、`output_format` 固定「结构化中文回答」，与现有能力（写脚本、自建技能、跑本机命令）和英文提问场景不完全匹配 |
