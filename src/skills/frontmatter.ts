/**
 * 极简 frontmatter 解析器。
 *
 * SKILL.md 只需要 name / description / when_to_use / tools 这几个简单字段，
 * 为此引入完整 YAML 依赖不划算，这里手写一个够用的子集：
 *   - 支持 `key: value`
 *   - 支持引号包裹的字符串
 *   - 支持内联数组 `key: [a, b]`
 * 不支持嵌套结构（用不到）。
 */

export interface Frontmatter {
  data: Record<string, string | string[]>;
  /** frontmatter 之后的正文 */
  body: string;
}

export function parseFrontmatter(raw: string): Frontmatter {
  // 统一换行符并去掉 BOM，避免 Windows 换行导致分隔符匹配失败
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) {
    return { data: {}, body: text.trim() };
  }

  const end = text.indexOf("\n---", 3);
  if (end === -1) {
    return { data: {}, body: text.trim() };
  }

  const header = text.slice(4, end);
  const body = text.slice(end + 4).replace(/^\n+/, "").trim();

  const data: Record<string, string | string[]> = {};
  for (const line of header.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf(":");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (key) data[key] = parseValue(value);
  }

  return { data, body };
}

function parseValue(value: string): string | string[] {
  if (value.startsWith("[") && value.endsWith("]")) {
    return value
      .slice(1, -1)
      .split(",")
      .map((item) => stripQuotes(item.trim()))
      .filter((item) => item !== "");
  }
  return stripQuotes(value);
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}
