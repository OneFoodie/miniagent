# MiniAgent 框架设计（v1）

日期：2026-09-23
最近更新：2026-09-24
状态：阶段一、二、三已完成；阶段四已完成（容器化未经实际构建验证）

技术栈：TypeScript 5 + Node.js 22+（ESM），`tsc --strict` 零错误。
（下限取 22 而非 20，是因为向量后端的 `@lancedb/lancedb` 声明 `engines: node >= 22`。）
（本文件最初按 Python 版规划，实现中途改为 TypeScript；本次已把全文口径同步到实际实现。）

## 1. 需求与目标

从零手写、教学可读、准生产标准的异步 Agent 框架。

| 能力 | 目标 | 状态 |
|---|---|---|
| Agent 循环 | ReAct 式 reason→act→observe，多轮工具调用、最大轮次保护、可取消 | ✅ |
| 并发 Tool | 同批 tool_call 并发执行；信号量限流、独立超时、故障隔离 | ✅ |
| Skills | 文件化技能包（SKILL.md + 资源），动态发现、渐进式加载 | ✅ |
| Memory | 短期滑窗 + 阈值摘要 + 可插拔长期存储 | ✅ |
| Prompt | 分段组装、版本化系统提示词，支持技能目录/记忆注入 | ✅ |
| LLM | OpenAI 兼容多服务商（DeepSeek / OpenAI / Moonshot / 通义 / 智谱 / Ollama / 自建网关），tool calling，token 级流式 | ✅ |
| Knowledge | 本地知识库 + `search_knowledge` 工具（模型自主检索、支持热更新、词面/语义/混合三后端） | ✅ |
| Context | 滑窗/摘要/卸载/隔离四类上下文处理 | ✅ |
| Tool 生态 | MCP 客户端：把远端 MCP 服务端的工具接成内置工具（默认不加载 SDK） | ✅ |
| 持久化执行 | 运行存档 + 断点续跑 + 工具级人工审批 | ✅ |
| Test/Eval | FakeLLM 确定性单测；评测集 + 规则/LLM 裁判 | ✅ 用例为 JSON（不引入 YAML 依赖） |
| 部署监控 | HTTP（SSE）+ 结构化日志 + JSONL trace + `/metrics` + OTLP 导出 | 🟡 容器化未经构建验证 |

非目标（放弃不做）：多 Agent 编排图、自动微调。

原先列为非目标、后经决定实现的三项，此处如实修正：

- **浏览器 UI**——已实现为 Web 研究控制台（`public/`，零前端框架）。
- **向量库**——一期已实施：`MINIAGENT_KNOWLEDGE_BACKEND=vector` 走 LanceDB + 本地 ONNX 模型做语义检索，词面实现保留为默认与降级路径。选型与容量分析见 [知识库存储升级设计](../../designs/2026-09-24-知识库存储升级设计.md)。
- **多模型协议适配**——已实施为「OpenAI 兼容 + provider 预设」：客户端只依赖协议本身，
  接入另一家只需 `MINIAGENT_PROVIDER` + 两个变量，不是一家一个适配器（见第 11 节 A3）。

「多 Agent 编排图」仍未做，且已明确**不跟进**：本项目面向单机单进程场景，图的表达能力在此规模下用不到，
却会让「读一遍源码就能改」这个核心优势消失。需要图编排的场合应当直接用 LangGraph。
角色化与并行派发（第 11 节 B1）是这条线上真正有收益的部分，已实现。

## 2. 项目规范

- TypeScript 5 + Node.js 22+；ESM；`src/` 布局；包名 miniagent
- **核心运行时依赖**：**zod**（参数校验 + JSON Schema 生成）与 **zod-to-json-schema**；开发依赖 typescript、tsx、vitest、eslint（含 `@eslint/js` / `typescript-eslint` / `@stylistic` / `globals`）
- **可选运行时依赖（`optionalDependencies`）**：`@lancedb/lancedb` + `@huggingface/transformers`
  （语义检索的两个包）声明为可选，于是两类环境都成立：完整环境 `npm ci` 三套后端全可用；
  轻量环境 `npm ci --omit=dev --omit=optional` 只有词面后端——**实测 102 个包 / 15.6 MB / 2 秒**。
  理由是具体的：`onnxruntime-node` 的 postinstall 要下载预编译二进制，受限网络下会失败，
  放在 `dependencies` 会让整个 `npm ci` 失败（服务直接装不上，1.8 G 内存的小机器上已实测踩到）；
  作为可选依赖，安装失败只意味着「语义后端不可用」。运行期真去用语义后端时，由
  `knowledge/optionalDeps.ts` 把 Node 的 `ERR_MODULE_NOT_FOUND` 翻成「装依赖 / 换回 lexical」
  两条出路（只翻缺包，模型加载失败等真实故障原样抛出）。
  代价说清楚：**轻量环境只能运行、不能编译**——`vector.ts` 的类型导入要求该包存在，缺包时
  `tsc` 报 TS2307，所以 `dist/` 在完整环境产出后分发。`@modelcontextprotocol/sdk`（MCP 客户端）
  仍留在 `dependencies`：它是纯 JS、安装不会失败，且上面那个 15.6 MB 的数字已经含它，不构成负担
- **零框架原则**：HTTP 服务用 `node:http`、并发限流自写 `Semaphore`、中文切词与 TF-IDF 自写、SSE 手写、
  **OTLP/HTTP 导出自己编码**。不引入 Web 框架、不引入 OpenTelemetry SDK，保证每一层可读可调
- **向量后端的例外**：语义检索需要真正的向量库与 embedding 模型，自写不现实，故引入 `@lancedb/lancedb` + `@huggingface/transformers`。两者都只引类型 + 动态 `import()`（`knowledge/vector.ts` 的 `openConnection`、`knowledge/embedding.ts` 的 `create`），**`lexical` 下不会被加载**——已实测：在只装了 zod 的目录里（`npm ci --omit=dev --omit=optional`）词面检索照常命中。零依赖默认路径因此得以保留
- **MCP 同样是「按需加载」的可选能力**（包本身在 `dependencies`，见上）：MCP SDK 会拖进 79 个包（express / hono / ajv / jose…），
  因此同样只引类型 + 动态 `import()`；`mcp.json` 不存在时完全不加载，默认路径依赖数量不变
- 全程 async/await + Promise 并发；类型注解全覆盖；公共接口不用裸 any
- 配置走环境变量 + `.env`（`node --env-file-if-exists`，Key 不入库）
- 异常用错误类层级，禁止吞异常
- 中文注释、英文标识符；`tsc --strict` 零错误；行宽 100 由 ESLint（`@stylistic/max-len`）强制

## 3. 项目架构

```
prj1/
├── package.json / tsconfig.json / tsconfig.build.json / vitest.config.ts / eslint.config.js
├── .env.example
├── Dockerfile / docker-compose.yml / .dockerignore
├── .github/workflows/ci.yml   # typecheck → lint → test（Node 22/24）
├── src/
│   ├── core/           # types / errors / events(事件总线) / config / providers(provider 预设) / logging
│   ├── llm/            # base(接口 + 流式增量类型) + openai(OpenAI 兼容 client / retry / SSE 解析)
│   ├── mcp/            # config(mcp.json 校验) / client(连接与工具适配) / index(注册与容错)
│   ├── tools/          # base(defineTool) / registry / runtime(并发) / semaphore / builtins/
│   ├── agent/          # context(取消与用量) / agent(门面与主循环) / checkpoint(运行存档与续跑)
│   ├── prompts/        # builder(分段组装) / system(段定义) / roles(角色预设与白名单)
│   ├── memory/         # buffer(滑窗) / summary(阈值摘要) / textIndex(TF-IDF) / scoring(四信号)
│   │                   # lifecycle(生命周期记忆) / store(JSONL) / memos(云记忆) / base
│   ├── knowledge/      # base(接口) / chunker(两级切分) / store(多目录扫描) / index(工厂与工具)
│   │                   # lexical(词面 TF-IDF) / embedding(本地 ONNX 模型) / vector(LanceDB 语义检索)
│   │                   # hybrid(词面 + 语义 RRF 融合)
│   ├── skills/         # loader（可原地重扫）/ frontmatter / index(load_skill + create_skill 元工具)
│   ├── history/        # store(会话持久化：追加写 JSONL + 独立元信息 + 导入导出)
│   ├── observability/  # tracer(JSONL 轨迹) / metrics(计数与分位) / otel(OTLP/HTTP 手写编码)
│   ├── eval/           # types / judge(规则 + LLM 裁判) / runner(执行与汇总)
│   ├── server/         # server(HTTP + SSE)
│   └── cli.ts
├── docs/               # 设计文档 specs/ designs/ 与问题记录 issues/（同时是默认知识库目录之一）
├── public/             # Web 控制台（index.html / app.js / styles.css / markdown.js，零前端框架）
│                       #   markdown.js = 纯函数渲染器（表格/图片/链接/mermaid/svg），可被单测直接 import
├── scripts/            # knowledgeAdd.ts(入库命令) / convert.py(格式转换) / runEval.ts(评测入口)
│                       # fetchModel.ts(下载 embedding 模型，断点续传) / traceReplay.ts(轨迹重放)
│                       # knowledgeReindex.ts(向量索引重建与对账)
├── models/             # 本地 embedding 模型（npm run model:fetch 落点，不入库）
├── vector-db/          # LanceDB 索引（运行产物，不入库；删掉即全量重建）
├── checkpoints/        # 运行存档（成功即删，只留中断/挂起的，不入库）
├── skills/             # 示例技能包
├── mcp.example.json    # MCP 服务端配置示例（复制成 mcp.json 生效）
├── tests/              # FakeLLM 确定性测试（vitest）
├── eval/cases/         # 评测集（JSON）
└── deploy/             # Dockerfile（阶段四，未建）
```

数据流：User → Server → Agent →（记忆裁剪 + 长期召回 + 知识库按需检索）→ PromptBuilder
（含角色段）→ LLM（OpenAI 兼容，token 级流式）→ ToolRuntime（并发执行；内置 / MCP / 子 agent）
→ 结果回灌 → 每轮落一次运行存档 → 循环 → Answer。

每个动作向 EventBus 发事件，Tracer / Metrics / SSE 转发各自订阅，业务与可观测性完全解耦。

## 4. Agent 与并发 Tool

- `defineTool` + zod：参数校验并自动生成 JSON Schema（含 draft-07 → 2020-12 归一化，规避 DeepSeek 校验失败）；`ToolResult{ok, data, error}`
- `ToolRegistry`：注册 / 重名拦截 / 生成 tools 载荷 / 按名分派
- `ToolRuntime`：`Promise.all` 并发；自写 `Semaphore` 限流；每工具独立超时（`Promise.race` 三竞速：任务 / 超时 / 取消）；失败转模型可见错误；故障隔离
- 主循环：无工具调用即结束；`max_iterations` 兜底；`AgentContext` 持 `AbortSignal` 与 `run_id`；累计统计 token 与时延
- 子 agent（Isolate）：`run_subagent` 把「要翻很多资料才能得出结论」的子任务隔离出去——子 agent 用独立上下文与
  「不含本工具」的工具集（递归深度天然为 1），不挂记忆与长期召回；父只拿到结论与用量。工具可声明
  `timeoutSeconds`，子 agent 以**协作式取消**（而非运行时的硬超时）收尾，避免超时后变成后台孤儿
- 内置工具：`calculator`、`http_fetch`、`web_search`（Bing→百度→DuckDuckGo 三源降级）、`read_file` / `write_file`（沙箱限制）、`load_skill` / `create_skill`、`search_knowledge`、`run_subagent` / `run_subagents`、`powershell`
- **通用执行通道**（`tools/builtins/powershell.ts`）：模型的知识里没有「现在」，也没有本机状态，
  所以把 shell 交出去覆盖「取时间（`Get-Date`）、看系统与进程、跑 git 等 CLI」这类需求。
  它的性质与其余工具**不同——没有沙箱**（子进程权限 = 本进程权限），因此用权限档位显式约束：
  `off`（不注册）/ `readonly`（默认，只放行只读 cmdlet 且必须是单条简单命令）/ `full`（不限制）。
  两个实现要点：**readonly 校验是「白名单命令名 + 拒绝元字符」**，属于防误用而非防对手的沙箱，
  且它保证「不写」但不保证「不读出沙箱外的东西」；**子进程环境按名字剔除凭据类变量**，
  否则 `Get-ChildItem env:` 就能把 API Key 读进对话与轨迹。超时/取消共用一条 `AbortController`，
  保证命令超时后 PowerShell 进程真的被终止（运行时的硬超时不会杀底层进程，见 `runtime.ts` 的说明）。
  **写脚本 → 执行 → 看结果**这条链路是 `write_file`（脚本落在沙箱内 `scripts/`）+ 本工具的组合：
  工具的工作目录就是 `workspace`，所以 `python scripts/x.py` 这类相对路径天然可达；
  full 档单次执行可用 `timeout_seconds` 覆盖默认超时（上限 `max(MINIAGENT_POWERSHELL_TIMEOUT, 300)`），
  readonly 档不接受调大——它的用途是取时间与看信息，没有理由长时间占着进程。
  这套工作法由 `tool_policy` 段在「同时具备 powershell 与 write_file」时写进提示词（含
  「Windows 上用 python 而非应用商店占位符 python3」这条本地知识）

## 5. Skills（阶段二）

技能目录：`SKILL.md`（YAML frontmatter：`name` / `description` / `when_to_use` / `tools`）+ 正文 + `resources/`。
渐进式披露：系统提示词只放目录摘要，元工具 `load_skill` 按需加载正文与资源（资源必须走 `load_skill`，不在文件沙箱内）。损坏技能包跳过不拖垮启动。

**运行期自建（`create_skill`）**：模型把跑通的做法写进技能目录，写完立即重扫注册表——
`SkillRegistry.refresh()` **原地**替换条目，而系统提示词每轮都读 `catalog()`、`load_skill` 闭包也持有同一实例，
所以当轮即可 `load_skill` 读回、下一轮起进入「可用技能」。技能名同时是目录名，用字符集白名单挡目录穿越
（`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`）；元信息拒绝英文双引号并折成单行，保证写出的 frontmatter 能被自己的解析器读回；
同名技能允许覆盖并在返回值里标 `replaced`。技能正文只是指引，不含可执行代码——「自己执行」由 `powershell` 承担。

## 6. Content / Memory / Context（阶段二起持续扩展）

- **短期**：token 滑窗（预算 = 模型窗口 × 比例，默认 `131072 × 0.25 ≈ 32K`，换模型只改窗口；
  保留首条 system；不以孤立 `tool` 消息开头，否则 DeepSeek 报 400）
  ＋ 被裁部分超阈值（默认 2000，**刻意不随窗口伸缩**——它衡量的是「裁掉的内容够不够抵一次 LLM 调用」，
  是成本考量）时 LLM 摘要压缩（≤400 字），摘要滚动合并旧摘要并注入 `memory_summary` 段
- **长期**：`LongTermMemory` 可插拔接口，三个后端——`jsonl`（默认）/ `lifecycle`（本地生命周期记忆）/ `memos`（MemOS 云记忆）
- **生命周期记忆**：置信度（召回 +0.1、按类型日衰减）+ 矛盾消解（`supersededBy`，不删除）+ 去重（重叠系数）
  ＋ Ebbinghaus 遗忘 + 多信号排序（语义 0.5 / 时效 0.2 / 置信 0.15 / 优先级 0.15）
  ＋ 巩固（超阈值时用 LLM 把最低分的一批压成归档摘要，标记 `consolidatedInto`，不删除原记录）。
  去重与矛盾消解还依赖**「信息替换」判定**：比较两条记忆的基础 token（中文单字 + 拉丁词，丢掉相邻双字），
  若旧信息有丢失、新信息有引入，即判为内容被替换——此时**即使没有推翻词也让旧记录作废**。
  少了这一步，「代号是 A」会把后来的「代号是 B」当成重复丢掉（两者 token 重叠高达 0.96），
  系统就会一直记着过时的值。另外判为重复时，若新记忆信息更全则用它刷新旧文本，避免丢掉补充内容。
- **上下文处理**（四类做法全做齐，对应业界 context engineering 的分类）：
  ① **Reduce** —— 两层：**历史**用滑窗 + 阈值摘要（见上一条）；**循环内**在每轮回灌工具结果后
  按「工具结果总量 vs `memoryMaxTokens`」折叠最早的若干条（`foldOldToolResults`）。
  折叠而非删除是因为 OpenAI 兼容协议要求 `tool_calls` 与 `tool` 消息成对出现，
  删掉会让下一次请求直接报错；折叠只改正文、不动结构。**本批刚回灌的结果永不折叠**——
  模型还没看过它们，折叠等于把这一轮的行动依据抽走；
  ② **Offload** —— 工具结果超限时**卸载**到 `workspace/offload/<runId>/`，上下文里只留预览 + 路径，
  agent 可用 `read_file` 取回；写盘失败才退化为纯截断。原来是直接截断，超出的内容**永久丢失**。
  产物按 run 保留最近 `offloadKeepRuns`（默认 50）个，更早的自动清理；
  ③ **Retrieve** —— 长期记忆按问题召回 Top-3、知识库由模型自主调 `search_knowledge`、技能正文靠 `load_skill` 拉取；
  ④ **Isolate** —— `run_subagent` 把需大量探索的子任务隔离出去，见第 4 节。**中间步骤会中继到父轨迹**（见第 10 节）。
  子 agent 可指定**角色**（researcher / analyst / critic，角色同时决定提示词与工具白名单），
  也可用 `run_subagents` **并行派发** 2-5 个互不依赖的子任务（一个失败不影响其他），见第 11 节 B1。
  另：摘要 prompt 要求把用户提出的指令与约束**逐字引用**，避免压缩掉可执行性
  （对应 Compaction Cliff：安全规则经一轮压缩只剩 53%、五轮后剩 10%，因为规则需要精确措辞才可执行）
- **会话**：`history/<id>.jsonl` 追加写 + `<id>.meta.json` 独立元信息；旧整份 `.json` 格式读取兼容、写入时迁移
- **执行事实随轮次持久化**（`SessionTurn.tools`）：每轮记下「实际调用了哪些工具、成没成」，
  下一轮由运行期写进**系统提示词**的证据小节（`tool_policy` 段）：
  `〔上一轮实际执行〕mcp__echo__echo 成功`。起因是一次实测误判：上一轮真的调用过 `mcp__echo__echo`，
  但工具清单在两次对话之间变了（`mcp.json` 被移除），而工具结果只落在沙箱之外的 `traces/` 里、
  模型读不到，于是它把"当前清单"当成了历史事实，推翻自己、声称此前是编造的。
  **第一版做法（把台账拼在上一轮 assistant 消息后面）实测失败**：模型说"这行是我自己敲的，
  也是我编的"——挂在 assistant 名下就等于它自己的话；换成系统提示词后同一场景复现通过。
  配套的「证据规则」小节两个方向都写：工具清单只描述当前环境、不代表过去；
  但**只有真的收到过工具返回才可以说「已调用」**——只加前半句反而会加固编造。
  运行存档（checkpoint）里也带上这份事实，续跑时才不会丢掉挂起前的记录
- **知识库**：与长期记忆相互独立（数据源是外部文档、不遗忘、无置信度）。
  多目录扫描（`MINIAGENT_KNOWLEDGE_DIR` 逗号分隔）→ 标题/段落两级切分（600 字 + 80 字重叠）
  → 检索（`lexical` 词面 TF-IDF / `vector` LanceDB 语义向量，二者同一接口，见第 6.1 条）
  → 由 `search_knowledge` 工具**按需检索**（模型自主决定，非每轮硬注入）
  → 按「路径 + mtime」指纹做热更新，改文档无需重启进程。
  冲突可见性：片段携带来源文件的修改时间（`updatedAt`，工具返回为 `updated_at`），供模型判断两份冲突记载哪份更新；
  检索截断后会把「`heading` 相同但 `source` 不同」的片段补回来（上限 `top_k` 条），避免冲突的另一方被截掉；
  工具描述要求模型先比较 `updated_at` 取较新者，无法判断新旧的才并列报出、不得自行裁决

### 6.1 知识库检索后端（一期 + 二期均已实施）

`KnowledgeBase` 是唯一接口（`docs()` + `search()`），`search_knowledge` 工具与 Agent 都只依赖它，
所以三个后端可切换、可组合，替换不动上层任何代码。

| 后端 | 配置 | 实现 | 依赖 |
|---|---|---|---|
| `lexical`（默认） | `MINIAGENT_KNOWLEDGE_BACKEND=lexical` | `src/knowledge/lexical.ts`：内存 TF-IDF（中文单字 + 相邻双字），余弦排序 | 无 |
| `vector` | `...=vector` | `src/knowledge/vector.ts` + `embedding.ts`：LanceDB + ONNX 本地模型 | 2 个可选包 + 380 MB 模型 |
| `hybrid` | `...=hybrid` | `src/knowledge/hybrid.ts`：两路并发召回，RRF 融合 | 同上 |

**`lexical` 的失效模式**（这是升级的动因，不是可调参数）：词面匹配对**跨语言**与**同义改写**都零召回或接近零召回。
中文查英文文档直接查不到；「日志要保存多久」与文档里的「日志保留期限」因为用词不同，分数低到会被长度惩罚压下去。
这类问题靠调权重、加同义词表都治不好，本质是表示层的问题。

**`vector` 的关键设计**：

- **增量索引是必需而非常规优化**——本地 CPU 嵌入很慢，全量重建代价不可接受。索引按「路径 + mtime」指纹比对，
  只重嵌入变化的文件、删掉已消失文件的向量行。首次构建实测约 5.7s（`./docs` 全量），之后命中缓存时检索约 0.04s；
  新进程实例化时不重复嵌入（`重嵌入 0 个文件`）。
- **度量必须显式指定**——用 `table.vectorSearch(v).distanceType("cosine")`，不用默认的 l2；
  分数换算 `score = 1 - distance`，与 `lexical` 的余弦分同量纲，上层无需区分。
- **标题参与嵌入**——嵌入文本是 `heading + "\n" + text`，因为标题里的词往往正是检索时的关键词。
- **模型加载与下载分离**——`scripts/fetchModel.ts`（`npm run model:fetch`）负责下载且带 `Range` 断点续传；
  `embedding.ts` 只负责加载。本地模型目录齐备（`config.json` + 对应精度的 ONNX 都存在且非空）时 `allowRemoteModels=false`，
  **完全离线**，不发起任何网络请求。
- **dtype → 权重文件名**：`fp32→model.onnx`、`fp16→model_fp16.onnx`、`q8→model_quantized.onnx`、
  `int8→model_int8.onnx`、`q4→model_q4.onnx`、`q4f16→model_q4f16.onnx`。默认 `q8`。
- **国内网络**：`huggingface.co` 实测不可达（连接超时），需 `MINIAGENT_EMBEDDING_REMOTE_HOST=https://hf-mirror.com`；
  镜像连接不稳定，故下载脚本以「连续无进展」而非「单次失败」判定失败。
- **首次检索必须撑得住同步耗时**：`search_knowledge` 单独声明了 180s 超时，不沿用工具默认的 30s。
  原因是检索前会先把变更文件嵌入完，而本地 CPU 嵌入是分钟级操作——**实测踩到过**：
  冷启动时 2 个文档待重嵌入、113 个片段，同步耗时 42s，导致两个并发的 `search_knowledge`
  都被 30s 超时判为失败（`tool.search_knowledge.errors` 直接 +2），而它们其实马上就要成功，
  模型还会拿同样的参数重试。超时不会取消底层嵌入，所以调大它没有额外代价。
- **容量治理**：`npm run knowledge:reindex` 全量重建、`-- --check` 只对账（报告「磁盘有索引没有」与
  「索引有磁盘已删」两类漂移）。实测改一个文档后 `--check` 能立刻指出该文件待重嵌入；
  重建 4 个文件 111 个片段耗时 17.0s——这个数字正说明**日常不该靠重建**，增量同步才是主路径。

**`hybrid` 的融合规则（二期）**：

两路的失效模式不重叠，所以融合是互补而不是叠加：语义通道对同义与跨语言有效但会**把代号/编号这类精确 token 平滑掉**，
词面通道反过来。融合用 RRF：`score = Σ weight_c / (k + rank_c)`，k 默认 60。

- **只用排名、不用分数**——这是选 RRF 而非加权求和的原因：词面的余弦分与向量的 `1 - distance` 虽然都落在 0~1，
  分布完全不同，直接加权需要额外的分数校准。
- **候选要放宽**——两路各取 `max(topK × 5, 20)` 条进融合，否则 topK 很小时两路几乎没有交集。
- **降级而非报错**——任一路抛错（典型是嵌入模型没装好）只记警告，用另一路继续；两路都失败才抛错。
- **归一化返回分**：`score = 融合分 / 理论满分`，因此**两路都排第一得 1.0、只有一路排第一得 0.5**。
  这个分比裸 RRF 分（约 0.016）好读，而且偏低本身就是信息：另一路没有佐证同一个片段。
- **不做 cross-encoder 重排**——那需要再挂一个 ONNX 模型，而二期要解决的「精确匹配被漏掉」用 RRF 已经覆盖
  （目标片段会在词面通道排到头部，融合后排名自然被抬起）。
- 权重旋钮（`MINIAGENT_HYBRID_LEXICAL_WEIGHT` / `MINIAGENT_HYBRID_VECTOR_WEIGHT`）就是「重排」的调节手段。

**实测对比**：语料是**受控构造的双语夹具**（英文 `security.md` + 中文 `governance.md` + 中文 `billing.md`）。
之所以要构造，是因为**项目自有语料全是中文，无法体现跨语言差异**：

| 查询 | `lexical` | `vector` | `hybrid` |
|---|---|---|---|
| 密钥多久轮换一次？（中文查英文文档） | 无命中 | `security.md>Key rotation` 0.554 | `security.md>Key rotation` 0.500 |
| 日志要保存多久？（同义改写） | `governance.md` 0.107 | `governance.md` 0.754 | `governance.md` 1.000 |
| How long are audit logs kept?（英文查中文文档） | 无命中 | `governance.md>日志保留` 0.658 | `governance.md>日志保留` 0.500 |

跨语言那两条 `hybrid` 得 0.5 不是融合变差，而是只有语义通道命中（词面通道零召回）；
同义改写那条得 1.0，是两路都把同一片段排在第一、互为佐证。

**代价与边界**：多出 2 个可选依赖与一次模型下载，首次建索引有秒级 CPU 开销；
索引单机全量常驻、无分区与重建流程。容量模型、三层分离架构与 pgvector 路线的取舍见
[知识库存储升级设计](../../designs/2026-09-24-知识库存储升级设计.md)（其中「一期」按本项目实际规模改用
LanceDB + 本地模型落地，而非设计时的 Postgres + pgvector——零依赖降级路径因此得以保留）。

## 7. Prompt（阶段一最小版，阶段二完整版）

系统提示词分段：身份 → 操作原则 → 工具策略 → 技能目录 → 记忆摘要 → 相关历史记忆 → 输出格式。

每段带 `id@version`；`run_start` 轨迹记录本次全部段版本，供 eval 归因。段渲染是纯函数，便于快照测试防漂移。

**角色段是可选的第 2 段**（`prompts/roles.ts`）：选了角色就在身份段后插入 `role_<name>@1.0.0`，
不选则段与版本号与默认完全一致——因此角色化对既有快照、eval 归因零影响（见第 11 节 B1）。

### 7.1 每轮请求里哪些是固定信息（2026-09-25 审计）

请求体字段固定为 `model` / `messages` / `tools` / `tool_choice`（写死 `"auto"`）/ 流式时的
`stream` + `stream_options.include_usage`。**不发 `temperature` / `top_p` / `max_tokens` / `stop`**：
采样随机性与输出长度上限完全由服务商默认值决定，本项目不提供配置项（见第 10 节缺口表）。
`messages` 的 system 恒置顶，历史**每轮全量重发**，不做服务端会话复用。

七段中**完全固定**的是三段（字符数为实测值）：

| 段 | 版本 | 字符 | 内容 |
|---|---|---|---|
| `identity` | 1.0.0 | 35 | 「你是一个严谨的研究助手…」 |
| `principles` | 1.1.0 | 121 | 三条原则（含写死的「最多调用 8 次工具」，口径见第 10 节） |
| `output_format` | 1.1.0 | 251 | 「结构化中文回答」+ 表格 / mermaid / svg / 图片四条渲染引导 |

**骨架固定、内容随上下文变**：`tool_policy@1.8.0`（示例 1269 字符）由四条按 `toolNames` 的条件分支
（`search_knowledge` / `load_skill` / `create_skill` / `powershell`，其中脚本工作法还要求 `write_file` 在列）
＋ 运行期写入的执行台账组成；`skills_catalog` / `memory_summary` / `recalled_memory` 三段模板句固定、条目动态。

工具描述每轮全量重发：8 个内置与技能工具合计 **3742 字符** JSON，最长两项是 `create_skill`（859）与
`powershell`（710，其中档位与超时提示按配置动态生成）。MCP 工具与子 agent 的角色段另计。

## 8. Test / Eval（阶段三）

- **已完成**：FakeLLM 确定性单测共 368 个（25 个文件），覆盖工具契约、注册表、并发与故障隔离、`max_iterations`、取消、
  滑窗与摘要（含措辞保护）、预算按窗口推导、**循环内上下文折叠**、工具结果卸载与**卸载产物保留策略**、
  子 agent 隔离与**轨迹中继**、**角色化与并行派发**（并发探针实测最大并发数）、长期记忆（含矛盾消解、信息替换判定、巩固）、
  知识库（切分 / 多目录 / 白名单 / 热更新 / 长度惩罚 / 冲突可见性 / **RRF 融合** / **重建与对账**）、
  会话存储（含旧格式迁移与**跨实例导入导出**、**执行事实持久化**）、提示词全文快照、
  **前端 Markdown 渲染器**（表格 / 图片 / 链接 / 转义 / URL 白名单 / mermaid / svg）、
  指标聚合（含 `llm_error` 口径）、评测裁判与报告汇总、
  **OpenAI 兼容协议与多 provider 配置**、**流式 SSE 分片与 tool_calls 累积**、**OTLP span/指标编码**、
  **MCP 配置校验与真实子进程端到端**、**运行存档与人工审批**、
  **powershell 档位与只读白名单（含 13 类绕过形态）与单次超时**、**技能运行期自建与注册表原地重扫**
- **已完成**：HTTP 层单测 25 个（`tests/server.test.ts`）。做法是把请求处理抽成 `createRequestHandler(deps)`
  工厂，测试用替身依赖建真实 `http.Server` 跑在临时端口上——不启动整个进程、不用真实 LLM。
  覆盖路由与状态码、SSE 事件序列、请求校验与体积上限、会话与轨迹接口（含**导出/导入**）、静态资源与路径穿越防护、
  `/api/stop` 取消在途运行
- **向量后端的测试策略**：`tests/vector.test.ts` 用**注入式假嵌入**（`FakeEmbedding` 返回确定性向量），
  因此增量索引、删除同步、持久化等逻辑无需下载模型、无需网络即可确定性覆盖；
  真模型只用于一次性端到端验证（见 6.1 的实测表格）
- **已完成**：评测集 `eval/cases/*.json` → 成功率 / 工具正确率 / 平均 token / p50 / p95 / 平均迭代 → JSON 报告（`eval_reports/`）。
  规则裁判（关键词 · 禁止词 · 工具覆盖）为主力，LLM 裁判按「问题 + 答案」哈希缓存，避免回归时重复花 API 费用。
  `npm run eval` 有用例失败即以非零码退出，可直接接进 CI
- 用例格式用 JSON 而非原规划的 YAML —— 项目没有 YAML 解析器，不为评测单独引入依赖
- **已完成**：ESLint 扁平配置（`eslint.config.js`）+ `npm run lint`。用非类型化规则集（类型错误已由 `tsc` 兜住，
  开 projectService 的收益不抵其开销）；行宽 100 由 `@stylistic/max-len` 从「约定」变成「强制」。
  `public/` 按浏览器环境单独配置，`scripts/` 与 `tests/` 放开 `no-console`
- **已完成**：CI（`.github/workflows/ci.yml`）在 Node 22 与 24 上跑 typecheck → lint → test。
  选 22 作矩阵下限是因为 `@lancedb/lancedb` 声明 `engines: node >= 22`——项目 `engines` 也已同步改为 `>=22`
- **未覆盖**：`eval/` 的报告生成逻辑无单测（评测本身要真实调模型，属于人工触发）

## 9. 部署与监控（阶段四）

- **API**：`POST /api/chat`（SSE 流式）、`POST /api/stop`、`GET /api/trace/:runId`、
  `GET|DELETE /api/sessions[/:id]`、`GET /api/sessions/:id/export`、`POST /api/sessions/import`、
  `GET /api/runs`、`POST /api/approve`、`GET /health`、`GET /metrics`
- **SSE 事件**：`run_started` / `status` / `llm_delta`（token 级增量）/ `llm_end` / `tool_start` /
  `tool_end` / `approval_required` / `final` / `error` / `done`
- 已实现：SSE 流式推送、结构化 JSONL 日志、`run_id` 贯穿全链路（`AsyncLocalStorage`）、JSONL trace 落盘
- `GET /metrics` 默认输出 Prometheus 文本格式（可直接被抓取），`?format=json` 便于人工排查；
  指标含 run 成功率（`runs` / `runs.failed`）、工具总错误率与分工具错误率、**模型失败数（`llm.errors`，来自 `llm_error` 事件）**、
  token、时延 p50/p95、迭代次数。工具错误与模型失败分开计：前者定位「哪个工具在挂」，后者定位「模型侧是不是不通」。
  指标聚合器用 `attach(bus)` 而非构造订阅——server 每请求一个新 EventBus，构造订阅只能挂上第一个
- **OTLP 导出**（第 11 节 A4）：按 OpenTelemetry GenAI 语义约定把同一份事件映射成 span 与指标，
  `POST {endpoint}/v1/traces` 与 `/v1/metrics`。默认关闭（`MINIAGENT_OTEL_ENABLED=false`）；
  未启用时走空实现，不订阅任何总线开销
- **答案渲染**（`public/markdown.js`）：手写 Markdown 渲染器，支持表格（含对齐、列数不齐时补齐/截断）、图片、
  链接、标题 h1–h4、引用、分隔线、粗体斜体、行内代码、围栏代码块，以及两类图表：
  ` ```mermaid ` 交给 mermaid（按需从 CDN 加载，失败降级为「提示 + 可复制源码」）、
  ` ```svg ` 走 `<img src="data:image/svg+xml,…">`。
  安全上有三条硬约束并有单测盯着：**先转义再拼标签**（含引号，属性无法逃逸）、
  **URL 白名单**（`javascript:`/`vbscript:` 一律拒；`data:` 只允许出现在图片位置）、
  **SVG 用 img 上下文**（脚本不执行，等于天然沙箱，不必自写 SVG 消毒器）。
  渲染器是纯函数且 `public/app.js` 已是 ES module，因此可以直接被 vitest import ——
  "拼 HTML 字符串"这类代码最该测的就是转义与白名单，前端因此第一次有了单测
- **已完成**：多阶段 Dockerfile（非 root）+ `docker-compose.yml`。三步构建：生产依赖 → `tsc` 编译 →
  运行层只带 `dist/` 与生产依赖，`USER node` 非 root，`HEALTHCHECK` 打 `/health`；
  compose 用 `env_file: .env` 整份注入配置，只覆盖容器内路径，知识库/模型/运行产物走卷挂载。
  **注意：本机没有 Docker，镜像未经实际构建验证**（已验证的是 `npm run build` 产物可正常起服务、
  且 `dist/` 不引用任何 devDependency）
- **已完成**：trace 重放（`npm run trace:replay -- <runId>`）：把 JSONL 轨迹渲染成带相对时间戳的时间线
  （模型思考 / 工具入参与产出 / 记忆召回与写入），末尾汇总 token、耗时、工具成败；`--full` 看全文，`--json` 出原始数据。
  刻意不加载 `Settings`，因此重放不需要 API Key
- 说明：原规划的服务端为 FastAPI，改用 TypeScript 后为 `node:http` 零框架实现；API 路径亦由 `/v1/agent/*` 调整为 `/api/*`

## 10. 实现状态与已知缺口

阶段之外，以下是尚未处理的质量问题：

| 缺口 | 现象 | 代价 |
|---|---|---|
| ~~检索质量~~ | **已解决**（一期 + 二期）：`vector` 语义后端 + `hybrid` 两路 RRF 融合，实测见 6.1 | ✅ |
| ~~子 agent 步骤不可见~~ | **已解决**（方案 A）：工具执行期注入 `{bus, runId}` 作用域，子 agent 事件中继到父总线，见下 | ✅ |
| ~~上下文仍是「开跑时裁一次」~~ | **已解决**：循环内按「工具结果总量 vs 预算」折叠最早的工具结果，本批永不折叠，见 6 节 | ✅ |
| ~~卸载产物不清理~~ | **已解决**：按 run 保留最近 `MINIAGENT_OFFLOAD_KEEP_RUNS`（默认 50）个，更早的自动删除 | ✅ |
| ~~错误率口径~~ | **已解决**：新增 `llm_error` 事件与 `llm.errors` 计数，模型重试耗尽不再混进工具错误 | ✅ |
| ~~HTTP 层无测试~~ | **已解决**：`tests/server.test.ts` 覆盖 21 个用例，见第 8 节 | ✅ |
| ~~lint / CI~~ | **已解决**：ESLint（行宽强制）+ GitHub Actions（Node 22/24 矩阵），见第 8 节 | ✅ |
| 向量索引无分区 | 已有重建与对账（`npm run knowledge:reindex [--check]`），但单机表全量常驻，无分区与增量压实流程。分析见 [知识库存储升级设计](../../designs/2026-09-24-知识库存储升级设计.md) 第 8–9 节 | 中 |
| 知识库 vs 记忆优先级 | 知识库文档与长期记忆给出不同说法时没有优先级定义（长期记忆段只说"与当前检索结果冲突时以当前检索结果为准"，未覆盖知识库这条路径） | 低 |
| ~~只绑 DeepSeek~~ | **已解决**：`llm/openai.ts` 只依赖 OpenAI 兼容协议，`core/providers.ts` 提供 6 家预设 + `custom`，见第 11 节 A3 | ✅ |
| ~~无工具生态入口~~ | **已解决**：MCP 客户端（`src/mcp/`），SDK 走动态 import，默认路径依赖不变，见第 11 节 A1 | ✅ |
| ~~无断点续跑 / 无人工审批~~ | **已解决**：运行存档 + `resume()` + `MINIAGENT_APPROVAL_TOOLS`，CLI 与 HTTP 两侧都接了，见第 11 节 A2 | ✅ |
| ~~可观测只能自己看~~ | **已解决**：按 GenAI 语义约定 OTLP/HTTP 导出 span 与指标，见第 11 节 A4 | ✅ |
| ~~只有整段响应~~ | **已解决**：token 级流式（SSE 解析 + tool_calls 分片累积 + 前端实时文本），见第 11 节 A5 | ✅ |
| OTLP 未过真实 collector | 已验证报文符合 OTLP/JSON 结构，但没接过 Jaeger/Tempo；只支持 JSON 编码（未实现 protobuf） | 中 |
| 运行存档是单机文件 | 跨实例共享未完成运行需要共享卷或另加后端（`checkpointDir` 目前是本地路径） | 中 |
| 提示词里的轮次口径与配置脱节 | `principles@1.1.0` 写死「整个会话最多调用 8 次工具」，实际是 `MINIAGENT_MAX_ITERATIONS` 的**迭代轮数**（每轮可并发多个工具），且 `AgentContext` 每次 `run()` 新建、每轮提问都重置计数。段文本未与配置联动，改配置后模型会拿到自相矛盾的环境描述 | 低 |
| 采样参数不可配 | 请求体不发 `temperature` / `top_p` / `max_tokens` / `stop`，随机性与输出上限全由服务商默认值决定（见 7.1） | 低 |
| `identity` 定位窄于现有能力 | 段固定写「研究助手」，而当前能力已覆盖写脚本执行、自建技能、跑本机命令（见第 4、5 节）；`output_format` 也固定要求「结构化中文回答」，未按提问语言区分 | 低 |

### 子 agent 步骤如何进入父轨迹（原缺口，已按方案 A 解决）

**原现象**：`run_subagent` 内部的工具调用与 LLM 调用不出现在父 agent 的 JSONL 轨迹里。
父侧只能从工具返回值拿到子 agent 的 `iterations` 与 `tokens`——**成本可见，步骤不可见**。

**根因**：server 的事件总线是**按请求创建**的（避免并发请求的事件互相串台，同时也是 SSE 转发的载体），
而 `ToolRegistry` 在**进程启动时**就构建好了。工具在注册时捕获的闭包里没有"当次请求的 bus"，
所以子 agent 只能自建一条总线，它的事件没有订阅者。

**已实施（方案 A）**：

1. `core/events.ts` 增加 `toolScopeStorage`（`AsyncLocalStorage<ToolScope>`）与 `currentToolScope()`；
2. `ToolRuntime.runOne` 在调用工具前 `toolScopeStorage.run({ bus, runId }, ...)` 注入当次作用域；
3. `subagent.ts` 的 `bridgeToParent()` 把子总线的事件**中继**到父总线。

两个容易踩的点，实现时都做了处理：

- **事件必须挂父 runId**：`Tracer` 按 `event.runId` 决定写哪个文件，沿用子 runId 只会多出一个孤立轨迹文件，等于没打通。
  子 runId 作为 payload 里的 `sub_run_id` 保留，`from_subagent: true` 作为标记——轨迹回放据此打 `↳`。
- **中继不会成环**：只有子 → 父单向中继，父总线上的订阅者（Tracer / Metrics / SSE）不再向子总线回传。

**顺带修好的**：`/metrics` 现在也统计子 agent 内部的调用次数与耗时（此前完全不计）。

**实测**（`npm run trace:replay` 一条真实运行的轨迹），修好前后父轨迹的差别：

| | 修前 | 修后 |
|---|---|---|
| 父轨迹能看到 | `run_subagent 1✔ · 61.88s` | 上述一行 **+ 子 agent 的 6 轮模型调用、12 次 `search_knowledge`（其中 4 次失败）、1 次 `read_file` 失败** |
| token 归属 | 只有父的 8104+1357 | 另单独列出子 agent 的 31777+3871 |

这正是「步骤不可见」的实际代价：修前完全看不出子 agent 那一刻在反复重试失败的工具、以及它吃掉了 4 倍于父的 token。

## 11. 与市场主流框架的对齐（2026-09-25 补强）

一次与市场主流框架（LangGraph / CrewAI / Microsoft Agent Framework 1.0 / OpenAI Agents SDK /
Mastra / Vercel AI SDK / Google ADK）的逐项比对，把差异分成**真实缺口（A）**与**定位差异（B）**。
A 类逐项补齐，B 类逐项判断跟进与否。**完整判断依据与取舍见
[能力差距收敛与市场适配评估](../../designs/2026-09-25-能力差距收敛与市场适配评估.md)**，此处只留结论与落点。

### A 类：真实缺口（已全部补齐）

| 项 | 落点 | 关键设计决定 |
|---|---|---|
| **A1 MCP 客户端** | `src/mcp/` + `mcp.example.json` | 远程工具注册为 `mcp__<server>__<tool>` 避免撞名；SDK 走**动态 import**，没配 `mcp.json` 就完全不加载（它拖进 79 个包）；文档明确标注 MCP 工具**不受 workspace 沙箱约束** |
| **A2 运行存档 / 断点续跑 / 人工审批** | `src/agent/checkpoint.ts` + `agent.ts` 的 `loop/resume` | 稳定点选在「一批工具结果全部回灌之后」；`ctx.iterations++` 必须在落盘前（存档记的是已完成轮数）；审批以**整批**为单位停下；决定先落盘再读存档；成功即删档 |
| **A3 多 provider** | `src/llm/openai.ts` + `src/core/providers.ts` | 只依赖 OpenAI 兼容协议，预设只提供「接入点 + 默认模型名」；旧变量 `MINIAGENT_DEEPSEEK_API_KEY` 继续可用；未知 provider / 缺 baseUrl / 缺模型名在**启动时**报错 |
| **A4 OTel 导出** | `src/observability/otel.ts` | **手写 OTLP/JSON 编码，不引 SDK**（同「零框架」原则）；子 agent 中继事件按 `from_subagent` 跳过 run 级事件，否则会顶掉父的根 span；导出失败只记警告；长跑进程有定时上报（`unref()`） |
| **A5 token 级流式** | `client.chatStream()` + `StreamAccumulator` + `llm_delta` 事件 + 前端实时文本 | 按空行切事件、尾部分片留给下一 chunk、`\r\n` 归一化；tool_calls 按 index 累积（下标会跳跃）；**已吐片段后不重试**；流式增量**不落盘**（完整文本在 `llm_end` 里已有） |

### B 类：定位差异

| 项 | 决策 | 落点 / 理由 |
|---|---|---|
| **B1 编排模型** | **部分跟进**：角色化 + 并行派发 | `src/prompts/roles.ts`（researcher / analyst / critic，各带提示词 + **工具白名单**）、`run_subagents`（2-5 个互不依赖的子任务并发，失败互相隔离）。**不跟进图编排与分布式**：单机单进程场景用不到，代价是丢掉"读一遍源码就能改" |
| **B2 交付形态** | **部分跟进**：指标 OTLP 导出 + 会话可搬运 | 指标同时以 Prometheus 文本与 OTLP 暴露，多实例在 collector 侧汇总；`GET /api/sessions/:id/export` + `POST /api/sessions/import`（默认拒绝覆盖，`overwrite=true` 显式重建；导入按系统边界逐条校验） |
| **B3 生态依赖** | **保留，不优化** | 核心依赖只有 zod + zod-to-json-schema；LanceDB / transformers.js / MCP SDK 都是「只引类型 + 动态 import()」的可选依赖。这是可验证的优势而非缺口 |
| **B4 handoff / 辩论式多 agent** | **暂不跟进** | 与「隔离式委派」是两种范式：handoff 适合对话式前台，隔离委派适合探索式后台。混用会同时丢掉两者的好处——要做应当作为**独立编排模式**引入 |
| **B5 自动护栏** | **暂不跟进** | 已有 `MINIAGENT_APPROVAL_TOOLS` 这条人工闸门；自动护栏的价值高度依赖具体合规要求，需要的人在工具层包一层即可，不必进内核 |

### 角色化为什么不只是"换个语气"

角色 = **一段提示词** + **一份工具白名单**，白名单是硬约束：复核员拿不到 `write_file`。
且白名单**严格生效**——刻意不做「一个都不匹配就退回全量」的兜底，那等于在配置错位时
悄悄把写权限交回给本该只读的角色。

提示词注入方式是「在身份段之后插一段」：**没有角色时段与版本号完全不变**，
既有快照与 eval 归因不受影响；只有选了角色才会多出 `role_critic@1.0.0` 这样的段。

## 实施顺序

| 阶段 | 内容 | 完成标志 | 状态 |
|---|---|---|---|
| 一 | 骨架 + core + DeepSeek + Tool/Runtime + Agent 循环 + CLI | CLI 跑通研究任务，测试通过 | ✅ |
| 二 | Skills + Memory + PromptBuilder | 技能按需加载、长对话摘要 | ✅ |
| 三 | Eval + 裁判 + lint/CI | 评测报告量化回归 | ✅ |
| 四 | HTTP/SSE + Docker + trace/metrics | 容器化部署，指标可查 | ✅ 容器化未经实际构建验证 |
| 五 | 市场对齐补强（第 11 节）：MCP / 断点续跑与审批 / 多 provider / OTLP / token 级流式 / 角色化与并行子 agent | 320 个测试通过；真实模型验证流式与 MCP 调用 | ✅ OTLP 未过真实 collector |
