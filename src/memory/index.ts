/** 记忆模块对外入口。 */

import type { Settings } from "../core/config.js";
import { getLogger } from "../core/logging.js";
import type { BaseLLM } from "../llm/base.js";
import type { LongTermMemory } from "./base.js";
import { LifecycleMemory } from "./lifecycle.js";
import { MemOsMemory } from "./memos.js";
import { JsonlLongTermMemory } from "./store.js";

const logger = getLogger("miniagent.memory");

export type {
  ConversationAwareMemory,
  ConversationTurn,
  LongTermMemory,
  MemoryRecord,
  MemorySearchOptions,
} from "./base.js";
export {
  estimateTokens,
  isConversationMemory,
  matchesSession,
  messagesTokens,
  rememberTurn,
} from "./base.js";
export { applyWindow, type WindowResult } from "./buffer.js";
export {
  DEFAULT_SUMMARY_OPTIONS,
  SummaryMemory,
  type SummaryMemoryOptions,
} from "./summary.js";
export { JsonlLongTermMemory } from "./store.js";
export { MemOsMemory, type MemOsOptions } from "./memos.js";
export {
  LifecycleMemory,
  type ConsolidateOptions,
  type LifecycleMemoryOptions,
  type StoredMemory,
} from "./lifecycle.js";
export {
  composeScore,
  decayedConfidence,
  DEFAULT_PRIORITY,
  DECAY_PER_DAY,
  hasContradictionCue,
  inferKind,
  RECALL_BOOST,
  recencyScore,
  SIGNAL_WEIGHTS,
  type MemoryKind,
} from "./scoring.js";
export { baseTokens, TfidfIndex, tokenize } from "./textIndex.js";

/** 可选的长期记忆后端 */
export type MemoryBackend = "jsonl" | "lifecycle" | "memos";

/**
 * 决定用哪个后端。
 * 显式配置优先；未配置时按"有没有 MemOS key"自动选，保持向后兼容。
 * 只配了 memos 却没给 key 时降级到 jsonl，并给出明确告警——避免静默失效。
 */
export function resolveMemoryBackend(settings: Settings): MemoryBackend {
  const configured = settings.memoryBackend.trim().toLowerCase();

  if (configured === "lifecycle") return "lifecycle";
  if (configured === "jsonl") return "jsonl";

  if (configured === "memos" || (!configured && settings.memosApiKey)) {
    if (settings.memosApiKey) return "memos";
    logger.warning(
      "MINIAGENT_MEMORY_BACKEND=memos 但未配置 MINIAGENT_MEMOS_API_KEY，回退到本地 JSONL",
    );
    return "jsonl";
  }

  if (configured) {
    logger.warning(
      `未知的 MINIAGENT_MEMORY_BACKEND="${configured}"，回退到本地 JSONL`,
    );
  }
  return "jsonl";
}

/**
 * 按配置构造长期记忆后端。
 *
 * 上层（Agent / Server / CLI）只依赖 LongTermMemory 接口，
 * 因此换后端不需要改它们的代码——这正是当初把它抽成接口的用意。
 *
 * @param summarize 记忆巩固用的语义压缩器；不传则不启用巩固（jsonl / memos 后端用不到）
 */
export function createLongTermMemory(
  settings: Settings,
  summarize?: (texts: string[]) => Promise<string | undefined>,
): LongTermMemory {
  switch (resolveMemoryBackend(settings)) {
    case "memos":
      return new MemOsMemory({
        apiKey: settings.memosApiKey,
        baseUrl: settings.memosBaseUrl,
        userId: settings.memosUserId,
        timeout: settings.memosTimeout,
      });
    case "lifecycle":
      return new LifecycleMemory({
        filePath: settings.lifecycleMemoryFile,
        consolidate: summarize
          ? {
              threshold: settings.memoryConsolidateThreshold,
              batch: settings.memoryConsolidateBatch,
              maxChars: settings.memoryArchiveChars,
              summarize,
            }
          : undefined,
      });
    default:
      return new JsonlLongTermMemory(settings.longTermMemoryFile);
  }
}

/**
 * 记忆巩固用的语义压缩器：把一批低分记忆压成一段归档摘要。
 * 与 SummaryMemory 的压缩同源思路——都只保留"目标与偏好 / 已确认结论 / 未决问题"三类信息。
 */
export function createMemorySummarizer(
  llm: BaseLLM,
  settings: Settings,
): (texts: string[]) => Promise<string | undefined> {
  return async (texts: string[]) => {
    const prompt = [
      `请把下面 ${texts.length} 条历史记忆压缩成一段不超过 ${settings.memoryArchiveChars} 字的归档摘要。`,
      "只保留三类信息：用户的目标与偏好、已经确认的事实与结论、尚未解决的问题。",
      "合并重复与过时内容，删掉寒暄和过程细节。不要分点，直接输出摘要正文。",
      `待压缩记忆：\n${texts.map((text, i) => `${i + 1}. ${text}`).join("\n")}`,
    ].join("\n\n");

    const response = await llm.chat([{ role: "user", content: prompt }], []);
    return response.content.trim() || undefined;
  };
}

/** 供启动日志展示当前实际生效的记忆后端 */
export function describeLongTermMemory(settings: Settings): string {
  switch (resolveMemoryBackend(settings)) {
    case "memos":
      return `MemOS 云记忆（user=${settings.memosUserId}）`;
    case "lifecycle":
      return `本地生命周期记忆（置信度 / 矛盾消解 / 遗忘曲线 / 巩固，${settings.lifecycleMemoryFile}）`;
    default:
      return `本地 JSONL（${settings.longTermMemoryFile}）`;
  }
}
