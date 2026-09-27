/**
 * 工作记忆滑窗：按 token 预算保留最近的消息，保证不超出上下文。
 *
 * 两条硬规则：
 *   1. 首条 system 消息永远保留（它承载身份与工具策略）
 *   2. 不能从 role=tool 的消息开始保留——它的配对 assistant 消息若被裁掉，
 *      DeepSeek 会因"孤立 tool 消息"直接报 400，必须一并裁掉
 */

import type { Message } from "../core/types.js";
import { estimateTokens, messagesTokens } from "./base.js";

export interface WindowResult {
  /** 预算内保留的消息 */
  kept: Message[];
  /** 被裁掉的消息（交给摘要压缩） */
  dropped: Message[];
}

export function applyWindow(messages: Message[], maxTokens: number): WindowResult {
  if (messages.length === 0) return { kept: [], dropped: [] };

  const first = messages[0]!;
  const pinned = first.role === "system" ? [first] : [];
  const pool = first.role === "system" ? messages.slice(1) : messages;

  // 从最新往回装，装不下就停
  let used = messagesTokens(pinned);
  let keptStart = pool.length;
  for (let i = pool.length - 1; i >= 0; i--) {
    const cost = estimateTokens(pool[i]!.content) + 4;
    // keptStart === pool.length 表示还没装入任何消息，至少保留一条
    if (used + cost > maxTokens && keptStart < pool.length) break;
    used += cost;
    keptStart = i;
  }

  // 修正起点：不能以孤立的 tool 消息开头
  while (keptStart < pool.length && pool[keptStart]!.role === "tool") {
    keptStart++;
  }

  return {
    kept: [...pinned, ...pool.slice(keptStart)],
    dropped: pool.slice(0, keptStart),
  };
}
