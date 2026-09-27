/**
 * HTTP 层测试：直接驱动 `createRequestHandler`，跑在临时端口上。
 *
 * 不启动整个进程（不读 .env、不开浏览器、不用真实 LLM），
 * 依赖全部用替身注入，因此可以确定性地覆盖路由、校验、SSE 与取消。
 */

import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApprovalAllowlist } from "../src/agent/allowlist.js";
import { saveCheckpoint } from "../src/agent/checkpoint.js";
import { loadSettings, type Settings } from "../src/core/config.js";
import { SessionStore } from "../src/history/store.js";
import type { KnowledgeBase } from "../src/knowledge/index.js";
import type { LongTermMemory, MemoryRecord } from "../src/memory/base.js";
import { Metrics } from "../src/observability/metrics.js";
import { createOtelExporter } from "../src/observability/otel.js";
import { createRequestHandler, type ServerDeps } from "../src/server/server.js";
import { SkillRegistry } from "../src/skills/index.js";
import { calculator } from "../src/tools/builtins/calculator.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { FakeLLM, finalResponse, toolCallResponse, type LLMCall } from "./fakes.js";

/** 什么都不做的长期记忆：HTTP 层测试不关心记忆内容 */
const emptyMemory: LongTermMemory = {
  add: async (_record: MemoryRecord) => {},
  search: async () => [],
  load: async () => [],
};

/** 空知识库：避免语义后端在测试里加载模型 */
const emptyKnowledge: KnowledgeBase = {
  docs: async () => [],
  search: async () => [],
};

/** 挂在 fetch 上的一条 SSE 事件 */
interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

let server: Server;
let baseUrl: string;
let deps: ServerDeps;
let tempDir: string;

/** 解析 SSE 字节流为事件序列 */
async function* sseEvents(response: Response): AsyncGenerator<SseEvent> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf("\n\n");
    while (index >= 0) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const event = /^event: (.+)$/m.exec(block)?.[1] ?? "message";
      const raw = /^data: (.*)$/m.exec(block)?.[1] ?? "{}";
      yield { event, data: JSON.parse(raw) as Record<string, unknown> };
      index = buffer.indexOf("\n\n");
    }
  }
}

/** 读完全部事件 */
async function collectSse(response: Response): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  for await (const event of sseEvents(response)) events.push(event);
  return events;
}

/** 不加任何规范化的原始请求：用来验证路径穿越防护（fetch 会先帮忙 normalize 掉） */
function rawRequest(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(Number(new URL(baseUrl).port), "127.0.0.1");
    let text = "";
    socket.setEncoding("utf-8");
    socket.on("connect", () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
    });
    socket.on("data", (chunk: string) => {
      text += chunk;
    });
    socket.on("end", () => resolve(text));
    socket.on("error", reject);
  });
}

function postChat(body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "miniagent-server-"));
  process.env.MINIAGENT_DEEPSEEK_API_KEY = "test-key";
  const settings: Settings = {
    ...loadSettings(),
    traceDir: join(tempDir, "traces"),
    historyDir: join(tempDir, "history"),
    workspace: join(tempDir, "workspace"),
    // 待审批存档写这里，供 /api/approve 的用例构造现场
    checkpointDir: join(tempDir, "checkpoints"),
    // 配置接口写盘的目标：指向临时目录，绝不碰开发者真实 .env
    envFile: join(tempDir, ".env"),
    adminToken: "test-admin-token",
    approvalAllowlistFile: join(tempDir, "approvals", "allowlist.jsonl"),
  };

  const registry = new ToolRegistry();
  registry.register(calculator);

  const allowlist = new ApprovalAllowlist(settings.approvalAllowlistFile);
  await allowlist.load();

  deps = {
    settings,
    registry,
    skills: await SkillRegistry.load(join(tempDir, "no-such-skills")),
    knowledge: emptyKnowledge,
    sessions: new SessionStore(settings.historyDir),
    longTerm: emptyMemory,
    longTermLabel: "测试用记忆",
    llm: new FakeLLM([finalResponse("默认回答")]),
    metrics: new Metrics(),
    otel: createOtelExporter(settings),
    memories: new Map(),
    allowlist,
    // 默认放行；需要拒绝的用例自行替换
    aiApprover: { judge: async () => ({ verdict: "approve", reason: "测试放行" }) },
  };

  server = createServer(createRequestHandler(deps));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("健康检查与指标", () => {
  it("GET /health 返回模型与工具清单", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      ok: boolean;
      model: string;
      tools: string[];
    };
    expect(body.ok).toBe(true);
    expect(body.model).toBe(deps.settings.model);
    expect(body.tools).toContain("calculator");
  });

  it("GET /metrics 默认输出 Prometheus 文本，?format=json 输出 JSON", async () => {
    const prometheus = await fetch(`${baseUrl}/metrics`);
    expect(prometheus.status).toBe(200);
    expect(prometheus.headers.get("content-type")).toContain("text/plain");

    const json = await fetch(`${baseUrl}/metrics?format=json`);
    expect(json.headers.get("content-type")).toContain("application/json");
    // 还没跑过任何任务，快照也应该是合法 JSON 对象
    expect(typeof (await json.json())).toBe("object");
  });
});

describe("会话接口", () => {
  it("空库时列出空数组", async () => {
    const response = await fetch(`${baseUrl}/api/sessions`);
    expect(await response.json()).toEqual({ sessions: [] });
  });

  it("不存在的会话取详情与删除都返回 404", async () => {
    expect((await fetch(`${baseUrl}/api/sessions/nonexistent`)).status).toBe(404);
    expect(
      (await fetch(`${baseUrl}/api/sessions/nonexistent`, { method: "DELETE" })).status,
    ).toBe(404);
  });

  it("写入后可列出、取详情、删除", async () => {
    await deps.sessions.append("s_test", [
      { role: "user", content: "你好", ts: 1 },
      { role: "assistant", content: "你好，我是 MiniAgent", ts: 1 },
    ]);

    const list = (await (await fetch(`${baseUrl}/api/sessions`)).json()) as {
      sessions: Array<{ id: string }>;
    };
    expect(list.sessions.map((item) => item.id)).toEqual(["s_test"]);

    const detail = (await (await fetch(`${baseUrl}/api/sessions/s_test`)).json()) as {
      messages: Array<{ content: string }>;
    };
    expect(detail.messages.map((item) => item.content)).toEqual([
      "你好",
      "你好，我是 MiniAgent",
    ]);

    expect(
      (await fetch(`${baseUrl}/api/sessions/s_test`, { method: "DELETE" })).status,
    ).toBe(200);
    expect((await fetch(`${baseUrl}/api/sessions/s_test`)).status).toBe(404);
  });
});

describe("会话跨实例搬运", () => {
  /** 导出 → 换个实例导入：跨实例搬历史的最小闭环 */
  it("导出的会话可直接导入另一个实例，内容一致", async () => {
    await deps.sessions.append("s_move", [
      { role: "user", content: "这条会话要搬家", ts: 1 },
      { role: "assistant", content: "好的", runId: "run_1", ts: 2 },
    ]);

    const exported = (await (
      await fetch(`${baseUrl}/api/sessions/s_move/export`)
    ).json()) as {
      session: { id: string; title: string; createdAt: number; messages: unknown };
    };
    expect(exported.session.messages).toBeTruthy();

    // 另一实例：全新的 history 目录
    const otherDir = join(tempDir, "history-other");
    const other = new SessionStore(otherDir);
    const summary = await other.import(exported.session);

    expect(summary.id).toBe("s_move");
    expect(summary.turns).toBe(1);
    const moved = await other.get("s_move");
    expect(moved?.messages.map((item) => item.content)).toEqual([
      "这条会话要搬家",
      "好的",
    ]);
    // assistant 的 runId 也得保留，否则搬过去就看不了轨迹了
    expect(moved?.messages[1]?.runId).toBe("run_1");
  });

  it("POST /api/sessions/import 写进本实例，重复导入默认被拒", async () => {
    const payload = {
      session: {
        id: "s_imported",
        title: "导入的会话",
        createdAt: 100,
        messages: [
          { role: "user", content: "从别处来", ts: 1 },
          { role: "assistant", content: "收到", ts: 2 },
        ],
      },
    };

    const first = await fetch(`${baseUrl}/api/sessions/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(first.status).toBe(200);
    expect((await first.json()) as { session: { title: string } }).toMatchObject({
      ok: true,
      session: { id: "s_imported", title: "导入的会话" },
    });

    const again = await fetch(`${baseUrl}/api/sessions/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(again.status).toBe(400);
    expect((await again.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("已存在"),
    });

    // overwrite=true 时按导入内容重建，而不是把两段历史接在一起
    const overwritten = await fetch(`${baseUrl}/api/sessions/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session: {
          id: "s_imported",
          messages: [{ role: "user", content: "覆盖后只剩这一轮", ts: 3 }],
        },
        overwrite: true,
      }),
    });
    expect(overwritten.status).toBe(200);
    const detail = (await (
      await fetch(`${baseUrl}/api/sessions/s_imported`)
    ).json()) as { messages: Array<{ content: string }>; turns: number };
    expect(detail.messages.map((item) => item.content)).toEqual(["覆盖后只剩这一轮"]);
    expect(detail.turns).toBe(1);
  });

  it("导入非法会话被拒：id 含路径穿越字符或缺少 id", async () => {
    const badId = await fetch(`${baseUrl}/api/sessions/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: { id: "../../etc/passwd", messages: [] } }),
    });
    expect(badId.status).toBe(400);

    const noId = await fetch(`${baseUrl}/api/sessions/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: { messages: [] } }),
    });
    expect(noId.status).toBe(400);
  });

  it("导入时丢弃结构非法的轮次，坏数据不影响正常轮次", async () => {
    const response = await fetch(`${baseUrl}/api/sessions/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session: {
          id: "s_dirty",
          messages: [
            { role: "user", content: "正常一轮", ts: 1 },
            { role: "system", content: "不该出现在历史里" },
            { role: "assistant" },
            "这不是对象",
            null,
          ],
        },
      }),
    });
    expect(response.status).toBe(200);

    const detail = (await (
      await fetch(`${baseUrl}/api/sessions/s_dirty`)
    ).json()) as { messages: Array<{ content: string }> };
    expect(detail.messages.map((item) => item.content)).toEqual(["正常一轮"]);
  });
});

describe("轨迹接口", () => {
  it("非法 run_id 被拒（防路径穿越）", async () => {
    const response = await fetch(`${baseUrl}/api/trace/${encodeURIComponent("../../secret")}`);
    expect(response.status).toBe(400);
  });

  it("轨迹不存在返回 404", async () => {
    expect((await fetch(`${baseUrl}/api/trace/run_missing`)).status).toBe(404);
  });

  it("轨迹存在时按行解析为记录数组", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(deps.settings.traceDir, { recursive: true });
    await writeFile(
      join(deps.settings.traceDir, "run_ok.jsonl"),
      '{"type":"run_start"}\n{"type":"llm_end"}\n',
      "utf-8",
    );

    const body = (await (await fetch(`${baseUrl}/api/trace/run_ok`)).json()) as {
      run_id: string;
      records: Array<{ type: string }>;
    };
    expect(body.run_id).toBe("run_ok");
    expect(body.records.map((record) => record.type)).toEqual(["run_start", "llm_end"]);
  });
});

describe("静态资源", () => {
  it("GET / 返回控制台页面", async () => {
    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("MiniAgent");
  });

  it("不存在的文件返回 404", async () => {
    expect((await fetch(`${baseUrl}/no-such-file.js`)).status).toBe(404);
  });

  it("越出 public/ 的路径返回 403", async () => {
    const raw = await rawRequest("/../../package.json");
    expect(raw).toContain("403");
  });
});

describe("POST /api/chat", () => {
  it("正常问答：SSE 依次给出 run_started / final / done，并落盘会话", async () => {
    deps.llm = new FakeLLM([finalResponse("答案是 3")]);
    const response = await postChat({ message: "1+2 等于几？" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const events = await collectSse(response);
    const names = events.map((item) => item.event);
    expect(names[0]).toBe("run_started");
    expect(names).toContain("final");
    expect(names.at(-1)).toBe("done");

    const started = events[0]!.data as { run_id: string; session_id: string };
    expect(started.run_id).toBeTruthy();
    expect(started.session_id).toBeTruthy();

    const final = events.find((item) => item.event === "final")!.data as {
      answer: string;
      iterations: number;
    };
    expect(final.answer).toBe("答案是 3");

    // 问题与回答都写进了会话历史
    const stored = await deps.sessions.get(started.session_id);
    expect(stored?.messages.map((item) => item.content)).toEqual([
      "1+2 等于几？",
      "答案是 3",
    ]);
  });

  it("工具调用过程通过 tool_start / tool_end 推送", async () => {
    deps.llm = new FakeLLM([
      {
        content: "",
        toolCalls: [{ id: "c1", name: "calculator", arguments: { expression: "2*3" } }],
        usage: { promptTokens: 0, completionTokens: 0 },
        finishReason: "tool_calls",
      },
      finalResponse("等于 6"),
    ]);

    const events = await collectSse(await postChat({ message: "2*3" }));
    const toolStart = events.find((item) => item.event === "tool_start")!.data as {
      name: string;
      arguments: Record<string, unknown>;
    };
    expect(toolStart.name).toBe("calculator");
    expect(toolStart.arguments).toEqual({ expression: "2*3" });

    const toolEnd = events.find((item) => item.event === "tool_end")!.data as {
      ok: boolean;
    };
    expect(toolEnd.ok).toBe(true);
  });

  it("message 缺失或为空白时返回 400", async () => {
    const response = await postChat({ message: "   " });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("message");
  });

  it("请求体超限返回 400", async () => {
    const response = await postChat({ message: "甲".repeat(257 * 1024) });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("过大");
  });

  it("续聊同一会话时历史以服务端持久化内容为准", async () => {
    await deps.sessions.append("s_keep", [
      { role: "user", content: "上一轮的问题", ts: 1 },
      { role: "assistant", content: "上一轮的回答", ts: 1 },
    ]);

    deps.llm = new FakeLLM([finalResponse("接着答")]);
    const events = await collectSse(
      await postChat({
        message: "这一轮的问题",
        // 客户端塞进来的历史应被忽略：服务端已有该会话的持久化记录
        history: [{ role: "user", content: "伪造的历史" }],
        session_id: "s_keep",
      }),
    );

    const started = events[0]!.data as { session_id: string };
    expect(started.session_id).toBe("s_keep");

    const calls = (deps.llm as unknown as { calls: LLMCall[] }).calls;
    const userMessages = calls[0]!.messages
      .filter((message) => message.role === "user")
      .map((message) => message.content);
    expect(userMessages).toEqual(["上一轮的问题", "这一轮的问题"]);
  });

  it("非法 session_id 会另建新会话，而不是写进别人目录", async () => {
    const events = await collectSse(
      await postChat({ message: "你好", session_id: "../../etc" }),
    );
    const started = events[0]!.data as { session_id: string };
    expect(started.session_id).not.toBe("../../etc");
    expect(/^[A-Za-z0-9_-]+$/.test(started.session_id)).toBe(true);
  });

  it("执行事实落进会话历史，并在下一轮进入系统提示词（但不污染界面文本）", async () => {
    // 第一轮：一个成功的工具 + 一个不存在的工具（覆盖成功与失败两条路径）
    deps.llm = new FakeLLM([
      toolCallResponse([
        ["c1", "calculator", { expression: "2*3" }],
        ["c2", "no_such_tool", {}],
      ]),
      finalResponse("等于 6"),
    ]);
    const first = await collectSse(await postChat({ message: "2*3" }));
    const sessionId = (first[0]!.data as { session_id: string }).session_id;

    // 事实被持久化，而用户可见的回答文本保持原样
    const stored = await deps.sessions.get(sessionId);
    expect(stored?.messages[1]?.content).toBe("等于 6");
    expect(stored?.messages[1]?.tools).toEqual([
      { name: "calculator", ok: true },
      { name: "no_such_tool", ok: false },
    ]);

    // 第二轮：台账进的是**系统提示词**（不是拼在历史消息里——拼在 assistant 名下会被当成它自己的话）
    deps.llm = new FakeLLM([finalResponse("接着答")]);
    await collectSse(await postChat({ message: "还等于几", session_id: sessionId }));

    const messages = (deps.llm as unknown as { calls: LLMCall[] }).calls[0]!.messages;
    const systemPrompt = messages.find((message) => message.role === "system")!.content;
    expect(systemPrompt).toContain("上一轮实际执行〕calculator 成功；no_such_tool 失败");
    expect(systemPrompt).toContain("不是你的输出");

    // 历史消息保持原样：台账既不进用户可见的回答，也不混进 assistant 消息
    const assistantHistory = messages.filter((message) => message.role === "assistant");
    expect(assistantHistory[0]!.content).toBe("等于 6");
  });
});

describe("POST /api/stop", () => {
  it("run_id 不存在时返回 404", async () => {
    const response = await fetch(`${baseUrl}/api/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run_id: "not_running" }),
    });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { ok: boolean }).ok).toBe(false);
  });

  it("请求体不是合法 JSON 时返回 400", async () => {
    const response = await fetch(`${baseUrl}/api/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ 不是 JSON",
    });
    expect(response.status).toBe(400);
  });

  it("能取消正在运行的对话", async () => {
    // 挂起的 LLM：只有收到 abort 才结束，否则永不返回
    deps.llm = {
      chat: (_messages, _tools, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    };

    const response = await postChat({ message: "慢慢想" });
    const iterator = sseEvents(response);
    const first = await iterator.next();
    const { run_id: runId } = first.value!.data as { run_id: string };

    const stop = await fetch(`${baseUrl}/api/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run_id: runId }),
    });
    expect(stop.status).toBe(200);

    // 取消后应收到带 cancelled 标记的 error，然后正常收尾
    const rest: SseEvent[] = [];
    for await (const event of iterator) rest.push(event);
    const error = rest.find((item) => item.event === "error")!.data as {
      cancelled: boolean;
    };
    expect(error.cancelled).toBe(true);
    expect(rest.at(-1)!.event).toBe("done");
  });
});

describe("方法与路由兜底", () => {
  it("不支持的方法返回 405", async () => {
    expect((await fetch(`${baseUrl}/health`, { method: "PUT" })).status).toBe(405);
    expect((await fetch(`${baseUrl}/api/unknown`, { method: "POST" })).status).toBe(405);
  });
});

describe("配置接口", () => {
  const TOKEN = "test-admin-token";

  function getConfig(token?: string): Promise<Response> {
    return fetch(`${baseUrl}/api/config`, {
      headers: token ? { "X-Admin-Token": token } : {},
    });
  }

  function putConfig(body: unknown, token?: string): Promise<Response> {
    return fetch(`${baseUrl}/api/config`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "X-Admin-Token": token } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  it("未配置管理令牌时一律 403", async () => {
    deps.settings.adminToken = "";
    expect((await getConfig(TOKEN)).status).toBe(403);
    expect((await putConfig({ values: {} }, TOKEN)).status).toBe(403);
  });

  it("令牌缺失或错误时 401", async () => {
    expect((await getConfig()).status).toBe(401);
    expect((await getConfig("wrong")).status).toBe(401);
    expect((await putConfig({ values: {} }, "wrong")).status).toBe(401);
  });

  it("GET 下发 schema 与当前值，且不含 API Key 明文", async () => {
    const response = await getConfig(TOKEN);
    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      schema: Array<{ key: string; env: string }>;
      values: Record<string, unknown>;
      readonlyModeNote: string;
    };
    expect(data.schema.map((field) => field.key)).toContain("shellMode");
    expect(data.values.model).toBe(deps.settings.model);
    expect(data.values.apiKeySet).toBe(true);
    expect(JSON.stringify(data)).not.toContain("test-key");
  });

  it("readonly 档下给出灰字说明，full 档下为空", async () => {
    deps.settings.shellMode = "readonly";
    const note = (await (await getConfig(TOKEN)).json()) as { readonlyModeNote: string };
    expect(note.readonlyModeNote).toContain("readonly");

    deps.settings.shellMode = "full";
    const full = (await (await getConfig(TOKEN)).json()) as { readonlyModeNote: string };
    expect(full.readonlyModeNote).toBe("");
  });

  it("PUT 改配置：写回 .env、原地改 settings、立即生效", async () => {
    const response = await putConfig(
      { values: { maxIterations: 12, model: "new-model" } },
      TOKEN,
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as { ok: boolean; applied: string[] };
    expect(data.ok).toBe(true);
    expect(data.applied.sort()).toEqual(["maxIterations", "model"]);

    expect(deps.settings.maxIterations).toBe(12);
    expect(deps.settings.model).toBe("new-model");

    const env = await readFile(deps.settings.envFile, "utf-8");
    expect(env).toContain("MINIAGENT_MAX_ITERATIONS=12\n");
    expect(env).toContain("MINIAGENT_MODEL=new-model\n");
  });

  it("PUT 改 shellMode 后工具表立即变化", async () => {
    expect(deps.registry.has("shell")).toBe(false);

    const on = await putConfig({ values: { shellMode: "full" } }, TOKEN);
    expect(on.status).toBe(200);
    expect(deps.settings.shellMode).toBe("full");
    expect(deps.registry.has("shell")).toBe(true);

    const off = await putConfig({ values: { shellMode: "off" } }, TOKEN);
    expect(off.status).toBe(200);
    expect(deps.registry.has("shell")).toBe(false);
  });

  it("校验失败返回 400，且 .env 与 settings 都不变", async () => {
    const before = deps.settings.shellMode;
    const response = await putConfig({ values: { shellMode: "read-only" } }, TOKEN);
    expect(response.status).toBe(400);
    const data = (await response.json()) as { errors: Array<{ key: string }> };
    expect(data.errors[0]!.key).toBe("shellMode");
    expect(deps.settings.shellMode).toBe(before);

    const env = await readFile(deps.settings.envFile, "utf-8").catch(() => "");
    expect(env).not.toContain("MINIAGENT_SHELL_MODE");
  });

  it("secret 留空表示保持原值，填了才覆盖", async () => {
    const before = deps.settings.apiKey;
    await putConfig({ values: { apiKey: "" } }, TOKEN);
    expect(deps.settings.apiKey).toBe(before);

    await putConfig({ values: { apiKey: "sk-new-key-value" } }, TOKEN);
    expect(deps.settings.apiKey).toBe("sk-new-key-value");
    const env = await readFile(deps.settings.envFile, "utf-8");
    expect(env).toContain("MINIAGENT_API_KEY=sk-new-key-value\n");
  });
});

describe("人工审批接口鉴权与命令级放行", () => {
  const TOKEN = "test-admin-token";

  function approve(body: unknown, token?: string): Promise<Response> {
    return fetch(`${baseUrl}/api/approve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "X-Admin-Token": token } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  function getAllowlist(token?: string): Promise<Response> {
    return fetch(`${baseUrl}/api/allowlist`, {
      headers: token ? { "X-Admin-Token": token } : {},
    });
  }

  function deleteAllowlist(body: unknown, token?: string): Promise<Response> {
    return fetch(`${baseUrl}/api/allowlist`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "X-Admin-Token": token } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  /** 造一份挂在某个工具调用上的待审批存档 */
  async function pendingCheckpoint(
    runId: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<void> {
    await saveCheckpoint(deps.settings.checkpointDir, {
      runId,
      input: "原始问题",
      createdAt: 1,
      updatedAt: 1,
      iterations: 0,
      usage: { promptTokens: 0, completionTokens: 0 },
      messages: [{ role: "system", content: "系统" }],
      promptVersions: [],
      approvals: {},
      pendingApproval: { callId: "c1", tool, arguments: args },
    });
  }

  it("未配置管理令牌时三个接口一律 403", async () => {
    deps.settings.adminToken = "";
    expect((await approve({ run_id: "run_x", approved: true }, TOKEN)).status).toBe(403);
    expect((await getAllowlist(TOKEN)).status).toBe(403);
    expect((await deleteAllowlist({ tool: "shell", arguments: {} }, TOKEN)).status).toBe(403);
  });

  it("令牌缺失或错误时 401", async () => {
    expect((await approve({ run_id: "run_x", approved: true })).status).toBe(401);
    expect((await approve({ run_id: "run_x", approved: true }, "wrong")).status).toBe(401);
    expect((await getAllowlist()).status).toBe(401);
    expect((await getAllowlist("wrong")).status).toBe(401);
    expect((await deleteAllowlist({ tool: "shell", arguments: {} }, "wrong")).status).toBe(401);
  });

  it("批准并 remember：记入白名单，响应带 remembered", async () => {
    await pendingCheckpoint("run_ok", "shell", { command: "date" });

    const response = await approve(
      { run_id: "run_ok", approved: true, remember: true },
      TOKEN,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      call: { tool: string; arguments: Record<string, unknown> };
      remembered: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.remembered).toBe(true);
    expect(body.call.tool).toBe("shell");

    const listed = (await (await getAllowlist(TOKEN)).json()) as {
      entries: Array<{ tool: string; arguments: Record<string, unknown> }>;
    };
    expect(listed.entries).toHaveLength(1);
    expect(listed.entries[0]).toMatchObject({ tool: "shell", arguments: { command: "date" } });
  });

  it("拒绝时即使 remember=true 也不写白名单", async () => {
    await pendingCheckpoint("run_no", "shell", { command: "rm -rf /" });

    const response = await approve({ run_id: "run_no", approved: false, remember: true }, TOKEN);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { remembered: boolean }).remembered).toBe(false);

    const listed = (await (await getAllowlist(TOKEN)).json()) as { entries: unknown[] };
    expect(listed.entries).toHaveLength(0);
  });

  it("没有待审批项返回 404；请求体不合法返回 400", async () => {
    expect((await approve({ run_id: "no_such_run", approved: true }, TOKEN)).status).toBe(404);
    expect((await approve({ run_id: "run_x" }, TOKEN)).status).toBe(400);
    expect((await approve({ run_id: "../etc", approved: true }, TOKEN)).status).toBe(400);
  });

  it("DELETE 白名单：删到返回 removed:true，删不存在返回 false，非法体 400", async () => {
    await deps.allowlist.add("shell", { command: "date" });

    const first = await deleteAllowlist(
      { tool: "shell", arguments: { command: "date" } },
      TOKEN,
    );
    expect(first.status).toBe(200);
    expect(((await first.json()) as { removed: boolean }).removed).toBe(true);

    const again = await deleteAllowlist(
      { tool: "shell", arguments: { command: "date" } },
      TOKEN,
    );
    expect(((await again.json()) as { removed: boolean }).removed).toBe(false);

    expect((await deleteAllowlist({ tool: "shell" }, TOKEN)).status).toBe(400);
  });
});

describe("POST /api/chat 的权限档位", () => {
  const TOKEN = "test-admin-token";

  function postChatWithMode(body: unknown, token?: string): Promise<Response> {
    return fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "X-Admin-Token": token } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  it("manual（或缺省）不需要令牌，run_started 回带档位", async () => {
    deps.llm = new FakeLLM([finalResponse("好的")]);
    const response = await postChatWithMode({ message: "你好" });
    expect(response.status).toBe(200);

    const events = await collectSse(response);
    const started = events[0]!.data as { permission_mode: string };
    expect(started.permission_mode).toBe("manual");
  });

  it("非 manual 档缺令牌 401、错令牌 401、对令牌 200 并回带档位", async () => {
    deps.llm = new FakeLLM([finalResponse("好的")]);

    expect((await postChatWithMode({ message: "hi", permission_mode: "full" })).status).toBe(401);
    expect(
      (await postChatWithMode({ message: "hi", permission_mode: "ai" }, "wrong")).status,
    ).toBe(401);

    const ok = await postChatWithMode({ message: "hi", permission_mode: "full" }, TOKEN);
    expect(ok.status).toBe(200);
    const events = await collectSse(ok);
    expect((events[0]!.data as { permission_mode: string }).permission_mode).toBe("full");
  });

  it("未配置令牌时非 manual 档也 403（堵住公网提权）", async () => {
    deps.settings.adminToken = "";
    expect(
      (await postChatWithMode({ message: "hi", permission_mode: "ai" }, TOKEN)).status,
    ).toBe(403);
  });

  it("非法档位值返回 400 并列出候选", async () => {
    const response = await postChatWithMode({ message: "hi", permission_mode: "ait" });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("manual");
  });

  it("ai 档：AI 的裁决以 approval_ai_verdict 事件推给前端", async () => {
    deps.settings.approvalTools = ["calculator"];
    deps.aiApprover = { judge: async () => ({ verdict: "approve", reason: "只读查询" }) };
    deps.llm = new FakeLLM([
      toolCallResponse([["c1", "calculator", { expression: "1+1" }]]),
      finalResponse("等于 2"),
    ]);

    const response = await postChatWithMode({ message: "1+1", permission_mode: "ai" }, TOKEN);
    expect(response.status).toBe(200);
    const events = await collectSse(response);
    const verdict = events.find((item) => item.event === "approval_ai_verdict");
    expect(verdict?.data).toMatchObject({
      tool: "calculator",
      verdict: "approve",
      reason: "只读查询",
    });
    // 工具照常执行、正常收尾
    expect(events.map((item) => item.event)).toContain("tool_end");
    expect(events.at(-1)!.event).toBe("done");
  });
});
