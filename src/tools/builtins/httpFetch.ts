/** HTTP 抓取工具：获取网页内容并按字符数截断。 */

import { defineTool } from "../base.js";
import { z } from "zod";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export const httpFetch = defineTool({
  name: "http_fetch",
  description:
    "抓取指定 URL 的网页文本内容（自动跟随重定向，最多返回 max_chars 个字符）。",
  args: z.object({
    url: z.string().url(),
    max_chars: z.number().int().positive().default(4000),
  }),
  handler: async ({ url, max_chars }, signal) => {
    const response = await fetch(url, {
      redirect: "follow",
      // 超时与外部取消任一触发即中断
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      headers: { "User-Agent": USER_AGENT },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const text = await response.text();
    return {
      url: response.url,
      status_code: response.status,
      content_type: response.headers.get("content-type") ?? "",
      length: text.length,
      truncated: text.length > max_chars,
      text: text.slice(0, max_chars),
    };
  },
});
