/**
 * 轻量文本向量索引：字符 n-gram + TF-IDF + 余弦相似度。
 *
 * 为什么不用神经 embedding：本框架刻意保持零额外依赖，而且要离线可跑、可确定性单测。
 * 更关键的是中文没有空格——旧实现按"非字母数字"切词会把整句当成一个词，
 * 所以"量子计算的进展"搜不到存了"量子计算"的记录。
 * 这里改成：拉丁/数字按词切，中日韩按「单字 + 相邻双字」切，
 * 于是中文也能拿到有意义的向量空间相似度。
 *
 * 将来要换真神经向量：把 vector() 换成调用 embedding 服务即可，
 * 上层打分与生命周期逻辑完全不用改。
 */

/** 中日韩字符（这些文字没有词间空格，需要按字切） */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** 可组成"词"的字符（拉丁字母与数字） */
const WORD = /[\p{L}\p{N}]/u;

/**
 * 中英混排切词。
 * 例："用户喜欢 Rust" → ["用","用户","户","户喜","喜","喜欢","欢","rus","rust"] 等
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let latin = "";
  let previousCjk = "";

  const flushLatin = (): void => {
    if (latin) {
      tokens.push(latin);
      latin = "";
    }
  };

  for (const char of text.toLowerCase()) {
    if (CJK.test(char)) {
      flushLatin();
      tokens.push(char);
      if (previousCjk) tokens.push(previousCjk + char);
      previousCjk = char;
    } else if (WORD.test(char)) {
      previousCjk = "";
      latin += char;
    } else {
      flushLatin();
      previousCjk = "";
    }
  }
  flushLatin();
  return tokens;
}

/** 平滑 IDF：保证语料外的新词也有有限权重，不会除零或爆权重 */
function smoothedIdf(documentFrequency: number, documentCount: number): number {
  return Math.log((1 + documentCount) / (1 + documentFrequency)) + 1;
}

/**
 * TF-IDF 索引：先用全部记忆的 token 统计 IDF，再把任意文本编码成
 * L2 归一化的稀疏向量；归一化后点积即余弦相似度。
 *
 * 记忆条数变化时重建索引（上层负责触发），本类自身无状态更新。
 */
export class TfidfIndex {
  private readonly idfByToken = new Map<string, number>();
  private readonly documentCount: number;

  constructor(documents: string[][]) {
    this.documentCount = documents.length;

    // 先统计 document frequency（同一文档内重复 token 只计一次）
    for (const tokens of documents) {
      for (const token of new Set(tokens)) {
        this.idfByToken.set(token, (this.idfByToken.get(token) ?? 0) + 1);
      }
    }
    // 再把 df 就地换算成 idf（只覆盖已有键，遍历安全）
    for (const [token, df] of this.idfByToken) {
      this.idfByToken.set(token, smoothedIdf(df, this.documentCount));
    }
  }

  idf(token: string): number {
    return this.idfByToken.get(token) ?? smoothedIdf(0, this.documentCount);
  }

  /** 编码为 L2 归一化的 tf-idf 稀疏向量 */
  vector(tokens: string[]): Map<string, number> {
    const vector = new Map<string, number>();
    if (tokens.length === 0) return vector;

    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);

    let squaredNorm = 0;
    for (const [token, count] of counts) {
      const weight = (count / tokens.length) * this.idf(token);
      if (weight <= 0) continue;
      vector.set(token, weight);
      squaredNorm += weight * weight;
    }

    const norm = Math.sqrt(squaredNorm);
    if (norm === 0) return vector;
    for (const [token, weight] of vector) vector.set(token, weight / norm);
    return vector;
  }

  /** 两个已归一化向量的余弦相似度（即点积），遍历较短一侧 */
  static cosine(a: Map<string, number>, b: Map<string, number>): number {
    if (a.size === 0 || b.size === 0) return 0;
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];

    let dot = 0;
    for (const [token, weight] of small) {
      const other = large.get(token);
      if (other !== undefined) dot += weight * other;
    }
    return Math.min(1, Math.max(0, dot));
  }
}

/**
 * 从切词结果里筛出「基础 token」：中文单字与拉丁词，丢掉相邻双字。
 *
 * 为什么要额外这一层：判断两条记忆是「重述同一件事」还是「内容被换掉了」时，
 * 双字组会添乱——「代号是 ZTX-9917」与「代号是 ZTX-8800」的双字组几乎全同，
 * 只有数字不同；而「用户喜欢」与「用户很喜欢」的双字组又完全不同。
 * 退到单字/词这个粒度比较，才能分清「只是换个说法」和「信息被替换了」。
 */
export function baseTokens(tokens: string[]): Set<string> {
  const result = new Set<string>();
  for (const token of tokens) {
    const chars = [...token];
    // 相邻双字：两个及以上 CJK 字符拼成的，跳过
    if (chars.length > 1 && chars.every((char) => CJK.test(char))) continue;
    result.add(token);
  }
  return result;
}

/**
 * 重叠系数：|A∩B| / min(|A|,|B|)。
 *
 * 为什么判定"是否在说同一件事"不能用余弦：
 * 「用户不再喜欢咖啡了」包含「用户喜欢咖啡」的全部内容，只多了否定词，
 * 但多出来的词会稀释向量，余弦只有 0.58 左右，够不到阈值。
 * 重叠系数看的是"短的那句是否被长的完全覆盖"，这种情况得 0.91，正好抓住。
 *
 * 于是两种度量分工：
 *   检索排序用余弦（对称、惩罚噪声，越聚焦越靠前）
 *   去重与矛盾判定用重叠系数（判断是否同一件事，包含关系要能识别）
 */
export function overlapCoefficient(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;

  const setA = new Set(a);
  const setB = new Set(b);
  const [small, large] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  if (small.size === 0) return 0;

  let common = 0;
  for (const token of small) {
    if (large.has(token)) common += 1;
  }
  return common / small.size;
}
