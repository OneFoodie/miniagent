/**
 * MemOS 云记忆后端。
 *
 * 为什么不直接用官方 SDK：MemOS 官方 SDK 是 Python（`pip install MemoryOS`，需 Python 3.10+），
 * 本框架是 TypeScript，因此直接调用它开放的 HTTP API，零额外依赖。
 *
 * 顺带避坑：搜索 "memos" 会大量命中同名的自托管笔记应用 usememos.com，
 * 与本文件对接的 MemOS（openmem.net / MemTensor）毫无关系。
 *
 * 用到的两个核心端点：
 *   POST {base}/add/message     把原始对话交给 MemOS，由它抽取并落库
 *   POST {base}/search/memory   按当前问题召回记忆（事实记忆 + 偏好记忆）
 *
 * 失败策略：记忆是增强能力而非关键路径。任何网络/协议错误都只记警告并返回空结果，
 * 绝不把异常抛给主循环——这与工具故障隔离是同一个思路。
 */

import { getLogger } from "../core/logging.js";
import type {
  ConversationAwareMemory,
  ConversationTurn,
  MemoryRecord,
  MemorySearchOptions,
} from "./base.js";

const logger = getLogger("miniagent.memos");

export interface MemOsOptions {
  apiKey: string;
  baseUrl: string;
  /** 记忆归属的用户标识；同一个人跨会话必须保持一致 */
  userId: string;
  /** 单次请求超时（秒） */
  timeout: number;
  /** fetch 实现，便于测试注入；默认为全局 fetch */
  fetchImpl?: typeof fetch;
}

/** MemOS 返回的单条记忆 */
interface MemOsMemoryItem {
  id?: string;
  memory_key?: string;
  memory_value?: string;
  memory_type?: string;
  tags?: string[];
  relativity?: number;
  update_time?: number;
}

interface MemOsPayload {
  memory_detail_list?: MemOsMemoryItem[];
  preference_detail_list?: MemOsMemoryItem[];
  preference_note?: string;
}

interface MemOsEnvelope {
  code?: number;
  message?: string;
  data?: MemOsPayload;
}

/** MemOS 单次召回条数上限 */
const MAX_LIMIT = 25;

export class MemOsMemory implements ConversationAwareMemory {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: MemOsOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** 通用写入：把整条记录当作一条用户消息（信息已自包含） */
  async add(record: MemoryRecord): Promise<void> {
    const sessionId = record.meta?.sessionId;
    await this.addConversation([{ role: "user", content: record.text }], {
      conversationId: typeof sessionId === "string" ? sessionId : undefined,
    });
  }

  /** 按真实角色写入一轮对话，抽取质量优于拼成一段文本 */
  async addConversation(
    turns: ConversationTurn[],
    context?: { conversationId?: string },
  ): Promise<void> {
    if (turns.length === 0) return;
    const result = await this.post("/add/message", {
      user_id: this.options.userId,
      conversation_id: context?.conversationId ?? this.options.userId,
      messages: turns.map((turn) => ({
        role: turn.role,
        content: turn.content,
      })),
    });
    if (!result.ok) {
      logger.warning(`MemOS 写入失败: ${result.error}`);
    }
  }

  /**
   * 召回。`options.sessionId` **在这里无法生效**：MemOS 云 API 的检索只有 `user_id`
   * 这一个维度，没有按会话过滤的参数，返回结果里也不带会话标识。要真正按会话隔离，
   * 用本地后端（jsonl / lifecycle）。
   */
  async search(
    query: string,
    limit = 5,
    _options?: MemorySearchOptions,
  ): Promise<MemoryRecord[]> {
    if (!query.trim()) return [];
    const result = await this.post("/search/memory", {
      query,
      user_id: this.options.userId,
      memory_limit_number: clampLimit(limit),
      include_preference: true,
      preference_limit_number: clampLimit(limit),
    });
    if (!result.ok) {
      logger.warning(`MemOS 召回失败: ${result.error}`);
      return [];
    }
    return toRecords(result.data, limit);
  }

  /**
   * MemOS 云 API 只提供"按查询检索"，没有"列举全部记忆"的语义，
   * 因此这里返回空数组；需要枚举场景请使用 JsonlLongTermMemory。
   */
  async load(): Promise<MemoryRecord[]> {
    return [];
  }

  /** 统一的 POST 封装：永不抛异常，失败以 { ok: false } 返回 */
  private async post(
    path: string,
    body: Record<string, unknown>,
  ): Promise<{ ok: true; data: MemOsPayload } | { ok: false; error: string }> {
    const url = `${this.options.baseUrl.replace(/\/+$/, "")}${path}`;
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Token ${this.options.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeout * 1000),
      });
      if (!response.ok) {
        return { ok: false, error: `HTTP ${response.status}` };
      }
      const envelope = (await response.json()) as MemOsEnvelope;
      // 业务错误码：code !== 0 视为失败
      if (typeof envelope.code === "number" && envelope.code !== 0) {
        return {
          ok: false,
          error: `code=${envelope.code} ${envelope.message ?? ""}`.trim(),
        };
      }
      return { ok: true, data: envelope.data ?? {} };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  }
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit < 1) return 1;
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

/** 事实记忆 + 偏好记忆合并，按相关性排序后转成统一的记忆记录 */
function toRecords(payload: MemOsPayload, limit: number): MemoryRecord[] {
  const items = [
    ...(payload.memory_detail_list ?? []),
    ...(payload.preference_detail_list ?? []),
  ];
  return items
    .map((item) => ({ item, text: formatItem(item) }))
    .filter((entry) => entry.text !== "")
    .sort((a, b) => (b.item.relativity ?? 0) - (a.item.relativity ?? 0))
    .slice(0, clampLimit(limit))
    .map(({ item, text }) => ({
      text,
      ts: (item.update_time ?? Date.now()) / 1000,
      meta: {
        memoryId: item.id,
        memoryType: item.memory_type,
        tags: item.tags,
      },
    }));
}

/** 把一条记忆压成一行：key 与 value 相同则只保留一份 */
function formatItem(item: MemOsMemoryItem): string {
  const key = item.memory_key?.trim() ?? "";
  const value = item.memory_value?.trim() ?? "";
  if (!value) return key;
  if (!key || key === value) return value;
  return `${key}：${value}`;
}
