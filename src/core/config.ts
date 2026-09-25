/** 全局配置：读取 MINIAGENT_ 前缀的环境变量（node --env-file=.env 加载 .env）。 */

import { findProvider, knownProviders, type ProviderPreset } from "./providers.js";

/**
 * 通用执行通道（powershell 工具）的权限档位。
 * 定义放在配置层：它是「本机允许多大的执行权限」这件事的表述，工具只按它执行。
 */
export type PowershellMode = "off" | "readonly" | "full";

export interface Settings {
  /**
   * 模型服务商：内置预设名（deepseek / openai / moonshot / dashscope / zhipu /
   * ollama）或 custom（只认显式 baseUrl）。见 core/providers.ts
   */
  provider: string;
  /** 服务商 API Key；本地端点可为空 */
  apiKey: string;
  /** chat/completions 的基址，由 provider 预设推导，可用 MINIAGENT_BASE_URL 覆盖 */
  baseUrl: string;
  model: string;
  requestTimeout: number;
  maxRetries: number;
  /**
   * 是否用流式请求（`stream: true`）以便逐字显示。后端不支持时会自动降级。
   * 关掉即退回一次性返回。
   */
  streamEnabled: boolean;

  /** Agent */
  maxIterations: number;

  /** 子 agent（run_subagent）：它自己一轮跑多少步、以及单次执行的上限 */
  subagentMaxIterations: number;
  subagentTimeout: number;

  /** 模型上下文窗口（token）。历史预算按它推导，换模型只改这一个数 */
  modelContextTokens: number;
  /** 历史消息预算占上下文窗口的比例 */
  memoryBudgetRatio: number;
  /**
   * 记忆：历史消息的 token 预算。
   * 未显式配置（`MINIAGENT_MEMORY_MAX_TOKENS`）时按「窗口 × 比例」推导。
   */
  memoryMaxTokens: number;
  /**
   * 被裁掉的历史达到该 token 数才触发摘要压缩。
   * 故意保持绝对值、不随窗口伸缩——它衡量的是「裁掉的内容够不够抵一次 LLM 调用」，
   * 是成本考量，与模型窗口大小无关。
   */
  memorySummaryThreshold: number;

  /** 记忆巩固：可检索条数超过阈值时，把最低分的一批压缩成归档摘要 */
  memoryConsolidateThreshold: number;
  memoryConsolidateBatch: number;
  memoryArchiveChars: number;

  /** Tool 运行时 */
  toolTimeout: number;
  maxConcurrency: number;
  /**
   * 单个工具结果回灌上下文时的字符上限（0 表示不限制）。
   * 滑窗只约束传入的历史，循环中回灌的工具结果在窗外，需要单独设闸。
   */
  toolResultMaxChars: number;
  /**
   * 保留多少个 run 的卸载产物（`workspace/offload/<runId>/`），更早的删除。
   * 0 表示不清理（与 toolResultMaxChars 的 0 语义一致）。
   */
  offloadKeepRuns: number;

  /** 文件工具沙箱根目录 */
  workspace: string;

  /**
   * 通用执行通道（powershell 工具）的权限档位：
   *   off      不注册该工具
   *   readonly 只放行只读 cmdlet，且必须是单条简单命令（默认）
   *   full     不限制——建议同时把 powershell 加进 MINIAGENT_APPROVAL_TOOLS
   *
   * 这个工具**没有沙箱**（子进程权限 = 本进程权限），档位是唯一的约束手段。
   */
  powershellMode: PowershellMode;
  /** 单条命令的超时（秒） */
  powershellTimeout: number;
  /** 可执行文件；留空则 Windows 用 powershell、其它平台用 pwsh */
  powershellExecutable: string;

  /** trace 输出目录 */
  traceDir: string;

  /**
   * OpenTelemetry 导出（OTLP/HTTP JSON）。关闭时只写本地 JSONL 轨迹。
   * 端点/服务名等优先读 MINIAGENT_ 前缀变量，未配置时回退到 OTEL_ 官方变量。
   */
  otelEnabled: boolean;
  /** OTLP HTTP 基址，导出器会在其后追加 /v1/traces */
  otelEndpoint: string;
  /** 资源属性 service.name，多实例部署时用于区分服务 */
  otelServiceName: string;
  /** 附加请求头（如鉴权），形如 key1=value1,key2=value2 */
  otelHeaders: Record<string, string>;
  /** 单次导出超时（秒） */
  otelTimeout: number;
  /** 指标上报间隔（秒）；0 表示只在进程退出时上报一次 */
  otelMetricsInterval: number;

  /**
   * 运行存档目录。每轮迭代后落盘，成功即删除，只有中断/挂起的才留下。
   * 关掉它就没有断点续跑与人工审批这两项能力。
   */
  checkpointDir: string;
  checkpointEnabled: boolean;
  /**
   * 需要人工审批的工具名（逗号分隔）。命中即挂起本次运行，等外部决定后再续跑。
   * 适合放「有副作用且不可撤销」的工具，如写文件、发请求。
   */
  approvalTools: string[];

  /** 技能包目录 */
  skillsDir: string;

  /** MCP 服务配置（mcp.json）路径；文件不存在即不启用 MCP */
  mcpConfigPath: string;

  /** 会话历史目录 */
  historyDir: string;

  /** 长期记忆 JSONL 文件 */
  longTermMemoryFile: string;

  /**
   * 长期记忆后端：jsonl | lifecycle | memos。
   * 留空则自动选择——配了 MemOS key 用 memos，否则用 jsonl。
   */
  memoryBackend: string;

  /** 生命周期记忆（置信度/矛盾消解/遗忘曲线）的存储文件 */
  lifecycleMemoryFile: string;

  /**
   * 知识库根目录，可配多个（用逗号分隔）。
   * 例如 ./docs 放项目文档、./knowledge 放业务资料，两者都会入库。
   */
  knowledgeDirs: string[];
  /** 知识片段的最大字符数 */
  knowledgeChunkChars: number;
  /** 相邻片段的重叠字符数 */
  knowledgeChunkOverlap: number;
  /**
   * 知识库检索后端：
   *   lexical —— 词面 TF-IDF，零依赖、零配置（默认）
   *   vector  —— 语义检索，LanceDB + 本地嵌入模型；能召回跨语言与同义改写
   *   hybrid  —— 词面 + 语义两路召回，RRF 融合；精确 token 与同义改写都不漏
   */
  knowledgeBackend: string;
  /** 本地嵌入模型（HuggingFace 模型 ID） */
  embeddingModel: string;
  /** 嵌入模型下载源；留空用官方 Hub，国内网络需指向镜像 */
  embeddingRemoteHost: string;
  /** 嵌入模型缓存目录 */
  embeddingCacheDir: string;
  /** 本地模型根目录（npm run model:fetch 的落点）；已有权重时完全离线加载 */
  embeddingLocalModelPath: string;
  /** 权重精度，需与 model:fetch 时选的一致（q8 对应 onnx/model_quantized.onnx） */
  embeddingDtype: string;
  /** LanceDB 数据目录 */
  vectorDbPath: string;
  /** 混合检索的 RRF 常数 k（仅 hybrid 后端生效） */
  hybridRrfK: number;
  /** 混合检索里词面通道的权重（仅 hybrid 后端生效） */
  hybridLexicalWeight: number;
  /** 混合检索里语义通道的权重（仅 hybrid 后端生效） */
  hybridVectorWeight: number;

  /** MemOS 云记忆（可选）：填写 API Key 后启用，否则回退到本地 JSONL */
  memosApiKey: string;
  memosBaseUrl: string;
  /** 记忆归属的用户标识：同一个人跨会话必须保持一致 */
  memosUserId: string;
  /** MemOS 单次请求超时（秒） */
  memosTimeout: number;
}

function readString(name: string, defaultValue: string): string {
  const value = process.env[name];
  return value === undefined || value === "" ? defaultValue : value;
}

function readNumber(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") return defaultValue;
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`环境变量 ${name} 不是合法数字: ${value}`);
  }
  return parsed;
}

/** 读取逗号分隔的路径列表；未配置或全为空白时用默认值 */
function readList(name: string, defaultValue: string[]): string[] {
  const value = process.env[name];
  if (value === undefined) return defaultValue;
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : defaultValue;
}

/** 读取 `key1=value1,key2=value2` 形式的键值对；无有效项时返回空对象 */
function readPairs(name: string): Record<string, string> {
  const value = process.env[name];
  if (value === undefined || value === "") return {};
  const pairs: Record<string, string> = {};
  for (const item of value.split(",")) {
    const index = item.indexOf("=");
    if (index <= 0) continue;
    const key = item.slice(0, index).trim();
    const found = item.slice(index + 1).trim();
    if (key && found) pairs[key] = found;
  }
  return pairs;
}

/** 布尔开关：接受 true/false、1/0、yes/no（大小写不敏感） */
function readBoolean(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === "") return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  throw new Error(`环境变量 ${name} 不是合法布尔值: ${value}`);
}

/** DeepSeek-V3.2 官方标称 128K 上下文（deepseek-chat / deepseek-reasoner 同） */
const DEFAULT_CONTEXT_TOKENS = 131072;

/**
 * 默认嵌入模型：多语言、384 维、体积小，中英混排语料适用。
 * 中文专用场景可换 Xenova/bge-small-zh-v1.5（512 维）。
 */
const DEFAULT_EMBEDDING_MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";

/**
 * 历史消息预算占窗口的比例。
 * 不取满：context rot 的研究表明输入越长模型质量越差、成本也越高，
 * 所以留出大块余量给 system、工具回灌与输出。0.25（128K 下约 32K）在
 * 「长对话少触发摘要」与「不把窗口塞满」之间取平衡，可按需调整。
 */
const DEFAULT_MEMORY_BUDGET_RATIO = 0.25;

/** 按 provider 名取预设；未知名字直接报错，避免带着空 baseUrl 跑到第一次请求才炸 */
function resolvePreset(name: string): ProviderPreset {
  const preset = findProvider(name);
  if (preset) return preset;
  throw new Error(
    `未知的模型服务商 MINIAGENT_PROVIDER=${name}；可选: ${knownProviders()}`,
  );
}

/** 权限档位只认三个值：写错就报错，避免「以为关了其实开着」 */
function readPowershellMode(): PowershellMode {
  const value = readString("MINIAGENT_POWERSHELL_MODE", "readonly").toLowerCase();
  if (value === "off" || value === "readonly" || value === "full") return value;
  throw new Error(
    `环境变量 MINIAGENT_POWERSHELL_MODE 只能是 off / readonly / full，收到: ${value}`,
  );
}

export function loadSettings(): Settings {
  const provider = readString("MINIAGENT_PROVIDER", "deepseek");
  const preset = resolvePreset(provider);
  const modelContextTokens = readNumber(
    "MINIAGENT_MODEL_CONTEXT_TOKENS",
    DEFAULT_CONTEXT_TOKENS,
  );
  const memoryBudgetRatio = readNumber(
    "MINIAGENT_MEMORY_BUDGET_RATIO",
    DEFAULT_MEMORY_BUDGET_RATIO,
  );
  // 0 表示未显式配置 → 按窗口比例推导
  const explicitMemoryBudget = readNumber("MINIAGENT_MEMORY_MAX_TOKENS", 0);

  const settings: Settings = {
    provider,
    apiKey: readString(
      "MINIAGENT_API_KEY",
      // 旧的 DeepSeek 专用变量继续可用，避免已有 .env 失效
      readString("MINIAGENT_DEEPSEEK_API_KEY", ""),
    ),
    baseUrl: readString(
      "MINIAGENT_BASE_URL",
      readString("MINIAGENT_DEEPSEEK_BASE_URL", preset.baseUrl),
    ),
    model: readString("MINIAGENT_MODEL", preset.defaultModel ?? ""),
    requestTimeout: readNumber("MINIAGENT_REQUEST_TIMEOUT", 60),
    maxRetries: readNumber("MINIAGENT_MAX_RETRIES", 3),
    streamEnabled: readBoolean("MINIAGENT_STREAM_ENABLED", true),

    maxIterations: readNumber("MINIAGENT_MAX_ITERATIONS", 8),
    subagentMaxIterations: readNumber("MINIAGENT_SUBAGENT_MAX_ITERATIONS", 6),
    subagentTimeout: readNumber("MINIAGENT_SUBAGENT_TIMEOUT", 180),

    modelContextTokens,
    memoryBudgetRatio,
    memoryMaxTokens:
      explicitMemoryBudget > 0
        ? explicitMemoryBudget
        : Math.floor(modelContextTokens * memoryBudgetRatio),
    memorySummaryThreshold: readNumber("MINIAGENT_MEMORY_SUMMARY_THRESHOLD", 2000),
    memoryConsolidateThreshold: readNumber("MINIAGENT_MEMORY_CONSOLIDATE_THRESHOLD", 400),
    memoryConsolidateBatch: readNumber("MINIAGENT_MEMORY_CONSOLIDATE_BATCH", 40),
    memoryArchiveChars: readNumber("MINIAGENT_MEMORY_ARCHIVE_CHARS", 400),

    toolTimeout: readNumber("MINIAGENT_TOOL_TIMEOUT", 30),
    maxConcurrency: readNumber("MINIAGENT_MAX_CONCURRENCY", 8),
    toolResultMaxChars: readNumber("MINIAGENT_TOOL_RESULT_MAX_CHARS", 4000),
    offloadKeepRuns: readNumber("MINIAGENT_OFFLOAD_KEEP_RUNS", 50),

    workspace: readString("MINIAGENT_WORKSPACE", "./workspace"),
    powershellMode: readPowershellMode(),
    powershellTimeout: readNumber("MINIAGENT_POWERSHELL_TIMEOUT", 30),
    powershellExecutable: readString("MINIAGENT_POWERSHELL_EXECUTABLE", ""),
    traceDir: readString("MINIAGENT_TRACE_DIR", "./traces"),
    otelEnabled: readBoolean("MINIAGENT_OTEL_ENABLED", false),
    // 端点用官方变量名兜底：容器里通常已经按 OTel 规范注入了 OTEL_EXPORTER_OTLP_ENDPOINT
    otelEndpoint: readString(
      "MINIAGENT_OTEL_ENDPOINT",
      readString("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318"),
    ).replace(/\/+$/, ""),
    otelServiceName: readString(
      "MINIAGENT_OTEL_SERVICE_NAME",
      readString("OTEL_SERVICE_NAME", "miniagent"),
    ),
    otelHeaders: {
      ...readPairs("OTEL_EXPORTER_OTLP_HEADERS"),
      ...readPairs("MINIAGENT_OTEL_HEADERS"),
    },
    otelTimeout: readNumber("MINIAGENT_OTEL_TIMEOUT", 10),
    otelMetricsInterval: readNumber("MINIAGENT_OTEL_METRICS_INTERVAL", 60),
    checkpointDir: readString("MINIAGENT_CHECKPOINT_DIR", "./checkpoints"),
    checkpointEnabled: readBoolean("MINIAGENT_CHECKPOINT_ENABLED", true),
    approvalTools: readList("MINIAGENT_APPROVAL_TOOLS", []),
    skillsDir: readString("MINIAGENT_SKILLS_DIR", "./skills"),
    mcpConfigPath: readString("MINIAGENT_MCP_CONFIG", "./mcp.json"),
    historyDir: readString("MINIAGENT_HISTORY_DIR", "./history"),
    longTermMemoryFile: readString(
      "MINIAGENT_MEMORY_FILE",
      "./memory/long_term.jsonl",
    ),
    memoryBackend: readString("MINIAGENT_MEMORY_BACKEND", ""),
    lifecycleMemoryFile: readString(
      "MINIAGENT_LIFECYCLE_MEMORY_FILE",
      "./memory/lifecycle.jsonl",
    ),
    knowledgeDirs: readList("MINIAGENT_KNOWLEDGE_DIR", ["./knowledge"]),
    knowledgeChunkChars: readNumber("MINIAGENT_KNOWLEDGE_CHUNK_CHARS", 600),
    knowledgeChunkOverlap: readNumber("MINIAGENT_KNOWLEDGE_CHUNK_OVERLAP", 80),
    knowledgeBackend: readString("MINIAGENT_KNOWLEDGE_BACKEND", "lexical").toLowerCase(),
    embeddingModel: readString("MINIAGENT_EMBEDDING_MODEL", DEFAULT_EMBEDDING_MODEL),
    embeddingRemoteHost: readString("MINIAGENT_EMBEDDING_REMOTE_HOST", ""),
    embeddingCacheDir: readString("MINIAGENT_EMBEDDING_CACHE_DIR", "./.cache/embeddings"),
    embeddingLocalModelPath: readString("MINIAGENT_EMBEDDING_LOCAL_MODEL_PATH", "./models"),
    // 默认值与 knowledge/embedding.ts 的 DEFAULT_EMBEDDING_DTYPE 保持一致
    embeddingDtype: readString("MINIAGENT_EMBEDDING_DTYPE", "q8"),
    vectorDbPath: readString("MINIAGENT_VECTOR_DB_PATH", "./vector-db"),
    hybridRrfK: readNumber("MINIAGENT_HYBRID_RRF_K", 60),
    hybridLexicalWeight: readNumber("MINIAGENT_HYBRID_LEXICAL_WEIGHT", 1),
    hybridVectorWeight: readNumber("MINIAGENT_HYBRID_VECTOR_WEIGHT", 1),

    memosApiKey: readString("MINIAGENT_MEMOS_API_KEY", ""),
    memosBaseUrl: readString(
      "MINIAGENT_MEMOS_BASE_URL",
      "https://memos.memtensor.cn/api/openmem/v1",
    ),
    memosUserId: readString("MINIAGENT_MEMOS_USER_ID", "miniagent-local"),
    memosTimeout: readNumber("MINIAGENT_MEMOS_TIMEOUT", 15),
  };

  // 接入点与模型名缺失都是「一跑到第一次请求才炸」的配置错误，启动时就说清楚
  if (!settings.baseUrl) {
    throw new Error(
      `provider=${provider} 没有内置接入点，请设置 MINIAGENT_BASE_URL` +
        `（形如 https://your-host/v1）`,
    );
  }
  if (!settings.model) {
    throw new Error(
      `provider=${provider} 没有默认模型名，请设置 MINIAGENT_MODEL` +
        `（具体型号见服务商文档）`,
    );
  }
  return settings;
}
