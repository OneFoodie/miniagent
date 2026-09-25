#!/usr/bin/env node
/**
 * 知识库入库命令：把各种格式的文件转成 Markdown，落到知识库目录。
 *
 * 用法::
 *
 *     npm run knowledge:add <文件或目录> [更多输入...] [--out <输出目录>]
 *
 * 分派规则：
 *   .pdf / .xlsx / .xls / .csv / .tsv   → python scripts/convert.py（表格转 Markdown 表格）
 *   Word / HTML / ePub / ODT / RTF / ipynb → pandoc -t markdown
 *   其余文本类（.md/.txt/.json/代码…）    → 直接复制
 *
 * 转换产物会加上 `# <原文件名>` 作为标题，让它能作为切分边界与引用来源；
 * 直接复制的文件保持原样不动。
 *
 * 输出目录默认 ./knowledge，必须落在 MINIAGENT_KNOWLEDGE_DIR 内才会被检索到，
 * 否则脚本会给出提示。
 */

import { spawnSync } from "node:child_process";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { loadSettings } from "../src/core/config.js";
import { isTextExtension, readText } from "../src/knowledge/store.js";

const DEFAULT_OUT_DIR = "./knowledge";

/** 交给 python scripts/convert.py 的格式：值是该脚本的子命令 */
const PYTHON_FORMATS: Record<string, string> = {
  ".pdf": "pdf",
  ".xlsx": "xlsx",
  ".csv": "csv",
  ".tsv": "csv",
};

/** 交给 pandoc 的格式：值是 -f 的格式名 */
const PANDOC_FORMATS: Record<string, string> = {
  ".docx": "docx",
  ".odt": "odt",
  ".rtf": "rtf",
  ".html": "html",
  ".htm": "html",
  ".epub": "epub",
  ".ipynb": "ipynb",
};

const CONVERT_SCRIPT = fileURLToPath(new URL("./convert.py", import.meta.url));
const MAX_BUFFER = 64 * 1024 * 1024;

interface Converted {
  /** 输出文件名 */
  name: string;
  /** Markdown 正文 */
  markdown: string;
  /** 来源描述，仅用于打印 */
  via: string;
}

async function main(): Promise<void> {
  const { inputs, outDir } = parseArgs(process.argv.slice(2));
  if (inputs.length === 0) {
    process.stdout.write(
      "用法: npm run knowledge:add <文件或目录> [更多输入...] [--out <输出目录>]\n",
    );
    return;
  }

  const settings = loadSettings();
  const target = resolve(outDir || DEFAULT_OUT_DIR);
  if (!settings.knowledgeDirs.some((dir) => resolve(dir) === target)) {
    process.stdout.write(
      `注意: 输出目录 ${target} 不在 MINIAGENT_KNOWLEDGE_DIR` +
        `（${settings.knowledgeDirs.join("、")}）内，入库后不会被检索到。\n`,
    );
  }

  const files = await collect(inputs);
  if (files.length === 0) {
    process.stdout.write("没有找到可入库的文件。\n");
    return;
  }

  await mkdir(target, { recursive: true });
  const used = new Set(await readdir(target));

  let ok = 0;
  for (const file of files) {
    const converted = await convert(file);
    if (!converted) continue;

    const name = uniqueName(converted.name, used);
    used.add(name);
    const body = converted.markdown.endsWith("\n")
      ? converted.markdown
      : `${converted.markdown}\n`;
    await writeFile(join(target, name), body, "utf-8");

    ok++;
    process.stdout.write(
      `  ✓ ${name}  ← ${relativeish(file)}（${converted.via}，${body.length} 字）\n`,
    );
  }

  process.stdout.write(`\n入库完成: ${ok}/${files.length} 个文件 → ${target}\n`);
  if (ok > 0) {
    process.stdout.write("知识库支持热更新，正在运行的服务无需重启即可检索到。\n");
  }
}

function parseArgs(argv: string[]): { inputs: string[]; outDir: string } {
  const inputs: string[] = [];
  let outDir = "";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--out") {
      outDir = argv[++i] ?? "";
      continue;
    }
    inputs.push(arg);
  }
  return { inputs, outDir };
}

/** 展开输入：目录递归收集文件，文件原样保留 */
async function collect(inputs: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const input of inputs) {
    const info = await stat(input).catch(() => undefined);
    if (!info) {
      process.stdout.write(`跳过（不存在）: ${input}\n`);
      continue;
    }
    if (info.isDirectory()) {
      files.push(...(await walk(input)));
    } else {
      files.push(resolve(input));
    }
  }
  return files;
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else {
      files.push(full);
    }
  }
  return files;
}

async function convert(file: string): Promise<Converted | undefined> {
  const ext = extname(file).toLowerCase();
  const base = basename(file, ext);

  if (ext === ".xls") {
    process.stdout.write(`跳过（${file}）: 不支持旧的 .xls，请在 Excel 里另存为 .xlsx\n`);
    return undefined;
  }

  const pythonCommand = PYTHON_FORMATS[ext];
  if (pythonCommand) {
    const result = spawnSync("python", [CONVERT_SCRIPT, pythonCommand, file], {
      encoding: "utf-8",
      maxBuffer: MAX_BUFFER,
    });
    if (result.status !== 0) {
      report(`python 转换失败`, file, result.stderr || result.error?.message);
      return undefined;
    }
    return titled(base, result.stdout, `python/${pythonCommand}`);
  }

  const pandocFormat = PANDOC_FORMATS[ext];
  if (pandocFormat) {
    const result = spawnSync(
      "pandoc",
      ["-f", pandocFormat, "-t", "markdown", "--wrap=none", file],
      { encoding: "utf-8", maxBuffer: MAX_BUFFER },
    );
    if (result.status !== 0) {
      report(`pandoc 转换失败`, file, result.stderr || result.error?.message);
      return undefined;
    }
    return titled(base, result.stdout, `pandoc/${pandocFormat}`);
  }

  if (!isTextExtension(file)) {
    process.stdout.write(
      `跳过（不支持的格式）: ${file}\n` +
        `  支持: .pdf/.docx/.odt/.rtf/.html/.epub/.ipynb/.xlsx/.csv/.tsv 及各类纯文本\n`,
    );
    return undefined;
  }

  const text = await readText(file);
  if (text === undefined) {
    process.stdout.write(`跳过（无法按文本读取）: ${file}\n`);
    return undefined;
  }
  // 已经是文本，保持原样，不额外加标题
  return { name: `${base}${ext}`, markdown: text, via: "直接复制" };
}

/**
 * 转换产物补一个 H1 标题：让文件名里的词也能被检索到，并给切分一个明确边界。
 * 产物已自带 H1 时不再补——docx 这类带内建标题的格式转回来会带 H1，
 * 再补一个就会出现同名标题重复。
 */
function titled(base: string, markdown: string, via: string): Converted | undefined {
  const body = markdown.trim();
  if (!body) {
    process.stdout.write(`跳过（${base}）: 转换结果为空\n`);
    return undefined;
  }
  const withTitle = /^#(?!#)/m.test(body) ? body : `# ${base}\n\n${body}`;
  return { name: `${base}.md`, markdown: `${withTitle}\n`, via };
}

function report(what: string, file: string, detail?: string): void {
  const reason = (detail ?? "").trim().split("\n")[0] ?? "未知原因";
  process.stdout.write(`  ✗ ${what}: ${file} — ${reason}\n`);
}

/** 重名时加序号，避免不同来源的同名文件互相覆盖 */
function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) return name;
  const ext = extname(name);
  const base = basename(name, ext);
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}${ext}`;
    if (!used.has(candidate)) return candidate;
  }
}

function relativeish(file: string): string {
  const root = resolve(process.cwd());
  return file.startsWith(root + sep) ? file.slice(root.length + 1) : file;
}

await main();
