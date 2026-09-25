/**
 * 联网搜索工具（多源降级）：
 *   Bing(cn.bing.com) → 百度 → DuckDuckGo
 * 任一源网络失败或零结果即尝试下一源；全部失败才报错。
 * 背景：DuckDuckGo 在部分网络（如国内）不可达，单源会导致 fetch failed。
 */

import { ToolError } from "../../core/errors.js";
import { defineTool } from "../base.js";
import { z } from "zod";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

interface SearchItem {
  title: string;
  url: string;
  snippet: string;
}

/** 单个搜索源的签名：多源降级时按统一形态放进数组轮询 */
type SearchFn = (query: string, max: number, signal: AbortSignal) => Promise<SearchItem[]>;

/** 合并超时与外部取消信号 */
function signalWithTimeout(signal: AbortSignal, ms: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
}

/* ---------------- Bing ---------------- */

async function searchBing(
  query: string,
  max: number,
  signal: AbortSignal,
): Promise<SearchItem[]> {
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&count=${max}`;
  const response = await fetch(url, {
    signal: signalWithTimeout(signal, 15_000),
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
  });
  if (!response.ok) throw new Error(`Bing HTTP ${response.status}`);
  const page = await response.text();

  // 按结果块切分：每个 <li class="b_algo"> 内含标题链接与摘要段落
  const blocks = page.split(/<li class="b_algo"/).slice(1);
  const items: SearchItem[] = [];
  for (const block of blocks) {
    const linkMatch = block.match(
      /<h2[^>]*>\s*<a[^>]*?href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/,
    );
    if (!linkMatch || !/^https?:\/\//.test(linkMatch[1]!)) continue;
    // 摘要：<p class="b_lineclampN" ...>文本</p>
    const snippetMatch = block.match(
      /<p class="b_lineclamp\d+"[^>]*>([\s\S]*?)<\/p>/,
    );
    items.push({
      title: stripTags(linkMatch[2]!).trim(),
      url: linkMatch[1]!,
      snippet: snippetMatch ? stripTags(snippetMatch[1]!).trim() : "",
    });
    if (items.length >= max) break;
  }
  return items;
}

/* ---------------- 百度 ---------------- */

async function searchBaidu(
  query: string,
  max: number,
  signal: AbortSignal,
): Promise<SearchItem[]> {
  const url = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=${max}`;
  const response = await fetch(url, {
    signal: signalWithTimeout(signal, 15_000),
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "zh-CN,zh;q=0.9" },
  });
  if (!response.ok) throw new Error(`百度 HTTP ${response.status}`);
  const page = await response.text();

  // 百度结果块：<div class="result ...">，内含 <h3> 标题与摘要 span
  const blocks = page.split(/<div[^>]*class="[^"]*\bresult\b/).slice(1);
  const items: SearchItem[] = [];
  for (const block of blocks.slice(0, max * 2)) {
    const linkMatch = block.match(
      /<h3[^>]*>[\s\S]*?<a[^>]*?href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/,
    );
    if (!linkMatch) continue;
    // 摘要：取内容区 span 的文本（class 名随版本变化，用通用 content 特征）
    const snippetMatch =
      block.match(/<span class="content-right[^"]*"[^>]*>([\s\S]*?)<\/span>/) ??
      block.match(/<span[^>]*>([\s\S]{20,300}?)<\/span>/);
    items.push({
      title: stripTags(linkMatch[2]!).trim(),
      url: linkMatch[1]!,
      snippet: snippetMatch ? stripTags(snippetMatch[1]!).trim() : "",
    });
    if (items.length >= max) break;
  }
  return items;
}

/* ---------------- DuckDuckGo（境外网络兜底） ---------------- */

const DDG_RESULT_PATTERN =
  /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;

async function searchDuckDuckGo(
  query: string,
  max: number,
  signal: AbortSignal,
): Promise<SearchItem[]> {
  const response = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    signal: signalWithTimeout(signal, 15_000),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: new URLSearchParams({ q: query }),
  });
  if (!response.ok) throw new Error(`DuckDuckGo HTTP ${response.status}`);
  const page = await response.text();

  const items: SearchItem[] = [];
  for (const match of page.matchAll(DDG_RESULT_PATTERN)) {
    const href = decodeEntities(match[1]!);
    const target = new URL(href, "https://duckduckgo.com").searchParams.get("uddg") ?? href;
    // 摘要：result__snippet 段落
    const rest = page.slice(match.index ?? 0);
    const snippetMatch = rest.match(
      // eslint-disable-next-line @stylistic/max-len -- 正则字面量不能折行
      /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>|<div[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/div>/,
    );
    const snippet = snippetMatch
      ? stripTags(snippetMatch[1] ?? snippetMatch[2] ?? "").trim()
      : "";
    items.push({ title: stripTags(match[2]!).trim(), url: target, snippet });
    if (items.length >= max) break;
  }
  return items;
}

/* ---------------- 统一入口 ---------------- */

export const webSearch = defineTool({
  name: "web_search",
  description: "联网搜索关键词，返回标题与链接列表（自动选择可用的搜索源，无需 API Key）。",
  args: z.object({
    query: z.string().min(1),
    max_results: z.number().int().positive().max(10).default(5),
  }),
  handler: async ({ query, max_results }, signal) => {
    const sources: Array<[string, SearchFn]> = [
      ["Bing", searchBing],
      ["百度", searchBaidu],
      ["DuckDuckGo", searchDuckDuckGo],
    ];

    const failures: string[] = [];
    for (const [sourceName, search] of sources) {
      try {
        const results = await search(query, max_results, signal);
        if (results.length > 0) {
          return { query, count: results.length, source: sourceName, results };
        }
        failures.push(`${sourceName}: 无结果`);
      } catch (error) {
        if (signal.aborted) throw error; // 外部取消，直接向上抛
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${sourceName}: ${message}`);
      }
    }
    throw new ToolError(
      `所有搜索源均失败（${failures.join("；")}），请检查网络或更换关键词`,
    );
  },
});

/* ---------------- HTML 辅助 ---------------- */

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ""));
}

/** 解码常见 HTML 实体 */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&ensp;/g, " ")
    .replace(/&emsp;/g, " ")
    .replace(/&#0?183;/g, "·")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}
