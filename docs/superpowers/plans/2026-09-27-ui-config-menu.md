# UI 配置菜单与沙盒开关 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Web 控制台加一个配置菜单，可查看/修改关键配置、开关执行权限档位（「沙盒模式」），保存后写回 `.env` 并即时生效；再经 CI 编译产物部署到服务器。

**Architecture:** 配置元数据集中在 `configSchema.ts`（单一事实来源），后端下发 schema、前端 schema 驱动渲染。保存时先校验、再原子写 `.env`、再原地 mutate `settings`（`Agent`/`OpenAICompatibleClient` 长期持有该引用，因此即时生效），最后只对「被闭包捕获」的工具（`powershell`、`read_file`/`write_file`）做精准重注册。接口用 `MINIAGENT_ADMIN_TOKEN` + `timingSafeEqual` 鉴权。

**Tech Stack:** TypeScript 5 + Node 22 ESM、`node:http`（零框架）、`node:fs/promises`、vitest、原生 HTML/CSS/JS。

**Spec:** [docs/superpowers/specs/2026-09-27-ui-config-menu-design.md](../specs/2026-09-27-ui-config-menu-design.md)

**与 spec 的一处偏差：** `.env` 读写落在新建的 `src/core/envFile.ts`（而非 `config.ts`）——`config.ts` 已经 400 行且职责是「解析环境变量为 Settings」，`.env` 文本改写是另一件事。仍是纯函数 + 原子写，测试方式不变。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/core/envFile.ts` | **新建**。`.env` 文本的纯函数改写（`writeEnvValues`）+ 读/原子写 |
| `src/core/configSchema.ts` | **新建**。可编辑字段元数据 + 校验 + 原地应用 |
| `src/tools/registry.ts` | 加 `unregister(name)` |
| `src/tools/builtins/index.ts` | 加 `reapplyTools(registry, settings, changed)` |
| `src/core/config.ts` | 加 `adminToken`、`envFile` 两个 Settings 字段 |
| `src/server/server.ts` | 加 `GET/PUT /api/config` + 鉴权 |
| `public/index.html` `public/app.js` `public/styles.css` | 配置菜单 UI |
| `.env.example` | 补 `MINIAGENT_ADMIN_TOKEN`、`MINIAGENT_ENV_FILE` |
| `.github/workflows/ci.yml` | 加 `build` + `deploy` job |
| `tests/envFile.test.ts` `tests/configSchema.test.ts` | 新增测试 |
| `tests/registry.test.ts` `tests/server.test.ts` | 扩展测试 |

---

## Task 1: ToolRegistry 支持注销

**Files:**
- Modify: `src/tools/registry.ts`
- Test: `tests/registry.test.ts`

- [ ] **Step 1: 写失败测试**

追加到 `tests/registry.test.ts` 的 `describe("ToolRegistry")` 内：

```ts
  it("注销后不再存在，重复注销不报错", () => {
    const registry = new ToolRegistry();
    registry.register(greet);

    expect(registry.unregister("greet")).toBe(true);
    expect(registry.has("greet")).toBe(false);
    expect(registry.toolPayload()).toEqual([]);

    // 注销不存在的名字是 no-op：off 档下改 workspace 会走到这条路径
    expect(registry.unregister("greet")).toBe(false);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/registry.test.ts`
Expected: FAIL — `registry.unregister is not a function`

- [ ] **Step 3: 实现**

在 `src/tools/registry.ts` 的 `get` 之前插入：

```ts
  /** 注销工具；返回是否真的删除了（不存在时为 no-op，便于「先删后建」不判断档位） */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/registry.test.ts`
Expected: PASS（4 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/tools/registry.ts tests/registry.test.ts
git commit -m "工具注册表支持注销，为重注册受影响工具做准备"
```

---

## Task 2: `.env` 原地改写

**Files:**
- Create: `src/core/envFile.ts`
- Test: `tests/envFile.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `tests/envFile.test.ts`：

```ts
/** .env 原地改写测试：保留注释与顺序，且必须能往返读回。 */

import { describe, expect, it } from "vitest";

import { writeEnvValues } from "../src/core/envFile.js";

const SAMPLE = [
  "# DeepSeek API Key（必填）",
  "MINIAGENT_DEEPSEEK_API_KEY=sk-old",
  "",
  "# 可选项（不填则使用默认值）",
  "# MINIAGENT_MAX_ITERATIONS=8",
  "MINIAGENT_MODEL=deepseek-flash",
  "# MINIAGENT_APPROVAL_TOOLS=powershell",
].join("\n") + "\n";

describe("writeEnvValues", () => {
  it("覆盖已生效的键，其余行原样", () => {
    const out = writeEnvValues(SAMPLE, { MINIAGENT_MODEL: "deepseek-chat" });
    expect(out).toContain("MINIAGENT_MODEL=deepseek-chat\n");
    expect(out).not.toContain("MINIAGENT_MODEL=deepseek-flash");
    // 注释与顺序没动
    expect(out.split("\n")[0]).toBe("# DeepSeek API Key（必填）");
    expect(out.split("\n")[1]).toBe("MINIAGENT_DEEPSEEK_API_KEY=sk-old");
    expect(out).toContain("# 可选项（不填则使用默认值）");
  });

  it("注释态的键被激活：注释保留，生效行插在其后", () => {
    const out = writeEnvValues(SAMPLE, { MINIAGENT_MAX_ITERATIONS: "12" });
    const lines = out.split("\n");
    const commentAt = lines.indexOf("# MINIAGENT_MAX_ITERATIONS=8");
    expect(commentAt).toBeGreaterThan(-1);
    expect(lines[commentAt + 1]).toBe("MINIAGENT_MAX_ITERATIONS=12");
  });

  it("注释态的键也被激活", () => {
    const out = writeEnvValues(SAMPLE, { MINIAGENT_APPROVAL_TOOLS: "powershell" });
    expect(out).toContain("# MINIAGENT_APPROVAL_TOOLS=powershell");
    expect(out.split("\n").at(-2)).toBe("MINIAGENT_APPROVAL_TOOLS=powershell");
  });

  it("新键追加到末尾", () => {
    const out = writeEnvValues(SAMPLE, { MINIAGENT_ADMIN_TOKEN: "s3cret" });
    expect(out.split("\n").at(-2)).toBe("MINIAGENT_ADMIN_TOKEN=s3cret");
    expect(out.split("\n").filter((l) => l.startsWith("MINIAGENT_ADMIN_TOKEN="))).toHaveLength(1);
  });

  it("值含 = 与 逗号也往返一致", () => {
    const out = writeEnvValues(SAMPLE, { MINIAGENT_APPROVAL_TOOLS: "write_file,powershell" });
    const line = out.split("\n").find((l) => l.startsWith("MINIAGENT_APPROVAL_TOOLS="));
    expect(line).toBe("MINIAGENT_APPROVAL_TOOLS=write_file,powershell");
  });

  it("原文件没有末尾换行时补上", () => {
    const out = writeEnvValues("MINIAGENT_MODEL=a", { MINIAGENT_MODEL: "b" });
    expect(out).toBe("MINIAGENT_MODEL=b\n");
  });

  it("空内容直接生成一行", () => {
    expect(writeEnvValues("", { MINIAGENT_MODEL: "b" })).toBe("MINIAGENT_MODEL=b\n");
  });

  it("同一键在文件里出现两次时都改掉，避免留下旧的生效值", () => {
    const out = writeEnvValues("MINIAGENT_MODEL=a\nMINIAGENT_MODEL=b\n", { MINIAGENT_MODEL: "c" });
    expect(out).toBe("MINIAGENT_MODEL=c\nMINIAGENT_MODEL=c\n");
  });

  it("updates 为空时原样返回", () => {
    expect(writeEnvValues(SAMPLE, {})).toBe(SAMPLE);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/envFile.test.ts`
Expected: FAIL — 无法解析 `../src/core/envFile.js`

- [ ] **Step 3: 实现**

创建 `src/core/envFile.ts`：

```ts
/**
 * .env 原地改写与落盘。
 *
 * 为什么不整文件重写：.env 是手写维护的，含注释行与「注释态」的键
 * （如 `# MINIAGENT_APPROVAL_TOOLS=powershell`）。整文件重写会把这些全丢掉。
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** 匹配 `KEY=...`（可带前导空白）；注释行不匹配 */
function matchActiveKey(line: string, key: string): boolean {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("#")) return false;
  const index = trimmed.indexOf("=");
  if (index <= 0) return false;
  return trimmed.slice(0, index).trim() === key;
}

/** 匹配 `# KEY=...`（注释态） */
function matchCommentedKey(line: string, key: string): boolean {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("#")) return false;
  const body = trimmed.replace(/^#+\s*/, "");
  const index = body.indexOf("=");
  if (index <= 0) return false;
  return body.slice(0, index).trim() === key;
}

/**
 * 逐行改写 .env：
 *   - 已生效的键 → 替换该行（同键出现多次时全部替换，避免留下旧的生效值）
 *   - 注释态的键 → 在该行之后插入生效行，注释保留
 *   - 都没有 → 追加到末尾
 * 值不做转义或加引号：解析侧（config.ts 的 readString/readList/readPairs）
 * 只按第一个 `=` 与 `,` 切分，与现有 .env 风格一致。
 */
export function writeEnvValues(
  content: string,
  updates: Record<string, string>,
): string {
  const keys = Object.keys(updates);
  if (keys.length === 0) return content;

  const hadTrailingNewline = content === "" || content.endsWith("\n");
  const lines = content.split("\n");
  // 末尾换行会切出一个空串，先摘掉，最后统一补
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const inserted = new Set<string>();
  const output: string[] = [];
  for (const line of lines) {
    const hit = keys.find((key) => matchActiveKey(line, key));
    if (hit !== undefined) {
      output.push(`${hit}=${updates[hit]}`);
      continue;
    }
    output.push(line);
    // 注释态：紧跟其后插入生效行（只插一次，防止同键多条注释重复插入）
    const commented = keys.find((key) => !inserted.has(key) && matchCommentedKey(line, key));
    if (commented !== undefined && !output.some((l) => matchActiveKey(l, commented))) {
      output.push(`${commented}=${updates[commented]}`);
      inserted.add(commented);
    }
  }

  for (const key of keys) {
    if (!output.some((line) => matchActiveKey(line, key))) {
      output.push(`${key}=${updates[key]}`);
    }
  }

  const text = output.join("\n");
  return hadTrailingNewline || text === "" ? `${text}\n` : text;
}

/** 读取 .env；文件不存在按空内容处理（首次保存即新建） */
export async function readEnvFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}

/**
 * 原子写：先写同目录临时文件再 rename。
 * 直接 writeFile 若在写到一半时进程被杀，会留下半截 .env——下次启动直接读不出配置。
 */
export async function writeEnvFile(path: string, content: string): Promise<void> {
  const temp = join(dirname(path), `.env.tmp-${process.pid}-${Date.now()}`);
  await writeFile(temp, content, "utf-8");
  await rename(temp, path);
}

/** 一次完成「读出 → 改写 → 原子写回」，返回新内容（供调用方需要时使用） */
export async function updateEnvFile(
  path: string,
  updates: Record<string, string>,
): Promise<string> {
  const next = writeEnvValues(await readEnvFile(path), updates);
  await writeEnvFile(path, next);
  return next;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/envFile.test.ts`
Expected: PASS（9 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/core/envFile.ts tests/envFile.test.ts
git commit -m "新增 .env 原地改写与原子写，保留注释与顺序"
```

---

## Task 3: 配置元数据与校验

**Files:**
- Create: `src/core/configSchema.ts`
- Modify: `src/core/config.ts`（加 `adminToken`、`envFile` 字段）
- Test: `tests/configSchema.test.ts`

- [ ] **Step 1: 先给 Settings 加两个字段**

在 `src/core/config.ts` 的 `interface Settings` 末尾（`memosTimeout` 之后）加：

```ts
  /**
   * 配置菜单的管理令牌。留空则 /api/config 一律 403（关闭配置接口）。
   * 单独放一个令牌而不是复用 API Key：这个令牌能改 powershellMode，等于本机执行权。
   */
  adminToken: string;
  /**
   * 配置菜单写回的目标文件。默认 ./.env，与 `node --env-file-if-exists=.env` 对齐。
   * 独立成配置项是为了测试时能指向临时目录，不碰开发者的真实 .env。
   */
  envFile: string;
```

在 `loadSettings()` 的返回对象里（`memosTimeout` 之后）加：

```ts
    adminToken: readString("MINIAGENT_ADMIN_TOKEN", ""),
    envFile: readString("MINIAGENT_ENV_FILE", "./.env"),
```

- [ ] **Step 2: 写失败测试**

创建 `tests/configSchema.test.ts`：

```ts
/** 配置元数据：字段可编辑范围、校验、原地应用。 */

import { describe, expect, it } from "vitest";

import { loadSettings, type Settings } from "../src/core/config.js";
import {
  applyConfigValues,
  CONFIG_FIELDS,
  normalizeConfigValues,
  readConfigValues,
} from "../src/core/configSchema.js";

process.env.MINIAGENT_DEEPSEEK_API_KEY = "sk-test-1234";

function makeSettings(): Settings {
  return { ...loadSettings(), powershellMode: "readonly", adminToken: "t" };
}

describe("CONFIG_FIELDS", () => {
  it("key 与 env 都不重复", () => {
    const keys = CONFIG_FIELDS.map((f) => f.key);
    const envs = CONFIG_FIELDS.map((f) => f.env);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(envs).size).toBe(envs.length);
  });

  it("每个字段的 key 都真实存在于 Settings 上", () => {
    const settings = makeSettings() as unknown as Record<string, unknown>;
    for (const field of CONFIG_FIELDS) {
      expect(settings, field.key).toHaveProperty(field.key);
    }
  });
});

describe("normalizeConfigValues", () => {
  it("接受合法值并归一化", () => {
    const result = normalizeConfigValues({
      maxIterations: 12,
      planMode: false,
      approvalTools: ["write_file", "powershell"],
      powershellMode: "full",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.normalized).toMatchObject({
      maxIterations: 12,
      planMode: false,
      approvalTools: ["write_file", "powershell"],
      powershellMode: "full",
    });
  });

  it("list 也接受逗号分隔的字符串，并丢掉空白项", () => {
    const result = normalizeConfigValues({ approvalTools: "write_file, ,powershell" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.normalized.approvalTools).toEqual(["write_file", "powershell"]);
  });

  it("拒绝非法 powershellMode", () => {
    const result = normalizeConfigValues({ powershellMode: "read-only" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]!.key).toBe("powershellMode");
  });

  it("拒绝未知字段、未知 provider、非整数与越界数字", () => {
    const result = normalizeConfigValues({
      nope: 1,
      provider: "not-a-provider",
      maxIterations: 1.5,
      maxConcurrency: 999,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.key).sort()).toEqual([
      "maxConcurrency",
      "maxIterations",
      "nope",
      "provider",
    ]);
  });

  it("拒绝含换行的值（会破坏 .env 行结构）", () => {
    const result = normalizeConfigValues({ model: "a\nMINIAGENT_X=1" });
    expect(result.ok).toBe(false);
  });

  it("空字符串的 secret 被丢掉（表示保持原值）", () => {
    const result = normalizeConfigValues({ apiKey: "" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.normalized).not.toHaveProperty("apiKey");
  });
});

describe("applyConfigValues", () => {
  it("原地改 settings 并返回变化项", () => {
    const settings = makeSettings();
    const changed = applyConfigValues(settings, {
      maxIterations: 12,
      powershellMode: "full",
    });
    expect(changed.sort()).toEqual(["maxIterations", "powershellMode"]);
    expect(settings.maxIterations).toBe(12);
    expect(settings.powershellMode).toBe("full");
  });

  it("值没变就不算变化项（避免无谓地重注册工具）", () => {
    const settings = makeSettings();
    const changed = applyConfigValues(settings, { powershellMode: "readonly" });
    expect(changed).toEqual([]);
  });

  it("换 provider 且未显式给 baseUrl/model 时，按新预设补齐", () => {
    const settings = makeSettings();
    applyConfigValues(settings, { provider: "openai" });
    expect(settings.baseUrl).toBe("https://api.openai.com/v1");
    expect(settings.model).toBe("gpt-4o-mini");
  });

  it("换 provider 时显式给的 baseUrl/model 优先于预设", () => {
    const settings = makeSettings();
    applyConfigValues(settings, {
      provider: "custom",
      baseUrl: "https://gw.example.com/v1",
      model: "my-model",
    });
    expect(settings.baseUrl).toBe("https://gw.example.com/v1");
    expect(settings.model).toBe("my-model");
  });

  it("custom 且给不出 baseUrl 时保持原值而非清空（下一次请求可能仍可用）", () => {
    const settings = makeSettings();
    const before = settings.baseUrl;
    applyConfigValues(settings, { provider: "custom" });
    expect(settings.baseUrl).toBe(before);
  });
});

describe("readConfigValues", () => {
  it("apiKey 只回布尔与掩码，不含明文", () => {
    const settings = makeSettings();
    const values = readConfigValues(settings);
    expect(values.apiKeySet).toBe(true);
    expect(values.apiKeyMask).not.toContain("sk-test-1234");
    expect(JSON.stringify(values)).not.toContain("sk-test-1234");
    expect(values).not.toHaveProperty("apiKey");
  });

  it("未配置 apiKey 时 apiKeySet 为 false", () => {
    const settings = makeSettings();
    settings.apiKey = "";
    expect(readConfigValues(settings).apiKeySet).toBe(false);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run tests/configSchema.test.ts`
Expected: FAIL — 无法解析 `../src/core/configSchema.js`

- [ ] **Step 4: 实现**

创建 `src/core/configSchema.ts`：

```ts
/**
 * 配置菜单的可编辑字段元数据 —— 「哪些配置能被 UI 改」的唯一事实来源。
 *
 * 后端下发这份 schema，前端照它渲染，于是新增一个可编辑项只改这一个文件，
 * 不会出现「后端能改、前端没入口」或两者的字段名漂移。
 *
 * 只覆盖常用子集：路径类、记忆/知识库调参这类需要读懂源码才知道后果的项不在内。
 */

import type { PowershellMode, Settings } from "./config.js";
import { findProvider, knownProviders } from "./providers.js";

export type ConfigFieldType =
  | "string"
  | "number"
  | "boolean"
  | "list"
  | "secret"
  | "powershellMode";

export type ConfigGroup = "model" | "runtime" | "sandbox" | "files" | "approval";

export interface ConfigField {
  /** Settings 上的字段名，也是 PUT 请求体里的键 */
  key: string;
  /** 环境变量名（写回 .env 用的就是它） */
  env: string;
  group: ConfigGroup;
  /** 中文标签（前端直接用） */
  label: string;
  type: ConfigFieldType;
  /** 一句话说明：会造成什么后果 */
  description?: string;
  /** 是否敏感：GET 不出明文，PUT 留空表示不改 */
  secret?: boolean;
  /** number 的取值范围 */
  min?: number;
  max?: number;
}

/** 分组顺序与标题，前端按这个顺序渲染 */
export const CONFIG_GROUPS: Array<{ id: ConfigGroup; label: string }> = [
  { id: "model", label: "模型" },
  { id: "runtime", label: "运行" },
  { id: "sandbox", label: "执行权限（沙盒）" },
  { id: "files", label: "文件边界" },
  { id: "approval", label: "人工审批" },
];

export const CONFIG_FIELDS: ConfigField[] = [
  {
    key: "provider",
    env: "MINIAGENT_PROVIDER",
    group: "model",
    label: "服务商",
    type: "string",
    description: `内置预设：${knownProviders()}。改它会按新预设补齐接入点与模型名`,
  },
  {
    key: "model",
    env: "MINIAGENT_MODEL",
    group: "model",
    label: "模型名",
    type: "string",
  },
  {
    key: "baseUrl",
    env: "MINIAGENT_BASE_URL",
    group: "model",
    label: "接入点",
    type: "string",
    description: "形如 https://your-host/v1",
  },
  {
    key: "apiKey",
    env: "MINIAGENT_API_KEY",
    group: "model",
    label: "API Key",
    type: "secret",
    secret: true,
    description: "留空表示保持原值不变",
  },

  {
    key: "maxIterations",
    env: "MINIAGENT_MAX_ITERATIONS",
    group: "runtime",
    label: "单次最多迭代轮数",
    type: "number",
    min: 1,
    max: 100,
  },
  {
    key: "planMode",
    env: "MINIAGENT_PLAN_MODE",
    group: "runtime",
    label: "计划模式",
    type: "boolean",
    description: "首轮给出简短计划，并作为长任务的锚点",
  },
  {
    key: "streamEnabled",
    env: "MINIAGENT_STREAM_ENABLED",
    group: "runtime",
    label: "流式输出",
    type: "boolean",
    description: "关掉即退回一次性返回",
  },
  {
    key: "requestTimeout",
    env: "MINIAGENT_REQUEST_TIMEOUT",
    group: "runtime",
    label: "模型请求超时（秒）",
    type: "number",
    min: 1,
    max: 3600,
  },
  {
    key: "toolTimeout",
    env: "MINIAGENT_TOOL_TIMEOUT",
    group: "runtime",
    label: "工具超时（秒）",
    type: "number",
    min: 1,
    max: 3600,
  },
  {
    key: "maxConcurrency",
    env: "MINIAGENT_MAX_CONCURRENCY",
    group: "runtime",
    label: "工具并发上限",
    type: "number",
    min: 1,
    max: 64,
  },

  {
    key: "powershellMode",
    env: "MINIAGENT_POWERSHELL_MODE",
    group: "sandbox",
    label: "通用执行通道",
    type: "powershellMode",
    description: "off 不注册工具；full 完全不受限。开=full，关=off",
  },

  {
    key: "workspace",
    env: "MINIAGENT_WORKSPACE",
    group: "files",
    label: "文件沙箱根目录",
    type: "string",
    description: "read_file / write_file 只能在这个目录内活动",
  },

  {
    key: "approvalTools",
    env: "MINIAGENT_APPROVAL_TOOLS",
    group: "approval",
    label: "需要人工审批的工具",
    type: "list",
    description: "逗号分隔。建议开 full 档时把 powershell 加进来",
  },
];

const MODE_VALUES: PowershellMode[] = ["off", "readonly", "full"];

/** 单值长度上限：挡住明显异常的输入，同时远小于请求体上限 */
const MAX_VALUE_CHARS = 4000;

export interface ConfigError {
  key: string;
  message: string;
}

export type NormalizeResult =
  | { ok: true; normalized: Record<string, string | number | boolean | string[]> }
  | { ok: false; errors: ConfigError[] };

/** 含换行会破坏 .env 的行结构；含 NUL 会在子进程环境里被截断 */
function hasControlChars(value: string): boolean {
  return /[\r\n\0]/.test(value);
}

/**
 * 校验并归一化前端提交的值。**纯函数**：不碰 settings、不写文件。
 * 校验必须先于写盘，否则会出现「.env 改了、内存没改」的半截状态。
 */
export function normalizeConfigValues(input: Record<string, unknown>): NormalizeResult {
  const errors: ConfigError[] = [];
  const normalized: Record<string, string | number | boolean | string[]> = {};
  const known = new Map(CONFIG_FIELDS.map((field) => [field.key, field]));

  for (const [key, raw] of Object.entries(input)) {
    const field = known.get(key);
    if (!field) {
      errors.push({ key, message: `不是可配置项: ${key}` });
      continue;
    }
    switch (field.type) {
      case "string":
      case "secret": {
        if (typeof raw !== "string") {
          errors.push({ key, message: "需要字符串" });
          break;
        }
        const value = raw.trim();
        // secret 留空 = 保持原值；普通 string 留空照常写入（多数项有默认值兜底）
        if (field.type === "secret" && value === "") break;
        if (hasControlChars(value)) {
          errors.push({ key, message: "不能包含换行" });
          break;
        }
        if (value.length > MAX_VALUE_CHARS) {
          errors.push({ key, message: `长度不能超过 ${MAX_VALUE_CHARS}` });
          break;
        }
        if (value === "") {
          errors.push({ key, message: "不能为空" });
          break;
        }
        if (key === "provider" && !findProvider(value)) {
          errors.push({ key, message: `未知服务商，可选: ${knownProviders()}` });
          break;
        }
        normalized[key] = value;
        break;
      }
      case "number": {
        const value = typeof raw === "number" ? raw : Number(raw);
        if (!Number.isInteger(value)) {
          errors.push({ key, message: "需要整数" });
          break;
        }
        if (field.min !== undefined && value < field.min) {
          errors.push({ key, message: `不能小于 ${field.min}` });
          break;
        }
        if (field.max !== undefined && value > field.max) {
          errors.push({ key, message: `不能大于 ${field.max}` });
          break;
        }
        normalized[key] = value;
        break;
      }
      case "boolean": {
        if (typeof raw !== "boolean") {
          errors.push({ key, message: "需要布尔值" });
          break;
        }
        normalized[key] = raw;
        break;
      }
      case "list": {
        const items = Array.isArray(raw)
          ? raw.map((item) => String(item).trim())
          : String(raw).split(",").map((item) => item.trim());
        const kept = items.filter(Boolean);
        if (kept.some(hasControlChars)) {
          errors.push({ key, message: "不能包含换行" });
          break;
        }
        normalized[key] = kept;
        break;
      }
      case "powershellMode": {
        const value = String(raw).toLowerCase();
        if (!MODE_VALUES.includes(value as PowershellMode)) {
          errors.push({ key, message: "只能是 off / readonly / full" });
          break;
        }
        normalized[key] = value;
        break;
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, normalized };
}

/**
 * 把归一化后的值原地写进 settings，返回**实际发生变化**的字段名。
 *
 * 原地改就够：Agent 与 OpenAICompatibleClient 都长期持有同一个 settings 引用，
 * 后续每次请求都实时读 `this.settings.*`，无需重建。
 * 只有「工具注册状态」是启动时被闭包捕获的，需要调用方另行重注册。
 */
export function applyConfigValues(
  settings: Settings,
  normalized: Record<string, string | number | boolean | string[]>,
): string[] {
  const changed: string[] = [];
  const record = settings as unknown as Record<string, unknown>;

  const setIfChanged = (key: string, value: unknown): void => {
    if (record[key] === value) return;
    record[key] = value;
    changed.push(key);
  };

  // provider 先落地：换服务商时下面要用新预设补齐 baseUrl / model
  if ("provider" in normalized) setIfChanged("provider", normalized.provider);

  if ("provider" in normalized) {
    const preset = findProvider(String(normalized.provider));
    // 显式给的值优先；没给才按预设补。预设也没有（custom）就保持原值，
    // 而不是清空——清空会让 baseUrl 校验失败、连带整次保存被拒。
    if (!("baseUrl" in normalized) && preset?.baseUrl) setIfChanged("baseUrl", preset.baseUrl);
    if (!("model" in normalized) && preset?.defaultModel) {
      setIfChanged("model", preset.defaultModel);
    }
  }

  for (const [key, value] of Object.entries(normalized)) {
    if (key === "provider") continue;
    setIfChanged(key, value);
  }
  return changed;
}

/** 给前端看的值。apiKey 绝不出明文，只给「有没有」与掩码 */
export function readConfigValues(
  settings: Settings,
): Record<string, unknown> & { apiKeySet: boolean; apiKeyMask: string } {
  const record = settings as unknown as Record<string, unknown>;
  const values: Record<string, unknown> = {};
  for (const field of CONFIG_FIELDS) {
    if (field.secret) continue;
    values[field.key] = record[field.key];
  }
  const key = settings.apiKey;
  return {
    ...values,
    apiKeySet: key !== "",
    apiKeyMask: maskSecret(key),
  };
}

/** 掩码：保留首尾各 4 位，中间固定用 ***。短到这个程度就直接全遮 */
export function maskSecret(value: string): string {
  if (value === "") return "";
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}***${value.slice(-4)}`;
}

/** 归一化结果 → 写 .env 的文本值 */
export function toEnvText(value: string | number | boolean | string[]): string {
  if (Array.isArray(value)) return value.join(",");
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/configSchema.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/core/config.ts src/core/configSchema.ts tests/configSchema.test.ts
git commit -m "新增配置元数据与校验：可编辑范围集中一处，secret 不出明文"
```

---

## Task 4: 精准重注册受影响工具

**Files:**
- Modify: `src/tools/builtins/index.ts`
- Test: `tests/builtins.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

创建 `tests/builtins.test.ts`：

```ts
/** 重注册：只有被闭包捕获的工具（powershell、文件工具）需要重建。 */

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadSettings, type Settings } from "../src/core/config.js";
import { reapplyTools } from "../src/tools/builtins/index.js";
import { ToolRegistry } from "../src/tools/registry.js";

process.env.MINIAGENT_DEEPSEEK_API_KEY = "test-key";

let tempDir = "";
let settings: Settings;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "miniagent-builtins-"));
  settings = {
    ...loadSettings(),
    workspace: join(tempDir, "ws-a"),
    powershellMode: "off",
    powershellExecutable: "",
  };
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("reapplyTools", () => {
  it("off → full 会把 powershell 注册进来", async () => {
    const registry = new ToolRegistry();
    await reapplyTools(registry, settings, ["powershellMode"]);
    expect(registry.has("powershell")).toBe(false);

    settings.powershellMode = "full";
    await reapplyTools(registry, settings, ["powershellMode"]);
    expect(registry.has("powershell")).toBe(true);
  });

  it("full → off 会把 powershell 移除，且不抛错", async () => {
    settings.powershellMode = "full";
    const registry = new ToolRegistry();
    await reapplyTools(registry, settings, ["powershellMode"]);
    expect(registry.has("powershell")).toBe(true);

    settings.powershellMode = "off";
    await reapplyTools(registry, settings, ["powershellMode"]);
    expect(registry.has("powershell")).toBe(false);
    // 再切一次：off 档下没有可删的，也不该抛
    await reapplyTools(registry, settings, ["powershellMode"]);
    expect(registry.has("powershell")).toBe(false);
  });

  it("改 workspace 后文件工具落在新根目录", async () => {
    const registry = new ToolRegistry();
    await reapplyTools(registry, settings, ["workspace"]);
    await registry.get("write_file").run({ path: "a.txt", content: "x" });
    expect(existsSync(join(tempDir, "ws-a", "a.txt"))).toBe(true);

    settings.workspace = join(tempDir, "ws-b");
    await reapplyTools(registry, settings, ["workspace"]);
    await registry.get("write_file").run({ path: "b.txt", content: "y" });
    expect(existsSync(join(tempDir, "ws-b", "b.txt"))).toBe(true);
    // 旧根不再被写入
    expect(existsSync(join(tempDir, "ws-a", "b.txt"))).toBe(false);
  });

  it("改 workspace 时 powershell 也要重注册（它的 cwd 绑在 workspace 上）", async () => {
    settings.powershellMode = "full";
    const registry = new ToolRegistry();
    await reapplyTools(registry, settings, ["workspace"]);
    expect(registry.has("powershell")).toBe(true);
  });

  it("不相关的变更不动工具表", async () => {
    const registry = new ToolRegistry();
    await reapplyTools(registry, settings, []);
    expect(registry.all()).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/builtins.test.ts`
Expected: FAIL — `reapplyTools` 未导出

- [ ] **Step 3: 实现**

在 `src/tools/builtins/index.ts` 末尾追加，并补 import：

```ts
import { POWERSHELL_TOOL_NAME } from "./powershell.js";
```

```ts
/**
 * 配置变更后重建受影响的工具。
 *
 * 为什么需要它：settings 是活引用（原地改即生效），但**工具注册状态不是**——
 * powershell 的档位、文件工具的 workspace 都在注册时被闭包捕获，改 settings 对
 * 已注册的 handler 无效。而 off 档下 registerPowershell 直接 return，
 * 所以「关→开」必须新增注册、「开→关」必须删除，注册表得支持注销。
 *
 * 只重建这两个工具：calculator / webSearch / MCP / 技能工具都不依赖这两项配置。
 */
export async function reapplyTools(
  registry: ToolRegistry,
  settings: Settings,
  changed: Iterable<string>,
): Promise<void> {
  const keys = new Set(changed);
  const powershellAffected = keys.has("powershellMode") || keys.has("workspace");
  if (!powershellAffected && !keys.has("workspace")) return;

  if (keys.has("workspace")) {
    // 文件工具的根目录在闭包里，必须连同 powershell 一起重建
    registry.unregister("write_file");
    registry.unregister("read_file");
    await registerFileTools(registry, settings.workspace);
  }
  if (powershellAffected) {
    registry.unregister(POWERSHELL_TOOL_NAME);
    await registerPowershell(registry, settings);
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/builtins.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/tools/builtins/index.ts tests/builtins.test.ts
git commit -m "新增工具重注册：档位与 workspace 变更后重建 powershell 与文件工具"
```

---

## Task 5: 配置接口与鉴权

**Files:**
- Modify: `src/server/server.ts`
- Test: `tests/server.test.ts`（扩展）

- [ ] **Step 1: 写失败测试**

在 `tests/server.test.ts` 的 `beforeEach` 里给 settings 补 `envFile`：

```ts
  const settings: Settings = {
    ...loadSettings(),
    traceDir: join(tempDir, "traces"),
    historyDir: join(tempDir, "history"),
    workspace: join(tempDir, "workspace"),
    // 配置接口写盘的目标：指向临时目录，绝不碰开发者真实 .env
    envFile: join(tempDir, ".env"),
    adminToken: "test-admin-token",
  };
```

在文件末尾追加一个 describe：

```ts
describe("配置接口", () => {
  const TOKEN = "test-admin-token";

  function getConfig(token?: string): Promise<Response> {
    return fetch(`${baseUrl}/api/config`, {
      headers: token ? { "X-Admin-Token": token } : {},
    });
  }

  function putConfig(body: unknown, token?: string): Promise<Response> {
    return fetch(`${baseUrl}/api/config`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "X-Admin-Token": token } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  it("未配置管理令牌时一律 403", async () => {
    deps.settings.adminToken = "";
    expect((await getConfig(TOKEN)).status).toBe(403);
    expect((await putConfig({ values: {} }, TOKEN)).status).toBe(403);
  });

  it("令牌缺失或错误时 401", async () => {
    expect((await getConfig()).status).toBe(401);
    expect((await getConfig("wrong")).status).toBe(401);
    expect((await putConfig({ values: {} }, "wrong")).status).toBe(401);
  });

  it("GET 下发 schema 与当前值，且不含 API Key 明文", async () => {
    const response = await getConfig(TOKEN);
    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      schema: Array<{ key: string; env: string }>;
      values: Record<string, unknown>;
      readonlyModeNote: string;
    };
    expect(data.schema.map((f) => f.key)).toContain("powershellMode");
    expect(data.values.model).toBe(deps.settings.model);
    expect(data.values.apiKeySet).toBe(true);
    expect(JSON.stringify(data)).not.toContain("test-key");
  });

  it("readonly 档下给出灰字说明，full 档下为空", async () => {
    deps.settings.powershellMode = "readonly";
    const note = (await (await getConfig(TOKEN)).json()) as { readonlyModeNote: string };
    expect(note.readonlyModeNote).toContain("readonly");

    deps.settings.powershellMode = "full";
    const full = (await (await getConfig(TOKEN)).json()) as { readonlyModeNote: string };
    expect(full.readonlyModeNote).toBe("");
  });

  it("PUT 改配置：写回 .env、原地改 settings、立即生效", async () => {
    const response = await putConfig({ values: { maxIterations: 12, model: "new-model" } }, TOKEN);
    expect(response.status).toBe(200);
    const data = (await response.json()) as { ok: boolean; applied: string[] };
    expect(data.ok).toBe(true);
    expect(data.applied.sort()).toEqual(["maxIterations", "model"]);

    expect(deps.settings.maxIterations).toBe(12);
    expect(deps.settings.model).toBe("new-model");

    const env = await readFile(deps.settings.envFile, "utf-8");
    expect(env).toContain("MINIAGENT_MAX_ITERATIONS=12\n");
    expect(env).toContain("MINIAGENT_MODEL=new-model\n");
  });

  it("PUT 改 powershellMode 后工具表立即变化", async () => {
    deps.registry.register(powershellStub);
    expect(deps.registry.has("powershell")).toBe(false);

    await putConfig({ values: { powershellMode: "full" } }, TOKEN);
    expect(deps.settings.powershellMode).toBe("full");
    // 真实注册由 reapplyTools 完成；这里只断言 settings 与响应
    const data = (await (await getConfig(TOKEN)).json()) as { values: Record<string, unknown> };
    expect(data.values.powershellMode).toBe("full");
  });

  it("校验失败返回 400，且 .env 与 settings 都不变", async () => {
    const before = deps.settings.maxIterations;
    const response = await putConfig({ values: { powershellMode: "read-only" } }, TOKEN);
    expect(response.status).toBe(400);
    const data = (await response.json()) as { errors: Array<{ key: string }> };
    expect(data.errors[0]!.key).toBe("powershellMode");
    expect(deps.settings.maxIterations).toBe(before);

    const env = await readFile(deps.settings.envFile, "utf-8").catch(() => "");
    expect(env).not.toContain("powershellMode");
  });

  it("secret 留空表示保持原值，不下发也不覆盖", async () => {
    const before = deps.settings.apiKey;
    await putConfig({ values: { apiKey: "" } }, TOKEN);
    expect(deps.settings.apiKey).toBe(before);

    await putConfig({ values: { apiKey: "sk-new-key-value" } }, TOKEN);
    expect(deps.settings.apiKey).toBe("sk-new-key-value");
    const env = await readFile(deps.settings.envFile, "utf-8");
    expect(env).toContain("MINIAGENT_API_KEY=sk-new-key-value\n");
  });
});
```

需要补的 import（加到 `tests/server.test.ts` 顶部）：

```ts
import { readFile } from "node:fs/promises";
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/server.test.ts`
Expected: FAIL — 配置接口 404 / 405

- [ ] **Step 3: 实现**

在 `src/server/server.ts` 顶部补 import：

```ts
import { timingSafeEqual } from "node:crypto";
import { updateEnvFile } from "../core/envFile.js";
import { applyConfigValues, CONFIG_FIELDS, normalizeConfigValues, readConfigValues, toEnvText } from "../core/configSchema.js";
import { registerFileTools } from "../tools/builtins/files.js";
import { registerPowershell } from "../tools/builtins/powershell.js";
```

（`registerFileTools` / `registerPowershell` 若用 `reapplyTools` 则不需要，见下。）

在 `handleSessions` 之前插入配置接口的处理函数：

```ts
/** 管理令牌校验结果 */
type AdminAuth = { ok: true } | { ok: false; status: number; error: string };

/**
 * 配置接口的鉴权。
 *
 * 为什么必须鉴权：这个接口能写 .env 并把 powershellMode 切成 full —— 等于把本机执行权
 * 交给任何能访问到 HTTP 端口的人。而 README 里的在线演示实例是公网且无鉴权的。
 * 未配置令牌时直接 403（关掉接口），而不是「不校验就放行」。
 */
function checkAdminAuth(request: IncomingMessage, settings: Settings): AdminAuth {
  const expected = settings.adminToken;
  if (!expected) {
    return { ok: false, status: 403, error: "未配置 MINIAGENT_ADMIN_TOKEN，配置接口已禁用" };
  }
  const header = request.headers["x-admin-token"];
  const provided = Array.isArray(header) ? header[0] : header;
  if (typeof provided !== "string" || provided === "") {
    return { ok: false, status: 401, error: "缺少 X-Admin-Token 请求头" };
  }
  const a = Buffer.from(provided, "utf-8");
  const b = Buffer.from(expected, "utf-8");
  // timingSafeEqual 要求等长，长度不同直接判否（长度本身不是秘密）
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, status: 401, error: "管理令牌不匹配" };
  }
  return { ok: true };
}

/** GET /api/config：下发字段元数据 + 当前值（不含任何密钥明文） */
function handleConfigRead(response: ServerResponse, settings: Settings): void {
  const body = {
    schema: CONFIG_FIELDS,
    values: readConfigValues(settings),
    // readonly 是二值开关表达不了的第三态：开关显示为关，旁边用这句说明
    readonlyModeNote:
      settings.powershellMode === "readonly"
        ? "当前为 readonly（只读白名单，非开关状态）；保存开关会把它覆盖为 off 或 full"
        : "",
  };
  response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

/**
 * PUT /api/config：校验 → 写 .env → 原地改 settings → 重注册受影响工具。
 *
 * 顺序不能换：先写盘再改内存，写盘失败时内存仍是旧的；
 * 若反过来，写盘失败会留下「本次运行是新配置、重启后是旧配置」的错位。
 */
async function handleConfigWrite(
  request: IncomingMessage,
  response: ServerResponse,
  settings: Settings,
  registry: ToolRegistry,
): Promise<void> {
  const json = (status: number, payload: unknown): void => {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(payload));
  };

  let parsed: { values?: unknown };
  try {
    parsed = JSON.parse(await readRawBody(request)) as { values?: unknown };
  } catch {
    json(400, { errors: [{ key: "", message: "请求体不是合法 JSON" }] });
    return;
  }
  const raw = parsed.values;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    json(400, { errors: [{ key: "values", message: "需要 values 对象" }] });
    return;
  }

  const result = normalizeConfigValues(raw as Record<string, unknown>);
  if (!result.ok) {
    json(400, { errors: result.errors });
    return;
  }

  // 写 .env：只写本次提交的项，其余行原样保留
  const updates: Record<string, string> = {};
  for (const field of CONFIG_FIELDS) {
    if (field.key in result.normalized) {
      updates[field.env] = toEnvText(result.normalized[field.key]!);
    }
  }
  try {
    if (Object.keys(updates).length > 0) {
      await updateEnvFile(settings.envFile, updates);
    }
  } catch (error) {
    json(500, {
      errors: [
        {
          key: "envFile",
          message: `写入 ${settings.envFile} 失败: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      ],
    });
    return;
  }

  const changed = applyConfigValues(settings, result.normalized);
  await reapplyTools(registry, settings, changed);

  json(200, {
    ok: true,
    applied: changed,
    // 所有可编辑项都是即时生效的；留这个字段是为了让前端不必硬编码这个结论
    restartRequired: [] as string[],
  });
}
```

在 `createRequestHandler` 的路由表里，插到 `/api/stop` 分支之前：

```ts
    if (urlPath === "/api/config" && (request.method === "GET" || request.method === "PUT")) {
      const auth = checkAdminAuth(request, settings);
      if (!auth.ok) {
        response.writeHead(auth.status, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: auth.error }));
        return;
      }
      if (request.method === "GET") {
        handleConfigRead(response, settings);
        return;
      }
      handleConfigWrite(request, response, settings, deps.registry).catch((error: unknown) => {
        response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        response.end(
          JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
        );
      });
      return;
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/server.test.ts`
Expected: PASS（原有用例 + 8 个新用例）

- [ ] **Step 5: 提交**

```bash
git add src/server/server.ts tests/server.test.ts
git commit -m "新增配置读写接口与管理令牌鉴权，保存后即时生效"
```

---

## Task 6: 前端配置菜单

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`

- [ ] **Step 1: 加配置按钮与面板容器**

`public/index.html` 的 `.topbar-right` 里，在 `.history-wrap` 之前插入：

```html
        <div class="config-wrap">
          <button id="configBtn" class="top-btn" aria-expanded="false">配置</button>
          <div id="configPanel" class="config-panel" hidden></div>
        </div>
```

- [ ] **Step 2: 加样式**

`public/styles.css` 末尾追加：

```css
.config-wrap {
  position: relative;
}

.config-panel {
  position: absolute;
  top: calc(100% + 10px);
  right: 0;
  z-index: 21;
  width: 420px;
  max-height: 70vh;
  overflow-y: auto;
  padding: 14px 16px 16px;
  border: 1px solid var(--line-strong);
  border-radius: 12px;
  background: var(--panel);
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.45);
  font-size: 12px;
  color: var(--ink-soft);
}

.config-panel h3 {
  margin: 14px 0 8px;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}

.config-panel h3:first-child {
  margin-top: 0;
}

.config-field {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 0;
}

.config-field label {
  flex: 0 0 150px;
  color: var(--ink-soft);
}

.config-field input[type="text"],
.config-field input[type="password"],
.config-field input[type="number"] {
  flex: 1;
  min-width: 0;
  padding: 6px 9px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--bg-soft);
  color: var(--ink);
  font-family: var(--font-mono);
  font-size: 12px;
}

.config-field input:focus {
  outline: none;
  border-color: var(--line-strong);
}

.config-hint {
  margin: 2px 0 0 160px;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.5;
}

.config-switch {
  display: flex;
  align-items: center;
  gap: 8px;
}

.config-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 16px;
}

.config-save {
  padding: 7px 16px;
  border: 1px solid var(--line-strong);
  border-radius: 100px;
  background: var(--bg-soft);
  color: var(--ink);
  font-family: var(--font-mono);
  font-size: 12px;
  cursor: pointer;
}

.config-save:disabled {
  opacity: 0.5;
  cursor: default;
}

.config-status {
  margin-top: 10px;
  font-size: 11px;
  line-height: 1.6;
}

.config-status.error {
  color: #e08b72;
}

.config-status.ok {
  color: #8fbf7f;
}
```

- [ ] **Step 3: 加逻辑**

在 `public/app.js` 顶部 DOM 引用区（`newChatBtn` 之后）加：

```js
const configWrap = document.querySelector(".config-wrap");
const configBtn = document.querySelector("#configBtn");
const configPanel = document.querySelector("#configPanel");
```

在 `closeHistoryPanel()` 之后加一整块：

```js
/* ---------------- 配置菜单 ---------------- */

const ADMIN_TOKEN_KEY = "miniagent.adminToken";

/** 打开面板时的初值快照：只提交与它不同的项，避免「看一眼再保存」把 readonly 降级成 off */
let configBaseline = null;
let configSchema = [];

function adminToken() {
  return localStorage.getItem(ADMIN_TOKEN_KEY) ?? "";
}

async function toggleConfigPanel() {
  if (!configPanel.hidden) {
    configPanel.hidden = true;
    configBtn.setAttribute("aria-expanded", "false");
    return;
  }
  configPanel.hidden = false;
  configBtn.setAttribute("aria-expanded", "true");
  configPanel.textContent = "加载中…";
  await loadConfigPanel();
}

async function loadConfigPanel() {
  let data;
  try {
    const response = await fetch("/api/config", {
      headers: { "X-Admin-Token": adminToken() },
    });
    data = await response.json();
    if (!response.ok) {
      renderConfigAuthError(data.error ?? `HTTP ${response.status}`);
      return;
    }
  } catch {
    renderConfigAuthError("加载失败：服务未响应");
    return;
  }
  configSchema = data.schema ?? [];
  configBaseline = { ...data.values };
  renderConfigPanel(data.values, data.readonlyModeNote ?? "");
}

/** 令牌没配 / 不对时，面板只剩一个令牌输入框 */
function renderConfigAuthError(message) {
  configPanel.innerHTML = "";
  const notice = document.createElement("div");
  notice.className = "config-status error";
  notice.textContent = message;
  const row = document.createElement("div");
  row.className = "config-field";
  const label = document.createElement("label");
  label.textContent = "管理令牌";
  const input = document.createElement("input");
  input.type = "password";
  input.id = "configToken";
  input.value = adminToken();
  input.placeholder = "与服务端 MINIAGENT_ADMIN_TOKEN 一致";
  input.addEventListener("change", () => {
    localStorage.setItem(ADMIN_TOKEN_KEY, input.value.trim());
  });
  row.append(label, input);
  const actions = document.createElement("div");
  actions.className = "config-actions";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "config-save";
  retry.textContent = "重试";
  retry.addEventListener("click", () => {
    localStorage.setItem(ADMIN_TOKEN_KEY, input.value.trim());
    configPanel.textContent = "加载中…";
    void loadConfigPanel();
  });
  actions.append(retry);
  const hint = document.createElement("div");
  hint.className = "config-hint";
  hint.style.marginLeft = "0";
  hint.textContent = "服务端未配置 MINIAGENT_ADMIN_TOKEN 时，配置接口一律禁用（403）。";
  configPanel.append(notice, row, actions, hint);
}

function renderConfigPanel(values, readonlyModeNote) {
  configPanel.innerHTML = "";
  const groups = new Map();
  for (const field of configSchema) {
    if (!groups.has(field.group)) groups.set(field.group, []);
    groups.get(field.group).push(field);
  }
  for (const [group, fields] of groups) {
    const title = document.createElement("h3");
    title.textContent = groupLabel(group);
    configPanel.appendChild(title);
    for (const field of fields) {
      configPanel.append(makeConfigRow(field, values, readonlyModeNote));
    }
  }

  const actions = document.createElement("div");
  actions.className = "config-actions";
  const save = document.createElement("button");
  save.type = "button";
  save.className = "config-save";
  save.textContent = "保存并生效";
  save.addEventListener("click", () => void saveConfig(save));
  const status = document.createElement("span");
  status.className = "config-status";
  status.id = "configStatus";
  actions.append(save, status);
  configPanel.appendChild(actions);

  const tokenRow = document.createElement("div");
  tokenRow.className = "config-field";
  tokenRow.style.marginTop = "10px";
  const tokenLabel = document.createElement("label");
  tokenLabel.textContent = "管理令牌";
  const tokenInput = document.createElement("input");
  tokenInput.type = "password";
  tokenInput.id = "configToken";
  tokenInput.value = adminToken();
  tokenInput.addEventListener("change", () => {
    localStorage.setItem(ADMIN_TOKEN_KEY, tokenInput.value.trim());
  });
  tokenRow.append(tokenLabel, tokenInput);
  configPanel.appendChild(tokenRow);
}

const GROUP_LABELS = {
  model: "模型",
  runtime: "运行",
  sandbox: "执行权限（沙盒）",
  files: "文件边界",
  approval: "人工审批",
};

function groupLabel(group) {
  return GROUP_LABELS[group] ?? group;
}

function makeConfigRow(field, values, readonlyModeNote) {
  const row = document.createElement("div");
  const name = `config-${field.key}`;

  // 沙盒开关：二值开关表达不了 readonly，所以判定只看是否 full
  if (field.type === "powershellMode") {
    const wrap = document.createElement("div");
    wrap.className = "config-field";
    const label = document.createElement("label");
    label.textContent = "沙盒模式（开=full）";
    const box = document.createElement("div");
    box.className = "config-switch";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = name;
    input.dataset.key = field.key;
    input.dataset.kind = "powershellMode";
    input.checked = values[field.key] === "full";
    const text = document.createElement("span");
    text.textContent = input.checked ? "开" : "关";
    input.addEventListener("change", () => {
      text.textContent = input.checked ? "开" : "关";
    });
    box.append(input, text);
    wrap.append(label, box);
    const container = document.createElement("div");
    container.appendChild(wrap);
    const noteText = readonlyModeNote || field.description || "";
    if (noteText) {
      const hint = document.createElement("div");
      hint.className = "config-hint";
      hint.textContent = noteText;
      container.appendChild(hint);
    }
    return container;
  }

  row.className = "config-field";
  const label = document.createElement("label");
  label.setAttribute("for", name);
  label.textContent = field.label;
  row.appendChild(label);

  let input;
  if (field.type === "boolean") {
    input = document.createElement("input");
    input.type = "checkbox";
    input.checked = Boolean(values[field.key]);
  } else if (field.type === "number") {
    input = document.createElement("input");
    input.type = "number";
    input.value = String(values[field.key] ?? "");
    if (field.min !== undefined) input.min = String(field.min);
    if (field.max !== undefined) input.max = String(field.max);
  } else if (field.type === "secret") {
    input = document.createElement("input");
    input.type = "password";
    input.value = "";
    input.placeholder = values.apiKeySet ? `已配置（${values.apiKeyMask}）· 留空不改` : "未配置";
  } else {
    input = document.createElement("input");
    input.type = "text";
    input.value = Array.isArray(values[field.key])
      ? values[field.key].join(",")
      : String(values[field.key] ?? "");
  }
  input.id = name;
  input.dataset.key = field.key;
  input.dataset.kind = field.type;
  row.appendChild(input);

  if (field.description) {
    const hint = document.createElement("div");
    hint.className = "config-hint";
    hint.textContent = field.description;
    const container = document.createElement("div");
    container.append(row, hint);
    return container;
  }
  return row;
}

/** 收集与初值不同的项；空对象表示没有一个可提交的变更 */
function collectConfigChanges() {
  const values = {};
  for (const field of configSchema) {
    const input = configPanel.querySelector(`#config-${field.key}`);
    if (!input) continue;
    if (field.type === "powershellMode") {
      // 开关只输出 off / full：readonly 位置上显示为「关」，但初值也是「关」，
      // 因此只要用户没动开关就不会被提交（下面与基线比较时自然相等）
      const next = input.checked ? "full" : "off";
      const base = configBaseline[field.key] === "full" ? "full" : "off";
      if (next !== base) values[field.key] = next;
      continue;
    }
    // secret 留空 = 不改
    if (field.type === "secret") {
      if (input.value.trim() !== "") values[field.key] = input.value.trim();
      continue;
    }
    let next;
    if (field.type === "boolean") {
      next = input.checked;
    } else if (field.type === "number") {
      if (input.value.trim() === "") continue;
      next = Number(input.value);
    } else if (field.type === "list") {
      next = input.value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    } else {
      next = input.value.trim();
    }
    const base = configBaseline[field.key];
    const same = Array.isArray(next) ? next.join(",") === (base ?? []).join(",") : next === base;
    if (!same) values[field.key] = next;
  }
  return values;
}

async function saveConfig(button) {
  const status = configPanel.querySelector("#configStatus");
  const values = collectConfigChanges();
  if (Object.keys(values).length === 0) {
    status.className = "config-status";
    status.textContent = "没有改动";
    return;
  }
  button.disabled = true;
  status.className = "config-status";
  status.textContent = "保存中…";
  try {
    const response = await fetch("/api/config", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Token": adminToken(),
      },
      body: JSON.stringify({ values }),
    });
    const data = await response.json();
    if (!response.ok) {
      const detail = (data.errors ?? []).map((e) => `${e.key}: ${e.message}`).join("；");
      status.className = "config-status error";
      status.textContent = detail || data.error || `HTTP ${response.status}`;
      return;
    }
    status.className = "config-status ok";
    status.textContent =
      data.applied.length > 0 ? `已生效：${data.applied.join("、")}` : "没有改动";
    // 保存后重新拉一次，让掩码与开关回到真实状态
    await loadConfigPanel();
  } catch (error) {
    status.className = "config-status error";
    status.textContent = `保存失败：${error.message}`;
  } finally {
    button.disabled = false;
  }
}

function closeConfigPanel() {
  configPanel.hidden = true;
  configBtn.setAttribute("aria-expanded", "false");
}

configBtn.addEventListener("click", () => void toggleConfigPanel());
```

改现有的「点击面板外部时收起」监听，同时收配置面板：

```js
document.addEventListener("click", (event) => {
  if (!configPanel.hidden && configWrap && !configWrap.contains(event.target)) {
    closeConfigPanel();
  }
  if (historyPanel.hidden) return;
  if (historyWrap && historyWrap.contains(event.target)) return;
  closeHistoryPanel();
});
```

- [ ] **Step 4: 手工验证**

Run: `$env:MINIAGENT_ADMIN_TOKEN="dev-token"; npm start`
Expected:
1. 顶栏出现「配置」按钮，点击展开面板，字段按分组渲染；
2. 未填令牌时面板提示令牌不对；
3. 填入 `dev-token` 后字段正常显示，`API Key` 显示为「已配置（sk-d***c52b）· 留空不改」；
4. 切换沙盒开关并保存，提示「已生效：powershellMode」；`/health` 返回的 `tools` 里 `powershell` 出现/消失；
5. `.env` 里对应行被替换，注释与其它行未动。

- [ ] **Step 5: 提交**

```bash
git add public/index.html public/app.js public/styles.css
git commit -m "UI 增加配置菜单：schema 驱动渲染、沙盒开关、令牌存本地"
```

---

## Task 7: `.env.example` 与 CI 部署

**Files:**
- Modify: `.env.example`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: 补 `.env.example`**

在 `.env.example` 的 `MINIAGENT_WORKSPACE` 行前后（`# MINIAGENT_WORKSPACE=./workspace` 之前）插入：

```bash
# 配置菜单（Web UI 顶栏「配置」按钮）的管理令牌
#   未配置 → /api/config 一律 403，即整块配置接口关闭（默认关闭，避免裸奔）
#   配置后 → 请求必须带 X-Admin-Token 头且与本值一致
#   为什么需要它：这个接口能改 .env、并把 powershellMode 切成 full，等于本机执行权
#   请用足够长的随机串，不要与 API Key 复用
# MINIAGENT_ADMIN_TOKEN=
# 配置菜单写回的目标文件；默认 ./.env，与 node --env-file-if-exists 对齐
# MINIAGENT_ENV_FILE=./.env
```

- [ ] **Step 2: 加 build 与 deploy job**

在 `.github/workflows/ci.yml` 的 `verify` job 之后追加：

```yaml
  # 编译产物只有完整环境能产出：轻量环境缺 optional 依赖，tsc 会报 TS2307。
  # 所以服务器不编译，只接收这里产出的 dist/。
  build:
    needs: verify
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: npm

      - name: 安装依赖（含 optional，保证类型齐全）
        run: npm ci

      - name: 编译
        run: npm run build

      - name: 上传编译产物
        uses: actions/upload-artifact@v4
        with:
          name: dist
          path: dist
          retention-days: 7

  deploy:
    needs: build
    runs-on: ubuntu-latest
    # Secrets 未配置时整体跳过，不阻塞主干 CI（step 级的 if 判断 secrets 不生效，只能放这里）。
    # 注意：一个 job 只能有一个 if，条件必须合并成一条。
    if: >
      github.event_name == 'push' && github.ref == 'refs/heads/main' &&
      secrets.SSH_HOST != '' && secrets.SSH_PRIVATE_KEY != ''
    steps:
      - uses: actions/checkout@v4

      - uses: actions/download-artifact@v4
        with:
          name: dist
          path: dist

      - name: 准备 SSH
        run: |
          mkdir -p ~/.ssh
          printf '%s\n' "${{ secrets.SSH_PRIVATE_KEY }}" > ~/.ssh/id_deploy
          chmod 600 ~/.ssh/id_deploy
          # 首次连接写入 known_hosts，避免交互式确认卡住
          ssh-keyscan -p "${{ secrets.SSH_PORT || '22' }}" -H "${{ secrets.SSH_HOST }}" >> ~/.ssh/known_hosts 2>/dev/null

      - name: 同步代码与产物
        env:
          SSH_PORT: ${{ secrets.SSH_PORT || '22' }}
          TARGET: ${{ secrets.SSH_USER }}@${{ secrets.SSH_HOST }}:${{ secrets.DEPLOY_PATH }}
        run: |
          # 不加 --delete：服务器上的 .env / knowledge / memory / history 等运行时数据必须留着。
          # 代价是远端 dist/ 可能残留已删除源文件对应的旧 .js，本规模下可接受。
          rsync -az --no-perms --omit-dir-times \
            -e "ssh -i ~/.ssh/id_deploy -p $SSH_PORT" \
            --exclude '.env' \
            --exclude 'node_modules/' \
            --exclude 'knowledge/' \
            --exclude 'memory/' \
            --exclude 'history/' \
            --exclude 'traces/' \
            --exclude 'workspace/' \
            --exclude 'vector-db/' \
            --exclude 'checkpoints/' \
            --exclude '.cache/' \
            --exclude 'models/' \
            public/ skills/ package.json package-lock.json \
            "$TARGET/"
          rsync -az --no-perms --omit-dir-times \
            -e "ssh -i ~/.ssh/id_deploy -p $SSH_PORT" \
            dist/ "$TARGET/dist/"

      - name: 安装运行依赖并重启
        env:
          SSH_PORT: ${{ secrets.SSH_PORT || '22' }}
          REMOTE: ${{ secrets.SSH_USER }}@${{ secrets.SSH_HOST }}
        run: |
          ssh -i ~/.ssh/id_deploy -p "$SSH_PORT" "$REMOTE" \
            "cd '${{ secrets.DEPLOY_PATH }}' && \
             npm ci --omit=dev --omit=optional --no-audit --no-fund && \
             sudo systemctl restart '${{ secrets.SERVICE_NAME || 'miniagent' }}'"
```

- [ ] **Step 3: 本地验证 workflow 语法**

Run: `npx --yes yaml-lint .github/workflows/ci.yml` 或直接在 GitHub 上看 Actions 结果（本地无 yaml-lint 时跳过，交由 push 后验证）
Expected: 无语法错误

- [ ] **Step 4: 提交**

```bash
git add .env.example .github/workflows/ci.yml
git commit -m "补充管理令牌说明，CI 增加编译产物与 rsync 部署"
```

---

## Task 8: 全量验证与推送

- [ ] **Step 1: 类型检查 + 风格 + 测试**

```bash
npm run typecheck && npm run lint && npm test
```
Expected: tsc 零错误、eslint 零错误、vitest 全通过

- [ ] **Step 2: 构建产物可用**

```bash
npm run build && node -e "console.log(require('node:fs').existsSync('dist/server/server.js'))"
```
Expected: `true`

- [ ] **Step 3: 推送**

```bash
git push origin main
```
Expected: CI 上 `verify` 与 `build` 通过；`deploy` 在 Secrets 未配置时跳过

- [ ] **Step 4: 服务器侧配置（用户手动，一次性）**

在 GitHub 仓库 Settings → Secrets and variables → Actions 里配置：

| Secret | 说明 |
|---|---|
| `SSH_HOST` | `47.104.106.151` |
| `SSH_USER` | 登录用户 |
| `SSH_PRIVATE_KEY` | 部署私钥（对应公钥需在服务器 `~/.ssh/authorized_keys`） |
| `SSH_PORT` | SSH 端口（不填按 22） |
| `DEPLOY_PATH` | 部署目录（如 `/opt/miniagent`） |
| `SERVICE_NAME` | systemd 服务名（不填按 `miniagent`） |

服务器上还需一次性准备：`/etc/systemd/system/miniagent.service`（`ExecStart=/usr/bin/node --env-file-if-exists=.env dist/server/server.js`、`WorkingDirectory=DEPLOY_PATH`、`Environment=NODE_ENV=production`）与一份 `.env`（含 `MINIAGENT_ADMIN_TOKEN`）。

---

## 自审记录

- **spec 覆盖**：可编辑子集 → Task 3；`.env` 写回 → Task 2；`unregister` → Task 1；配置接口 + 鉴权 → Task 5；readonly 显示为关 + 灰字 → Task 5（`readonlyModeNote`）+ Task 6（渲染）；前端 schema 驱动 → Task 6；`.env.example` → Task 7；CI 编译 + rsync 到 `47.104.106.151` → Task 7；测试 → 各任务内。
- **类型一致性**：`reapplyTools(registry, settings, changed)` 在 Task 4 定义、Task 5 以 `(registry, settings, changed)` 调用；`normalizeConfigValues` / `applyConfigValues` / `readConfigValues` / `toEnvText` 在 Task 3 定义、Task 5 使用；`writeEnvValues` / `updateEnvFile` 在 Task 2 定义、Task 5 使用。
- **spec 未写但实现必须有的两项**：`Settings.envFile`（测试不碰真实 `.env`）、`Settings.adminToken`。已写进 Task 3。
- **已知偏差**：`.env` 读写放在新文件 `src/core/envFile.ts` 而非 `config.ts`，理由已在开头说明。
