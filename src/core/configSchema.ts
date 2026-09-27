/**
 * 配置菜单的可编辑字段元数据 —— 「哪些配置能被 UI 改」的唯一事实来源。
 *
 * 后端下发这份 schema，前端照它渲染，于是新增一个可编辑项只改这一个文件，
 * 不会出现「后端能改、前端没入口」或两者的字段名漂移。
 *
 * 只覆盖常用子集：路径类、记忆/知识库调参这类要先读懂源码才知道后果的项不在内。
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
    description: "off 不注册该工具；full 完全不受限。开关口径：开=full，关=off",
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
        // secret 留空 = 保持原值（前端不回填明文，用户不填就不该被清空）
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
          : String(raw)
              .split(",")
              .map((item) => item.trim());
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
        normalized[key] = value as PowershellMode;
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
  return {
    ...values,
    apiKeySet: settings.apiKey !== "",
    apiKeyMask: maskSecret(settings.apiKey),
  };
}

/** 掩码：保留首尾各 4 位。短到这个程度就直接全遮 */
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
