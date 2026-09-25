/**
 * 运行存档（checkpoint）：把一轮运行在现场落盘，使它可被**续跑**，而不是从头再来。
 *
 * 为什么必须落盘而不是只存在内存里：生产上「跑一半崩了」的成因是进程被杀、机器重启、
 * 部署滚动——内存里存的现场救不了这些。所以存档写在磁盘上，进程重启后仍可取回。
 *
 * 落盘时机：**每轮工具结果回灌之后**。这个位置是天然的稳定点——
 * 消息序列完整（assistant 的 tool_calls 与随后的 tool 结果都齐），继续跑就是再进一次循环。
 * 只存这一处就不需要保存「半截的 LLM 流」，恢复逻辑因此简单得多。
 *
 * 清理策略：**运行成功即删除**，只有中断/失败/挂起等待审批的才留在磁盘上。
 * 于是磁盘上留下的都是「确实需要人看一眼」的运行。
 */

import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { Message } from "../core/types.js";
import type { ToolFact } from "./context.js";

/** 等待人工审批的工具调用 */
export interface PendingApproval {
  callId: string;
  tool: string;
  arguments: Record<string, unknown>;
}

/** 一次运行的可恢复现场 */
export interface RunCheckpoint {
  runId: string;
  /** 本次运行的输入原文，用于在列表里认出这是哪一次 */
  input: string;
  /** 建档与最近更新时间（毫秒） */
  createdAt: number;
  updatedAt: number;
  /** 已完成的迭代轮数 */
  iterations: number;
  usage: { promptTokens: number; completionTokens: number };
  /** 完整消息序列（含 system），恢复时直接续用 */
  messages: Message[];
  /** 本次运行用到的提示词段版本，恢复后写进轨迹便于比对 */
  promptVersions: string[];
  /**
   * 已执行过的工具调用（name + 是否成功）。
   * 存档要一并带上：否则续跑出来的那一轮会丢掉挂起前的执行事实，
   * 而"执行事实"正是下一轮用来判断「这步到底做没做过」的依据。
   * 可选是为了兼容加这个字段之前写下的存档。
   */
  tools?: ToolFact[];
  /** 已做出的审批决定：callId → 是否批准 */
  approvals: Record<string, boolean>;
  /** 当前等待决定的调用；为空表示是「中断后待续跑」而不是「等审批」 */
  pendingApproval?: PendingApproval;
}

/** 列表用的摘要（不返回消息体，避免列表接口变重） */
export interface CheckpointSummary {
  runId: string;
  input: string;
  updatedAt: number;
  iterations: number;
  pendingApproval?: PendingApproval;
}

/** runId 会直接进文件名，必须限制字符集以防路径穿越 */
const SAFE_RUN_ID = /^[A-Za-z0-9_-]+$/;

function filePath(dir: string, runId: string): string {
  if (!SAFE_RUN_ID.test(runId)) {
    throw new Error(`非法的 runId，拒绝访问存档: ${runId}`);
  }
  return join(resolve(dir), `${runId}.json`);
}

/** 写存档。先写临时文件再改名的原子替换，避免读到写了一半的 JSON */
export async function saveCheckpoint(dir: string, checkpoint: RunCheckpoint): Promise<void> {
  const target = filePath(dir, checkpoint.runId);
  await mkdir(resolve(dir), { recursive: true });

  const temp = `${target}.tmp`;
  const payload: RunCheckpoint = { ...checkpoint, updatedAt: Date.now() };
  await writeFile(temp, JSON.stringify(payload), "utf-8");
  await rename(temp, target);
}

/** 读存档；不存在或内容损坏都返回 undefined（存档只是兜底，不该成为新的故障点） */
export async function loadCheckpoint(
  dir: string,
  runId: string,
): Promise<RunCheckpoint | undefined> {
  try {
    const raw = await readFile(filePath(dir, runId), "utf-8");
    const parsed = JSON.parse(raw) as RunCheckpoint;
    // 最低限度的自校验：缺了这两项就没法恢复，当作无效存档
    if (typeof parsed.runId !== "string" || !Array.isArray(parsed.messages)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** 列出全部可续跑的运行，按最近更新倒序 */
export async function listCheckpoints(dir: string): Promise<CheckpointSummary[]> {
  let names: string[];
  try {
    names = await readdir(resolve(dir));
  } catch {
    return [];
  }

  const summaries: CheckpointSummary[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const checkpoint = await loadCheckpoint(dir, name.slice(0, -".json".length));
    if (!checkpoint) continue;
    summaries.push({
      runId: checkpoint.runId,
      input: checkpoint.input,
      updatedAt: checkpoint.updatedAt,
      iterations: checkpoint.iterations,
      pendingApproval: checkpoint.pendingApproval,
    });
  }
  return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 删除存档（运行成功、或被人工放弃时调用） */
export async function removeCheckpoint(dir: string, runId: string): Promise<void> {
  try {
    await rm(filePath(dir, runId));
  } catch {
    // 已经不存在就是目标状态
  }
}

/**
 * 把一个审批决定写回存档。
 *
 * 单独抽出来是因为「做决定」与「续跑」是两次请求：
 * 前端先 POST 决定，再带着 resume_run_id 重连拿结果。两次请求之间进程可能重启，
 * 所以决定必须落盘。
 */
export async function recordApproval(
  dir: string,
  runId: string,
  approved: boolean,
): Promise<PendingApproval | undefined> {
  const checkpoint = await loadCheckpoint(dir, runId);
  if (!checkpoint?.pendingApproval) return undefined;

  const callId = checkpoint.pendingApproval.callId;
  checkpoint.approvals = { ...checkpoint.approvals, [callId]: approved };
  await saveCheckpoint(dir, checkpoint);
  return checkpoint.pendingApproval;
}
