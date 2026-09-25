/** PromptBuilder：分段拼接、版本记录、动态上下文注入、输出稳定性。 */

import { describe, expect, it } from "vitest";

import { PromptBuilder, type PromptContext, type PromptSegment } from "../src/prompts/builder.js";
import { createDefaultPromptBuilder } from "../src/prompts/system.js";

const baseContext: PromptContext = {
  skills: [],
  memorySummary: "",
  recalledMemory: [],
  toolNames: [],
};

describe("PromptBuilder", () => {
  it("按顺序拼接非空段，并记录全部段版本", () => {
    const segments: PromptSegment[] = [
      { id: "a", version: "1.0.0", render: () => "第一段" },
      { id: "empty", version: "1.0.0", render: () => "   " },
      { id: "b", version: "2.1.0", render: () => "第二段" },
    ];
    const { text, versions } = new PromptBuilder(segments).build(baseContext);

    expect(text).toBe("第一段\n\n第二段");
    // 空段不产出文本，但版本仍记录，便于 eval 归因
    expect(versions).toEqual(["a@1.0.0", "empty@1.0.0", "b@2.1.0"]);
  });

  it("输出是确定性的：同样输入必然同样输出", () => {
    const builder = createDefaultPromptBuilder();
    expect(builder.build(baseContext).text).toBe(builder.build(baseContext).text);
  });

  it("默认提示词全文与段版本快照（改动段内容或版本号会在这里暴露）", () => {
    const { text, versions } = createDefaultPromptBuilder().build({
      ...baseContext,
      skills: [{ name: "research_report", description: "写简报", whenToUse: "调研时" }],
      memorySummary: "用户偏好简洁回答",
      recalledMemory: ["上周问过 DeepSeek 发布时间"],
      toolNames: ["web_search", "load_skill", "search_knowledge"],
    });

    // 这两份快照是提示词的防漂移闸门：有意修改后需 `npm test -- -u` 显式接受变更
    expect(text).toMatchSnapshot("prompt-text");
    expect(versions).toMatchSnapshot("segment-versions");
  });

  it("技能目录、记忆摘要、召回片段按上下文注入", () => {
    const { text } = createDefaultPromptBuilder().build({
      ...baseContext,
      skills: [{ name: "research_report", description: "写简报", whenToUse: "调研时" }],
      memorySummary: "用户偏好简洁回答",
      recalledMemory: ["上周问过 DeepSeek 发布时间"],
      toolNames: ["web_search", "load_skill"],
    });

    expect(text).toContain("research_report");
    expect(text).toContain("用户偏好简洁回答");
    expect(text).toContain("上周问过 DeepSeek 发布时间");
    expect(text).toContain("load_skill");
  });

  it("没有技能时不出技能目录段，也没有记忆段", () => {
    const { text } = createDefaultPromptBuilder().build(baseContext);

    expect(text).not.toContain("## 可用技能");
    expect(text).not.toContain("## 早前对话摘要");
    expect(text).not.toContain("## 相关历史记忆");
  });

  it("注册了 powershell 才提示「时间要靠工具取」，否则不提", () => {
    // 模型的训练数据里没有"现在"，不给工具就不该鼓励它去猜时间
    const withTool = createDefaultPromptBuilder().build({
      ...baseContext,
      toolNames: ["powershell"],
    }).text;
    expect(withTool).toContain("Get-Date");
    expect(withTool).toContain("不要凭记忆或推测作答");

    const withoutTool = createDefaultPromptBuilder().build({
      ...baseContext,
      toolNames: ["calculator"],
    }).text;
    expect(withoutTool).not.toContain("Get-Date");
  });

  it("注册了 create_skill 才提示「把跑通的做法固化成技能」，否则不提", () => {
    const withTool = createDefaultPromptBuilder().build({
      ...baseContext,
      toolNames: ["load_skill", "create_skill"],
    }).text;
    expect(withTool).toContain("create_skill");
    expect(withTool).toContain("固化成技能");

    const withoutTool = createDefaultPromptBuilder().build({
      ...baseContext,
      toolNames: ["load_skill"],
    }).text;
    expect(withoutTool).not.toContain("固化成技能");
  });

  it("能写文件时才教「写脚本再执行」这条工作法，并点明 python3 的坑", () => {
    // 只给 shell 不给 write_file 时，模型没有落脚本的地方，提这条只会引导它去乱写
    const full = createDefaultPromptBuilder().build({
      ...baseContext,
      toolNames: ["powershell", "write_file", "read_file"],
    }).text;
    expect(full).toContain("scripts/");
    expect(full).toContain("不要写 python3");

    const shellOnly = createDefaultPromptBuilder().build({
      ...baseContext,
      toolNames: ["powershell"],
    }).text;
    expect(shellOnly).not.toContain("不要写 python3");
  });

  it("证据规则两个方向都写上：既不否定历史执行，也不放任声称未发生的调用", () => {
    // 起因是一次实测误判：当前工具清单里没有某个工具，模型就推翻了自己上一轮真实的调用记录。
    // 只写"不要否定历史"会反向加固真正的编造，所以两条必须成对出现。
    const { text } = createDefaultPromptBuilder().build(baseContext);

    expect(text).toContain("不代表过去");
    expect(text).toContain("只有真的收到过工具返回");
    // 没有执行记录时不出现台账行，避免凭空给出一份"事实"
    expect(text).not.toContain("上一轮实际执行");
  });

  it("有执行记录时把它作为系统写入的事实写进提示词，并声明不是模型自己的输出", () => {
    const { text } = createDefaultPromptBuilder().build({
      ...baseContext,
      executionLedger: [
        { name: "mcp__echo__echo", ok: true },
        { name: "no_such_tool", ok: false },
      ],
    });

    expect(text).toContain("〔上一轮实际执行〕mcp__echo__echo 成功；no_such_tool 失败");
    expect(text).toContain("不是你的输出");
    expect(text).toContain("不得否认或改写");
  });
});
