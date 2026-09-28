/** 记忆模块的公共抽象与 token 估算。 */

import type { Message } from "../core/types.js";

/** 长期记忆的一条记录 */
export interface MemoryRecord {
  /** 记录正文 */
  text: string;
  /** 写入时间（Unix 秒） */
  ts: number;
  /** 附加元数据（会话 id、角色等） */
  meta?: Record<string, unknown>;
}

/**
 * 检索范围。长期记忆是**跨会话共用一个文件**的，但会话之间必须互相看不见，
 * 因此检索时要能限定在「本次会话自己写入的那些记录」上——范围由调用方（Agent）给出。
 */
export interface MemorySearchOptions {
  /**
   * 会话 id。给了就只召回该会话写入的记忆；省略则不按会话过滤
   * （CLI / 评测这类没有会话概念的场景靠这个默认值保持原行为）。
   */
  sessionId?: string;
}

/**
 * 一条记录的 meta 是否落在检索范围内。
 *
 * 判定刻意是**严格相等**而不是「没有 sessionId 就算公共记忆」：后者会让早期写入的
 * 无会话记录渗进每一个会话，正是要消除的那种串台。
 */
export function matchesSession(
  meta: Record<string, unknown> | undefined,
  options?: MemorySearchOptions,
): boolean {
  const sessionId = options?.sessionId;
  if (!sessionId) return true;
  return meta?.sessionId === sessionId;
}

/** 可插拔的长期记忆后端。
 * v1 提供 JSONL 文件实现；将来换向量库只需要实现同一接口，调用方无需改动。
 */
export interface LongTermMemory {
  add(record: MemoryRecord): Promise<void>;
  /**
   * 按关键词相关性（含时间衰减）检索。
   * `options.sessionId` 用于把召回限制在本会话内，实现会话独立。
   */
  search(
    query: string,
    limit?: number,
    options?: MemorySearchOptions,
  ): Promise<MemoryRecord[]>;
  /** 取最近的若干条 */
  load(limit?: number): Promise<MemoryRecord[]>;
}

/** 对话中的一轮 */
export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * 支持按"原始对话"写入的长期记忆后端。
 *
 * MemOS 这类系统靠 LLM 从原始对话里抽取记忆，把完整的问答对交给它，
 * 抽取质量明显好于只给一段拼好的文本，因此单独开一个接口而不是硬塞进 add()。
 */
export interface ConversationAwareMemory extends LongTermMemory {
  /** conversationId 用于让后端把同一会话的记忆归组，缺省时由后端自行决定 */
  addConversation(
    turns: ConversationTurn[],
    context?: { conversationId?: string },
  ): Promise<void>;
}

export function isConversationMemory(
  memory: LongTermMemory,
): memory is ConversationAwareMemory {
  return typeof (memory as ConversationAwareMemory).addConversation === "function";
}

/**
 * 把一轮问答写入长期记忆。
 * 后端支持对话写入时按真实角色写，否则退化为一条自包含文本。
 */
export async function rememberTurn(
  memory: LongTermMemory,
  turn: {
    question: string;
    answer: string;
    /** 写入时间（Unix 秒） */
    ts: number;
    /** 所属会话 id（可选），供对话型后端归组 */
    conversationId?: string;
    meta?: Record<string, unknown>;
  },
): Promise<void> {
  if (isConversationMemory(memory)) {
    await memory.addConversation(
      [
        { role: "user", content: turn.question },
        { role: "assistant", content: turn.answer },
      ],
      { conversationId: turn.conversationId },
    );
    return;
  }
  await memory.add({
    text: `问：${turn.question}\n答：${turn.answer}`,
    ts: turn.ts,
    meta: turn.meta,
  });
}

/**
 * 粗略 token 估算：按 2 字符≈1 token 计。
 * 只用于"预算裁剪"这类容错场景，不追求与真实分词器一致。
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2);
}

/** 一组消息的估算 token 数（每条额外计 4 作为角色/分隔开销） */
export function messagesTokens(messages: Message[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message.content) + 4, 0);
}
