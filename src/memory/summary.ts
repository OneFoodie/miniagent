/**
 * 摘要记忆：滑窗裁掉的历史达到阈值时，用 LLM 把它压缩成摘要，
 * 摘要随后由提示词的 memory_summary 段注入，从而在不超预算的前提下保住长程信息。
 *
 * 注意两次调用的分工：滑窗负责"不超预算"，摘要负责"不丢信息"。
 * 只有被裁掉的内容足够多时才触发压缩，避免每轮都多花一次 LLM 调用。
 */

import { getLogger } from "../core/logging.js";
import type { Message } from "../core/types.js";
import type { BaseLLM } from "../llm/base.js";
import { messagesTokens } from "./base.js";
import { applyWindow } from "./buffer.js";

const logger = getLogger("miniagent.memory");

export interface SummaryMemoryOptions {
  /** 滑窗 token 预算 */
  maxTokens: number;
  /** 被裁掉的历史达到该 token 数才触发压缩 */
  summarizeThreshold: number;
  /** 摘要字数上限 */
  maxSummaryChars: number;
}

export const DEFAULT_SUMMARY_OPTIONS: SummaryMemoryOptions = {
  maxTokens: 6000,
  summarizeThreshold: 2000,
  maxSummaryChars: 400,
};

export class SummaryMemory {
  private summary = "";

  constructor(
    private readonly llm: BaseLLM,
    private readonly options: SummaryMemoryOptions = DEFAULT_SUMMARY_OPTIONS,
  ) {}

  get currentSummary(): string {
    return this.summary;
  }

  /** 裁剪历史使其落入预算（必要时先更新摘要），返回可直接喂给模型的消息 */
  async prepare(messages: Message[], signal?: AbortSignal): Promise<Message[]> {
    const { kept, dropped } = applyWindow(messages, this.options.maxTokens);
    if (dropped.length > 0 && messagesTokens(dropped) >= this.options.summarizeThreshold) {
      await this.refreshSummary(dropped, signal);
    }
    return kept;
  }

  /** 把被裁掉的消息合并进摘要；压缩失败只记警告，不影响本轮对话 */
  private async refreshSummary(dropped: Message[], signal?: AbortSignal): Promise<void> {
    const transcript = dropped
      .map((message) => `${roleLabel(message.role)}: ${message.content}`)
      .join("\n");

    const sections = [
      `请把下面的对话压缩成不超过 ${this.options.maxSummaryChars} 字的摘要，分两节输出。`,
      "第一节，标题写「【指令与约束】」：",
      "把用户明确提出过的要求、规则、禁止事项**逐字引用原文**，不要改写、不要概括、不要把同义表述合并——" +
        "这类内容一旦被改写就可能失去约束力。没有这类内容就写「无」。",
      "第二节，标题写「【摘要】」：",
      "只保留三类信息：用户的目标与偏好、已经确认的事实与结论、尚未解决的问题。" +
        "不要寒暄，不要分点，直接写正文。",
    ];
    if (this.summary) {
      sections.push(`已有摘要（请把它的要点合并进新摘要）：\n${this.summary}`);
    }
    sections.push(`待压缩对话：\n${transcript}`);

    try {
      const response = await this.llm.chat(
        [{ role: "user", content: sections.join("\n\n") }],
        [],
        signal,
      );
      const text = response.content.trim();
      if (text) this.summary = text;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warning(`历史摘要压缩失败，沿用旧摘要: ${message}`);
    }
  }
}

function roleLabel(role: Message["role"]): string {
  if (role === "user") return "用户";
  if (role === "assistant") return "助手";
  if (role === "tool") return "工具";
  return "系统";
}
