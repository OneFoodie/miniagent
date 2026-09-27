/**
 * 会话内用户提问（`ask_user`）测试。
 *
 * 它复用人工审批那根脊椎（挂起 → 落存档 → 续跑），所以这里重点覆盖三件审批没有的事：
 *  - 「执行结果」来自人的回答，而不是工具本身：handler 永远不该被跑到
 *  - 参数不合法时**不挂起**，而是当普通工具错误回灌（否则用户会面对一张点不动的空卡片）
 *  - 一轮里问两次时，第一次的答案要活着到第二次（回答与审批决定一样每次入档）
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Agent } from "../src/agent/agent.js";
import { loadCheckpoint, recordAnswer } from "../src/agent/checkpoint.js";
import { loadSettings, type Settings } from "../src/core/config.js";
import { ApprovalRequiredError, QuestionRequiredError } from "../src/core/errors.js";
import { EventBus, EventType } from "../src/core/events.js";
import { ASK_USER_TOOL_NAME, askUser } from "../src/tools/builtins/askUser.js";
import { calculator } from "../src/tools/builtins/calculator.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { FakeLLM, finalResponse, toolCallResponse } from "./fakes.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "miniagent-ask-"));
  tempDirs.push(dir);
  return dir;
}

async function testSettings(overrides: Partial<Settings> = {}): Promise<Settings> {
  process.env.MINIAGENT_DEEPSEEK_API_KEY = "test-key";
  const root = await tempDir();
  return {
    ...loadSettings(),
    checkpointDir: join(root, "checkpoints"),
    workspace: join(root, "workspace"),
    ...overrides,
  };
}

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(calculator);
  registry.register(askUser);
  return registry;
}

/** 两个候选、单选 */
const PLATFORM = [
  {
    question: "目标平台是哪个？",
    options: [{ label: "Linux" }, { label: "Windows" }, { label: "macOS" }],
  },
];

/** 跑一次并返回挂起现场（该用例的前提一定是挂起） */
async function suspend(settings: Settings, questions = PLATFORM): Promise<string> {
  const fake = new FakeLLM([
    toolCallResponse([["q1", ASK_USER_TOOL_NAME, { questions }]]),
  ]);
  const error = await new Agent(fake, makeRegistry(), settings, new EventBus())
    .run("做点什么")
    .catch((err: unknown) => err);
  expect(error).toBeInstanceOf(QuestionRequiredError);
  return (error as QuestionRequiredError).runId;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})),
  );
});

describe("ask_user 工具定义", () => {
  it("参数缺 questions / 只有题干、没有选项 → 校验失败", async () => {
    expect((await askUser.run({})).ok).toBe(false);

    // 「只有题干没有选项」必须被挡住：没有候选就退化成一个慢吞吞的对话框
    const noOptions = await askUser.run({ questions: [{ question: "怎么办？" }] });
    expect(noOptions.ok).toBe(false);

    // 选项少于 2 个不构成选择
    const oneOption = await askUser.run({
      questions: [{ question: "怎么办？", options: [{ label: "唯一解" }] }],
    });
    expect(oneOption.ok).toBe(false);

    // 一次超过 4 个问题
    const tooMany = await askUser.run({
      questions: Array.from({ length: 5 }, (_, index) => ({
        question: `第 ${index} 问？`,
        options: [{ label: "A" }, { label: "B" }],
      })),
    });
    expect(tooMany.ok).toBe(false);
  });

  it("handler 被直接执行时报错——它的「执行结果」只能来自人的回答", async () => {
    // 防回归：运行期的拦截一旦漏了，这里会立刻暴露，而不是编一个答案出来
    const result = await askUser.run({ questions: PLATFORM });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("不应被直接执行");
  });
});

describe("挂起与续跑", () => {
  it("模型调用 ask_user 即挂起，现场落盘且不执行任何工具", async () => {
    const settings = await testSettings();
    const bus = new EventBus();
    const ran: string[] = [];
    bus.subscribe(EventType.ToolEnd, async (event) => {
      ran.push(String(event.payload.name));
    });

    const fake = new FakeLLM([
      toolCallResponse([["q1", ASK_USER_TOOL_NAME, { questions: PLATFORM }]]),
    ]);
    const error = await new Agent(fake, makeRegistry(), settings, bus)
      .run("做点什么")
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(QuestionRequiredError);
    const runId = (error as QuestionRequiredError).runId;
    // 没有「被执行」这一步：它的结果是人给的
    expect(ran).toEqual([]);

    const saved = await loadCheckpoint(settings.checkpointDir, runId);
    expect(saved?.pendingQuestion?.callId).toBe("q1");
    // 待问与待批是两个字段，别把提问写进了审批
    expect(saved?.pendingApproval).toBeUndefined();
  });

  it("回答后接着跑，回答成为工具结果回灌给模型", async () => {
    const settings = await testSettings();
    const runId = await suspend(settings);

    await recordAnswer(settings.checkpointDir, runId, {
      answers: [{ question: "目标平台是哪个？", selected: ["Linux"] }],
    });

    const bus = new EventBus();
    const ran: string[] = [];
    const answered: Array<Record<string, unknown>> = [];
    bus.subscribe(EventType.ToolEnd, async (event) => {
      ran.push(String(event.payload.name));
    });
    bus.subscribe(EventType.QuestionAnswered, async (event) => {
      answered.push(event.payload);
    });

    const result = await new Agent(
      new FakeLLM([finalResponse("好，按 Linux 做")]),
      makeRegistry(),
      settings,
      bus,
    ).resume(runId);

    expect(result.answer).toBe("好，按 Linux 做");
    // 回答走的是「被回答」而不是「被执行」
    expect(ran).toEqual([]);
    expect(answered).toEqual([
      { call_id: "q1", answers: [{ question: "目标平台是哪个？", selected: ["Linux"] }], skipped: false },
    ]);

    const toolMessage = result.messages.find((message) => message.role === "tool");
    expect(toolMessage?.content).toContain("Linux");
    // 成功即清档
    expect(await loadCheckpoint(settings.checkpointDir, runId)).toBeUndefined();
  });

  it("跳过时回灌「用户不想答」，并明确不许重复追问", async () => {
    const settings = await testSettings();
    const runId = await suspend(settings);

    await recordAnswer(settings.checkpointDir, runId, { answers: [], skipped: true });
    const result = await new Agent(
      new FakeLLM([finalResponse("那我按默认来")]),
      makeRegistry(),
      settings,
      new EventBus(),
    ).resume(runId);

    expect(result.answer).toBe("那我按默认来");
    const toolMessage = result.messages.find((message) => message.role === "tool");
    expect(toolMessage?.content).toContain("跳过");
    expect(toolMessage?.content).toContain("不要重复追问");
  });

  it("回答也能靠存档传递：先记回答、再另起一个 Agent 续跑同样生效", async () => {
    // 回答与审批决定一样是两次请求，中间进程可能重启
    const settings = await testSettings();
    const runId = await suspend(settings);

    await recordAnswer(settings.checkpointDir, runId, {
      answers: [{ question: "目标平台是哪个？", selected: [], other: "还有一块 ARM 板子" }],
    });
    const result = await new Agent(
      new FakeLLM([finalResponse("明白")]),
      makeRegistry(),
      settings,
      new EventBus(),
    ).resume(runId);

    const toolMessage = result.messages.find((message) => message.role === "tool");
    expect(toolMessage?.content).toContain("ARM");
  });

  it("一轮里问两次：先答第一个，第一个的答案不会在第二次挂起时丢掉", async () => {
    const settings = await testSettings();
    const fake = new FakeLLM([
      toolCallResponse([
        ["q1", ASK_USER_TOOL_NAME, { questions: PLATFORM }],
        [
          "q2",
          ASK_USER_TOOL_NAME,
          {
            questions: [
              { question: "要不要附图表？", options: [{ label: "要" }, { label: "不要" }], multiple: false },
            ],
          },
        ],
      ]),
    ]);
    const runId = await new Agent(fake, makeRegistry(), settings, new EventBus())
      .run("做点什么")
      .then(() => "")
      .catch((err: unknown) => (err as QuestionRequiredError).runId);
    expect((await loadCheckpoint(settings.checkpointDir, runId))?.pendingQuestion?.callId).toBe(
      "q1",
    );

    // 答第一个：这次续跑不会调模型（工具还没跑完），只会立刻挂起第二次提问
    await recordAnswer(settings.checkpointDir, runId, {
      answers: [{ question: "目标平台是哪个？", selected: ["Windows"] }],
    });
    const second = await new Agent(new FakeLLM([]), makeRegistry(), settings, new EventBus())
      .resume(runId)
      .then(() => "")
      .catch((err: unknown) => err);
    expect(second).toBeInstanceOf(QuestionRequiredError);
    expect((second as QuestionRequiredError).call.id).toBe("q2");

    // 存档里两个回答都在：第一个若丢了，这次续跑会把它当没答过、重问一遍
    const saved = await loadCheckpoint(settings.checkpointDir, runId);
    expect(Object.keys(saved?.answers ?? {}).sort()).toEqual(["q1"]);

    await recordAnswer(settings.checkpointDir, runId, {
      answers: [{ question: "要不要附图表？", selected: ["要"] }],
    });
    const result = await new Agent(
      new FakeLLM([finalResponse("好，带图表")]),
      makeRegistry(),
      settings,
      new EventBus(),
    ).resume(runId);

    expect(result.answer).toBe("好，带图表");
    const toolMessages = result.messages.filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[0]?.content).toContain("Windows");
    expect(toolMessages[1]?.content).toContain("要");
  });
});

describe("与其他挂起机制的关系", () => {
  it("同批里既有待批又有待问时，先过审批这一关", async () => {
    // 审批被拒会让整批都不执行，先问用户可能是白问
    const settings = await testSettings({ approvalTools: ["calculator"] });
    const fake = new FakeLLM([
      toolCallResponse([
        ["c1", "calculator", { expression: "1+1" }],
        ["q1", ASK_USER_TOOL_NAME, { questions: PLATFORM }],
      ]),
      finalResponse("好"),
    ]);

    const error = await new Agent(fake, makeRegistry(), settings, new EventBus())
      .run("做点什么")
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ApprovalRequiredError);
    const saved = await loadCheckpoint(
      settings.checkpointDir,
      (error as ApprovalRequiredError).runId,
    );
    expect(saved?.pendingApproval?.callId).toBe("c1");
    expect(saved?.pendingQuestion).toBeUndefined();
  });

  it("参数不合法的提问不挂起，而是当普通工具错误回灌，让模型换个问法", async () => {
    const settings = await testSettings();
    const fake = new FakeLLM([
      toolCallResponse([
        ["q1", ASK_USER_TOOL_NAME, { questions: [{ question: "没有选项的问题" }] }],
      ]),
      finalResponse("我换个问法"),
    ]);

    const result = await new Agent(fake, makeRegistry(), settings, new EventBus()).run(
      "做点什么",
    );

    expect(result.answer).toBe("我换个问法");
    const toolMessage = result.messages.find((message) => message.role === "tool");
    expect(toolMessage?.content).toContain("参数不合法");
    // 没有留下待答现场
    const saved = await loadCheckpoint(settings.checkpointDir, result.context.runId);
    expect(saved?.pendingQuestion).toBeUndefined();
  });

  it("提问不受权限档位管辖：三档下都照常挂起等回答", async () => {
    // 它不执行任何外部动作，因此不该被审批逻辑拦成「等批准」
    const settings = await testSettings({ approvalTools: [ASK_USER_TOOL_NAME] });
    for (const mode of ["manual", "ai", "full"] as const) {
      const fake = new FakeLLM([
        toolCallResponse([["q1", ASK_USER_TOOL_NAME, { questions: PLATFORM }]]),
      ]);
      const agent = new Agent(fake, makeRegistry(), settings, new EventBus(), {
        permissionMode: mode,
        aiApprover: { judge: async () => ({ verdict: "approve", reason: "不该被问到" }) },
      });

      await expect(agent.run("做点什么")).rejects.toBeInstanceOf(QuestionRequiredError);
    }
  });
});

describe("轨迹事件", () => {
  it("问了什么、答了什么都进事件流，便于事后核对", async () => {
    const settings = await testSettings();
    const asked: Array<Record<string, unknown>> = [];
    const answered: Array<Record<string, unknown>> = [];
    const bus = new EventBus();
    bus.subscribe(EventType.QuestionAsked, async (event) => {
      asked.push(event.payload);
    });
    bus.subscribe(EventType.QuestionAnswered, async (event) => {
      answered.push(event.payload);
    });

    const fake = new FakeLLM([
      toolCallResponse([["q1", ASK_USER_TOOL_NAME, { questions: PLATFORM }]]),
    ]);
    const runId = await new Agent(fake, makeRegistry(), settings, bus)
      .run("做点什么")
      .then(() => "")
      .catch((err: unknown) => (err as QuestionRequiredError).runId);

    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ call_id: "q1" });
    expect(asked[0]!.questions).toEqual(PLATFORM);

    await recordAnswer(settings.checkpointDir, runId, {
      answers: [{ question: "目标平台是哪个？", selected: ["macOS"] }],
    });
    await new Agent(
      new FakeLLM([finalResponse("好")]),
      makeRegistry(),
      settings,
      bus,
    ).resume(runId);

    expect(answered).toHaveLength(1);
    expect(answered[0]).toMatchObject({ call_id: "q1", skipped: false });
  });
});
