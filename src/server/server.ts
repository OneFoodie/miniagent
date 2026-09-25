/**
 * Web UI 服务器（零框架，纯 node:http）：
 * - GET  /            托管 public/ 下的静态页面
 * - POST /api/chat     运行 Agent，以 SSE 流式推送每一步事件
 * - POST /api/stop     取消指定运行
 * - GET  /api/trace/:runId  读取某次运行的 JSONL 轨迹（思考内容与工具输入/输出）
 * - GET  /api/sessions      会话历史列表
 * - GET  /api/sessions/:id  单个会话详情
 * - DELETE /api/sessions/:id 删除会话
 * - GET  /health       健康检查
 *
 * 设计要点：每个请求使用独立的 EventBus 与 Agent 实例，
 * 避免多个用户并发时事件互相串台（registry/llm 可安全复用）。
 */

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Agent } from "../agent/agent.js";
import { listCheckpoints, loadCheckpoint, recordApproval } from "../agent/checkpoint.js";
import { AgentContext } from "../agent/context.js";
import { loadSettings, type Settings } from "../core/config.js";
import { ApprovalRequiredError, MiniAgentError } from "../core/errors.js";
import { EventBus, EventType, makeEvent } from "../core/events.js";
import { getLogger, setupLogging } from "../core/logging.js";
import type { Message } from "../core/types.js";
import {
  SessionStore,
  type SessionToolFact,
  type SessionTurn,
} from "../history/store.js";
import {
  createKnowledgeBase,
  describeKnowledgeBackend,
  registerKnowledgeTools,
  type KnowledgeBase,
} from "../knowledge/index.js";
import type { BaseLLM } from "../llm/base.js";
import { OpenAICompatibleClient } from "../llm/openai.js";
import { describeMcp, registerMcpTools } from "../mcp/index.js";
import type { LongTermMemory } from "../memory/base.js";
import {
  createLongTermMemory,
  createMemorySummarizer,
  describeLongTermMemory,
  DEFAULT_SUMMARY_OPTIONS,
  rememberTurn,
  SummaryMemory,
} from "../memory/index.js";
import { Metrics } from "../observability/metrics.js";
import {
  createOtelExporter,
  describeOtel,
  type OtelLike,
} from "../observability/otel.js";
import { Tracer } from "../observability/tracer.js";
import { registerSkillTools, SkillRegistry } from "../skills/index.js";
import { registerBuiltins } from "../tools/builtins/index.js";
import { describePowershell } from "../tools/builtins/powershell.js";
import {
  childRegistryOf,
  registerSubagent,
} from "../tools/builtins/subagent.js";
import { ToolRegistry } from "../tools/registry.js";

const logger = getLogger("miniagent.server");

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = resolve(__dirname, "../../public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const MAX_BODY_BYTES = 256 * 1024;

/**
 * 超限后仍继续读掉的字节数上限。
 *
 * 超限就立刻停止读取会让双方互等：客户端还在传，服务端已经不看，
 * TCP 缓冲区填满后客户端的写阻塞，而客户端又要等响应——实测要等 socket
 * 超时（约 6s）才拿到 400。所以这里继续读掉一部分再报错，让客户端能立刻收到响应。
 * 上限存在的意义是不让「无限读取」变成新的放大面：超过就断开连接。
 */
const MAX_DRAIN_BYTES = 1024 * 1024;

/** 正在运行的 Agent：runId → 上下文，供 /api/stop 取消 */
const activeRuns = new Map<string, AgentContext>();

interface ChatRequest {
  message: string;
  history: Array<{ role: string; content: string }>;
  /** 可选：续聊某个已持久化的会话；不传则新建 */
  session_id?: string;
  /** 可选：续跑某个中断/挂起的运行；给了它就不需要 message */
  resume_run_id?: string;
}

/** 服务器级依赖：启动时构建一次，各请求复用。导出以便测试自行拼装 */
export interface ServerDeps {
  settings: Settings;
  registry: ToolRegistry;
  skills: SkillRegistry;
  knowledge: KnowledgeBase;
  sessions: SessionStore;
  longTerm: LongTermMemory;
  /** 当前生效的长期记忆后端描述，启动时算一次，写进轨迹用 */
  longTermLabel: string;
  /** LLM 客户端无状态（只持有配置），各请求安全复用。类型放宽到 BaseLLM 便于测试注入替身 */
  llm: BaseLLM;
  /** 指标聚合器：跨请求累计，每次请求把该请求的 bus 挂上去 */
  metrics: Metrics;
  /** OTel 导出器：同样跨请求累计，每次请求把该请求的 bus 挂上去 */
  otel: OtelLike;
  /** 每个会话一个摘要记忆实例，避免不同会话的历史摘要互相污染 */
  memories: Map<string, SummaryMemory>;
}

/** 会话 id 只允许安全字符，与 SessionStore 的校验保持一致 */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** 读取并限制请求体大小，返回原始字符串 */
async function readRawBody(request: IncomingMessage): Promise<string> {
  let size = 0;
  let overflowed = false;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      overflowed = true;
      // 已经不打算用这份内容了，尽早释放
      chunks.length = 0;
      if (size > MAX_BODY_BYTES + MAX_DRAIN_BYTES) {
        request.destroy();
        break;
      }
      continue;
    }
    chunks.push(chunk as Buffer);
  }
  if (overflowed) throw new MiniAgentError("请求体过大");
  return Buffer.concat(chunks).toString("utf-8");
}

async function readJsonBody(request: IncomingMessage): Promise<ChatRequest> {
  const raw = await readRawBody(request);
  const parsed = JSON.parse(raw) as ChatRequest;
  const resumeRunId =
    typeof parsed.resume_run_id === "string" && parsed.resume_run_id.length > 0
      ? parsed.resume_run_id
      : undefined;
  // resume_run_id 会被当作 runId 登记进 activeRuns，必须限制字符集
  if (resumeRunId && !SAFE_ID.test(resumeRunId)) {
    throw new MiniAgentError("resume_run_id 含非法字符");
  }
  // 续跑时模型侧不需要新输入：原始问题已在存档里，所以 message 可以为空
  if (!resumeRunId && (typeof parsed.message !== "string" || !parsed.message.trim())) {
    throw new MiniAgentError("字段 message 必须是非空字符串（除非提供 resume_run_id）");
  }
  return {
    message: typeof parsed.message === "string" ? parsed.message : "",
    history: Array.isArray(parsed.history) ? parsed.history : [],
    session_id: typeof parsed.session_id === "string" ? parsed.session_id : undefined,
    resume_run_id: resumeRunId,
  };
}

/** 以 SSE 格式写一条事件（连接已关闭时安全跳过） */
function writeSSE(response: ServerResponse, event: string, data: unknown): void {
  if (response.writableEnded) return;
  try {
    response.write(`event: ${event}\n`);
    response.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch {
    // 客户端已断开，写入失败是正常现象
  }
}

/** 会话历史接口：GET /api/sessions 列表、GET /api/sessions/:id 详情、DELETE 删除 */
async function handleSessions(
  request: IncomingMessage,
  response: ServerResponse,
  urlPath: string,
  sessions: SessionStore,
): Promise<void> {
  const json = (status: number, payload: unknown): void => {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(payload));
  };

  const prefix = "/api/sessions/";
  // 导入：把别处导出的整份会话写进本实例（跨实例搬历史用）。
  // 必须排在 :id 分支之前，否则 "import" 会被当成会话 id。
  if (request.method === "POST" && urlPath === `${prefix}import`) {
    try {
      const body = JSON.parse(await readRawBody(request)) as {
        // 导入的是外部 JSON：这里只取用得到的字段，其余交给 SessionStore 校验
        session?: {
          id?: unknown;
          title?: unknown;
          createdAt?: unknown;
          messages?: unknown;
        };
        overwrite?: boolean;
      };
      const session = body.session;
      if (!session || typeof session.id !== "string" || !SAFE_ID.test(session.id)) {
        json(400, { error: "需要 session.id（仅字母数字下划线连字符）" });
        return;
      }
      const summary = await sessions.import(
        {
          id: session.id,
          title: session.title,
          createdAt: session.createdAt,
          messages: session.messages,
        },
        { overwrite: body.overwrite === true },
      );
      json(200, { ok: true, session: summary });
    } catch (error) {
      json(400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (urlPath.startsWith(prefix)) {
    const rest = decodeURIComponent(urlPath.slice(prefix.length));
    // 导出：原样吐出整份会话，可直接 POST 到另一个实例的 /api/sessions/import
    if (request.method === "GET" && rest.endsWith("/export")) {
      const session = await sessions.get(rest.slice(0, -"/export".length));
      if (!session) {
        json(404, { error: "会话不存在" });
        return;
      }
      json(200, { exportedAt: Date.now() / 1000, session });
      return;
    }

    const id = rest;
    if (request.method === "DELETE") {
      const removed = await sessions.remove(id);
      json(removed ? 200 : 404, removed ? { ok: true } : { error: "会话不存在" });
      return;
    }
    const session = await sessions.get(id);
    if (!session) {
      json(404, { error: "会话不存在" });
      return;
    }
    json(200, session);
    return;
  }

  json(200, { sessions: await sessions.list() });
}

/**
 * 取上一轮的执行事实，交给 Agent 渲染进系统提示词的证据小节。
 *
 * 为什么不拼在历史消息里（先前的做法，实测失败）：拼在 assistant 消息后面时，
 * 模型会说「这行是我自己敲的，也是我编的」而不认账——挂在 assistant 名下就等于它自己的话。
 * 放进系统提示词，再加上"这段由运行期记录、不是你的输出"的说明，它才有可用的provenance。
 *
 * 只看**最后一条** assistant 轮次：出问题的场景就是"上一轮我说过什么"，
 * 更早的轮次既让提示词变重，也会把不同时间的执行事实混在一起。
 */
function lastTurnToolFacts(turns: SessionTurn[]): SessionToolFact[] {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    if (turn.role !== "assistant") continue;
    return turn.tools ?? [];
  }
  return [];
}

/** 处理一次 Agent 对话：把 EventBus 事件实时转发给浏览器，并把问答落盘为会话历史 */
async function handleChat(
  request: IncomingMessage,
  response: ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  const { settings } = deps;
  const body = await readJsonBody(request);

  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // 会话 id：续聊用请求里的，否则新建
  const sessionId =
    body.session_id && SAFE_ID.test(body.session_id) ? body.session_id : newId();

  // 历史以服务端持久化的会话为准；没有则用请求里带的（兼容首次发送）
  const existing = await deps.sessions.get(sessionId);
  const priorTurns: SessionTurn[] = existing
    ? existing.messages
    : body.history
        .filter((item) => item.role === "user" || item.role === "assistant")
        .map((item) => ({
          role: item.role as "user" | "assistant",
          content: item.content,
          ts: Date.now() / 1000,
        }));
  const history: Message[] = priorTurns.map((turn) => ({
    role: turn.role,
    content: turn.content,
  }));

  // 建立运行上下文并登记，第一时间把 runId 与会话 id 告知浏览器。
  // 续跑时沿用存档里的 runId：前端要靠它去查轨迹、做审批，也必须与存档对得上。
  const resuming = body.resume_run_id !== undefined;
  const context = new AgentContext(body.resume_run_id);
  activeRuns.set(context.runId, context);
  writeSSE(response, "run_started", {
    run_id: context.runId,
    session_id: sessionId,
    resumed: resuming,
  });

  // 客户端断开连接时取消运行（监听 response.close 而非 request.close，
  // 因为 request.close 在读完请求体后就触发，会误取消正在执行的 Agent）
  const onClose = () => context.requestCancel();
  response.on("close", onClose);

  // 每请求独立事件总线，订阅后立刻转发
  const bus = new EventBus();
  // 轨迹落盘：与 CLI 一致，每次运行写入 traces/<runId>.jsonl，供事后回看
  new Tracer(bus, settings.traceDir);
  // 本请求的事件汇入全局指标聚合器（attach 而非构造订阅，见 metrics.ts 注释）
  deps.metrics.attach(bus);
  // 同一份事件也映射成 GenAI span 导出（未启用时是空实现）
  deps.otel.attach(bus);

  bus.subscribe(EventType.LLMStart, async () => {
    writeSSE(response, "status", { phase: "thinking", text: "正在思考…" });
  });
  // token 级流式：把增量原样透出，前端边收边显示
  bus.subscribe(EventType.LLMDelta, async (event) => {
    writeSSE(response, "llm_delta", {
      text: event.payload.text,
      tool_name: event.payload.tool_name,
    });
  });
  bus.subscribe(EventType.LLMEnd, async (event) => {
    // 把本轮模型的推理文本推给前端，供"思考内容"折叠展示
    writeSSE(response, "llm_end", {
      content: event.payload.content,
      tool_calls: event.payload.tool_calls,
      latency: Number((event.payload.latency as number).toFixed(2)),
      prompt_tokens: event.payload.prompt_tokens,
      completion_tokens: event.payload.completion_tokens,
    });
  });
  bus.subscribe(EventType.ToolStart, async (event) => {
    writeSSE(response, "tool_start", {
      name: event.payload.name,
      arguments: event.payload.arguments,
    });
  });
  bus.subscribe(EventType.ToolEnd, async (event) => {
    writeSSE(response, "tool_end", {
      name: event.payload.name,
      ok: event.payload.ok,
      error: event.payload.error,
      latency: Number((event.payload.latency as number).toFixed(2)),
      // 完整入参与产出：前端展开后可见
      input: event.payload.input,
      output: event.payload.output,
    });
  });

  // Agent 是无状态门面（历史从请求传入），每请求新建并绑定本请求的 bus；
  // LLM 客户端只持有配置，直接复用启动时建的实例
  const llm = deps.llm;

  // 每个会话一个摘要记忆实例：本进程内复用，进程重启后由会话文件兜底
  let memory = deps.memories.get(sessionId);
  if (!memory) {
    memory = new SummaryMemory(llm, {
      ...DEFAULT_SUMMARY_OPTIONS,
      maxTokens: settings.memoryMaxTokens,
      summarizeThreshold: settings.memorySummaryThreshold,
    });
    deps.memories.set(sessionId, memory);
  }

  const agent = new Agent(llm, deps.registry, settings, bus, {
    skills: deps.skills,
    memory,
    longTerm: deps.longTerm,
    // 上一轮真的执行过什么，进系统提示词的证据小节（见 lastTurnToolFacts）
    executionLedger: lastTurnToolFacts(priorTurns),
  });

  // 续跑时用户消息要取存档里的原始问题：请求体里的 message 是空的
  const turnInput = resuming
    ? ((await loadCheckpoint(settings.checkpointDir, context.runId))?.input ?? "")
    : body.message;

  try {
    // 续跑走 resume：模型侧不需要新输入，消息序列由存档提供
    const result = resuming
      ? await agent.resume(context.runId, undefined, context)
      : await agent.run(body.message, history, context);
    writeSSE(response, "final", {
      answer: result.answer,
      iterations: result.context.iterations,
      latency: Number(result.latency.toFixed(2)),
      tokens:
        result.context.usage.promptTokens + result.context.usage.completionTokens,
      prompt_versions: result.promptVersions,
    });

    // 落盘会话历史 + 长期记忆；失败只记警告，不影响已经给出的回答
    const now = Date.now() / 1000;
    try {
      await deps.sessions.append(sessionId, [
        { role: "user", content: turnInput, ts: now },
        {
          role: "assistant",
          content: result.answer,
          runId: context.runId,
          // 带上真实执行过的工具：下一轮靠它避免"把当前工具清单当历史事实"
          ...(result.context.tools.length > 0
            ? { tools: [...result.context.tools] }
            : {}),
          ts: now,
        },
      ]);
      // 写入长期记忆：MemOS 后端会收到真实角色的一轮对话，本地后端收到一条自包含文本
      await rememberTurn(deps.longTerm, {
        question: turnInput,
        answer: result.answer,
        ts: now,
        conversationId: sessionId,
        meta: { sessionId, runId: context.runId },
      });
      // 写入明细进轨迹：本轮往长期记忆里放了什么、落在哪个后端
      await bus.publish(
        makeEvent(
          EventType.MemoryWrite,
          {
            backend: deps.longTermLabel,
            session_id: sessionId,
            question: turnInput,
            answer: result.answer,
          },
          context.runId,
        ),
      );
    } catch (persistError) {
      const reason =
        persistError instanceof Error ? persistError.message : String(persistError);
      logger.warning(`会话落盘失败: ${reason}`);
    }
  } catch (error) {
    // 挂起等审批：**这不是失败**，所以单独一个事件，前端据此渲染批准/拒绝
    if (error instanceof ApprovalRequiredError) {
      writeSSE(response, "approval_required", {
        run_id: error.runId,
        call_id: error.call.id,
        tool: error.call.name,
        arguments: error.call.arguments,
        session_id: sessionId,
      });
    } else {
      const message = error instanceof Error ? error.message : String(error);
      writeSSE(response, "error", {
        message,
        cancelled: context.signal.aborted,
      });
    }
  } finally {
    activeRuns.delete(context.runId);
    response.off("close", onClose);
    writeSSE(response, "done", {});
    if (!response.writableEnded) response.end();
  }
}

function newId(): string {
  return randomUUID().replace(/-/g, "");
}

/** 读取某次运行的 JSONL 轨迹，返回结构化记录列表（供"原始轨迹"查看） */
async function handleTrace(
  response: ServerResponse,
  runId: string,
  traceDir: string,
): Promise<void> {
  // 防路径穿越：run_id 只允许安全字符
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) {
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "非法 run_id" }));
    return;
  }
  try {
    const raw = await readFile(join(traceDir, `${runId}.jsonl`), "utf-8");
    const records = raw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ run_id: runId, records }));
  } catch {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "轨迹不存在" }));
  }
}

/** 托管 public/ 静态文件，带路径穿越防护 */
async function serveStatic(response: ServerResponse, urlPath: string): Promise<void> {
  const relativePath = normalize(urlPath === "/" ? "index.html" : urlPath.slice(1));
  const filePath = join(PUBLIC_DIR, relativePath);
  if (!filePath.startsWith(PUBLIC_DIR + sep) && filePath !== PUBLIC_DIR) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  try {
    const content = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream",
      // 教学阶段：静态资源不缓存，避免改了代码浏览器仍是旧版
      "Cache-Control": "no-cache",
    });
    response.end(content);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not Found");
  }
}

/** 在默认浏览器中打开页面 */
function openBrowser(url: string): void {
  const platform = process.platform;
  const command =
    platform === "win32"
      ? spawn("cmd", ["/c", "start", "", url], { detached: true })
      : platform === "darwin"
        ? spawn("open", [url], { detached: true })
        : spawn("xdg-open", [url], { detached: true });
  command.on("error", (error) => logger.warning(`无法打开浏览器: ${error.message}`));
  command.unref();
}

async function main(): Promise<void> {
  setupLogging(process.env.MINIAGENT_LOG_LEVEL ?? "WARNING");
  const settings = loadSettings();

  const registry = new ToolRegistry();
  await registerBuiltins(registry, settings);

  // 阶段二：技能目录（渐进式披露）+ 会话历史 + 长期记忆
  const skills = await SkillRegistry.load(settings.skillsDir);
  registerSkillTools(registry, skills);

  // 知识库走「模型自主检索」：注册成工具由模型决定何时查，而不是每轮硬注入
  const knowledge = createKnowledgeBase(settings);
  registerKnowledgeTools(registry, knowledge);

  // MCP：只有配了 mcp.json 才会加载 SDK 并连接远端（含 stdio 子进程）
  const mcp = await registerMcpTools(registry, settings.mcpConfigPath);

  const llm = new OpenAICompatibleClient(settings);

  // 子 agent 必须最后注册：它的子工具集是「除自己以外的全部工具」
  registerSubagent(registry, {
    llm,
    settings,
    childRegistry: (role) => childRegistryOf(registry, role),
  });

  const deps: ServerDeps = {
    settings,
    registry,
    skills,
    knowledge,
    sessions: new SessionStore(settings.historyDir),
    // 生命周期记忆注入 LLM 压缩器后即启用「巩固」
    longTerm: createLongTermMemory(settings, createMemorySummarizer(llm, settings)),
    longTermLabel: describeLongTermMemory(settings),
    llm,
    metrics: new Metrics(),
    otel: createOtelExporter(settings),
    memories: new Map<string, SummaryMemory>(),
  };

  logger.info(`长期记忆后端: ${deps.longTermLabel}`);
  logger.info(`通用执行通道: ${describePowershell(settings)}`);
  logger.info(`可观测导出: ${describeOtel(settings)}`);
  // 刻意不在这里统计文档数：语义后端会因此触发首次索引（含模型下载），把启动拖成几分钟
  logger.info(
    `知识库: ${describeKnowledgeBackend(settings)}（目录 ${settings.knowledgeDirs.join("、")}）`,
  );

  const server = createServer(createRequestHandler(deps));

  // MCP 的连接（含 stdio 子进程）要显式关闭，否则子进程可能残留；
  // OTel 也要先 flush，否则最后一批 span 随进程一起消失
  const shutdown = (): void => {
    void Promise.allSettled([mcp.close(), deps.otel.close()]).finally(() => {
      process.exit(0);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  const port = Number(process.env.PORT ?? 3000);

  // listen 失败是通过 'error' 事件报的，不是 throw——没有这个处理器就只能看到
  // 裸的 "Unhandled 'error' event" 栈，用户根本不知道是端口冲突还是权限问题。
  server.on("error", (error: NodeJS.ErrnoException) => {
    process.stderr.write(`\n服务器启动失败: ${describeListenError(error, port)}\n`);
    process.exitCode = 1;
  });

  server.listen(port, () => {
    const url = `http://localhost:${port}`;
    logger.info(`MiniAgent UI 已启动: ${url}`);
    process.stdout.write(`MiniAgent 研究控制台已启动: ${url}\n`);
    process.stdout.write(`长期记忆: ${deps.longTermLabel}\n`);
    process.stdout.write(`知识库: ${describeKnowledgeBackend(settings)}\n`);
    process.stdout.write(`知识库目录: ${settings.knowledgeDirs.join("、")}\n`);
    process.stdout.write(`MCP 工具: ${describeMcp(mcp)}\n`);
    process.stdout.write(`通用执行: ${describePowershell(settings)}\n`);
    process.stdout.write(`可观测: ${describeOtel(settings)}\n`);
    openBrowser(url);
  });
}

/** 把 listen 的常见失败翻译成「下一步该做什么」，而不是只回一个 errno */
function describeListenError(error: NodeJS.ErrnoException, port: number): string {
  if (error.code === "EADDRINUSE") {
    return (
      `端口 ${port} 已被占用。\n` +
      `  先确认是不是已经有一个 MiniAgent 在跑：打开 http://localhost:${port}\n` +
      `  换端口重试：$env:PORT=3001; npm start`
    );
  }
  if (error.code === "EACCES") {
    return (
      `没有权限监听端口 ${port}（1024 以下的端口通常需要管理员权限）。\n` +
      `  换一个大于 1024 的端口：$env:PORT=3001; npm start`
    );
  }
  return error.message;
}

/**
 * 路由与请求处理。抽成工厂是为了可测：测试可以直接拿这个 listener 建
 * `http.Server` 跑在临时端口上，不用启动整个进程（也就不用真实 LLM 与真端口）。
 */
export function createRequestHandler(deps: ServerDeps) {
  return (request: IncomingMessage, response: ServerResponse): void => {
    // settings 原先取自 main 的局部变量，抽出来后从 deps 取
    const { settings } = deps;
    const urlPath = (request.url ?? "/").split("?")[0]!;
    if (request.method === "POST" && urlPath === "/api/stop") {
      // 停止指定运行：读取 run_id → 找到上下文 → 触发取消
      readRawBody(request)
        .then((raw) => {
          const { run_id: runId } = JSON.parse(raw) as { run_id?: string };
          const target = runId ? activeRuns.get(runId) : undefined;
          if (!target) {
            response.writeHead(404, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ ok: false, error: "运行不存在或已结束" }));
            return;
          }
          target.requestCancel();
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ ok: true }));
        })
        .catch((error: unknown) => {
          response.writeHead(400, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        });
      return;
    }
    if (
      // POST 只用于 /api/sessions/import（跨实例导入会话）
      (request.method === "GET" ||
        request.method === "DELETE" ||
        request.method === "POST") &&
      (urlPath === "/api/sessions" || urlPath.startsWith("/api/sessions/"))
    ) {
      void handleSessions(request, response, urlPath, deps.sessions);
      return;
    }
    // 可续跑/待审批的运行列表
    if (request.method === "GET" && urlPath === "/api/runs") {
      void listCheckpoints(settings.checkpointDir)
        .then((runs) => {
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({ runs }));
        })
        .catch((error: unknown) => {
          response.writeHead(500, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
          );
        });
      return;
    }
    // 人工审批：只写决定，续跑由客户端再发一次 /api/chat {resume_run_id}
    // 拆成两步是为了让决定落盘——两步之间进程重启也不丢
    if (request.method === "POST" && urlPath === "/api/approve") {
      readRawBody(request)
        .then(async (raw) => {
          const { run_id: runId, approved } = JSON.parse(raw) as {
            run_id?: string;
            approved?: boolean;
          };
          if (!runId || !SAFE_ID.test(runId) || typeof approved !== "boolean") {
            response.writeHead(400, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ ok: false, error: "需要 run_id 与布尔型 approved" }));
            return;
          }
          const call = await recordApproval(settings.checkpointDir, runId, approved);
          if (!call) {
            response.writeHead(404, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ ok: false, error: "该运行没有待审批项" }));
            return;
          }
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ ok: true, call }));
        })
        .catch((error: unknown) => {
          response.writeHead(400, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        });
      return;
    }
    if (request.method === "POST" && urlPath === "/api/chat") {
      handleChat(request, response, deps).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (!response.headersSent) {
          response.writeHead(400, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: message }));
        } else {
          writeSSE(response, "error", { message });
          response.end();
        }
      });
      return;
    }
    if (request.method === "GET" && urlPath === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          provider: settings.provider,
          model: settings.model,
          longTermMemory: deps.longTermLabel,
          tools: deps.registry.all().map((tool) => tool.name),
        }),
      );
      return;
    }
    if (request.method === "GET" && urlPath === "/metrics") {
      // 默认 Prometheus 文本格式（可直接被 Prometheus/Grafana 抓取）；
      // ?format=json 给人工排查用
      const wantsJson = (request.url ?? "").includes("format=json");
      response.writeHead(200, {
        "Content-Type": wantsJson
          ? "application/json; charset=utf-8"
          : "text/plain; version=0.0.4; charset=utf-8",
      });
      response.end(
        wantsJson
          ? JSON.stringify(deps.metrics.snapshot(), null, 2)
          : deps.metrics.toPrometheus(),
      );
      return;
    }
    if (request.method === "GET" && urlPath.startsWith("/api/trace/")) {
      const runId = decodeURIComponent(urlPath.slice("/api/trace/".length));
      void handleTrace(response, runId, settings.traceDir);
      return;
    }
    if (request.method === "GET") {
      void serveStatic(response, urlPath);
      return;
    }
    response.writeHead(405);
    response.end("Method Not Allowed");
  };
}

/** 只有作为入口直接运行时才启动服务；被测试 import 时不应产生副作用 */
const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(
      `服务器启动失败: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
