/**
 * MiniAgent 前端逻辑：
 * 1. 发送消息到 POST /api/chat（SSE 流式响应）
 * 2. 实时渲染 Agent 步骤时间线（思考 / 工具调用 / 结果）
 * 3. 最终答案做轻量 Markdown 渲染（先转义 HTML，防注入）
 * 4. 表格 / 图片 / 流程图：Markdown 渲染器在 markdown.js，图表由 mermaid 按需渲染
 */

import { renderMarkdown } from "./markdown.js";

const thread = document.querySelector("#thread");
const welcome = document.querySelector("#welcome");
const input = document.querySelector("#input");
const sendBtn = document.querySelector("#sendBtn");
const statusDot = document.querySelector("#statusDot");
const modelName = document.querySelector("#modelName");
const historyWrap = document.querySelector(".history-wrap");
const historyBtn = document.querySelector("#historyBtn");
const historyPanel = document.querySelector("#historyPanel");
const newChatBtn = document.querySelector("#newChatBtn");

/** 单条输入/输出展示的最大字符数，超出则截断（完整内容见原始轨迹） */
const MAX_IO_CHARS = 20000;

/** 会话历史（只保留 user / assistant 的纯文本，回传给后端做多轮上下文） */
// 刻意不叫 history：那会遮蔽 window.history，是个容易踩的坑
let chatHistory = [];
let busy = false;
/** 当前会话 id：由服务端下发并持久化，刷新后据此恢复 */
let sessionId = null;
/** 当前运行 ID（由 run_started 事件下发，停止时回传） */
let currentRunId = null;
/** runId 下发前就点了停止：意图排队，run_started 一到达立即补发 */
let stopRequested = false;

/** 切换发送/停止按钮外观 */
function setButtonMode(isBusy) {
  const iconSend = sendBtn.querySelector(".icon-send");
  const iconStop = sendBtn.querySelector(".icon-stop");
  if (isBusy) {
    sendBtn.classList.add("stopping");
    sendBtn.disabled = false;
    sendBtn.setAttribute("aria-label", "停止");
    iconSend.hidden = true;
    iconStop.hidden = false;
  } else {
    sendBtn.classList.remove("stopping");
    sendBtn.disabled = false;
    sendBtn.setAttribute("aria-label", "发送");
    iconSend.hidden = false;
    iconStop.hidden = true;
  }
}

/** 点击停止：记录意图；runId 已知则立即通知后端，否则等 run_started 补发 */
function requestStop() {
  stopRequested = true;
  if (currentRunId) {
    void doStop(currentRunId);
  }
}

async function doStop(runId) {
  sendBtn.disabled = true;
  try {
    await fetch("/api/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run_id: runId }),
    });
  } catch {
    // 停止请求本身失败时，SSE 流仍会随取消结束，忽略即可
  }
}

// 获取后端模型名（接口返回 /health）
fetch("/health")
  .then((r) => r.json())
  .then((data) => {
    if (data.model) modelName.textContent = data.model;
  })
  .catch(() => {});

/* ---------------- 输入交互 ---------------- */

// 文本框自适应高度
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight}px`;
});

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void submit();
  }
});

sendBtn.addEventListener("click", () => {
  if (busy) {
    requestStop();
  } else {
    void submit();
  }
});

// 建议芯片
document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    if (busy) return;
    input.value = chip.dataset.prompt;
    input.dispatchEvent(new Event("input"));
    void submit();
  });
});

async function submit() {
  const message = input.value.trim();
  if (!message || busy) return;

  busy = true;
  currentRunId = null;
  stopRequested = false;
  setButtonMode(true);
  statusDot.className = "status-dot busy";

  // 首次提问时隐藏欢迎页，建立消息容器
  const inner = ensureThread();

  appendUserBubble(inner, message);
  const assistantCard = createAssistantCard(inner, message);
  scrollToBottom();

  input.value = "";
  input.style.height = "auto";

  try {
    await streamChat(message, assistantCard);
  } catch (error) {
    assistantCard.markError(`请求中断：${error.message ?? error}`);
    statusDot.className = "status-dot error";
  } finally {
    // 运行结束：无论成功 / 失败 / 停止，都统一重置全部 UI 状态
    assistantCard.finish();
    busy = false;
    currentRunId = null;
    stopRequested = false;
    setButtonMode(false);
    statusDot.className = "status-dot";
    input.focus();
  }
}

/* ---------------- 消息元素构造 ---------------- */

function appendUserBubble(container, text) {
  const bubble = document.createElement("div");
  bubble.className = "msg-user";
  bubble.textContent = text;
  container.appendChild(bubble);
}

function createAssistantCard(container, userMessage) {
  const card = document.createElement("div");
  card.className = "msg-assistant";
  card.innerHTML = `
    <div class="steps"></div>
    <div class="stream" hidden></div>
    <div class="status-line">
      <span class="spinner"></span><span class="status-text">等待响应…</span>
    </div>
    <div class="answer" hidden></div>
  `;
  container.appendChild(card);

  const stepsEl = card.querySelector(".steps");
  const streamEl = card.querySelector(".stream");
  const statusLine = card.querySelector(".status-line");
  const answerEl = card.querySelector(".answer");

  /** 一个工具一个时间线条目，用 name+序号 匹配 tool_start / tool_end */
  const stepMap = new Map();
  let toolSeq = 0;
  let runId = null;

  return {
    /** run_started 到达时记录，供"原始轨迹"按钮读取 */
    setRunId(id) {
      runId = id;
    },

    setStatus(text) {
      statusLine.querySelector(".status-text").textContent = text;
    },

    /**
     * 流式增量：逐段追加成一段"正在打字"的实时文本。
     * 它只是过程预览——轮次结束时（llm_end）即收起，内容由"思考"折叠区与答案区正式呈现。
     */
    appendStream(text) {
      if (!text) return;
      if (streamEl.hidden) {
        streamEl.hidden = false;
        streamEl.classList.add("streaming");
      }
      streamEl.textContent += text;
      scrollToBottom();
    },

    /** 收起实时文本，避免与"思考"折叠区、最终答案重复 */
    endStream() {
      if (streamEl.hidden) return;
      streamEl.hidden = true;
      streamEl.textContent = "";
      streamEl.classList.remove("streaming");
    },

    /** 模型一轮推理的思考内容（可折叠）。无推理文本时退化为该轮决策摘要 */
    addThinking(content, meta) {
      const calls = meta?.tool_calls ?? [];
      // 最终答案轮不展示：其内容已由答案区呈现，避免重复
      if (!calls.length) return;
      const text = (content ?? "").trim();
      const think = document.createElement("div");
      think.className = "think";
      think.innerHTML = `
        <button type="button" class="think-head" aria-expanded="false">
          <span class="think-badge">思考</span>
          <span class="think-preview"></span>
          <span class="caret">▸</span>
        </button>
        <pre class="think-body" hidden></pre>
      `;
      const decision = `本轮决定调用：${calls.join("、")}（${meta.latency}s）`;
      think.querySelector(".think-preview").textContent = text
        ? previewLine(text)
        : decision;
      think.querySelector(".think-body").textContent = text
        ? `${text}\n\n—— ${decision}`
        : decision;
      bindToggle(think.querySelector(".think-head"), think.querySelector(".think-body"), think);
      stepsEl.appendChild(think);
      scrollToBottom();
    },

    addToolStart(name, args) {
      const step = document.createElement("div");
      step.className = "step running";
      const argsText = summarizeArgs(name, args);
      step.innerHTML = `
        <span class="step-node"><span class="spinner"></span></span>
        <button type="button" class="step-head" aria-expanded="false">
          <span class="step-name"></span>
          <span class="step-args"></span>
          <span class="caret">▸</span>
        </button>
        <div class="step-body" hidden>
          <div class="io-label">输入</div>
          <pre class="io-pre"></pre>
          <div class="io-label io-out" hidden>输出</div>
          <pre class="io-pre io-pre-out" hidden></pre>
        </div>
      `;
      const nameEl = step.querySelector(".step-name");
      const argsEl = step.querySelector(".step-args");
      nameEl.textContent = name;
      argsEl.textContent = argsText;
      argsEl.title = argsText;
      // 完整入参（未省略）放在展开区
      step.querySelector(".step-body .io-pre").textContent = prettyJson(args);
      bindToggle(step.querySelector(".step-head"), step.querySelector(".step-body"), step);
      stepsEl.appendChild(step);
      const key = `${name}#${toolSeq++}`;
      stepMap.set(key, step);
      this.setStatus(`正在调用 ${name}…`);
      scrollToBottom();
      return key;
    },

    finishTool(key, ok, error, latency, output) {
      const step = stepMap.get(key);
      if (!step) return;
      step.classList.remove("running");
      step.classList.add(ok ? "step-done" : "step-failed");
      step.querySelector(".step-node").innerHTML = "";

      const head = step.querySelector(".step-head");
      const latencyEl = document.createElement("span");
      latencyEl.className = "step-latency";
      latencyEl.textContent = `${latency}s`;
      head.insertBefore(latencyEl, head.querySelector(".caret"));

      const outLabel = step.querySelector(".io-out");
      const outPre = step.querySelector(".io-pre-out");
      if (!ok && error) {
        outLabel.textContent = "错误";
        outLabel.hidden = false;
        outPre.hidden = false;
        outPre.textContent = String(error);
      } else if (output !== undefined) {
        outLabel.hidden = false;
        outPre.hidden = false;
        outPre.textContent = prettyJson(output);
      }
      this.setStatus(ok ? "工具执行完成" : "工具执行失败");
    },

    showAnswer(html, meta) {
      this.finish();
      answerEl.hidden = false;
      answerEl.innerHTML = html;
      // 流程图交给 mermaid；没有图表时这个调用是零成本的
      void renderDiagrams(answerEl);
      if (meta) {
        const metaEl = document.createElement("div");
        metaEl.className = "run-meta";
        metaEl.textContent =
          `ITER ${meta.iterations} · ${meta.tokens} TOKENS · ${meta.latency}s`;
        answerEl.appendChild(metaEl);
      }
      // 已落盘则提供原始轨迹入口（思考 + 工具输入/输出的逐条记录）
      if (runId) answerEl.appendChild(makeTraceViewer(runId));
      chatHistory.push({ role: "user", content: userMessage });
      chatHistory.push({ role: "assistant", content: meta.answer });
      scrollToBottom();
    },

    markError(message) {
      this.finish();
      const banner = document.createElement("div");
      banner.className = "error-banner";
      banner.textContent = message;
      card.appendChild(banner);
      scrollToBottom();
    },

    /** 用户主动停止：中性样式 */
    markStopped() {
      this.finish();
      const banner = document.createElement("div");
      banner.className = "stopped-banner";
      banner.textContent = "已停止 · 本次运行被用户中断";
      card.appendChild(banner);
      scrollToBottom();
    },

    /** 运行结束统一收尾（幂等）：停掉在途 spinner、收起实时文本、隐藏状态行、重置文案 */
    finish() {
      for (const step of stepMap.values()) {
        if (step.classList.contains("running")) {
          step.classList.remove("running");
          step.querySelector(".step-node").innerHTML = "";
        }
      }
      this.endStream();
      statusLine.hidden = true;
      statusLine.querySelector(".status-text").textContent = "正在思考…";
    },
  };
}

/* ---------------- 详情展开 / 轨迹查看 ---------------- */

/** 点击标题行时切换详情区的展开状态 */
function bindToggle(head, body, root) {
  head.addEventListener("click", () => {
    const expand = body.hidden;
    body.hidden = !expand;
    root.classList.toggle("expanded", expand);
    head.setAttribute("aria-expanded", String(expand));
  });
}

/** 把任意值渲染成可读的多行 JSON；超长内容截断，避免拖垮页面 */
function prettyJson(value) {
  let text;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  if (text === undefined) text = String(value);
  if (text.length > MAX_IO_CHARS) {
    text = `${text.slice(0, MAX_IO_CHARS)}\n…（已截断，完整内容见原始轨迹）`;
  }
  return text;
}

/** 取首行作为折叠态的预览文本 */
function previewLine(text) {
  const line = text.split("\n").find((item) => item.trim()) ?? "";
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

/** 每条回复末尾的「查看原始轨迹」入口 */
function makeTraceViewer(runId) {
  const wrap = document.createElement("div");
  wrap.className = "trace-wrap";
  wrap.innerHTML = `
    <button type="button" class="trace-btn" aria-expanded="false">查看原始轨迹</button>
    <div class="trace-panel" hidden></div>
  `;
  const btn = wrap.querySelector(".trace-btn");
  const panel = wrap.querySelector(".trace-panel");
  btn.addEventListener("click", () => void toggleTrace(btn, panel, runId));
  return wrap;
}

/** 拉取并渲染某次运行的 JSONL 轨迹（首次点击才请求） */
async function toggleTrace(btn, panel, runId) {
  if (!panel.hidden) {
    panel.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    return;
  }
  if (panel.dataset.loaded !== "1") {
    panel.textContent = "加载中…";
    panel.hidden = false;
    try {
      const response = await fetch(`/api/trace/${encodeURIComponent(runId)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      panel.innerHTML = "";
      for (const record of data.records) {
        const row = document.createElement("div");
        row.className = "trace-row";
        const head = document.createElement("div");
        head.className = "trace-row-head";
        const time = new Date(record.ts * 1000).toLocaleTimeString("zh-CN");
        head.textContent = `${record.type} · ${time}`;
        const pre = document.createElement("pre");
        pre.className = "io-pre";
        pre.textContent = prettyJson(record.payload);
        row.append(head, pre);
        panel.appendChild(row);
      }
      if (!data.records.length) panel.textContent = "本次运行没有轨迹记录";
      panel.dataset.loaded = "1";
    } catch (error) {
      panel.textContent = `加载失败：${error.message ?? error}`;
      return;
    }
  }
  panel.hidden = false;
  btn.setAttribute("aria-expanded", "true");
}

/* ---------------- 会话历史（持久化 / 恢复 / 切换） ---------------- */

/** 隐藏欢迎页并确保消息容器存在；返回该容器 */
function ensureThread() {
  if (welcome) welcome.hidden = true;
  let inner = document.querySelector("#threadInner");
  if (!inner) {
    inner = document.createElement("div");
    inner.className = "thread-inner";
    inner.id = "threadInner";
    thread.appendChild(inner);
  }
  return inner;
}

/** 开新对话：清空界面与上下文，回到欢迎页 */
function startNewChat() {
  if (busy) return;
  sessionId = null;
  chatHistory = [];
  const inner = document.querySelector("#threadInner");
  if (inner) inner.remove();
  if (welcome) welcome.hidden = false;
  closeHistoryPanel();
  input.focus();
}

/** 页面加载时恢复最近一次会话；没有历史则保留欢迎页 */
async function restoreLatestSession() {
  try {
    const response = await fetch("/api/sessions");
    if (!response.ok) return;
    const data = await response.json();
    const latest = (data.sessions ?? [])[0];
    if (latest) await openSession(latest.id);
  } catch {
    // 拉不到历史不影响正常使用，静默保留欢迎页
  }
}

/** 打开某个历史会话并渲染 */
async function openSession(id) {
  if (busy) return;
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
    if (!response.ok) return;
    renderSession(await response.json());
  } catch {
    // 忽略：会话可能刚被删除
  }
}

function renderSession(session) {
  sessionId = session.id;
  chatHistory = session.messages.map((turn) => ({ role: turn.role, content: turn.content }));

  const inner = ensureThread();
  inner.innerHTML = "";
  for (const turn of session.messages) {
    if (turn.role === "user") {
      appendUserBubble(inner, turn.content);
    } else {
      appendRestoredAnswer(inner, turn);
    }
  }
  scrollToBottom();
}

/**
 * 恢复出来的答案卡片：只有正文 + 轨迹入口。
 * 步骤时间线属于"某次运行"而非"会话"，因此不放这里，需要时点开轨迹查看。
 */
function appendRestoredAnswer(container, turn) {
  const card = document.createElement("div");
  card.className = "msg-assistant";
  const answer = document.createElement("div");
  answer.className = "answer";
  answer.innerHTML = renderMarkdown(turn.content);
  // 历史里的答案同样可能有流程图，恢复时一并渲染
  void renderDiagrams(answer);
  if (turn.runId) answer.appendChild(makeTraceViewer(turn.runId));
  card.appendChild(answer);
  container.appendChild(card);
}

/** 展开/收起历史列表（每次展开重新拉取，保证看到最新会话） */
async function toggleHistoryPanel() {
  if (!historyPanel.hidden) {
    closeHistoryPanel();
    return;
  }
  historyPanel.hidden = false;
  historyBtn.setAttribute("aria-expanded", "true");
  historyPanel.textContent = "加载中…";
  try {
    const response = await fetch("/api/sessions");
    const data = await response.json();
    historyPanel.innerHTML = "";
    const sessions = data.sessions ?? [];
    if (sessions.length === 0) {
      historyPanel.textContent = "还没有历史会话";
      return;
    }
    for (const item of sessions) {
      historyPanel.appendChild(makeHistoryRow(item));
    }
  } catch {
    historyPanel.textContent = "加载失败";
  }
}

function makeHistoryRow(item) {
  const row = document.createElement("div");
  row.className = "history-row";
  if (item.id === sessionId) row.classList.add("active");

  const openBtn = document.createElement("button");
  openBtn.type = "button";
  openBtn.className = "history-open";
  const title = document.createElement("span");
  title.className = "history-title";
  title.textContent = item.title;
  const meta = document.createElement("span");
  meta.className = "history-meta";
  meta.textContent = `${formatTime(item.updatedAt)} · ${item.turns} 轮`;
  openBtn.append(title, meta);
  openBtn.addEventListener("click", () => {
    closeHistoryPanel();
    void openSession(item.id);
  });

  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "history-del";
  delBtn.textContent = "删除";
  delBtn.addEventListener("click", async () => {
    await fetch(`/api/sessions/${encodeURIComponent(item.id)}`, { method: "DELETE" });
    if (item.id === sessionId) startNewChat();
    row.remove();
    if (!historyPanel.querySelector(".history-row")) {
      historyPanel.textContent = "还没有历史会话";
    }
  });

  row.append(openBtn, delBtn);
  return row;
}

function closeHistoryPanel() {
  historyPanel.hidden = true;
  historyBtn.setAttribute("aria-expanded", "false");
}

/** 当天只显示时分，更早的显示月日 */
function formatTime(seconds) {
  const date = new Date(seconds * 1000);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

historyBtn.addEventListener("click", () => void toggleHistoryPanel());
newChatBtn.addEventListener("click", () => startNewChat());

// 点击面板外部时收起
document.addEventListener("click", (event) => {
  if (historyPanel.hidden) return;
  if (historyWrap && historyWrap.contains(event.target)) return;
  closeHistoryPanel();
});

// 启动即尝试恢复上次会话
void restoreLatestSession();

/* ---------------- SSE 流式通信 ---------------- */

async function streamChat(message, card) {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      history: chatHistory,
      // 带上会话 id，服务端据此续写并持久化
      session_id: sessionId ?? undefined,
    }),
  });

  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error ?? `HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let gotFinal = false;
  // 用 (name, arguments) 顺序配对工具的开始/结束
  const pending = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

    // SSE 帧以空行分隔
    const frames = buffer.split("\n\n");
    buffer = frames.pop();
    for (const frame of frames) {
      const parsed = parseFrame(frame);
      if (!parsed) continue;

      switch (parsed.event) {
        case "run_started":
          currentRunId = parsed.data.run_id;
          card.setRunId(currentRunId);
          // 服务端下发会话 id：记录下来，后续请求续写同一会话
          if (parsed.data.session_id) sessionId = parsed.data.session_id;
          // 点击停止早于 runId 到达：立即补发
          if (stopRequested) void doStop(currentRunId);
          break;
        case "status":
          card.setStatus(parsed.data.text);
          break;
        case "llm_delta":
          card.appendStream(parsed.data.text);
          break;
        case "llm_end":
          // 有工具调用 → 本轮文本会进"思考"折叠区，收起预览避免重复；
          // 没有工具调用 → 它就是最终答案，保留预览直到 final 用渲染后的答案无缝替换
          if ((parsed.data.tool_calls ?? []).length > 0) card.endStream();
          card.addThinking(parsed.data.content, parsed.data);
          break;
        case "tool_start": {
          const key = card.addToolStart(parsed.data.name, parsed.data.arguments);
          // 记录名称，便于 tool_end 乱序到达时按名匹配
          pending.push({ key, name: parsed.data.name });
          break;
        }
        case "tool_end": {
          // 优先匹配同名的最早条目（同批并发可能乱序返回），否则取队首
          let index = pending.findIndex((item) => item.name === parsed.data.name);
          if (index === -1) index = 0;
          const [{ key }] = pending.splice(index, 1);
          card.finishTool(
            key,
            parsed.data.ok,
            parsed.data.error,
            parsed.data.latency,
            parsed.data.output,
          );
          break;
        }
        case "final":
          gotFinal = true;
          card.endStream();
          card.showAnswer(renderMarkdown(parsed.data.answer), parsed.data);
          break;
        case "error":
          // 状态点的重置统一交给 submit 的 finally 处理
          if (parsed.data.cancelled) {
            card.markStopped();
          } else {
            card.markError(parsed.data.message);
          }
          break;
        case "done":
          return;
      }
    }
  }
  } catch (streamError) {
    // reader.read() 抛错（ERR_ABORTED 等）：如果已收到答案就忽略，否则报错
    if (!gotFinal) {
      throw new Error(`连接中断: ${streamError.message ?? streamError}`);
    }
  }

  // 流正常结束但没收到 final 事件（服务端提前关闭）
  if (!gotFinal) {
    throw new Error("服务端未返回最终结果");
  }
}

/** 解析一帧 SSE：提取 event: 与 data:（data 可能多行） */
function parseFrame(frame) {
  let event = "message";
  const dataLines = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    return null;
  }
}

/* ---------------- 工具辅助 ---------------- */

/** 把工具参数压缩成一行可读文本，展示在时间线上 */
function summarizeArgs(name, args) {
  if (!args || Object.keys(args).length === 0) return "（无参数）";
  try {
    const text = JSON.stringify(args);
    return text.length > 80 ? `${text.slice(0, 80)}…` : text;
  } catch {
    return String(args);
  }
}

/* ---------------- Markdown 与图表 ----------------
   渲染器在 markdown.js（纯函数，可被单测直接验证）；这里负责把渲染结果里的
   `.mermaid` 节点交给 mermaid，以及加载失败时的降级展示。 */

/**
 * mermaid 是**按需**加载的：页面里真出现 ` ```mermaid ` 图表时才去 CDN 取一次，
 * 同一个页面生命周期只加载一次。离线/内网取不到时会抛错，由调用方降级成代码块展示。
 */
let mermaidPromise = null;

function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import(
      "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs"
    )
      .then((module) => {
        const mermaid = module.default;
        mermaid.initialize({
          startOnLoad: false,
          theme: "dark",
          // strict：图表文本不允许注入 HTML/脚本（默认值，这里写出来是为了别人改动时能看见）
          securityLevel: "strict",
        });
        return mermaid;
      })
      .catch((error) => {
        // 不缓存失败：网络恢复后再次渲染应当能重新尝试
        mermaidPromise = null;
        throw error;
      });
  }
  return mermaidPromise;
}

/** 把容器内的 `.mermaid` 节点渲染成 SVG；失败则原地降级为可复制的代码块 */
async function renderDiagrams(root) {
  const nodes = [...root.querySelectorAll(".mermaid")];
  if (nodes.length === 0) return;

  try {
    const mermaid = await loadMermaid();
    // 逐个渲染：一张图语法错不该拖累同一答案里的其他图
    for (const node of nodes) {
      try {
        await mermaid.run({ nodes: [node] });
      } catch (error) {
        degradeDiagram(node, error);
      }
    }
  } catch (error) {
    for (const node of nodes) degradeDiagram(node, error);
  }
}

/** 渲染失败：用 DOM API 组装（textContent 天然转义，不必再手写 escape） */
function degradeDiagram(node, error) {
  if (node.dataset.degraded === "1") return;
  node.dataset.degraded = "1";

  const wrap = document.createElement("div");
  wrap.className = "diagram-fallback";

  const hint = document.createElement("p");
  hint.className = "diagram-hint";
  const reason = error instanceof Error ? error.message : String(error);
  hint.textContent = `图表未能渲染（mermaid 需要联网加载，也可能是语法问题）：${reason}`;

  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.className = "language-mermaid";
  code.textContent = node.textContent ?? "";
  pre.appendChild(code);

  wrap.appendChild(hint);
  wrap.appendChild(pre);
  node.replaceWith(wrap);
}

function scrollToBottom() {
  thread.scrollTop = thread.scrollHeight;
}
