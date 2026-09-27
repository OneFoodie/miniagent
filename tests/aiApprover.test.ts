/**
 * AI 审批器：放行 / 拒绝 / 输出不可解析 / 调用失败四条路径。
 * 关键约束是 **judge 永不抛异常**——失败一律转成「拒绝」。
 */

import { describe, expect, it } from "vitest";

import { AiApprover } from "../src/agent/aiApprover.js";
import { loadSettings } from "../src/core/config.js";
import type { LLMResponse, ToolCall } from "../src/core/types.js";
import { FakeLLM } from "./fakes.js";

process.env.MINIAGENT_DEEPSEEK_API_KEY = "test-key";

const call: ToolCall = {
  id: "c1",
  name: "shell",
  arguments: { command: "rm -rf /tmp/x" },
};

const signal = new AbortController().signal;

function reply(content: string): LLMResponse {
  return {
    content,
    toolCalls: [],
    usage: { promptTokens: 10, completionTokens: 5 },
    finishReason: "stop",
  };
}

function approverWith(response: LLMResponse): { ai: AiApprover; llm: FakeLLM } {
  const llm = new FakeLLM([response]);
  return { ai: new AiApprover(llm, loadSettings()), llm };
}

describe("AiApprover.judge", () => {
  it("模型放行 → approve，理由透传", async () => {
    const { ai } = approverWith(reply('{"verdict":"approve","reason":"只读查询"}'));
    await expect(ai.judge(call, "看下时间", signal)).resolves.toEqual({
      verdict: "approve",
      reason: "只读查询",
    });
  });

  it("模型拒绝 → deny，理由透传", async () => {
    const { ai } = approverWith(reply('{"verdict":"deny","reason":"破坏性操作"}'));
    await expect(ai.judge(call, "清理临时文件", signal)).resolves.toEqual({
      verdict: "deny",
      reason: "破坏性操作",
    });
  });

  it("JSON 被代码块包裹时也能提取第一个 {...} 块", async () => {
    const { ai } = approverWith(
      reply('```json\n{"verdict":"approve","reason":"可逆"}\n```'),
    );
    await expect(ai.judge(call, "查一下", signal)).resolves.toMatchObject({
      verdict: "approve",
    });
  });

  it("输出不可解析 → deny，理由含「不可解析」", async () => {
    const { ai } = approverWith(reply("我觉得可以吧"));
    const verdict = await ai.judge(call, "查一下", signal);
    expect(verdict.verdict).toBe("deny");
    expect(verdict.reason).toContain("不可解析");
  });

  it("verdict 字段非法 → deny，理由含「不可解析」", async () => {
    const { ai } = approverWith(reply('{"verdict":"maybe","reason":"?"}'));
    const verdict = await ai.judge(call, "查一下", signal);
    expect(verdict.verdict).toBe("deny");
    expect(verdict.reason).toContain("不可解析");
  });

  it("LLM 抛异常 → judge 不抛，返回 deny 且理由含失败原因", async () => {
    // 空脚本：FakeLLM 一被调用就抛「脚本已耗尽」
    const ai = new AiApprover(new FakeLLM([]), loadSettings());
    const verdict = await ai.judge(call, "查一下", signal);
    expect(verdict.verdict).toBe("deny");
    expect(verdict.reason).toContain("审批服务不可用");
  });

  it("调用时不传 tools（裁决只问一个问题）", async () => {
    const { ai, llm } = approverWith(reply('{"verdict":"approve","reason":"ok"}'));
    await ai.judge(call, "查一下", signal);
    expect(llm.calls[0]!.tools).toBeUndefined();
  });
});
