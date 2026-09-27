# UI 配置菜单与沙盒开关设计

日期：2026-09-27
状态：设计已确认，待评审
关联：[MiniAgent 框架设计（v1）](./2026-09-23-miniagent-design.md)

## 1. 需求

在 Web 控制台（`public/`）增加一个**配置菜单**，让用户不登服务器、不改 `.env` 文件，就能：

1. **查看**当前的关键运行配置；
2. **修改并保存**这些配置；
3. **一键切换执行权限档位**（UI 上的「沙盒模式」开关）；
4. 改完通过 **GitHub push → CI 自动部署** 同步到服务器并重启服务。

### 1.1 「沙盒模式」的语义澄清

项目里**没有**名为「沙盒模式」的开关。现有的执行约束有两层，必须分清：

| 层 | 实现 | 约束对象 | 是否本次可控 |
|---|---|---|---|
| 文件沙箱 | `registerFileTools` 把 `read_file`/`write_file` 关在 `resolve(workspace)` 内，`resolveWithin` 用 `root + sep` 前缀校验防路径穿越 | 文件工具 | 是（改 `workspace`） |
| 命令执行档位 | `MINIAGENT_POWERSHELL_MODE` = `off` / `readonly` / `full` | `powershell` 工具 | 是（UI 开关） |

`powershell` 工具**没有沙箱**——子进程权限等于本进程权限，档位是唯一约束手段。

**UI 开关语义（已与用户确认）**：

- 关 = `off`（不注册 `powershell` 工具）
- 开 = `full`（不限制）

`readonly`（默认档，只读 cmdlet 白名单）是第三态，二值开关表达不了。处理方式（已确认）：

- 开关状态判定 = `powershellMode === "full"`；
- 当前若为 `readonly`，开关显示为**关**，旁边灰字标注「当前为 readonly（只读白名单，非开关状态）」；
- 保存时按开关状态写 `full` / `off`，即**会覆盖 `readonly`**。

## 2. 关键约束（设计前提）

这些是读源码后确认的事实，决定了方案形状：

1. **`settings` 是活引用**：`Agent` 与 `OpenAICompatibleClient` 都在构造时持有 `settings` 对象引用，每次请求实时读 `this.settings.*`（`model`、`apiKey`、`maxIterations`、`streamEnabled`、`approvalTools` 等）。
   → **原地 mutate `settings` 即可让所有后续运行即时生效**，无需重建 Agent 或 `ServerDeps`。
2. **工具注册状态是启动时固定的**：`powershell` 的档位、文件工具的 `workspace` 根目录都被**闭包捕获**在 handler 里。
   → 这两项的变更**必须重新注册工具**，`settings` 原地改无效。
3. **`registerPowershell` 在 `off` 档直接 return**：`off` 时工具根本不在 registry 里。
   → `off → full` 是「新增注册」，`full → off` 是「移除」。registry 目前**没有删除能力**。
4. **子 agent 自动跟随**：`childRegistryOf(registry, role)` 每次构造子 registry 时遍历父 registry 的当前内容。
   → 父 registry 增删会自动反映到子 agent，无需额外处理。
5. **`.env` 有大量注释与顺序**：`.env` 是手写维护的，含注释行与注释态的键（如 `# MINIAGENT_APPROVAL_TOOLS=powershell`）。
   → 写回必须**保留注释与顺序**，不能整文件重写。
6. **启动强校验**：`loadSettings()` 末尾对 `baseUrl` / `model` 非空有硬校验，`MINIAGENT_POWERSHELL_MODE` 非法值直接抛错。
   → 保存前必须做同等校验，否则下次重启会起不来。
7. **服务器不能编译**：README 明确轻量环境（`npm ci --omit=dev --omit=optional`）下 `tsc` 会因缺 `vector.ts` 的类型依赖报 TS2307。
   → 部署必须是「CI 完整环境编译出 `dist/` + rsync 产物」，服务器不跑 `tsc`。
8. **演示实例公网无鉴权**：README 已写明在线实例未加鉴权。
   → 配置接口能改 `powershellMode = full`，等于开放远程 RCE，**必须鉴权**。

## 3. 方案

### 3.1 配置元数据单一事实来源

新建 `src/core/configSchema.ts`，用**元数据数组**描述「哪些配置可被 UI 编辑、如何校验、如何渲染」。

每项的字段：

```ts
interface ConfigField {
  key: keyof Settings;          // settings 上的字段名，原地写回的依据
  env: string;                  // 环境变量名（含 MINIAGENT_ 前缀）
  group: "model" | "runtime" | "sandbox" | "files" | "approval";
  label: string;                // 中文标签
  type: "string" | "number" | "boolean" | "list" | "secret" | "powershellMode";
  description?: string;
  secret?: boolean;             // 敏感值：不回传明文
  restartRequired?: boolean;    // 是否需要重启（本设计里应为空——全部即时生效）
  min?: number;                 // number 类型的下界
  max?: number;
}
```

**可编辑范围（常用子集）**：

| 分组 | 字段 | 环境变量 | 类型 |
|---|---|---|---|
| model | provider | `MINIAGENT_PROVIDER` | string |
| model | model | `MINIAGENT_MODEL` | string |
| model | baseUrl | `MINIAGENT_BASE_URL` | string |
| model | apiKey | `MINIAGENT_API_KEY` | secret |
| runtime | maxIterations | `MINIAGENT_MAX_ITERATIONS` | number |
| runtime | planMode | `MINIAGENT_PLAN_MODE` | boolean |
| runtime | streamEnabled | `MINIAGENT_STREAM_ENABLED` | boolean |
| runtime | requestTimeout | `MINIAGENT_REQUEST_TIMEOUT` | number |
| runtime | toolTimeout | `MINIAGENT_TOOL_TIMEOUT` | number |
| runtime | maxConcurrency | `MINIAGENT_MAX_CONCURRENCY` | number |
| sandbox | powershellMode | `MINIAGENT_POWERSHELL_MODE` | powershellMode |
| files | workspace | `MINIAGENT_WORKSPACE` | string |
| approval | approvalTools | `MINIAGENT_APPROVAL_TOOLS` | list |

`memoryMaxTokens` 是**推导值**（未显式配置时按 `modelContextTokens × memoryBudgetRatio` 算），不进表单。

后端 `GET /api/config` 下发 schema + 当前值，**前端完全按 schema 动态渲染**，不在前端硬编码任何字段名。

### 3.2 `.env` 原地写回

在 `src/core/config.ts` 增加纯函数（可独立单测）：

```ts
/** 逐行改写 .env：命中已生效的键→替换该行；命中注释态的键→在其后插入生效行；都不命中→追加到末尾 */
export function writeEnvValues(
  content: string,
  updates: Record<string, string>,
): string;
```

规则：

- **保留注释与顺序**，只动目标行；
- 键已存在且生效（`KEY=...`）→ 替换该行值；
- 键以注释态存在（`# KEY=...`）→ 在**该行之后**插入 `KEY=新值`，注释保留；
- 键不存在 → 追加到文件末尾；
- **值里的 `=`、`,`、`#`、空格不需要转义**——`.env` 解析（`readString`/`readList`/`readPairs`）只按第一个 `=` 切分，`readList` 按 `,` 切分，`readPairs` 按 `,` 切分再按首个 `=` 切分。写入时**不加引号**，与现有文件风格一致。
- 值含换行的输入在 API 层就被拒绝（见 3.3 校验）。

配套一个读写入口（非纯函数，落盘用）：读取 `.env` → `writeEnvValues` → 原子写（写临时文件后 rename，避免写一半进程被杀导致 `.env` 损坏）。

**存量键的兼容处理**：当前 `.env` 用的是旧变量名 `MINIAGENT_DEEPSEEK_API_KEY`，而 `loadSettings` 读的是 `readString("MINIAGENT_API_KEY", readString("MINIAGENT_DEEPSEEK_API_KEY", ""))`——即新名优先。因此：

- UI 首次保存 `apiKey` 会在文件里**追加** `MINIAGENT_API_KEY=...`（不删除旧的 `MINIAGENT_DEEPSEEK_API_KEY`），生效值以新名为准；
- `GET /api/config` **直接读内存里的 `settings` 对象**（`loadSettings` 已完成优先级解析，`settings.apiKey` 就是生效值），不要另写一套变量名探测逻辑——那样必然与 `loadSettings` 漂移。
- 保存后仍写新变量名（`MINIAGENT_API_KEY` / `MINIAGENT_BASE_URL`），于是重启后的解析结果与保存时的内存值一致。

### 3.3 后端接口

在 `src/server/server.ts` 新增两条路由。

**`GET /api/config`**

- 鉴权（见 3.4）。
- 返回：
  ```json
  {
    "schema": [ /* ConfigField 数组 */ ],
    "values": { "provider": "deepseek", "model": "deepseek-flash", ...,
                "apiKeySet": true, "apiKeyMask": "sk-d02***c52b" },
    "readonlyModeNote": "当前为 readonly（只读白名单，非开关状态）"
  }
  ```
- **绝不回传 API Key 明文**：`apiKey` 只回传 `apiKeySet`（布尔）与 `apiKeyMask`（前后各留 4 位）。
- `readonlyModeNote` 仅在 `powershellMode === "readonly"` 时非空，供前端显示灰字。

**`PUT /api/config`**

- 鉴权（见 3.4）。
- 请求体：`{ "values": { "model": "...", "powershellMode": "off", ... } }`，只提交要改的项。
- **前端只提交与「打开面板时的初值」不同的项**。这条不是可选优化：若用户只是打开面板看一眼就点保存，把 `readonly` 位置上的开关（显示为关）当成 `off` 提交，会静默降级掉只读白名单。
- 流程：
  1. **逐项校验**（类型、`number` 的 `min`/`max`、`powershellMode` 只认三值、不含换行、`baseUrl`/`model` 非空）——任一项不过返回 `400`，附字段级错误信息，**不做部分写入**；
  2. `apiKey` 字段**留空或缺失表示保持原值**（前端不回填明文，用户不填就不动）；
  3. **写 `.env`**（原子写）；
  4. **原地 mutate `settings`**：数值项 `Number()`，布尔项直传，`list` 项按 `,` 切分去空白，`powershellMode` 直传；
  5. **精准重注册受影响的工具**；
  6. 返回 `{ "ok": true, "applied": ["model", "powershellMode"], "restartRequired": [] }`。
- 失败语义：写 `.env` 失败 → `500` 且不改内存；校验失败 → `400` 且两者都不改（校验在写之前）。

**重注册逻辑**（抽成函数，供保存流程复用）：

```ts
async function reapplyTools(registry: ToolRegistry, settings: Settings, changed: Set<string>): Promise<void> {
  if (changed.has("powershellMode")) {
    registry.unregister(POWERSHELL_TOOL_NAME);
    await registerPowershell(registry, settings);   // off 档内部 return，即"只删不建"
  }
  if (changed.has("workspace")) {
    registry.unregister("read_file");
    registry.unregister("write_file");
    await registerFileTools(registry, settings.workspace);
    await registerPowershell(registry, settings);   // powershell 的 cwd 也绑定 workspace
  }
}
```

> 注意：`registerPowershell` 内部 `await mkdir(cwd)`，且 cwd 取 `settings.workspace`，所以 `workspace` 变化时 powershell 也必须重注册（即使档位没变）。`unregister` 对不存在的键应为 no-op，避免「off 档下 workspace 变化」时抛错。

### 3.4 鉴权

- 新增环境变量 `MINIAGENT_ADMIN_TOKEN`。
- **未配置** → `/api/config` 的 GET 与 PUT 一律 **403**，响应体说明「未配置管理令牌，配置接口已禁用」。
- **已配置** → 读请求头 `X-Admin-Token`，与令牌做 **`timingSafeEqual`**（等长前置检查）比对；不匹配或缺失 → **401**。
- 前端把令牌存 `localStorage`，请求时带 `X-Admin-Token`。
- 理由：配置接口能写 `.env` 并把 `powershellMode` 切成 `full`，等于远程 RCE；而现有演示实例公网且无鉴权。

### 3.5 前端配置菜单

改 `public/index.html` + `public/app.js`。

**入口**：`topbar-right` 里 `.model-badge` 旁加一个「配置」按钮（齿轮图标），点击展开面板。复用现有历史面板的「点击外部收起」模式。

**面板内容**（全部由 `GET /api/config` 的 schema 驱动渲染）：

- 首次打开时按分组渲染表单（model / runtime / sandbox / files / approval）；
- 类型映射：`string`→text、`number`→number、`boolean`→checkbox、`list`→text（逗号分隔）、`secret`→password（placeholder 显示掩码，留空表示不改）、`powershellMode`→开关；
- **沙盒开关**：勾选态 = `powershellMode === "full"`；若当前是 `readonly`，开关为未勾选且下方显示灰字 `readonlyModeNote`；
- 令牌输入框（password），存 `localStorage`；
- 「保存」按钮 → `PUT /api/config`，按返回的 `applied` 提示；`403`/`401` 时提示去配置令牌。

**不改动**：消息流、SSE、历史面板、现有的 `#input` / `#sendBtn` 逻辑。

### 3.6 CI 自动部署

改 `.github/workflows/ci.yml`。

现有 job `verify`（matrix node 22/24：`npm ci` → `typecheck` → `lint` → `test`）保留不动，新增两个 job：

**`build`**（`needs: verify`，仅 `push` 到 `main` 时跑）：

- 完整环境 `npm ci`（含 optional 依赖，保证 `tsc` 不缺类型）→ `npm run build`；
- `actions/upload-artifact` 上传 `dist/`。

**`deploy`**（`needs: build`，仅 `push` 到 `main` 时跑）：

- 从 artifact 取回 `dist/`；
- **两次 rsync 到服务器** `47.104.106.151`：
  1. **代码与产物**：同步 `public/`、`skills/`、`package.json`、`package-lock.json`（从仓库 checkout 拿）；
  2. **编译产物**：单独同步 `dist/`，**这两次都不加 `--delete`**；
- **`--exclude` 保护**（两次 rsync 都加）：`.env`、`node_modules/`、`knowledge/`、`memory/`、`history/`、`traces/`、`workspace/`、`vector-db/`、`checkpoints/`、`.cache/`、`models/`；
- **不加 `--delete`**（保护服务器上的运行时数据）；代价是远端 `dist/` 可能残留已删除源文件对应的旧 `.js`——本规模下可接受，需要时手动清理；
- 远端执行：`npm ci --omit=dev --omit=optional` → `systemctl restart $SERVICE_NAME`；
- **Secrets 未配置时 step 级 `if` 跳过**，不阻塞主干 CI。

**Secrets 清单**（用户后配）：

| Secret | 用途 |
|---|---|
| `SSH_HOST` | 服务器地址（约定 `47.104.106.151`） |
| `SSH_USER` | 登录用户 |
| `SSH_PRIVATE_KEY` | 私钥 |
| `SSH_PORT` | SSH 端口 |
| `DEPLOY_PATH` | 部署目录 |
| `SERVICE_NAME` | systemd 服务名 |

### 3.7 `.env.example` 补充

新增 `MINIAGENT_ADMIN_TOKEN` 的说明段：用途、未配置则配置接口禁用、建议长随机串。

## 4. 改动清单

| 文件 | 改动 |
|---|---|
| `src/core/configSchema.ts` | **新建**：ConfigField 元数据数组（配置的可编辑范围的单一事实来源） |
| `src/core/config.ts` | 增加 `writeEnvValues` 纯函数 + `.env` 原子写入口 |
| `src/tools/registry.ts` | 增加 `unregister(name)`（不存在则 no-op） |
| `src/server/server.ts` | 增加 `GET /api/config`、`PUT /api/config` 路由；`MINIAGENT_ADMIN_TOKEN` 鉴权；`reapplyTools` 重注册函数；`Settings` 接口加 `adminToken` 字段 |
| `src/tools/builtins/index.ts` | 无改动（重注册直接调用 `registerPowershell` / `registerFileTools`） |
| `public/index.html` | `topbar-right` 加「配置」按钮与配置面板容器 |
| `public/app.js` | schema 驱动渲染、令牌存取、GET/PUT 调用、保存提示、readonly 灰字 |
| `.env.example` | 补充 `MINIAGENT_ADMIN_TOKEN` 说明 |
| `.github/workflows/ci.yml` | 新增 `build` + `deploy` job（服务器 `47.104.106.151`） |
| `tests/` | 新增/扩展测试（见下） |

## 5. 测试

| 用例 | 断言 |
|---|---|
| `.env` 写回：覆盖已有键 | 该行值被替换，其余行与注释原样 |
| `.env` 写回：注释键激活 | `# KEY=old` 之后出现 `KEY=new`，注释行保留 |
| `.env` 写回：新增键 | 追加到文件末尾 |
| `.env` 写回：值含 `=` 与 `,` | 往返一致（写后 `readList`/`readString` 读回同值） |
| 鉴权三态 | 未配 token → 403；配了但请求头错/缺 → 401；正确 → 200 |
| `apiKey` 保密 | `GET /api/config` 响应体不含明文 key，只有 `apiKeySet` + 掩码 |
| 改 `powershellMode` | `off`→`full` 后 `registry.has("powershell") === true`；`full`→`off` 后为 `false` |
| 改 `workspace` | 文件工具落在新根目录（写入新根内文件成功，越界仍被拒） |
| 校验失败 | 非法 `powershellMode` / 越界 number → 400，且 `.env` 与 `settings` 均未变 |
| 即时生效 | 改 `model` 后同一进程内发起 chat，请求体用的是新 model |

测试沿用 `tests/server.test.ts` 现有的 `createRequestHandler(deps)` + 临时端口 + `FakeLLM` 驱动方式。

## 6. 非目标

- 不做配置项的完整覆盖（只做常用子集）。
- 不做多用户 / 角色权限（单一管理令牌）。
- 不改前端框架（继续零框架）。
- 不做配置变更审计日志。
- 不引入自动回滚（保存后若服务起不来由用户手动改回，`.env` 内容始终可读可改）。

## 7. 安全提示

`powershellMode = full` + `approvalTools` 不含 `powershell` = 无限制远程命令执行。建议：

- 生产/公网实例保持 `powershellMode = off` 或 `readonly`；
- 必须开 `full` 时，同时把 `powershell` 加进 `MINIAGENT_APPROVAL_TOOLS`；
- `MINIAGENT_ADMIN_TOKEN` 用足够长的随机串，不要与 API Key 复用。
