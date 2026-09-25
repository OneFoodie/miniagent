/**
 * 知识库的公共抽象。
 *
 * 与长期记忆的分工（两者都在 LLM 之前做检索增强，但规则相反）：
 *   长期记忆：数据来自 agent 自己的对话产出，一问一答为一条，要遗忘、要矛盾消解
 *   知识库：  数据来自外部文档，切成几百字的片段，静态、不遗忘
 * 所以它们各自独立，不共用一套生命周期规则。
 */

/** 切分后的一个知识片段 */
export interface KnowledgeChunk {
  /** 片段唯一 id */
  id: string;
  /** 所属文档（相对知识库根目录的路径），作为引用来源 */
  source: string;
  /** 所属小节标题；无标题文档为空串 */
  heading: string;
  /** 片段正文 */
  text: string;
  /**
   * 来源文件的最后修改时间（毫秒）。
   * 知识库本身不做新旧排序，但模型需要它来判断"两份冲突记载里哪份更新"——
   * 否则只能靠文件名里恰好带了日期。
   */
  updatedAt: number;
}

/** 一次检索命中 */
export interface KnowledgeHit {
  chunk: KnowledgeChunk;
  /** 与查询的相关度（0~1，越大越相关） */
  score: number;
}

/**
 * 可插拔的检索后端。
 * 第一期是本地词面检索（TF-IDF，零依赖）；将来换 embedding 只需另实现一个类，
 * 工具层与 Agent 都不用改——这正是把它抽成接口的用意。
 */
export interface KnowledgeBase {
  /** 库内文档概览，供模型判断"库里到底有没有相关内容" */
  docs(): Promise<Array<{ source: string; chunks: number }>>;
  /** 按查询检索最相关的片段 */
  search(query: string, topK?: number): Promise<KnowledgeHit[]>;
}
