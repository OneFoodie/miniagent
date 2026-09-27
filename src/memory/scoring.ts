/**
 * 记忆的生命周期打分。
 *
 * 设计参考 rabisai-memory 的多信号排序与遗忘曲线。这里全部写成纯函数：
 * 同样的输入必然得到同样的分数，因此每条规则都能被单测钉住。
 *
 * 综合分 = 0.50 × 语义相似 + 0.20 × 时效 + 0.15 × 置信度 + 0.15 × 优先级
 * 语义占一半，是因为"相关性"始终是检索的第一性标准；
 * 其余三个信号负责在相关性接近时打破平局——这正是纯向量检索做不到的事。
 */

/** 记忆类型，决定衰减速度与默认优先级 */
export type MemoryKind =
  | "fact"
  | "preference"
  | "todo"
  | "context"
  | "decision"
  | "instruction";

/** 四信号权重 */
export const SIGNAL_WEIGHTS = {
  semantic: 0.5,
  recency: 0.2,
  confidence: 0.15,
  priority: 0.15,
} as const;

/** 各类型的日衰减率：越易失的内容衰减越快 */
export const DECAY_PER_DAY: Record<MemoryKind, number> = {
  context: 0.08,
  todo: 0.05,
  decision: 0.02,
  fact: 0.015,
  preference: 0.005,
  instruction: 0.005,
};

/** 各类型的默认优先级：稳定且带规范性的内容排在前面，临时上下文垫底 */
export const DEFAULT_PRIORITY: Record<MemoryKind, number> = {
  instruction: 0.8,
  preference: 0.7,
  decision: 0.6,
  fact: 0.5,
  todo: 0.5,
  context: 0.3,
};

/** 被召回一次带来的置信度提升 */
export const RECALL_BOOST = 0.1;

/** 新记忆的初始置信度 */
export const INITIAL_CONFIDENCE = 0.6;

/** 时效分的半衰期（天） */
export const RECENCY_HALF_LIFE_DAYS = 30;

const SECONDS_PER_DAY = 86400;

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * 艾宾浩斯式遗忘：置信度按类型对应的速率指数衰减。
 * 衰减始终从"存下来的置信度 + 上次访问时间"重新计算，因此是幂等的——
 * 不会被读多几次就越算越低。
 */
export function decayedConfidence(
  storedConfidence: number,
  lastAccessedAt: number,
  kind: MemoryKind,
  now: number,
): number {
  const days = Math.max(0, (now - lastAccessedAt) / SECONDS_PER_DAY);
  return clamp01(storedConfidence * Math.exp(-DECAY_PER_DAY[kind] * days));
}

/** 时效分：越新越高，30 天衰减一半 */
export function recencyScore(createdAt: number, now: number): number {
  const days = Math.max(0, (now - createdAt) / SECONDS_PER_DAY);
  return clamp01(0.5 ** (days / RECENCY_HALF_LIFE_DAYS));
}

/**
 * 矛盾线索：出现"不再/改成/其实"这类改写词时，说明用户可能在推翻旧说法。
 * 只有和现有记忆高度相似时才会真正触发消解，所以这里宁可召回率高一点。
 */
const CONTRADICTION_CUES = [
  "不再",
  "不是",
  "不喜欢",
  "改成",
  "改为",
  "换成",
  "改口",
  "其实",
  "纠正",
  "更正",
  "更新为",
  "已经",
  "现在",
  "no longer",
  "actually",
  "changed to",
  "switched to",
  "instead",
  "not ",
];

export function hasContradictionCue(text: string): boolean {
  const lower = text.toLowerCase();
  return CONTRADICTION_CUES.some((cue) => lower.includes(cue));
}

/** 类型的粗判规则；顺序即优先级，命中即返回 */
const KIND_RULES: Array<{ kind: MemoryKind; cues: string[] }> = [
  {
    kind: "preference",
    cues: ["喜欢", "偏好", "习惯", "不喜欢", "prefer", "prefers", "favorite", "likes"],
  },
  {
    kind: "instruction",
    cues: ["必须", "不要", "禁止", "规则", "以后都", "always", "never", "must"],
  },
  {
    kind: "todo",
    cues: ["待办", "记得", "提醒", "下次", "todo", "remind", "remember to"],
  },
  {
    kind: "decision",
    cues: ["决定", "选定", "采用", "定了", "decided", "chose", "we will use"],
  },
  {
    kind: "context",
    cues: ["正在", "目前在", "暂时", "目前是", "currently", "working on"],
  },
];

/** 从文本粗判记忆类型：类型决定它的衰减速度与默认优先级 */
export function inferKind(text: string): MemoryKind {
  const lower = text.toLowerCase();
  for (const rule of KIND_RULES) {
    if (rule.cues.some((cue) => lower.includes(cue))) return rule.kind;
  }
  return "fact";
}

/** 四信号加权合成最终分数 */
export function composeScore(signals: {
  semantic: number;
  recency: number;
  confidence: number;
  priority: number;
}): number {
  return (
    SIGNAL_WEIGHTS.semantic * clamp01(signals.semantic) +
    SIGNAL_WEIGHTS.recency * clamp01(signals.recency) +
    SIGNAL_WEIGHTS.confidence * clamp01(signals.confidence) +
    SIGNAL_WEIGHTS.priority * clamp01(signals.priority)
  );
}
