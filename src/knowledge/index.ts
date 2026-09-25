/** 知识库对外入口：工厂与 search_knowledge 工具。 */

import { z } from "zod";

import type { Settings } from "../core/config.js";
import { defineTool } from "../tools/base.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { KnowledgeBase } from "./base.js";
import { DEFAULT_CHUNK_CHARS } from "./chunker.js";
import { LexicalKnowledgeBase } from "./lexical.js";
import { LocalEmbedding } from "./embedding.js";
import { HybridKnowledgeBase } from "./hybrid.js";
import { VectorKnowledgeBase } from "./vector.js";

export type { KnowledgeBase, KnowledgeChunk, KnowledgeHit } from "./base.js";
export { chunkDocument, DEFAULT_CHUNK_CHARS, DEFAULT_CHUNK_OVERLAP } from "./chunker.js";
export { LexicalKnowledgeBase, lengthPenalty } from "./lexical.js";
export {
  LocalEmbedding,
  type EmbeddingModel,
  type LocalEmbeddingOptions,
} from "./embedding.js";
export {
  VectorKnowledgeBase,
  type ReconcileReport,
  type VectorKnowledgeOptions,
} from "./vector.js";
export {
  HybridKnowledgeBase,
  DEFAULT_RRF_K,
  type HybridKnowledgeOptions,
} from "./hybrid.js";
export {
  isTextExtension,
  readText,
  scanFiles,
  sourceOf,
  type ScannedFile,
} from "./store.js";

export const DEFAULT_KNOWLEDGE_TOP_K = 4;

/**
 * 按配置构造知识库后端。
 *
 * 上层（`search_knowledge` 工具、Agent）只依赖 KnowledgeBase 接口，
 * 所以三种实现可以并存、可切换——词面实现是「零依赖可跑」的降级路径。
 */
export function createKnowledgeBase(settings: Settings): KnowledgeBase {
  const chunkOptions = chunkOptionsOf(settings);

  if (settings.knowledgeBackend === "hybrid") {
    return new HybridKnowledgeBase({
      // 词面通道零依赖且便宜，永远可用；语义通道才是可能装不上的那一半
      lexical: new LexicalKnowledgeBase(chunkOptions),
      vector: createVectorBackend(settings, chunkOptions),
      rrfK: settings.hybridRrfK,
      lexicalWeight: settings.hybridLexicalWeight,
      vectorWeight: settings.hybridVectorWeight,
    });
  }

  if (settings.knowledgeBackend === "vector") {
    return createVectorBackend(settings, chunkOptions);
  }

  return new LexicalKnowledgeBase(chunkOptions);
}

/**
 * 取语义后端本体（带 `rebuild` / `verify`），供重建与对账脚本使用。
 * `lexical` 后端没有可重建的索引，返回 undefined。
 */
export function createVectorBackendFor(settings: Settings): VectorKnowledgeBase | undefined {
  if (settings.knowledgeBackend !== "vector" && settings.knowledgeBackend !== "hybrid") {
    return undefined;
  }
  return createVectorBackend(settings, chunkOptionsOf(settings));
}

function chunkOptionsOf(settings: Settings): {
  dirs: string[];
  maxChars: number;
  overlapChars: number;
} {
  return {
    dirs: settings.knowledgeDirs,
    maxChars: settings.knowledgeChunkChars || DEFAULT_CHUNK_CHARS,
    overlapChars: settings.knowledgeChunkOverlap,
  };
}

/** 语义后端：构造本身不加载模型，首次检索才触发（见 embedding.ts 的惰性加载） */
function createVectorBackend(
  settings: Settings,
  chunkOptions: { dirs: string[]; maxChars: number; overlapChars: number },
): VectorKnowledgeBase {
  return new VectorKnowledgeBase({
    ...chunkOptions,
    dbPath: settings.vectorDbPath,
    embedding: new LocalEmbedding({
      model: settings.embeddingModel,
      remoteHost: settings.embeddingRemoteHost || undefined,
      cacheDir: settings.embeddingCacheDir || undefined,
      localModelPath: settings.embeddingLocalModelPath || undefined,
      dtype: settings.embeddingDtype || undefined,
    }),
  });
}

/** 供启动日志展示当前生效的检索后端 */
export function describeKnowledgeBackend(settings: Settings): string {
  if (settings.knowledgeBackend === "hybrid") {
    const { hybridLexicalWeight: lexical, hybridVectorWeight: vector } = settings;
    return `混合检索（词面 + 语义 RRF 融合，权重 ${lexical}:${vector}，${settings.embeddingModel}）`;
  }
  return settings.knowledgeBackend === "vector"
    ? `语义检索（LanceDB + ${settings.embeddingModel}）`
    : "词面检索（TF-IDF）";
}

/**
 * 检索工具的独立超时。
 *
 * 不能沿用运行时默认的 30s：**首次检索要先把变更的文件嵌入完**，
 * 本地 CPU 嵌入是分钟级操作（实测：2 个文档变更、113 个片段，同步耗时约 42s）。
 * 用默认超时会把这次检索判为失败——而它其实马上就要成功了，
 * 而且模型拿到「工具超时」后通常会用同样的参数重试，白等一轮。
 *
 * 超时本身不会取消底层嵌入（JS 无协作式取消），所以调大它没有额外代价：
 * 只是让这一次等待走完，同步结果下次直接复用。
 */
const KNOWLEDGE_TIMEOUT_SECONDS = 180;

/**
 * 注册知识库检索工具。
 * 采用「模型自主检索」而非「每轮硬注入」：库大时硬注入会白烧 token，
 * 而且让模型自己判断"这题要不要查库"更准。
 */
export function registerKnowledgeTools(
  registry: ToolRegistry,
  knowledge: KnowledgeBase,
): void {
  registry.register(
    defineTool({
      name: "search_knowledge",
      description:
        "在本地知识库中检索资料，返回带来源（文件名 + 小节标题 + 文件修改日期）的原文片段。" +
        "当问题涉及项目自有文档、内部规范或特定领域资料时优先使用。" +
        "若多个片段对同一问题给出互相矛盾的说法：先比较 updated_at，以较新的记载为准；" +
        "若无法判断新旧（日期相同或缺失），不要自行裁决，应并列列出冲突内容与各自来源，" +
        "并说明需要以哪一份为准——片段顺序只反映检索相关度，不代表权威性。",
      // 首次检索可能要先完成索引同步，见 KNOWLEDGE_TIMEOUT_SECONDS
      timeoutSeconds: KNOWLEDGE_TIMEOUT_SECONDS,
      args: z.object({
        query: z.string().describe("检索关键词或问题，尽量具体"),
        top_k: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe(`返回片段数，默认 ${DEFAULT_KNOWLEDGE_TOP_K}`),
      }),
      handler: async ({ query, top_k }) => {
        const hits = await knowledge.search(query, top_k ?? DEFAULT_KNOWLEDGE_TOP_K);
        if (hits.length === 0) {
          // 空结果要给出下一步动作，否则模型容易拿同样的参数反复重试
          const docs = await knowledge.docs();
          return {
            query,
            hits: [],
            hint:
              docs.length === 0
                ? "知识库为空（目录下没有 .md/.txt 文档），请改用 web_search 或基于已有信息作答。"
                : `知识库中无匹配片段，现有文档：${docs.map((doc) => doc.source).join("、")}`,
          };
        }
        return {
          query,
          hits: hits.map((hit) => ({
            source: hit.chunk.source,
            heading: hit.chunk.heading,
            // 只给到日期：判断新旧够用，也比完整时间戳省 token
            updated_at: formatDate(hit.chunk.updatedAt),
            score: Number(hit.score.toFixed(4)),
            text: hit.chunk.text,
          })),
        };
      },
    }),
  );
}

/** 本地时区的 YYYY-MM-DD；用 UTC 会让凌晨修改的文件显示成前一天 */
function formatDate(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
