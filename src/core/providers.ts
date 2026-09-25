/**
 * 内置的 OpenAI 兼容服务商预设。
 *
 * 客户端只依赖「OpenAI 兼容」这一件事（`POST {baseUrl}/chat/completions` + tool calls），
 * 预设提供的是**接入点与默认模型名**这类易忘、易错的常量，不是适配器。
 * 任何未列出的服务商都可以用 `MINIAGENT_PROVIDER=custom` + `MINIAGENT_BASE_URL` 接进来，
 * 所以这里不需要穷举，也就不必追着各家上新款模型更新代码。
 */

export interface ProviderPreset {
  /** 服务商标识 */
  name: string;
  /**
   * chat/completions 的基址（客户端会在其后追加 `/chat/completions`）。
   * 是否带 `/v1` 按各家实际接口而定，不能一刀切。
   */
  baseUrl: string;
  /**
   * 该服务商的默认模型名。仅作「不配也能跑起来」的兜底，
   * 具体可用型号与计费请以各家当前文档为准。
   */
  defaultModel?: string;
  /** 申请 Key 的控制台入口：报错时直接给出「下一步去哪」 */
  consoleUrl?: string;
}

export const PROVIDER_PRESETS: Readonly<Record<string, ProviderPreset>> = {
  deepseek: {
    name: "deepseek",
    baseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-chat",
    consoleUrl: "https://platform.deepseek.com",
  },
  openai: {
    name: "openai",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    consoleUrl: "https://platform.openai.com",
  },
  moonshot: {
    name: "moonshot",
    baseUrl: "https://api.moonshot.cn/v1",
    defaultModel: "moonshot-v1-8k",
    consoleUrl: "https://platform.moonshot.cn",
  },
  dashscope: {
    name: "dashscope",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-plus",
    consoleUrl: "https://bailian.console.aliyun.com",
  },
  zhipu: {
    name: "zhipu",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-4-plus",
    consoleUrl: "https://open.bigmodel.cn",
  },
  /** 本地推理（Ollama / vLLM / LM Studio 默认都监听这个地址），无需 API Key */
  ollama: {
    name: "ollama",
    baseUrl: "http://localhost:11434/v1",
  },
  /** 兜底档：只认 MINIAGENT_BASE_URL / MINIAGENT_MODEL，用于未列出的服务商 */
  custom: {
    name: "custom",
    baseUrl: "",
  },
};

/** 查预设；未知名字返回 undefined（由调用方决定是报错还是回退） */
export function findProvider(name: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS[name.trim().toLowerCase()];
}

/** 未知 provider 时给出的候选清单，形如 `deepseek/openai/...` */
export function knownProviders(): string {
  return Object.keys(PROVIDER_PRESETS).join("/");
}

/** 启动时打印一行「当前接的是谁」 */
export function describeProvider(name: string, model: string, baseUrl: string): string {
  return `${name}（${model} @ ${baseUrl}）`;
}
