/**
 * `public/markdown.js` 的类型声明。
 *
 * 那个文件是浏览器直接加载的 JS（`public/` 上有独立构建路径），但渲染逻辑是纯函数，
 * 值得被 TS 测试直接 import 验证——这份声明就是给测试用的最小接口面。
 */
export function renderMarkdown(raw: string): string;
