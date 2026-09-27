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
  return { ...loadSettings(), shellMode: "readonly", adminToken: "t" };
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
      shellMode: "full",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.normalized).toMatchObject({
      maxIterations: 12,
      planMode: false,
      approvalTools: ["write_file", "powershell"],
      shellMode: "full",
    });
  });

  it("list 也接受逗号分隔的字符串，并丢掉空白项", () => {
    const result = normalizeConfigValues({ approvalTools: "write_file, ,powershell" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.normalized.approvalTools).toEqual(["write_file", "powershell"]);
  });

  it("拒绝非法 shellMode", () => {
    const result = normalizeConfigValues({ shellMode: "read-only" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]!.key).toBe("shellMode");
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
      shellMode: "full",
    });
    expect(changed.sort()).toEqual(["maxIterations", "shellMode"]);
    expect(settings.maxIterations).toBe(12);
    expect(settings.shellMode).toBe("full");
  });

  it("值没变就不算变化项（避免无谓地重注册工具）", () => {
    const settings = makeSettings();
    const changed = applyConfigValues(settings, { shellMode: "readonly" });
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
