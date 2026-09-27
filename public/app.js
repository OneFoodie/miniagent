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
const configWrap = document.querySelector(".config-wrap");
const configBtn = document.querySelector("#configBtn");
const configPanel = document.querySelector("#configPanel");
const sessionBadge = document.querySelector("#sessionBadge");
const sessionTitle = document.querySelector("#sessionTitle");

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

// 获取后端模型名（接口返回 /health）；配置菜单改完模型后也用它刷新徽标
async function refreshModelBadge() {
  try {
    const response = await fetch("/health");
    const data = await response.json();
    if (data.model) modelName.textContent = data.model;
  } catch {
    // 后端没起来时保持默认文案
  }
}

void refreshModelBadge();

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
      // 新会话的标题由服务端从首个提问推导，首轮落盘后才拿得到
      void refreshSessionTitle();
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

/**
 * 当前会话 id 记在 sessionStorage（**每个标签页一份**），不是 localStorage。
 *
 * 起因是一个实测出来的问题：早先页面加载时无条件接管「最近那个会话」，而 sessionId 是页面级变量。
 * 于是新开标签页（或刷新）都会抢到同一个会话——两边的问题与回答交错写进同一份历史；
 * 更常见的是你以为在开新对话，实际是旧会话的续聊，新问题的回答因此接着旧内容走。
 *
 * 换成 sessionStorage 后语义就对了：
 *   新标签页 → 没有记录 → 从新对话开始
 *   同一标签页刷新 → 有记录 → 回到刚才那个会话，不丢进度
 *   两个标签页 → 各记各的，互不干扰
 */
const SESSION_KEY = "miniagent.sessionId";

/** 当前会话 id 的唯一写入口：同步 sessionStorage 与顶栏标识 */
function setSessionId(id) {
  sessionId = id ?? null;
  if (sessionId) sessionStorage.setItem(SESSION_KEY, sessionId);
  else sessionStorage.removeItem(SESSION_KEY);
}

/** 顶栏显示「在哪个会话」；标题未知（新会话还没落盘）时整块隐藏 */
function showSessionLabel(title) {
  if (title) {
    sessionTitle.textContent = title;
    sessionBadge.hidden = false;
  } else {
    sessionTitle.textContent = "";
    sessionBadge.hidden = true;
  }
}

/**
 * 新会话的标题由服务端在首轮落盘时从首个提问推导，所以这一轮跑完才拿得到。
 * 只在标题还空着时拉一次，避免每轮都多一个请求。
 */
async function refreshSessionTitle() {
  if (!sessionId || sessionTitle.textContent) return;
  const target = sessionId;
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(target)}`);
    if (!response.ok) return;
    const session = await response.json();
    // 期间可能已经切走会话，别把标题写到别的会话上
    if (session.id === target) showSessionLabel(session.title);
  } catch {
    // 拿不到标题不影响使用
  }
}

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
  setSessionId(null);
  showSessionLabel("");
  chatHistory = [];
  const inner = document.querySelector("#threadInner");
  if (inner) inner.remove();
  if (welcome) welcome.hidden = false;
  closeHistoryPanel();
  input.focus();
}

/**
 * 页面加载时只恢复**本标签页**上次的会话。
 * 新标签页没有记录，于是停在欢迎页、从新对话开始——这是「新开页面 = 新对话」应有的语义。
 */
async function restoreTabSession() {
  const saved = sessionStorage.getItem(SESSION_KEY);
  if (!saved) return;
  if (await openSession(saved)) return;
  // 会话已被删除、或换了实例：清掉记录，回到新对话
  setSessionId(null);
  showSessionLabel("");
}

/** 打开某个历史会话并渲染；返回是否真的打开了 */
async function openSession(id) {
  if (busy) return false;
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
    if (!response.ok) return false;
    renderSession(await response.json());
    return true;
  } catch {
    // 会话可能刚被删除
    return false;
  }
}

function renderSession(session) {
  setSessionId(session.id);
  showSessionLabel(session.title);
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

/* ---------------- 配置菜单 ---------------- */

const ADMIN_TOKEN_KEY = "miniagent.adminToken";

/**
 * 打开面板时服务端值 + 开关折算值的快照。
 * 只提交与它不同的项：否则「打开看一眼再点保存」会把 readonly 位置上的
 * 开关（显示为「关」）当成 off 提交，静默砍掉只读白名单。
 */
let configBaseline = null;
let configSchema = [];

const GROUP_LABELS = {
  model: "模型",
  runtime: "运行",
  sandbox: "执行权限（沙盒）",
  files: "文件边界",
  approval: "人工审批",
};

function adminToken() {
  return localStorage.getItem(ADMIN_TOKEN_KEY) ?? "";
}

/** 开关口径：开 = full，关 = off；readonly 也折算为「关」 */
function switchState(mode) {
  return mode === "full" ? "full" : "off";
}

function configRequest(init) {
  return fetch("/api/config", {
    ...init,
    headers: { "X-Admin-Token": adminToken(), ...(init?.headers ?? {}) },
  });
}

async function toggleConfigPanel() {
  if (!configPanel.hidden) {
    closeConfigPanel();
    return;
  }
  configPanel.hidden = false;
  configBtn.setAttribute("aria-expanded", "true");
  configPanel.textContent = "加载中…";
  await loadConfigPanel();
}

async function loadConfigPanel() {
  let response;
  let data;
  try {
    response = await configRequest();
    data = await response.json();
  } catch {
    renderConfigAuthError(0, "服务未响应");
    return;
  }
  if (!response.ok) {
    // 401 与 403 是两件完全不同的事，必须分开说：
    //   401 = 服务端配了令牌，但浏览器这边没填/填错（最常见，用户只需要在下面填一次）
    //   403 = 服务端根本没配 MINIAGENT_ADMIN_TOKEN，此时填什么都没用
    // 早先把两者混成一句「服务端未配置…403」的提示，把 401 说成了 403，会让人去改服务器。
    renderConfigAuthError(response.status, data.error);
    return;
  }
  configSchema = data.schema ?? [];
  configBaseline = { ...data.values };
  for (const field of configSchema) {
    if (field.type === "shellMode") {
      configBaseline[field.key] = switchState(data.values[field.key]);
    }
  }
  renderConfigPanel(data.values, data.readonlyModeNote ?? "");
}

/**
 * 令牌相关的失败面板。
 * @param status HTTP 状态码；0 表示请求根本没发出去（服务未响应）
 * @param serverMessage 服务端返回的 error 字段
 */
function renderConfigAuthError(status, serverMessage) {
  configPanel.innerHTML = "";
  const serverDisabled = status === 403;

  const notice = document.createElement("div");
  notice.className = "config-status error";
  notice.textContent = serverDisabled
    ? "服务端未配置 MINIAGENT_ADMIN_TOKEN，配置接口已禁用（403）。"
    : status === 401
      ? "需要管理令牌（401）：浏览器里还没有存，或存的值不对。"
      : serverMessage || "加载失败";
  configPanel.appendChild(notice);

  if (serverDisabled) {
    // 服务端没开这个接口，填令牌没有意义，只给「怎么在服务端开启」和「重新检查」
    const how = document.createElement("div");
    how.className = "config-hint";
    how.style.marginLeft = "0";
    how.textContent =
      "在服务器部署目录的 .env 里加一行 MINIAGENT_ADMIN_TOKEN=<足够长的随机串>，" +
      "重启服务（systemctl restart miniagent）后点下面的按钮。";
    configPanel.appendChild(how);

    const recheck = document.createElement("button");
    recheck.type = "button";
    recheck.className = "config-save";
    recheck.textContent = "重新检查";
    recheck.style.marginTop = "12px";
    recheck.addEventListener("click", () => {
      configPanel.textContent = "加载中…";
      void loadConfigPanel();
    });
    configPanel.appendChild(recheck);
    return;
  }

  const row = document.createElement("div");
  row.className = "config-field";
  const label = document.createElement("label");
  label.setAttribute("for", "configToken");
  label.textContent = "管理令牌";
  const tokenInput = document.createElement("input");
  tokenInput.type = "password";
  tokenInput.id = "configToken";
  tokenInput.value = adminToken();
  tokenInput.placeholder = "与服务端 MINIAGENT_ADMIN_TOKEN 一致";
  row.append(label, tokenInput);
  configPanel.appendChild(row);

  const actions = document.createElement("div");
  actions.className = "config-actions";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "config-save";
  retry.textContent = "保存令牌并重试";
  const submit = () => {
    localStorage.setItem(ADMIN_TOKEN_KEY, tokenInput.value.trim());
    configPanel.textContent = "加载中…";
    void loadConfigPanel();
  };
  retry.addEventListener("click", submit);
  actions.appendChild(retry);
  configPanel.appendChild(actions);

  const hint = document.createElement("div");
  hint.className = "config-hint";
  hint.style.marginLeft = "0";
  hint.textContent = "令牌只存在本机浏览器（localStorage），不会发给第三方；填一次之后就不用再填。";
  configPanel.appendChild(hint);

  // 输入后直接回车提交，省掉一次点击
  tokenInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") submit();
  });
  tokenInput.focus();
}

function renderConfigPanel(values, readonlyModeNote) {
  configPanel.innerHTML = "";
  const groups = new Map();
  for (const field of configSchema) {
    if (!groups.has(field.group)) groups.set(field.group, []);
    groups.get(field.group).push(field);
  }
  for (const [group, fields] of groups) {
    const title = document.createElement("h3");
    title.textContent = GROUP_LABELS[group] ?? group;
    configPanel.appendChild(title);
    for (const field of fields) {
      configPanel.appendChild(makeConfigRow(field, values, readonlyModeNote));
    }
  }

  const actions = document.createElement("div");
  actions.className = "config-actions";
  const save = document.createElement("button");
  save.type = "button";
  save.className = "config-save";
  save.textContent = "保存并生效";
  save.addEventListener("click", () => void saveConfig(save));
  const status = document.createElement("span");
  status.className = "config-status";
  status.id = "configStatus";
  actions.append(save, status);
  configPanel.appendChild(actions);

  const tokenRow = document.createElement("div");
  tokenRow.className = "config-field";
  const tokenLabel = document.createElement("label");
  tokenLabel.textContent = "管理令牌";
  const tokenInput = document.createElement("input");
  tokenInput.type = "password";
  tokenInput.id = "configToken";
  tokenInput.value = adminToken();
  tokenInput.addEventListener("change", () => {
    localStorage.setItem(ADMIN_TOKEN_KEY, tokenInput.value.trim());
  });
  tokenRow.append(tokenLabel, tokenInput);
  configPanel.appendChild(tokenRow);
}

function makeConfigRow(field, values, readonlyModeNote) {
  const name = `config-${field.key}`;

  // 沙盒开关：二值开关表达不了 readonly，所以勾选与否只看是否 full
  if (field.type === "shellMode") {
    const container = document.createElement("div");

    const row = document.createElement("div");
    row.className = "config-field";
    const label = document.createElement("label");
    label.setAttribute("for", name);
    label.textContent = field.label;
    const box = document.createElement("div");
    box.className = "config-switch";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = name;
    input.dataset.key = field.key;
    input.checked = values[field.key] === "full";
    const stateText = document.createElement("span");
    stateText.textContent = input.checked ? "开（full）" : "关（off）";
    input.addEventListener("change", () => {
      stateText.textContent = input.checked ? "开（full）" : "关（off）";
    });
    box.append(input, stateText);
    row.append(label, box);
    container.appendChild(row);

    const note = readonlyModeNote || field.description || "";
    if (note) {
      const hint = document.createElement("div");
      hint.className = "config-hint";
      hint.textContent = note;
      container.appendChild(hint);
    }
    return container;
  }

  const row = document.createElement("div");
  row.className = "config-field";
  const label = document.createElement("label");
  label.setAttribute("for", name);
  label.textContent = field.label;
  row.appendChild(label);

  let input;
  if (field.type === "boolean") {
    input = document.createElement("input");
    input.type = "checkbox";
    input.checked = Boolean(values[field.key]);
  } else if (field.type === "number") {
    input = document.createElement("input");
    input.type = "number";
    input.value = String(values[field.key] ?? "");
    if (field.min !== undefined) input.min = String(field.min);
    if (field.max !== undefined) input.max = String(field.max);
  } else if (field.type === "secret") {
    input = document.createElement("input");
    input.type = "password";
    input.value = "";
    input.placeholder = values.apiKeySet ? `已配置（${values.apiKeyMask}）· 留空不改` : "未配置";
  } else {
    input = document.createElement("input");
    input.type = "text";
    input.value = Array.isArray(values[field.key])
      ? values[field.key].join(",")
      : String(values[field.key] ?? "");
  }
  input.id = name;
  input.dataset.key = field.key;
  row.appendChild(input);

  if (!field.description) return row;
  const container = document.createElement("div");
  const hint = document.createElement("div");
  hint.className = "config-hint";
  hint.textContent = field.description;
  container.append(row, hint);
  return container;
}

/** 收集与初值不同的项；空对象表示没有可提交的变更 */
function collectConfigChanges() {
  const values = {};
  for (const field of configSchema) {
    const input = configPanel.querySelector(`#config-${field.key}`);
    if (!input) continue;

    if (field.type === "shellMode") {
      const next = input.checked ? "full" : "off";
      if (next !== configBaseline[field.key]) values[field.key] = next;
      continue;
    }
    // secret 留空 = 保持原值
    if (field.type === "secret") {
      if (input.value.trim() !== "") values[field.key] = input.value.trim();
      continue;
    }

    let next;
    if (field.type === "boolean") {
      next = input.checked;
    } else if (field.type === "number") {
      if (input.value.trim() === "") continue;
      next = Number(input.value);
    } else if (field.type === "list") {
      next = input.value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    } else {
      next = input.value.trim();
      if (next === "") continue;
    }

    const base = configBaseline[field.key];
    const same = Array.isArray(next)
      ? next.join(",") === (Array.isArray(base) ? base.join(",") : "")
      : next === base;
    if (!same) values[field.key] = next;
  }
  return values;
}

async function saveConfig(button) {
  const status = configPanel.querySelector("#configStatus");
  const values = collectConfigChanges();
  if (Object.keys(values).length === 0) {
    status.className = "config-status";
    status.textContent = "没有改动";
    return;
  }
  button.disabled = true;
  status.className = "config-status";
  status.textContent = "保存中…";
  try {
    const response = await configRequest({
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values }),
    });
    const data = await response.json();
    if (!response.ok) {
      const detail = (data.errors ?? []).map((item) => `${item.key}: ${item.message}`).join("；");
      status.className = "config-status error";
      status.textContent = detail || data.error || `HTTP ${response.status}`;
      return;
    }
    const applied = data.applied ?? [];
    status.className = "config-status ok";
    status.textContent = applied.length > 0 ? `已生效：${applied.join("、")}` : "没有改动";
    // 重新拉一次，让掩码与开关回到服务端的真实状态
    await loadConfigPanel();
    const fresh = configPanel.querySelector("#configStatus");
    if (fresh) {
      fresh.className = "config-status ok";
      fresh.textContent = applied.length > 0 ? `已生效：${applied.join("、")}` : "没有改动";
    }
    if (applied.includes("model")) {
      void refreshModelBadge();
    }
  } catch (error) {
    status.className = "config-status error";
    status.textContent = `保存失败：${error.message}`;
  } finally {
    button.disabled = false;
  }
}

function closeConfigPanel() {
  configPanel.hidden = true;
  configBtn.setAttribute("aria-expanded", "false");
}

configBtn.addEventListener("click", () => void toggleConfigPanel());

/**
 * 拦掉面板内部的点击，不让它冒泡到 document 的「点击外部收起」监听。
 *
 * 不加这行会有一个很隐蔽的 bug（已实测）：面板里有些按钮在处理函数里**同步**替换
 * configPanel.innerHTML（如「保存令牌并重试」先显示"加载中…"），按钮在事件冒泡到
 * document 之前就已经从 DOM 上摘掉了；此时 configWrap.contains(event.target) 变成
 * false，于是被误判为「点了面板外面」，面板刚点完就自动收起。
 */
configWrap.addEventListener("click", (event) => event.stopPropagation());

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
  if (!configPanel.hidden && configWrap && !configWrap.contains(event.target)) {
    closeConfigPanel();
  }
  if (historyPanel.hidden) return;
  if (historyWrap && historyWrap.contains(event.target)) return;
  closeHistoryPanel();
});

// 启动即恢复**本标签页**上次的会话（新标签页没有记录，于是从新对话开始）
void restoreTabSession();

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
          if (parsed.data.session_id) setSessionId(parsed.data.session_id);
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
