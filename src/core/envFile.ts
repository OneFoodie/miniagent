/**
 * .env 原地改写与落盘。
 *
 * 为什么不整文件重写：.env 是手写维护的，含注释行与「注释态」的键
 * （如 `# MINIAGENT_APPROVAL_TOOLS=powershell`）。整文件重写会把这些全丢掉。
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** 匹配 `KEY=...`（可带前导空白）；注释行不匹配 */
function matchActiveKey(line: string, key: string): boolean {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("#")) return false;
  const index = trimmed.indexOf("=");
  if (index <= 0) return false;
  return trimmed.slice(0, index).trim() === key;
}

/** 匹配 `# KEY=...`（注释态） */
function matchCommentedKey(line: string, key: string): boolean {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("#")) return false;
  const body = trimmed.replace(/^#+\s*/, "");
  const index = body.indexOf("=");
  if (index <= 0) return false;
  return body.slice(0, index).trim() === key;
}

/**
 * 逐行改写 .env：
 *   - 已生效的键 → 替换该行（同键出现多次时全部替换，避免留下旧的生效值）
 *   - 注释态的键 → 在该行之后插入生效行，注释保留
 *   - 都没有 → 追加到末尾
 * 值不做转义或加引号：解析侧（config.ts 的 readString/readList/readPairs）
 * 只按第一个 `=` 与 `,` 切分，与现有 .env 风格一致。
 */
export function writeEnvValues(content: string, updates: Record<string, string>): string {
  const keys = Object.keys(updates);
  if (keys.length === 0) return content;

  const lines = content.split("\n");
  // 末尾换行会切出一个空串，先摘掉，最后统一补
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const output: string[] = [];
  const inserted = new Set<string>();
  for (const line of lines) {
    const hit = keys.find((key) => matchActiveKey(line, key));
    if (hit !== undefined) {
      output.push(`${hit}=${updates[hit]}`);
      continue;
    }
    output.push(line);
    // 注释态：紧跟其后插入生效行（只插一次，防止同键多条注释重复插入）
    const commented = keys.find((key) => !inserted.has(key) && matchCommentedKey(line, key));
    if (commented !== undefined) {
      output.push(`${commented}=${updates[commented]}`);
      inserted.add(commented);
    }
  }

  for (const key of keys) {
    if (!output.some((line) => matchActiveKey(line, key))) {
      output.push(`${key}=${updates[key]}`);
    }
  }

  return `${output.join("\n")}\n`;
}

/** 读取 .env；文件不存在按空内容处理（首次保存即新建） */
export async function readEnvFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}

/**
 * 原子写：先写同目录临时文件再 rename。
 * 直接 writeFile 若在写到一半时进程被杀，会留下半截 .env——下次启动直接读不出配置。
 */
export async function writeEnvFile(path: string, content: string): Promise<void> {
  const temp = join(dirname(path), `.env.tmp-${process.pid}-${Date.now()}`);
  await writeFile(temp, content, "utf-8");
  await rename(temp, path);
}

/** 一次完成「读出 → 改写 → 原子写回」，返回新内容 */
export async function updateEnvFile(
  path: string,
  updates: Record<string, string>,
): Promise<string> {
  const next = writeEnvValues(await readEnvFile(path), updates);
  await writeEnvFile(path, next);
  return next;
}
