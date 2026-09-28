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
const configBtn = document.querySelector("#configBtn");
const configPanel = document.querySelector("#configPanel");
const configModal = document.querySelector("#configModal");
const configCloseBtn = document.querySelector("#configCloseBtn");
const sessionBadge = document.querySelector("#sessionBadge");
const sessionTitle = document.querySelector("#sessionTitle");
const permissionMode = document.querySelector("#permissionMode");
const permissionHint = document.querySelector("#permissionHint");
const permPicker = document.querySelector(".perm-picker");

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
    await runTurn(message, assistantCard);
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
  /** 审批条（同一时刻只可能有一个待批调用，因为挂起是整批挂起） */
  let approvalEl = null;
  /** 提问卡片：与审批同理，同一时刻只可能有一个待回答的提问 */
  let questionEl = null;
  /** 回答提交后卡片要收敛成一句摘要，内容在这里攒好 */
  let questionSummary = "";

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

    /** 中性备注块：AI 裁决结果、加入白名单的确认都走它，避免为每种提示各写一套 DOM */
    addNote(text, danger = false) {
      const note = document.createElement("div");
      note.className = danger ? "ai-verdict deny" : "ai-verdict";
      note.textContent = text;
      card.appendChild(note);
      scrollToBottom();
    },

    /**
     * 渲染审批条并把「等用户点选」表达成一个 Promise。
     *
     * 用 Promise 而不是回调：调用方要在拿到决定之后紧接着续跑同一次运行，
     * await 最能直白地写出这条时序（否则得把续跑逻辑塞进按钮回调里）。
     */
    askApproval(info) {
      this.finish();
      approvalEl = document.createElement("div");
      approvalEl.className = "approval-card";

      const title = document.createElement("p");
      title.className = "approval-title";
      title.textContent = "⚠ 需要人工审批";

      const tool = document.createElement("div");
      tool.className = "approval-tool";
      tool.textContent = info.tool;

      const args = document.createElement("pre");
      args.className = "approval-args";
      args.textContent = prettyJson(info.arguments);

      const actions = document.createElement("div");
      actions.className = "approval-actions";
      const status = document.createElement("span");
      status.className = "approval-status";

      const buttons = [];
      const makeButton = (text, primary) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = primary ? "approval-btn primary" : "approval-btn";
        button.textContent = text;
        buttons.push(button);
        return button;
      };
      const approve = makeButton("批准", true);
      const deny = makeButton("拒绝", false);
      const remember = makeButton("批准并加入白名单", false);
      actions.append(approve, deny, remember, status);

      approvalEl.append(title, tool, args, actions);
      card.appendChild(approvalEl);
      scrollToBottom();

      return new Promise((resolve) => {
        const decide = (approved, withWhitelist) => {
          for (const button of buttons) button.disabled = true;
          status.className = "approval-status";
          status.textContent = approved
            ? withWhitelist
              ? "已批准，并已加入白名单…"
              : "已批准，继续执行…"
            : "已拒绝，让模型换条路…";
          resolve({ approved, remember: withWhitelist });
        };
        approve.addEventListener("click", () => decide(true, false));
        deny.addEventListener("click", () => decide(false, false));
        remember.addEventListener("click", () => decide(true, true));
      });
    },

    /** 审批决定已生效，撤掉审批条，让时间线接着往下走 */
    clearApproval() {
      if (approvalEl) approvalEl.remove();
      approvalEl = null;
    },

    /** 审批接口失败时把原因写在审批条里（此时审批条还留着，方便用户处理后重试） */
    setApprovalStatus(message, isError = false) {
      if (!approvalEl) return;
      const status = approvalEl.querySelector(".approval-status");
      if (!status) return;
      status.className = isError ? "approval-status error" : "approval-status";
      status.textContent = message;
    },

    /**
     * 渲染提问卡片并把「等用户选完」表达成一个 Promise（与 askApproval 同一套路）。
     *
     * 返回 resolve(答案) / resolve(null)（用户点了跳过）。
     * 单选/多选由模型给的 multiple 决定；每题都带一个「其他」输入框——选项是模型的猜测，
     * 猜不中时用户得能直接写。单选下选了选项就清空「其他」，避免「既选了 A 又写了 B」这种自相矛盾的答案。
     */
    askQuestion(info) {
      this.finish();
      questionEl = document.createElement("div");
      questionEl.className = "question-card";

      const title = document.createElement("p");
      title.className = "question-title";
      title.textContent = "需要你确认";
      questionEl.appendChild(title);

      const questions = Array.isArray(info.questions) ? info.questions : [];
      // 每题一份作答状态：选中的标签集合 + 那个「其他」输入框
      const state = questions.map((item) => ({
        multiple: item.multiple === true,
        selected: new Set(),
        otherInput: null,
      }));

      const status = document.createElement("span");
      status.className = "approval-status";
      const submit = document.createElement("button");
      submit.type = "button";
      submit.className = "approval-btn primary";
      submit.textContent = "提交";
      // 每题都要有答案（选了选项或填了「其他」）才让提交；跳过始终可点
      const refreshSubmit = () => {
        submit.disabled = !questions.every(
          (_, index) =>
            state[index].selected.size > 0 ||
            (state[index].otherInput?.value.trim() ?? "") !== "",
        );
      };

      questions.forEach((item, index) => {
        const block = document.createElement("div");
        block.className = "question-block";

        const text = document.createElement("p");
        text.className = "question-text";
        text.textContent = item.question;
        const tag = document.createElement("span");
        tag.className = "question-tag";
        tag.textContent = state[index].multiple ? "可多选" : "单选";
        text.appendChild(tag);
        block.appendChild(text);

        const optionList = document.createElement("div");
        optionList.className = "question-options";
        // 同组同名：单选靠它互斥，不需要自己维护 radio 的勾选状态
        const groupName = `q_${info.call_id}_${index}`;
        for (const option of item.options ?? []) {
          const row = document.createElement("label");
          row.className = "question-option";
          const box = document.createElement("input");
          box.type = state[index].multiple ? "checkbox" : "radio";
          box.name = groupName;
          box.value = option.label;

          const body = document.createElement("span");
          body.className = "question-option-body";
          const label = document.createElement("span");
          label.className = "question-option-label";
          label.textContent = option.label;
          body.appendChild(label);
          if (option.description) {
            const desc = document.createElement("span");
            desc.className = "question-option-desc";
            desc.textContent = option.description;
            body.appendChild(desc);
          }

          box.addEventListener("change", () => {
            const current = state[index];
            if (current.multiple) {
              if (box.checked) current.selected.add(option.label);
              else current.selected.delete(option.label);
            } else {
              current.selected.clear();
              current.selected.add(option.label);
              if (current.otherInput) current.otherInput.value = "";
            }
            refreshSubmit();
          });

          row.append(box, body);
          optionList.appendChild(row);
        }
        block.appendChild(optionList);

        const otherRow = document.createElement("label");
        otherRow.className = "question-other";
        const otherText = document.createElement("span");
        otherText.textContent = "其他";
        const otherInput = document.createElement("input");
        otherInput.type = "text";
        otherInput.placeholder = "选项都不合适时自己写";
        otherInput.addEventListener("input", () => {
          // 单选下写了「其他」就取消同组的选择；多选下两者可以并存（既要 A 又要补充说明）
          if (!state[index].multiple && otherInput.value.trim()) {
            state[index].selected.clear();
            for (const box of optionList.querySelectorAll("input")) box.checked = false;
          }
          refreshSubmit();
        });
        state[index].otherInput = otherInput;
        otherRow.append(otherText, otherInput);
        block.appendChild(otherRow);

        questionEl.appendChild(block);
      });

      const actions = document.createElement("div");
      actions.className = "approval-actions";
      const skip = document.createElement("button");
      skip.type = "button";
      skip.className = "approval-btn";
      skip.textContent = "跳过";
      actions.append(submit, skip, status);
      questionEl.appendChild(actions);
      card.appendChild(questionEl);
      scrollCardIntoView(questionEl);
      refreshSubmit();

      return new Promise((resolve) => {
        const freeze = (message) => {
          submit.disabled = true;
          skip.disabled = true;
          for (const box of questionEl.querySelectorAll("input")) box.disabled = true;
          status.className = "approval-status";
          status.textContent = message;
        };

        submit.addEventListener("click", () => {
          const answers = questions.map((item, index) => {
            const current = state[index];
            const other = current.otherInput?.value.trim() ?? "";
            return {
              question: item.question,
              selected: [...current.selected],
              ...(other ? { other } : {}),
            };
          });
          questionSummary = `你的回答：${answers
            .map((item) => [...item.selected, item.other].filter(Boolean).join("、"))
            .join("；")}`;
          freeze("已提交，继续中…");
          resolve({ answers });
        });

        skip.addEventListener("click", () => {
          questionSummary = "已跳过这个问题，交给模型自行判断";
          freeze("已跳过，继续中…");
          resolve(null);
        });
      });
    },

    /** 回答已生效，把卡片收敛成一句静态摘要，让时间线接着往下走 */
    clearQuestion() {
      if (questionEl) questionEl.remove();
      questionEl = null;
      if (questionSummary) {
        const note = document.createElement("div");
        note.className = "ai-verdict";
        note.textContent = questionSummary;
        // 插在答案区**之前**：答案是这一轮的产出，理应排在「你的回答」下面。
        // 直接 append 到卡片末尾的话，续跑产出的答案（固定落在 .answer 里）会排在摘要**上面**，
        // 于是摘要反被挤到最后一行，读起来像问答倒过来了。
        card.insertBefore(note, answerEl);
        questionSummary = "";
      }
      scrollToBottom();
    },

    /** 提交回答失败时把原因写在卡片里（此时卡片还留着，方便用户重试） */
    setQuestionStatus(message, isError = false) {
      if (!questionEl) return;
      const status = questionEl.querySelector(".approval-status");
      if (!status) return;
      status.className = isError ? "approval-status error" : "approval-status";
      status.textContent = message;
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

/* ---------------- 权限档位 ---------------- */

/**
 * 三档权限：手动审批 / 自动AI审批 / 完全访问。
 *
 * 为什么需要它：原来输入框下方写的是「工具在沙箱内执行」，但那句话只对文件工具成立——
 * shell 工具根本没有沙箱。与其给一句会误导人的说明，不如把「谁来把关」做成可选且可见的。
 *
 * 存在 sessionStorage（每个标签页一份），与当前会话的存法一致。刻意**不**按会话分别记：
 * 下拉始终可见，所以不存在隐藏状态；按会话分开反而会出现「同一个标签页里切了会话、
 * 档位却悄悄变了」这种更难察觉的情况。
 *
 * 非默认档需要管理令牌（服务端校验）：不这样做的话，公网实例上任何访客
 * 都能一键给自己开「完全访问」，那这个下拉就成了提权按钮而不是安全控制。
 */
const PERMISSION_KEY = "miniagent.permissionMode";

const PERMISSION_TEXT = {
  manual: "每条敏感命令都会挂起，等你批准",
  ai: "由 AI 裁决，不打扰你——这是便利层，不是安全防线",
  full: "不审批，直接执行",
};

function currentPermissionMode() {
  return sessionStorage.getItem(PERMISSION_KEY) ?? "manual";
}

/** 档位的中文短名，用于拼提示语。取自下拉本身，免得同一批文案在 HTML 与 JS 里各写一份 */
function permissionLabel(mode) {
  const option = [...permissionMode.options].find((item) => item.value === mode);
  return option?.textContent ?? mode;
}

/**
 * 刷新下拉外观：完全访问用警示色；无令牌时**真的退回**手动审批。
 *
 * 「无令牌就退回手动审批」不能只做在界面上（把其它选项置灰）——下拉里存的可能是
 * 上次有令牌时选的档位，只置灰的话它仍显示「完全访问」，请求也仍带着
 * `permission_mode=full`，服务端 401「缺少 X-Admin-Token 请求头」，整个对话当场断掉。
 * 所以这里必须同时把 sessionStorage 改回 manual，让「界面显示什么」与「请求发什么」一致。
 */
function renderPermissionPicker() {
  const canEscalate = adminToken() !== "";
  const mode = canEscalate ? currentPermissionMode() : "manual";
  if (!canEscalate) sessionStorage.setItem(PERMISSION_KEY, "manual");

  permissionMode.value = mode;
  permPicker.classList.toggle("danger", mode === "full");
  permissionHint.textContent = PERMISSION_TEXT[mode] ?? "";

  for (const option of permissionMode.options) {
    option.disabled = option.value !== "manual" && !canEscalate;
  }
  permissionMode.disabled = false;
  if (!canEscalate) {
    permissionHint.textContent =
      "只有「手动审批」可用：切换到其它档位需要先在配置菜单里填入管理令牌";
  }
}

/**
 * 切换档位。
 *
 * 非默认档要同时把执行通道切到 full —— 否则选了档位也跑不动（shellMode=off 时
 * 工具根本没注册）。这是有副作用的：配置菜单里的 shellMode 会被这里覆盖，
 * 所以**只在真的发生变化时提示**（用 PUT 返回的 applied 判断），不静默改。
 */
async function changePermissionMode(next) {
  const escalated = next !== "manual";
  if (escalated && adminToken() === "") {
    sessionStorage.setItem(PERMISSION_KEY, "manual");
    renderPermissionPicker();
    return;
  }

  if (escalated) {
    permissionHint.textContent = "正在切换…";
    try {
      const response = await configRequest({
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values: { shellMode: "full" } }),
      });
      const data = await response.json();
      if (!response.ok) {
        // 令牌不对就退回手动审批，并把原因摆出来，不要留一个「看起来切了其实没切」的下拉
        sessionStorage.setItem(PERMISSION_KEY, "manual");
        renderPermissionPicker();
        permissionHint.textContent =
          (data.errors ?? []).map((item) => item.message).join("；") ||
          data.error ||
          `HTTP ${response.status}`;
        return;
      }
      sessionStorage.setItem(PERMISSION_KEY, next);
      renderPermissionPicker();
      if ((data.applied ?? []).includes("shellMode")) {
        permissionHint.textContent = `${PERMISSION_TEXT[next]}（已同时把执行通道切到 full）`;
      }
      return;
    } catch (error) {
      sessionStorage.setItem(PERMISSION_KEY, "manual");
      renderPermissionPicker();
      permissionHint.textContent = `切换失败：${error.message}`;
      return;
    }
  }

  sessionStorage.setItem(PERMISSION_KEY, next);
  renderPermissionPicker();
}

permissionMode.addEventListener("change", () => {
  void changePermissionMode(permissionMode.value);
});

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

/**
 * 带管理令牌的请求。默认打 /api/config；白名单接口复用同一个函数，
 * 因为它们要的是同一把令牌与同一套 401/403 语义。
 */
function configRequest(init = {}) {
  const { url = "/api/config", ...rest } = init;
  return fetch(url, {
    ...rest,
    headers: { "X-Admin-Token": adminToken(), ...(rest.headers ?? {}) },
  });
}

async function toggleConfigPanel() {
  if (!configModal.hidden) {
    closeConfigPanel();
    return;
  }
  openConfigPanel();
  await loadConfigPanel();
}

/** 打开弹窗：解除 hidden、锁住页面滚动、把焦点移进弹窗 */
function openConfigPanel() {
  configModal.hidden = false;
  configBtn.setAttribute("aria-expanded", "true");
  // 锁滚动：否则滚轮会带动背后的时间线，看起来像「弹窗在飘」
  document.body.style.overflow = "hidden";
  configPanel.textContent = "加载中…";
  configPanel.focus({ preventScroll: true });
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
    // 令牌决定权限下拉能否切到非默认档。这里是「令牌不对」时的入口，
    // 用户填完就想立刻能用；不刷新的话下拉会一直停在锁定态，看起来像「填了也没用」（实测踩到过）。
    renderPermissionPicker();
    configPanel.textContent = "加载中…";
    void loadConfigPanel();
  };
  retry.addEventListener("click", submit);
  // 失焦即保存，省掉「必须先点按钮」这一层
  tokenInput.addEventListener("change", submit);
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
    // 令牌决定权限下拉能否切到非默认档，改完要立刻反映出来
    renderPermissionPicker();
  });
  tokenRow.append(tokenLabel, tokenInput);
  configPanel.appendChild(tokenRow);

  configPanel.appendChild(makeAllowlistBlock());
}

/**
 * 「已放行的命令」区块。
 *
 * 它是**一组条目**而不是标量配置，所以不进 schema 驱动的 CONFIG_FIELDS，
 * 而是作为自定义区块挂在表单之后。存在的意义是「放行错了能撤」——
 * 否则误放行一条危险命令后，只能登服务器去改 JSONL 文件。
 */
function makeAllowlistBlock() {
  const block = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = "已放行的命令";
  block.appendChild(title);

  const body = document.createElement("div");
  body.textContent = "加载中…";
  block.appendChild(body);

  void (async () => {
    let entries;
    try {
      const response = await configRequest({ url: "/api/allowlist" });
      const data = await response.json();
      if (!response.ok) {
        body.className = "allowlist-empty";
        body.textContent = data.error ?? `加载失败（HTTP ${response.status}）`;
        return;
      }
      entries = data.entries ?? [];
    } catch {
      body.className = "allowlist-empty";
      body.textContent = "加载失败：服务未响应";
      return;
    }

    body.innerHTML = "";
    if (entries.length === 0) {
      body.className = "allowlist-empty";
      body.textContent = "还没有放行过任何命令。审批时点「批准并加入白名单」就会出现在这里。";
      return;
    }
    for (const entry of entries) {
      body.appendChild(makeAllowlistRow(entry, body));
    }
  })();

  return block;
}

function makeAllowlistRow(entry, container) {
  const row = document.createElement("div");
  row.className = "allowlist-row";

  const main = document.createElement("div");
  main.className = "allowlist-main";
  const tool = document.createElement("span");
  tool.className = "allowlist-tool";
  tool.textContent = `${entry.tool} `;
  main.append(tool, document.createTextNode(summarizeArguments(entry.arguments)));

  const del = document.createElement("button");
  del.type = "button";
  del.className = "allowlist-del";
  del.textContent = "撤回";
  del.addEventListener("click", async () => {
    del.disabled = true;
    try {
      const response = await configRequest({
        url: "/api/allowlist",
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: entry.tool, arguments: entry.arguments }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.removed !== true) {
        del.disabled = false;
        del.textContent = "撤回失败";
        return;
      }
      row.remove();
      if (!container.querySelector(".allowlist-row")) {
        container.className = "allowlist-empty";
        container.textContent = "还没有放行过任何命令。";
      }
    } catch {
      del.disabled = false;
      del.textContent = "撤回失败";
    }
  });

  row.append(main, del);
  return row;
}

/** 参数摘要：单行、限量，避免一条超长命令把面板撑爆 */
function summarizeArguments(args) {
  const text = prettyJson(args).replace(/\s+/g, " ").trim();
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
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

/** 关闭弹窗：还原滚动、还焦点给左下角的入口按钮 */
function closeConfigPanel() {
  configModal.hidden = true;
  configBtn.setAttribute("aria-expanded", "false");
  document.body.style.overflow = "";
  configBtn.focus({ preventScroll: true });
}

configBtn.addEventListener("click", () => void toggleConfigPanel());
configCloseBtn.addEventListener("click", () => closeConfigPanel());

/**
 * 点遮罩关闭：判据是「点击的目标正是遮罩本身」。
 *
 * 这里刻意不用早先那套「点击不在容器内就收起」的写法。那套写法需要额外给容器挂一个
 * stopPropagation（因为面板里有按钮会在处理函数里同步替换 innerHTML，按钮在事件冒泡到
 * document 之前就已经从 DOM 上摘掉了，contains 于是变 false，面板刚点完就自动收起）。
 * 现在被摘掉的永远是 .modal 的后代，event.target 仍是那个按钮、不等于遮罩，那个 hack 也就不必要了。
 */
configModal.addEventListener("click", (event) => {
  if (event.target === configModal) closeConfigPanel();
});

// Esc 关闭：弹窗开着时才拦，免得影响输入框里的其它按键
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !configModal.hidden) closeConfigPanel();
});

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

// 历史面板仍是下拉，点它外面收起；配置菜单已经改成弹窗，自己有遮罩与 Esc 两条关闭路径
document.addEventListener("click", (event) => {
  if (historyPanel.hidden) return;
  if (historyWrap && historyWrap.contains(event.target)) return;
  closeHistoryPanel();
});

// 启动即恢复**本标签页**上次的会话（新标签页没有记录，于是从新对话开始）
void restoreTabSession();

// 权限档位：按本标签页记住的选择渲染，并按有无令牌决定能不能切到非默认档
renderPermissionPicker();

/* ---------------- SSE 流式通信 ---------------- */

/**
 * 提交一次审批决定。
 * 决定必须落盘（服务端 `recordApproval`），因为「做决定」与「续跑」是两次请求，
 * 两次之间进程可能重启。
 */
async function sendApprovalDecision(runId, decision) {
  try {
    const response = await fetch("/api/approve", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Token": adminToken(),
      },
      body: JSON.stringify({
        run_id: runId,
        approved: decision.approved,
        remember: decision.remember === true,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail =
        response.status === 401
          ? "管理令牌不对：请在配置菜单里填对令牌再批"
          : response.status === 403
            ? "服务端未配置 MINIAGENT_ADMIN_TOKEN，审批接口已禁用"
            : data.error ?? `HTTP ${response.status}`;
      return { ok: false, error: detail };
    }
    return { ok: true, remembered: data.remembered === true };
  } catch (error) {
    return { ok: false, error: `审批请求失败：${error.message}` };
  }
}

/**
 * 提交一次对 ask_user 的回答。`answer` 为 null 表示用户点了跳过。
 *
 * 与审批同理，回答必须先落盘（服务端 `recordAnswer`），因为「提交回答」与「续跑」是两次请求。
 * 这个接口**不需要管理令牌**：回答只是把用户的话交给模型，不放大任何权限。
 */
async function sendAnswer(runId, answer) {
  try {
    const response = await fetch("/api/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        answer === null
          ? { run_id: runId, skipped: true }
          : { run_id: runId, answers: answer.answers },
      ),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { ok: false, error: data.error ?? `HTTP ${response.status}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `提交回答失败：${error.message}` };
  }
}

/**
 * 跑一轮：流式对话 →（可能）撞上审批或提问 → 拿到决定/回答 → 续跑，直到不再挂起。
 *
 * 为什么要单独一层循环：一次运行可能连续挂起多轮（每轮批一个工具、或问一件事），
 * 而且续跑必须**接回同一张卡片**——另开一张卡会把一次问答拆成几段，
 * 时间线与最终答案都散掉了。
 */
async function runTurn(message, card) {
  let resumeRunId = null;
  let payload = message;
  for (;;) {
    const outcome = await streamChat(payload, card, resumeRunId);

    if (outcome.kind === "question") {
      const info = outcome.info;
      const answer = await card.askQuestion(info);
      const sent = await sendAnswer(info.run_id, answer);
      if (!sent.ok) {
        // 卡片留在原地，把原因写在它内部，方便用户重试
        card.setQuestionStatus(sent.error, true);
        return;
      }
      card.clearQuestion();
      resumeRunId = info.run_id;
      payload = "";
      continue;
    }

    if (outcome.kind !== "approval") return;

    const info = outcome.info;
    const decision = await card.askApproval(info);
    const result = await sendApprovalDecision(info.run_id, decision);
    if (!result.ok) {
      // 审批条留在原地，把原因写在它内部，方便用户处理好令牌后重试
      card.setApprovalStatus(result.error, true);
      return;
    }
    card.clearApproval();
    if (result.remembered) {
      card.addNote("已加入白名单：这条命令以后不再询问（可在配置菜单里撤回）");
    }
    resumeRunId = info.run_id;
    // 续跑时模型侧不需要新输入：原始问题已在存档里
    payload = "";
  }
}

async function streamChat(message, card, resumeRunId = null) {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      history: chatHistory,
      // 带上会话 id，服务端据此续写并持久化
      session_id: sessionId ?? undefined,
      // 续跑已挂起的运行：原始问题在存档里，所以 message 传空串
      resume_run_id: resumeRunId ?? undefined,
      // 权限档位随请求走（服务端对非默认档校验管理令牌）
      permission_mode: currentPermissionMode(),
    }),
  });

  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => ({}));
    const detail = data.error ?? `HTTP ${response.status}`;
    // 401 只可能来自「档位不是手动审批、而浏览器里没有管理令牌」。光说「缺少 X-Admin-Token
    // 请求头」用户不知道去哪儿处理，所以把下一步直接写出来。
    if (response.status === 401) {
      throw new Error(
        `${detail}（当前档位是「${permissionLabel(currentPermissionMode())}」，` +
          `请在左下角配置里填入管理令牌，或把档位调回「手动审批」）`,
      );
    }
    throw new Error(detail);
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
        case "approval_ai_verdict":
          // 这一档不打扰人，所以裁决只作为时间线上的一条记录存在，供事后核对
          card.addNote(
            `AI 审批：${parsed.data.verdict === "approve" ? "放行" : "拒绝"} · ` +
              `${parsed.data.reason}（${parsed.data.latency}s）`,
            parsed.data.verdict !== "approve",
          );
          break;
        case "approval_required":
          // 挂起等人工：把决定权交给调用方（runTurn），它会渲染审批条、提交决定再续跑。
          // 这里**直接返回**而不是继续读：服务端在发完这个事件后就是 done，
          // 站在流里等用户点击只会白白占着一个 reader。
          return { kind: "approval", info: parsed.data };
        case "question_required":
          // 挂起等回答：同一个道理，把选择权交给 runTurn
          return { kind: "question", info: parsed.data };
        case "error":
          // 状态点的重置统一交给 submit 的 finally 处理
          if (parsed.data.cancelled) {
            card.markStopped();
          } else {
            card.markError(parsed.data.message);
          }
          break;
        case "done":
          return { kind: "done" };
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

/**
 * 让一张卡片尽量完整地出现在视野里。
 *
 * 提问卡片可以比可视区还高——两题、每题五六个带说明的选项就有八百多像素。
 * 这时「钉到底」恰好会把标题与第一题推到屏幕外，用户看到的是一张没头没尾的卡片
 * （实测踩到过）。所以装不下时改为把卡片顶部对齐到可视区顶部，剩下的往下滚就是。
 */
function scrollCardIntoView(el) {
  const fits = el.offsetHeight <= thread.clientHeight - 24;
  if (fits) {
    scrollToBottom();
    return;
  }
  thread.scrollTop +=
    el.getBoundingClientRect().top - thread.getBoundingClientRect().top - 12;
}
