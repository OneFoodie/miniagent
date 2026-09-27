/**
 * AI 审批裁决的提示词分段（与 system.ts 同一分段风格：带 id@version、便于归因）。
 *
 * 单独成文件而不是塞进 aiApprover.ts：提示词的措辞直接决定放行/拒绝的宽松程度，
 * 是这套机制里最需要被单独审阅、单独改版本号的部分。
 */

import type { ToolCall } from "../core/types.js";

/** 提示词版本；裁决口径变化时递增，便于事后归因是哪一版影响了放行率 */
export const APPROVAL_PROMPT_ID = "ai_approval@1.0.0";

/**
 * 裁决器系统提示。
 *
 * 判「拒绝」的口径刻意保守（破坏性、越界、无关、外发敏感数据），因为这一档
 * 承诺的是「少打扰」，放宽的代价是不该跑的命令被放出去；但也不能全拒——
 * 全拒等于退化成手动审批，用户选这一档就失去了意义。
 */
const system = `你是工具调用的安全裁决器。用户把「是否执行某条敏感工具调用」的决定权交给你。
你只能基于「用户当前请求」与「待裁决的工具调用」判断，不要臆测不存在的上下文。

判「拒绝」的情形：
- 不可逆的破坏性操作：删库、格式化磁盘、批量删除、覆盖关键文件等；
- 明显越出用户请求范围的操作（用户要查询，却要写入/删除）；
- 与当前任务明显无关的操作；
- 会把敏感数据外发的操作（上传、推送到外部地址）。

判「放行」的情形：
- 只读查询（查看时间、读取信息、检索）；
- 与用户明确要求一致的操作；
- 可逆、影响范围可控的操作。

无论结论如何，都只输出一个 JSON 对象，不要输出解释文字或代码块标记：
{"verdict":"approve" 或 "deny","reason":"不超过 40 字的中文理由"}`;

export function renderApprovalSystemPrompt(): string {
  return system;
}

/** 裁决器的用户消息：把用户意图与待裁决调用放进去 */
export function renderApprovalUserPrompt(call: ToolCall, question: string): string {
  return [
    `用户当前的请求：${question.trim() || "（未提供）"}`,
    `待裁决的工具：${call.name}`,
    `参数：${JSON.stringify(call.arguments)}`,
    "",
    `请判断是否放行，并只输出 {"verdict":"approve" 或 "deny","reason":"不超过 40 字"}`,
  ].join("\n");
}
