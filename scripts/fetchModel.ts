/**
 * 把嵌入模型依次下载到本地，之后加载完全离线。
 *
 * 为什么需要它：镜像连接不稳定——实测同一批请求约一半报 `UND_ERR_CONNECT_TIMEOUT`
 * （连大文件小文件都一样，与体积无关），而 transformers.js 内部的下载没有重试。
 * 自己下载可以带重试、可以断点续跑（已完整落盘的文件直接跳过），**只需成功一次**。
 *
 * 用法：
 *   npm run model:fetch              # 默认 q8 量化版（约 113MB，体积与精度的平衡点）
 *   npm run model:fetch -- q4        # 更小
 *   npm run model:fetch -- Xenova/bge-small-zh-v1.5
 */

import { createWriteStream } from "node:fs";
import { mkdir, rename, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline as streamPipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";

import {
  DEFAULT_EMBEDDING_DTYPE,
  ONNX_FILE_BY_DTYPE,
} from "../src/knowledge/embedding.js";

const DEFAULT_MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
/** 最多尝试次数；因为支持续传，每次失败都能保留已下部分，可以给得多一些 */
const MAX_ATTEMPTS = 30;
/** 连续这么多次毫无进展才判定为失败（避免固定次数在慢速网络下过早放弃） */
const STALL_LIMIT = 3;
/** 模型文件与运行时代码分开存放 */
const OUT_ROOT = resolve("models");

/** 除权重外的必需文件；仓库里没有的会被跳过 */
const SIDECAR_FILES = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
  "unigram.json",
];

/** 按顺序解析参数：第一个非 dtype 的参数当作模型 ID */
function parseArgs(argv: string[]): { model: string; dtype: string } {
  let model = process.env.MINIAGENT_EMBEDDING_MODEL || DEFAULT_MODEL;
  let dtype = process.env.MINIAGENT_EMBEDDING_DTYPE || DEFAULT_EMBEDDING_DTYPE;

  for (const arg of argv) {
    if (ONNX_FILE_BY_DTYPE[arg]) dtype = arg;
    else if (arg.includes("/")) model = arg;
  }
  return { model, dtype };
}

const { model, dtype } = parseArgs(process.argv.slice(2));
const onnxFile = ONNX_FILE_BY_DTYPE[dtype];
if (!onnxFile) {
  throw new Error(
    `不支持的 dtype: ${dtype}（可选 ${Object.keys(ONNX_FILE_BY_DTYPE).join(" / ")}）`,
  );
}

const host = process.env.MINIAGENT_EMBEDDING_REMOTE_HOST || "https://hf-mirror.com";
const targetDir = join(OUT_ROOT, model);
const files = [...SIDECAR_FILES, onnxFile];

console.log(`模型    : ${model}`);
console.log(`精度    : ${dtype} → ${onnxFile}`);
console.log(`下载源  : ${host}`);
console.log(`目标目录: ${targetDir}\n`);

const formatSize = (bytes: number): string => `${(bytes / 1048576).toFixed(1)} MB`;

/**
 * 下载单个文件，**支持断点续传**。
 *
 * 断点续传不是可选优化：实测这个镜像下载 112MB 的权重时会在中途报 `terminated`，
 * 从头重试几乎不可能成功。所以失败时保留 `.part`，下次带 `Range` 头接着下。
 *
 * 全程写 `.part` 再改名：中途失败不会留下"看起来完整"的半截文件，
 * 否则下次运行会误判为已下载而跳过。
 */
async function download(relative: string): Promise<void> {
  const target = join(targetDir, relative);
  const url = `${host}/${model}/resolve/main/${relative}`;

  const existing = await stat(target).catch(() => undefined);
  if (existing && existing.size > 0) {
    console.log(`  跳过（已存在 ${formatSize(existing.size)}）`);
    return;
  }

  await mkdir(dirname(target), { recursive: true });
  const partial = `${target}.part`;
  const sizeOfPartial = async (): Promise<number> =>
    (await stat(partial).catch(() => undefined))?.size ?? 0;

  let lastSize = await sizeOfPartial();
  let stalled = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const done = await sizeOfPartial();
    try {
      const response = await fetch(url, {
        // 有已下部分就请服务器从断点接着给
        headers: done > 0 ? { Range: `bytes=${done}-` } : undefined,
      });

      if (response.status === 404) {
        console.log("  跳过（该仓库没有这个文件）");
        return;
      }
      if (response.status !== 206 && !response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      if (!response.body) throw new Error("响应没有 body");

      // 206 说明服务器接受了续传请求；返回 200 则是从头给的，必须覆盖写
      const resuming = response.status === 206 && done > 0;
      const total = totalSize(response, resuming ? done : 0);

      await streamPipeline(
        Readable.fromWeb(response.body as never),
        createWriteStream(partial, { flags: resuming ? "a" : "w" }),
      );

      const written = await sizeOfPartial();
      if (written === 0) throw new Error("下载到 0 字节");
      if (total > 0 && written !== total) {
        // 传输被打断：不算失败，留给下一轮续传
        throw new Error(`未传完（${formatSize(written)} / ${formatSize(total)}）`);
      }

      await rename(partial, target);
      console.log(`  完成 ${formatSize(written)}${attempt > 1 ? `（第 ${attempt} 次尝试）` : ""}`);
      return;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const current = await sizeOfPartial();

      // 有进展就重置停滞计数——慢速网络下这是常态，不该被判失败
      if (current > lastSize) {
        stalled = 0;
        lastSize = current;
      } else {
        stalled += 1;
      }

      if (stalled >= STALL_LIMIT) {
        throw new Error(
          `下载失败（连续 ${STALL_LIMIT} 次无进展，已下 ${formatSize(current)}）: ${relative} —— ${reason}`,
        );
      }

      const wait = Math.min(1000 * 2 ** attempt, 10000);
      console.log(
        `  第 ${attempt} 次中断（${reason}），已下 ${formatSize(current)}，${wait}ms 后续传`,
      );
      await delay(wait);
    }
  }

  throw new Error(`下载失败（已达尝试上限 ${MAX_ATTEMPTS} 次）: ${relative}`);
}

/**
 * 推断文件总大小。
 * 续传响应（206）的 Content-Length 只是**剩余**部分，必须用 Content-Range 才能拿到总量。
 */
function totalSize(response: Response, alreadyDone: number): number {
  if (response.status === 206) {
    const range = response.headers.get("content-range");
    const match = range?.match(/\/(\d+)\s*$/);
    if (match?.[1]) return Number(match[1]);
  }
  const length = Number(response.headers.get("content-length") ?? 0);
  return length > 0 ? alreadyDone + length : 0;
}

for (const file of files) {
  console.log(`· ${file}`);
  await download(file);
}

console.log(`\n就绪。模型已落到 ${targetDir}，之后加载不再联网。`);
