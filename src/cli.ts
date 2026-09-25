#!/usr/bin/env node
/** 命令行交互入口：miniagent，进入多轮对话式研究助手。 */

import { createInterface, type Interface } from "node:readline/promises";

import { Agent, type RunResult } from "./agent/agent.js";
import { listCheckpoints } from "./agent/checkpoint.js";
import { loadSettings } from "./core/config.js";
import { ApprovalRequiredError, MiniAgentError } from "./core/errors.js";
import { EventBus } from "./core/events.js";
import { getLogger, setupLogging } from "./core/logging.js";
import { describeProvider } from "./core/providers.js";
import type { Message } from "./core/types.js";
import {
  createKnowledgeBase,
  describeKnowledgeBackend,
  registerKnowledgeTools,
} from "./knowledge/index.js";
import { OpenAICompatibleClient } from "./llm/openai.js";
import { describeMcp, registerMcpTools } from "./mcp/index.js";
import {
  createLongTermMemory,
  createMemorySummarizer,
  describeLongTermMemory,
  DEFAULT_SUMMARY_OPTIONS,
  rememberTurn,
  SummaryMemory,
  type LongTermMemory,
} from "./memory/index.js";
import { Metrics } from "./observability/metrics.js";
import { createOtelExporter, describeOtel } from "./observability/otel.js";
import { Tracer } from "./observability/tracer.js";
import { registerSkillTools, SkillRegistry } from "./skills/index.js";
import { registerBuiltins } from "./tools/builtins/index.js";
import { describePowershell } from "./tools/builtins/powershell.js";
import { childRegistryOf, registerSubagent } from "./tools/builtins/subagent.js";
import { ToolRegistry } from "./tools/registry.js";

const logger = getLogger("miniagent.cli");

/**
 * 跑一次任务；撞上需要审批的工具就**就地问用户**，批准/拒绝后接着跑。
 * 用循环是因为一次运行可能连续挂起多轮（每轮批一个工具）。
 */
async function runWithApproval(
  agent: Agent,
  readline: Interface,
  start: () => Promise<RunResult>,
): Promise<RunResult> {
  let next = start;
  for (;;) {
    try {
      return await next();
    } catch (error) {
      if (!(error instanceof ApprovalRequiredError)) throw error;
      const approved = await askApproval(readline, error);
      next = () => agent.resume(error.runId, { approved });
    }
  }
}

/** 展示待批工具并询问决定；默认拒绝（回车即不执行） */
async function askApproval(
  readline: Interface,
  error: ApprovalRequiredError,
): Promise<boolean> {
  process.stdout.write(
    `\n[需要审批] 模型想调用 ${error.call.name}\n` +
      `  参数: ${JSON.stringify(error.call.arguments)}\n` +
      `  run_id: ${error.runId}\n`,
  );
  const answer = (await readline.question("  执行吗？(y/N) > ")).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

/** 列出磁盘上还没跑完、可以 /resume 接上的运行 */
async function listRuns(dir: string): Promise<void> {
  const runs = await listCheckpoints(dir);
  if (runs.length === 0) {
    process.stdout.write("（没有可续跑的运行存档）\n\n");
    return;
  }
  process.stdout.write("可续跑的运行：\n");
  for (const run of runs) {
    const at = new Date(run.updatedAt).toLocaleString();
    const state = run.pendingApproval ? `待审批: ${run.pendingApproval.tool}` : "（进程中断）";
    process.stdout.write(
      `  ${run.runId}  停在第 ${run.iterations} 轮  ${at}  ${state}\n` +
        `    原始输入: ${run.input}\n`,
    );
  }
  process.stdout.write("\n");
}

/**
 * 一次运行收尾：写长期记忆、打印答案与开销，返回可作为下一轮历史的非 system 消息。
 * 续跑路径也走这里，所以问题从消息序列里取（存档里没有单独的 question 字段）。
 */
async function finishRun(result: RunResult, longTerm: LongTermMemory): Promise<Message[]> {
  const question = result.messages.find((message) => message.role === "user")?.content ?? "";
  await rememberTurn(longTerm, {
    question,
    answer: result.answer,
    ts: Date.now() / 1000,
    meta: { runId: result.context.runId },
  });

  process.stdout.write(`助手 > ${result.answer}\n`);
  process.stdout.write(
    `  （迭代 ${result.context.iterations} 轮，` +
      `token: ${result.context.usage.promptTokens + result.context.usage.completionTokens}，` +
      `耗时 ${result.latency.toFixed(2)}s）\n\n`,
  );

  // 去掉 system 消息，作为下一轮历史
  return result.messages.slice(1);
}

const BANNER = `
 __  __ ___ _  _ ___    _  ___   ___ _  _ ___
|  \\/  |_ _| \\| |_ _|  /_\\| _ ) / __| \\| | __|
| |\\/| || || .\` || |  / _ \\ _ \\| (__| .\` | _|
|_|  |_|___|_|\\_|___|/_/ \\_\\___/ \\___|_|\\_|___|
`;

async function main(): Promise<void> {
  const verbose = process.argv.includes("-v") || process.argv.includes("--verbose");
  setupLogging(verbose ? "DEBUG" : "WARNING");

  const settings = loadSettings();
  const bus = new EventBus();
  new Tracer(bus, settings.traceDir);
  const metrics = new Metrics();
  metrics.attach(bus);
  const otel = createOtelExporter(settings);
  otel.attach(bus);

  const llm = new OpenAICompatibleClient(settings);
  const registry = new ToolRegistry();
  await registerBuiltins(registry, settings);

  // 阶段二能力：技能目录（渐进式披露）、摘要记忆、长期记忆
  const skills = await SkillRegistry.load(settings.skillsDir);
  registerSkillTools(registry, skills);
  // 知识库走「模型自主检索」：注册成工具由模型决定何时查
  const knowledge = createKnowledgeBase(settings);
  registerKnowledgeTools(registry, knowledge);
  // MCP：只有配了 mcp.json 才会加载 SDK 并连接远端
  const mcp = await registerMcpTools(registry, settings.mcpConfigPath);
  // 子 agent 必须最后注册：它的子工具集是「除自己以外的全部工具」
  registerSubagent(registry, {
    llm,
    settings,
    childRegistry: (role) => childRegistryOf(registry, role),
  });
  // 生命周期记忆注入 LLM 压缩器后即启用「巩固」
  const longTerm = createLongTermMemory(settings, createMemorySummarizer(llm, settings));
  const memory = new SummaryMemory(llm, {
    ...DEFAULT_SUMMARY_OPTIONS,
    maxTokens: settings.memoryMaxTokens,
    summarizeThreshold: settings.memorySummaryThreshold,
  });

  const agent = new Agent(llm, registry, settings, bus, { skills, memory, longTerm });

  const readline = createInterface({ input: process.stdin, output: process.stdout });

  process.stdout.write(BANNER + "\n");
  process.stdout.write(
    `模型: ${describeProvider(settings.provider, settings.model, settings.baseUrl)}` +
      ` | 工具: ${registry.all().map((t) => t.name).join(", ")}\n`,
  );
  process.stdout.write(
    `技能: ${skills.names().join(", ") || "（无）"} | 记忆窗口: ${settings.memoryMaxTokens} tokens\n`,
  );
  process.stdout.write(`长期记忆: ${describeLongTermMemory(settings)}\n`);
  // 与 server 一致：不在这里统计文档数，避免语义后端在启动时触发模型下载
  process.stdout.write(
    `知识库: ${describeKnowledgeBackend(settings)}（${settings.knowledgeDirs.join("、")}）\n`,
  );
  process.stdout.write(`MCP 工具: ${describeMcp(mcp)}\n`);
  process.stdout.write(`通用执行: ${describePowershell(settings)}\n`);
  process.stdout.write(`可观测: ${describeOtel(settings)}\n`);
  process.stdout.write(
    "输入你的任务开始对话；/reset 清空历史，/runs 列出可续跑运行，" +
      "/resume <run_id> 续跑，/exit 退出。\n\n",
  );

  let history: Message[] = [];
  try {
    while (true) {
      let userInput: string;
      try {
        userInput = (await readline.question("你 > ")).trim();
      } catch {
        // 输入流结束（EOF），安静退出
        break;
      }
      if (!userInput) continue;
      if (userInput === "/exit" || userInput === "/quit") break;
      if (userInput === "/reset") {
        history = [];
        process.stdout.write("（对话历史已清空）\n\n");
        continue;
      }
      if (userInput === "/runs") {
        await listRuns(settings.checkpointDir);
        continue;
      }
      if (userInput === "/resume" || userInput.startsWith("/resume ")) {
        const runId = userInput.slice("/resume".length).trim();
        if (!runId) {
          process.stdout.write("用法: /resume <run_id>（run_id 可用 /runs 查询）\n\n");
          continue;
        }
        try {
          const result = await runWithApproval(agent, readline, () => agent.resume(runId));
          await finishRun(result, longTerm);
        } catch (error) {
          if (error instanceof MiniAgentError) {
            process.stdout.write(`[续跑失败] ${error.message}\n\n`);
            continue;
          }
          throw error;
        }
        continue;
      }

      let result: RunResult;
      try {
        result = await runWithApproval(agent, readline, () => agent.run(userInput, history));
      } catch (error) {
        if (error instanceof MiniAgentError) {
          process.stdout.write(`[运行失败] ${error.message}\n\n`);
          continue;
        }
        throw error;
      }
      history = await finishRun(result, longTerm);
    }
  } finally {
    readline.close();
    // 关闭 MCP 连接，避免 stdio 子进程残留
    await mcp.close();
    // 把缓冲里剩下的 OTel span 发出去
    await otel.close();
    logger.debug("指标快照", { metrics: metrics.snapshot() });
  }
}

main().catch((error) => {
  if (error instanceof Error && error.name === "SIGINT") return;
  process.stderr.write(
    `启动失败: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
