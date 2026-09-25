/**
 * 分段组装的系统提示词构建器。
 *
 * 设计要点：把系统提示词拆成若干"段"，每段带 id@version。
 * 好处有三：
 *   1. 可读——每段职责单一，改动范围清晰
 *   2. 可归因——build() 返回各段版本号，eval 报告可据此定位是哪次改动带来效果变化
 *   3. 可测试——render 是纯函数，同样输入必然同样输出，便于快照测试防漂移
 */

/** 组装提示词时可用的动态上下文 */
export interface PromptContext {
  /** 技能目录（渐进式披露：只放 name/description/whenToUse，正文由 load_skill 按需拉取） */
  skills: Array<{ name: string; description: string; whenToUse: string }>;
  /** 早前对话的压缩摘要（无则为空串） */
  memorySummary: string;
  /** 长期记忆检索到的相关片段（无则为空数组） */
  recalledMemory: string[];
  /** 当前注册的工具名，用于生成工具策略段 */
  toolNames: string[];
  /**
   * 上一轮**实际执行过**的工具调用（name + 成败），由运行期写入。
   *
   * 为什么放在系统提示词而不是拼进历史消息：实测过一次——把它拼在 assistant 消息后面时，
   * 模型会说「这行是我自己敲的，也是我编的」而不认账；放进系统提示词，它才有"这不是我写的"这个判断。
   */
  executionLedger?: Array<{ name: string; ok: boolean }>;
}

/** 提示词的一个片段 */
export interface PromptSegment {
  /** 段标识 */
  id: string;
  /** 段版本号，与 id 组成 id@version */
  version: string;
  /** 渲染该段；返回空串表示本段在当前上下文下不出现 */
  render(context: PromptContext): string;
}

export interface BuiltPrompt {
  /** 最终拼装好的系统提示词 */
  text: string;
  /** 各段版本号，形如 ["identity@1.0.0", ...] */
  versions: string[];
}

export class PromptBuilder {
  constructor(private readonly segments: PromptSegment[]) {}

  /** 按顺序渲染并拼接所有非空段 */
  build(context: PromptContext): BuiltPrompt {
    const parts: string[] = [];
    const versions: string[] = [];
    for (const segment of this.segments) {
      versions.push(`${segment.id}@${segment.version}`);
      const rendered = segment.render(context).trim();
      if (rendered) parts.push(rendered);
    }
    return { text: parts.join("\n\n"), versions };
  }
}
