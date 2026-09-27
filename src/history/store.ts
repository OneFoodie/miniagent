/**
 * 会话历史持久化（追加写 + 独立元信息文件）。
 *
 * 为什么不再"每轮重写整个会话文件"：写完的代价值随会话长度线性增长，
 * 累起来接近 O(n²)——1000 轮的会话每轮都要把整份 JSON 重新序列化并落盘。
 * 现在的分工：
 *   <sessionId>.jsonl       每行一轮，只追加，写入 O(1)
 *   <sessionId>.meta.json   标题/时间/轮数等列表页所需信息，体积恒定
 * 列表页只读后者，所以打开历史面板的代价与单会话长度无关。
 *
 * 与 traces/ 的分工不变：
 *   history/   对话本身（问题与答案），供人回看
 *   traces/    单次运行的完整轨迹（思考、工具输入输出），供排查与回放
 * 两者通过 assistant 消息上的 runId 关联。
 */

import { appendFile, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** 会话中的一轮消息 */
export interface SessionTurn {
  role: "user" | "assistant";
  content: string;
  /** assistant 消息对应的运行 id，用于回看轨迹 */
  runId?: string;
  /**
   * 该轮实际执行过的工具调用（name + 是否成功）。
   *
   * 为什么必须存：会话历史只留问答文本，工具结果只进 `traces/`（在沙箱之外，模型读不到），
   * 于是下一轮只剩「我说过什么」而没有「我做过什么」。实测过一次由此引发的误判：
   * 上一轮真的调用过 `mcp__echo__echo`，下一轮因为工具清单里没有它，模型推翻自己、
   * 声称此前是编造的。存下这两个字段，下一轮就有据可查。
   * 消费方是 server 的 `lastTurnToolFacts` → Agent 的 `executionLedger` → 系统提示词的证据小节。
   */
  tools?: SessionToolFact[];
  /** 写入时间（Unix 秒） */
  ts: number;
}

/** 一轮里一次工具调用的事实：只记名字与成败，不记输出（输出在 traces 里） */
export interface SessionToolFact {
  name: string;
  ok: boolean;
}

/** 列表页用的摘要信息 */
export interface SessionSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  turns: number;
}

export interface Session extends SessionSummary {
  messages: SessionTurn[];
}

const JSONL_SUFFIX = ".jsonl";
const META_SUFFIX = ".meta.json";
const LEGACY_SUFFIX = ".json";

/**
 * 导入的原始输入。
 * 除 id 外都是 unknown：数据来自外部 JSON，字段可缺可错，由 import 内部逐项校验，
 * 这样调用方（HTTP 层）不必先伪造一个完整的 Session 对象。
 */
export interface SessionImportInput {
  id: string;
  title?: unknown;
  createdAt?: unknown;
  messages?: unknown;
}

export class SessionStore {
  constructor(private readonly dir: string) {}

  /** 追加若干轮并更新元信息；返回列表页需要的摘要 */
  async append(id: string, turns: SessionTurn[]): Promise<SessionSummary> {
    assertSafeId(id);
    await mkdir(this.dir, { recursive: true });

    const existing = await this.readMeta(id);
    // 旧格式会话先转成 jsonl，否则后面的追加会与旧文件各存一半
    await this.migrateLegacy(id);

    const body = turns.map((turn) => JSON.stringify(turn)).join("\n");
    if (body) await appendFile(this.pathOfJsonl(id), `${body}\n`, "utf-8");

    const now = Date.now() / 1000;
    const summary: SessionSummary = {
      id,
      title: existing?.title ?? deriveTitle(turns),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      // 增量累加即可，不必为了数轮数再把整个会话读一遍
      turns: (existing?.turns ?? 0) + turns.filter((turn) => turn.role === "user").length,
    };
    await this.writeMeta(summary);
    return summary;
  }

  /** 列出全部会话，按最近更新倒序；只读体积恒定的元信息文件 */
  async list(): Promise<SessionSummary[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return [];
    }

    const ids = new Set<string>();
    for (const file of files) {
      if (file.endsWith(META_SUFFIX)) {
        ids.add(file.slice(0, -META_SUFFIX.length));
      } else if (file.endsWith(JSONL_SUFFIX)) {
        ids.add(file.slice(0, -JSONL_SUFFIX.length));
      } else if (file.endsWith(LEGACY_SUFFIX)) {
        // 升级前的旧格式：没有元信息，走 readMeta 的回退分支现算一份
        ids.add(file.slice(0, -LEGACY_SUFFIX.length));
      }
    }

    const summaries: SessionSummary[] = [];
    for (const id of ids) {
      const meta = await this.readMeta(id);
      if (meta) summaries.push(meta);
    }
    return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 读取单个会话；不存在或损坏时返回 undefined */
  async get(id: string): Promise<Session | undefined> {
    if (!isSafeId(id)) return undefined;
    const meta = await this.readMeta(id);
    if (!meta) return undefined;
    return { ...meta, messages: await this.readTurns(id) };
  }

  /**
   * 导入一份外部会话（换实例、迁移部署、复现问题时会用到）。
   *
   * 两个要点：
   *  1. **默认不覆盖**同名会话——导入是外部数据，静默盖掉本机历史是不可接受的；
   *  2. 覆盖时**先删再写**：jsonl 是追加写的，不清掉旧文件会两段历史接在一起。
   *
   * 导入内容来自外部，按系统边界对待：逐条校验，非法轮次直接丢弃而不是整份拒收。
   */
  async import(
    session: SessionImportInput,
    options: { overwrite?: boolean } = {},
  ): Promise<SessionSummary> {
    assertSafeId(session.id);
    const turns = sanitizeTurns(session.messages);
    const existing = await this.readMeta(session.id);
    if (existing && !options.overwrite) {
      throw new Error(`会话 ${session.id} 已存在；如需覆盖请带 overwrite=true`);
    }

    await mkdir(this.dir, { recursive: true });
    if (existing) await this.remove(session.id);

    const body = turns.map((turn) => JSON.stringify(turn)).join("\n");
    await writeFile(this.pathOfJsonl(session.id), body ? `${body}\n` : "", "utf-8");

    const now = Date.now() / 1000;
    const title = typeof session.title === "string" ? session.title.trim() : "";
    const summary: SessionSummary = {
      id: session.id,
      title: title || deriveTitle(turns),
      createdAt: typeof session.createdAt === "number" ? session.createdAt : now,
      // 导入时刻作为更新时间：本机列表按它排序，导入的会话会出现在最前面
      updatedAt: now,
      turns: turns.filter((turn) => turn.role === "user").length,
    };
    await this.writeMeta(summary);
    return summary;
  }

  async remove(id: string): Promise<boolean> {
    if (!isSafeId(id)) return false;
    let removed = false;
    for (const path of [
      this.pathOfJsonl(id),
      this.pathOfMeta(id),
      this.pathOfLegacy(id),
    ]) {
      try {
        await unlink(path);
        removed = true;
      } catch {
        // 该文件不存在，跳过
      }
    }
    return removed;
  }

  /** 读元信息；没有则回退到旧格式文件，保证升级前的会话不会凭空消失 */
  private async readMeta(id: string): Promise<SessionSummary | undefined> {
    try {
      return JSON.parse(await readFile(this.pathOfMeta(id), "utf-8")) as SessionSummary;
    } catch {
      const legacy = await this.readLegacy(id);
      if (!legacy) return undefined;
      return {
        id: legacy.id,
        title: legacy.title,
        createdAt: legacy.createdAt,
        updatedAt: legacy.updatedAt,
        turns: legacy.turns,
      };
    }
  }

  /** 逐行读 jsonl；单行损坏只跳过该行 */
  private async readTurns(id: string): Promise<SessionTurn[]> {
    let raw: string;
    try {
      raw = await readFile(this.pathOfJsonl(id), "utf-8");
    } catch {
      return (await this.readLegacy(id))?.messages ?? [];
    }

    const turns: SessionTurn[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        turns.push(JSON.parse(line) as SessionTurn);
      } catch {
        // 跳过损坏行
      }
    }
    return turns;
  }

  private async readLegacy(id: string): Promise<Session | undefined> {
    try {
      return JSON.parse(await readFile(this.pathOfLegacy(id), "utf-8")) as Session;
    } catch {
      return undefined;
    }
  }

  /** 把升级前的整份 .json 转成 jsonl + 元信息，随后删除旧文件，避免两份数据不一致 */
  private async migrateLegacy(id: string): Promise<void> {
    const legacy = await this.readLegacy(id);
    if (!legacy) return;

    const body = legacy.messages.map((turn) => JSON.stringify(turn)).join("\n");
    await writeFile(this.pathOfJsonl(id), body ? `${body}\n` : "", "utf-8");
    await this.writeMeta({
      id,
      title: legacy.title,
      createdAt: legacy.createdAt,
      updatedAt: legacy.updatedAt,
      turns: legacy.turns,
    });
    try {
      await unlink(this.pathOfLegacy(id));
    } catch {
      // 已删除
    }
  }

  private async writeMeta(summary: SessionSummary): Promise<void> {
    await writeFile(this.pathOfMeta(summary.id), JSON.stringify(summary), "utf-8");
  }

  private pathOfJsonl(id: string): string {
    return join(this.dir, `${id}${JSONL_SUFFIX}`);
  }

  private pathOfMeta(id: string): string {
    return join(this.dir, `${id}${META_SUFFIX}`);
  }

  private pathOfLegacy(id: string): string {
    return join(this.dir, `${id}${LEGACY_SUFFIX}`);
  }
}

/** 用首个用户提问作为会话标题 */
function deriveTitle(messages: SessionTurn[]): string {
  const first = messages.find((message) => message.role === "user");
  if (!first) return "空会话";
  const line = first.content.replace(/\s+/g, " ").trim();
  return line.length > 40 ? `${line.slice(0, 40)}…` : line || "空会话";
}

/** 会话 id 只允许安全字符，避免路径穿越 */
function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id);
}

/**
 * 清洗导入的轮次：外部数据不保证结构正确，坏行丢掉即可，不必整份拒收。
 * 只保留 user/assistant 两种角色——别的角色进了历史会让下一轮拼上下文时出错。
 */
function sanitizeTurns(messages: unknown): SessionTurn[] {
  if (!Array.isArray(messages)) return [];
  const now = Date.now() / 1000;
  const turns: SessionTurn[] = [];
  for (const item of messages) {
    if (typeof item !== "object" || item === null) continue;
    const { role, content, runId, ts, tools } = item as Record<string, unknown>;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") continue;
    const facts = sanitizeToolFacts(tools);
    turns.push({
      role,
      content,
      ...(typeof runId === "string" ? { runId } : {}),
      ...(facts.length > 0 ? { tools: facts } : {}),
      ts: typeof ts === "number" ? ts : now,
    });
  }
  return turns;
}

/** 单轮最多保留多少条工具事实：导入的数据不可信，得有个上限 */
const MAX_TOOL_FACTS_PER_TURN = 50;

/** 工具事实也来自外部 JSON，逐项校验：名字必须是非空字符串，ok 归一到布尔 */
function sanitizeToolFacts(value: unknown): SessionToolFact[] {
  if (!Array.isArray(value)) return [];
  const facts: SessionToolFact[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const { name, ok } = item as Record<string, unknown>;
    if (typeof name !== "string" || name.length === 0) continue;
    facts.push({ name, ok: ok === true });
    if (facts.length >= MAX_TOOL_FACTS_PER_TURN) break;
  }
  return facts;
}

function assertSafeId(id: string): void {
  if (!isSafeId(id)) {
    throw new Error(`非法的会话 id: ${id}`);
  }
}
