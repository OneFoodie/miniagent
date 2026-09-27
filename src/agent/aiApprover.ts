/**
 * AI 审批器：被交给「自动 AI 审批」档时，用它代替人裁决一条敏感工具调用。
 *
 * 定位（必须说清，否则会被误当成安全防线）：它是**减少打扰的便利层**，
 * AI 说行就跑，判错的后果没人拦。所以每次裁决的理由都要进轨迹，可被事后核对。
 *
 * 失败策略：**任何异常都转成「拒绝」，绝不向外抛**。
 * 不降级成「问人」（这一档的承诺就是不打扰人），也不放行（那等于失败即全开）。
 */

import type { Settings } from "../core/config.js";
import type { AiVerdict, ToolApprover } from "../core/permission.js";
import type { ToolCall } from "../core/types.js";
import type { BaseLLM } from "../llm/base.js";
import {
  renderApprovalSystemPrompt,
  renderApprovalUserPrompt,
} from "../prompts/approval.js";

export type { AiVerdict } from "../core/permission.js";

/** 解析失败与调用失败共用的理由前缀，便于在轨迹里一眼认出「不是裁决、是故障」 */
const UNPARSABLE_REASON = "裁决输出不可解析";

export class AiApprover implements ToolApprover {
  constructor(
    private readonly llm: BaseLLM,
    private readonly settings: Settings,
  ) {}

  /** 判定一次工具调用；任何异常都不向外抛，调用方按「拒绝」处理并记录原因 */
  async judge(call: ToolCall, question: string, signal: AbortSignal): Promise<AiVerdict> {
    try {
      // 不传 tools：裁决只问一个问题，模型没有理由再发起工具调用
      const response = await this.llm.chat(
        [
          { role: "system", content: renderApprovalSystemPrompt() },
          { role: "user", content: renderApprovalUserPrompt(call, question) },
        ],
        undefined,
        signal,
      );
      return parseVerdict(response.content);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { verdict: "deny", reason: `审批服务不可用: ${reason}` };
    }
  }
}

/**
 * 从模型回复里提取第一个 `{...}` 块并解析。
 * 模型可能给代码块或前后缀文字，所以只取第一个花括号块，不做更宽的容错。
 * 解析失败、缺字段、verdict 非法 → 一律拒绝：宁可挂起也不误放。
 */
function parseVerdict(content: string): AiVerdict {
  const match = /\{[\s\S]*?\}/.exec(content);
  if (!match) return { verdict: "deny", reason: UNPARSABLE_REASON };
  let parsed: { verdict?: unknown; reason?: unknown };
  try {
    parsed = JSON.parse(match[0]) as { verdict?: unknown; reason?: unknown };
  } catch {
    return { verdict: "deny", reason: UNPARSABLE_REASON };
  }
  if (parsed.verdict !== "approve" && parsed.verdict !== "deny") {
    return { verdict: "deny", reason: UNPARSABLE_REASON };
  }
  return {
    verdict: parsed.verdict,
    reason: typeof parsed.reason === "string" ? parsed.reason : "",
  };
}
