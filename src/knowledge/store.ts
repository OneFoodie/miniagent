/** 知识库文档读取：多目录递归扫描 + 白名单过滤 + 变化指纹。 */

import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";

/** 扫描到的候选文件（只含元信息，不读内容——热更新用它做廉价的变化检测） */
export interface ScannedFile {
  /** 绝对路径 */
  path: string;
  /** 所属知识库根目录名，作为 source 前缀以区分不同来源 */
  rootLabel: string;
  /** 相对所在根目录的路径（统一用 / 分隔） */
  relativePath: string;
  /** 修改时间（毫秒），用于判断文件是否变过 */
  mtimeMs: number;
}

/**
 * 只收纯文本类文件。二进制格式（PDF/Word/Excel）请先用
 * `npm run knowledge:add` 转成 Markdown 再入库。
 */
const TEXT_EXTENSIONS = new Set([
  // 文档
  ".md", ".markdown", ".mdx", ".txt", ".rst", ".adoc", ".org",
  // 结构化数据与配置
  ".json", ".jsonl", ".ndjson", ".yaml", ".yml", ".toml", ".ini",
  ".csv", ".tsv", ".xml",
  // 代码
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".c", ".h", ".cpp", ".cs",
  ".php", ".sql", ".sh", ".bash", ".ps1", ".bat",
  ".css", ".scss", ".html", ".vue", ".svelte",
]);

/**
 * 永远跳过的目录。
 * 正常情况下知识库不会指向项目根，但一旦那样配了，node_modules 里的海量
 * Markdown 会把索引直接撑爆——所以这里做硬性防御。
 */
const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "coverage",
  ".next", ".nuxt", ".cache", "__pycache__", ".venv", "venv",
]);

/** 判断文件名是否属于可直接入库的纯文本类型 */
export function isTextExtension(name: string): boolean {
  return TEXT_EXTENSIONS.has(extname(name).toLowerCase());
}

/** 扫描多个知识库目录，返回候选文件（按路径排序，保证指纹稳定） */
export async function scanFiles(dirs: string[]): Promise<ScannedFile[]> {
  const found: ScannedFile[] = [];
  for (const dir of dirs) {
    const rootLabel = basename(resolve(dir));
    found.push(...(await walk(dir, rootLabel, dir)));
  }
  return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** source 字段：`<根目录名>/<相对路径>`，多目录时能一眼看出片段来自哪里 */
export function sourceOf(file: ScannedFile): string {
  return `${file.rootLabel}/${file.relativePath}`;
}

/** 读取单个文件内容；失败返回 undefined，单个文件损坏不该让整个知识库不可用 */
export async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return undefined;
  }
}

async function walk(dir: string, rootLabel: string, base: string): Promise<ScannedFile[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // 目录不存在视为空库
    return [];
  }

  const files: ScannedFile[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      files.push(...(await walk(full, rootLabel, base)));
      continue;
    }
    if (!isTextExtension(entry.name)) continue;

    try {
      const info = await stat(full);
      files.push({
        path: full,
        rootLabel,
        relativePath: relative(base, full).split(sep).join("/"),
        mtimeMs: info.mtimeMs,
      });
    } catch {
      // stat 失败（权限/竞态）就跳过这个文件
    }
  }
  return files;
}
