/**
 * 子 agent 的角色预设。
 *
 * 业界做法（CrewAI 的 role/goal/backstory、Microsoft Agent Framework 的 specialized agents）都指向同一件事：
 * 同一个任务换个"身份"去执行，关注点与产出形态会明显不同——调研员要出处，分析员要口径，
 * 复核员要反例。与其在一个通用提示词里互相扯皮，不如让父 agent 显式选角色。
 *
 * 每个角色两件事：**一段补充提示词** + **一份工具白名单**。
 * 白名单是硬约束：复核员拿不到写文件的权限，这是"角色"而非"语气"的关键。
 */

import { PromptBuilder, type PromptSegment } from "./builder.js";
import { createDefaultPromptBuilder, DEFAULT_PROMPT_SEGMENTS } from "./system.js";

export interface RolePreset {
  /** 角色标识，父 agent 通过它选择 */
  name: string;
  /** 一句话说明"什么时候该派它"，会被拼进 run_subagent 的工具描述 */
  whenToUse: string;
  /** 角色补充提示词：只写"这个身份关注什么"，通用规则仍由默认段承担 */
  prompt: string;
  /**
   * 工具白名单。省略表示「除子 agent 工具外全部可用」；
   * 若白名单里的名字一个都不存在（工具集被裁剪过），退回全部可用，避免子 agent 空手。
   */
  tools?: string[];
}

export const ROLE_PRESETS: Readonly<Record<string, RolePreset>> = {
  researcher: {
    name: "researcher",
    whenToUse: "需要翻阅多份资料、交叉验证事实并给出带出处的结论时",
    prompt: `你现在是**调研员**，只对「事实是什么」负责。
- 每个关键结论后面必须标出来源（文档名或 URL）；找不到来源的说法，明确标注为推测。
- 多份资料冲突时，把冲突本身写进结论（谁说了什么、差在哪里），不要私自挑一个当答案。
- 不要下投资/决策建议，那是分析员的活。`,
    tools: ["search_knowledge", "web_search", "http_fetch", "read_file", "load_skill"],
  },
  analyst: {
    name: "analyst",
    whenToUse: "需要对已有材料做量化分析、对比或推导结论时",
    prompt: `你现在是**分析员**，只对「数据说明什么」负责。
- 一切数值计算都走 calculator，不要心算；关键结论要给出算式或口径。
- 明确写出假设与前提前提；假设变了结论会怎么变，要顺带说一句。
- 引用数字必须注明它来自哪份材料；材料没给的数据就说"缺失"，不要估算成事实。`,
    tools: ["calculator", "search_knowledge", "read_file", "load_skill"],
  },
  critic: {
    name: "critic",
    whenToUse: "需要对已有结论做独立复核、找漏洞与反例时",
    prompt: `你现在是**复核员**，只对「这个结论站不站得住」负责。
- 不要复述或润色原结论，直接列出：证据不足之处、逻辑跳跃、被忽略的反例、以及可能的其他解释。
- 每一条质疑都要指向具体的原文或数据；没有依据的"感觉不对"不要写。
- 若复核后认为结论成立，明确说"未发现实质问题"并给出你检查过的范围。`,
    tools: ["search_knowledge", "read_file", "http_fetch"],
  },
};

/** 查角色；未知名字返回 undefined（由调用方决定是报错还是退回通用） */
export function findRole(name: string): RolePreset | undefined {
  return ROLE_PRESETS[name.trim().toLowerCase()];
}

/** 未知角色时给出的候选清单，形如 `researcher/analyst/critic` */
export function knownRoles(): string {
  return Object.keys(ROLE_PRESETS).join("/");
}

/** 拼进工具描述的角色清单，让父 agent 知道有哪些身份可选 */
export function describeRoles(): string {
  return Object.values(ROLE_PRESETS)
    .map((role) => `${role.name}（${role.whenToUse}）`)
    .join("；");
}

/** 角色段：插在身份段之后，其余通用规则段保持原样 */
function roleSegment(role: RolePreset): PromptSegment {
  return {
    id: `role_${role.name}`,
    version: "1.0.0",
    render: () => `## 角色：${role.name}\n${role.prompt}`,
  };
}

/**
 * 按角色组装提示词。
 *
 * 没有角色时**原样返回默认构建器**：段与版本号完全不变，
 * 既有快照与 eval 归因不受影响；选了角色才会多出一个 `role_xxx@1.0.0` 段。
 */
export function promptBuilderForRole(role?: RolePreset): PromptBuilder {
  if (!role) return createDefaultPromptBuilder();
  const [identity, ...rest] = DEFAULT_PROMPT_SEGMENTS;
  return new PromptBuilder([identity!, roleSegment(role), ...rest]);
}
