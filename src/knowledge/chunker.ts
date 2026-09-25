/**
 * 文档切分：两级策略。
 *   一级——按 Markdown 标题切小节（标题本身就是天然的语义边界）
 *   二级——小节的正文按空行段落聚合成不超过 maxChars 的块，相邻块带重叠
 *
 * 保留小节标题有三个用处：拼进检索语料（标题词往往是关键词）、
 * 作为答案的来源标注、以及在轨迹里说明"这段是从哪来的"。
 * 重叠是为了避免句子正好落在块边界上被切断，导致两边都召不回。
 */

export interface ChunkOptions {
  /** 单块最大字符数 */
  maxChars?: number;
  /** 相邻块的重叠字符数，0 表示不留重叠 */
  overlapChars?: number;
}

/** 一个切好的片段（不含来源信息，由调用方补） */
export interface TextChunk {
  heading: string;
  text: string;
}

export const DEFAULT_CHUNK_CHARS = 600;
export const DEFAULT_CHUNK_OVERLAP = 80;

export function chunkDocument(text: string, options: ChunkOptions = {}): TextChunk[] {
  const maxChars = Math.max(1, options.maxChars ?? DEFAULT_CHUNK_CHARS);
  const maxOverlap = Math.max(0, maxChars - 1);
  const overlap = Math.min(Math.max(0, options.overlapChars ?? DEFAULT_CHUNK_OVERLAP), maxOverlap);

  const chunks: TextChunk[] = [];
  for (const section of splitSections(text)) {
    for (const body of packParagraphs(section.body, maxChars, overlap)) {
      chunks.push({ heading: section.heading, text: body });
    }
  }
  return chunks;
}

/** 按 Markdown 标题切小节；代码块内的 # 不算标题 */
function splitSections(text: string): Array<{ heading: string; body: string }> {
  const sections: Array<{ heading: string; body: string[] }> = [];
  let current: { heading: string; body: string[] } = { heading: "", body: [] };
  let inFence = false;

  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) inFence = !inFence;

    const heading = inFence ? null : /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      if (hasContent(current.body)) sections.push(current);
      current = { heading: heading[1]!.trim(), body: [] };
      continue;
    }
    current.body.push(line);
  }
  if (hasContent(current.body)) sections.push(current);

  return sections.map((section) => ({
    heading: section.heading,
    body: section.body.join("\n").trim(),
  }));
}

function hasContent(lines: string[]): boolean {
  return lines.some((line) => line.trim().length > 0);
}

/** 把段落聚合成不超过 maxChars 的块；单段超长时按长度硬切 */
function packParagraphs(body: string, maxChars: number, overlap: number): string[] {
  if (!body) return [];

  const paragraphs = body
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let buffer = "";
  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      if (buffer) {
        chunks.push(buffer);
        buffer = "";
      }
      chunks.push(...hardSplit(paragraph, maxChars, overlap));
      continue;
    }

    const candidate = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
    if (candidate.length > maxChars) {
      chunks.push(buffer);
      buffer = withOverlap(buffer, paragraph, overlap);
    } else {
      buffer = candidate;
    }
  }
  if (buffer) chunks.push(buffer);
  return chunks;
}

/** 把上一块的尾部拼到新块开头，保证跨块语义连续 */
function withOverlap(previous: string, next: string, overlap: number): string {
  if (overlap <= 0 || !previous) return next;
  return `${previous.slice(-overlap)}\n\n${next}`;
}

function hardSplit(text: string, maxChars: number, overlap: number): string[] {
  const step = Math.max(1, maxChars - overlap);
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += step) {
    parts.push(text.slice(i, i + maxChars));
  }
  return parts;
}
