/**
 * 会话内用户提问工具（挂起型工具）。
 *
 * 它让模型在会话中间把「只有用户才能决定的事」问出来：给出 2-6 个候选，用户点一下，
 * 运行接着往下走。在这之前模型只能把疑问写在回答里然后**结束这一轮**，
 * 用户得再发一条消息才能继续。
 *
 * 为什么参数里 `options` 是必填的：没有选项就退化成一个慢吞吞的对话框，
 * 而「点一下比打字快」正是这个能力的价值所在。所以 schema 上就不允许只有题干。
 *
 * 为什么 handler 一定抛错：这个工具的「执行结果」只能是人的回答。真去执行它 =
 * 没有人的回答，那是逻辑漏洞而不是一种结果。运行期（`Agent.act()`）会拦截它，
 * 从存档里的答案构造结果；万一拦截漏了，这里立刻报错而不是编一个答案出来。
 */

import { z } from "zod";

import { ToolError } from "../../core/errors.js";
import { defineTool } from "../base.js";

/** 工具名：运行期识别挂起型调用、前端渲染提问卡片都按这个名字判 */
export const ASK_USER_TOOL_NAME = "ask_user";

/** 一次最多问几个：再多应该拆成两轮，用户一次读完 4 个已经到顶 */
export const MAX_QUESTIONS = 4;
/** 每题最少几个选项：少于 2 个不构成「选择」 */
export const MIN_OPTIONS = 2;
/** 每题最多几个选项：超过 6 个用户读不动，不如让模型自己收敛 */
export const MAX_OPTIONS = 6;

const askUserArgs = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().describe("要问用户的问题，一句话说清"),
        options: z
          .array(
            z.object({
              label: z.string().describe("选项短标签，2-8 个字"),
              description: z
                .string()
                .optional()
                .describe("这个选项是什么意思、选了会怎样"),
            }),
          )
          .min(MIN_OPTIONS)
          .max(MAX_OPTIONS)
          .describe("2-6 个候选，把你推荐的放第一个"),
        multiple: z.boolean().optional().describe("true 表示多选（勾选框），默认单选"),
      }),
    )
    .min(1)
    .max(MAX_QUESTIONS)
    .describe("一次最多 4 个问题，只问真正卡住下一步的"),
});

/** 单个候选项 */
export interface AskOption {
  label: string;
  description?: string;
}

/** 单个问题 */
export interface AskQuestion {
  question: string;
  options: AskOption[];
  multiple?: boolean;
}

/**
 * 校验模型的提问参数。
 *
 * 为什么单独导出：运行期在**挂起之前**要校验一次。不校验的话，一个参数不合法
 * （比如 `questions` 是空数组）的调用会照样挂起，前端渲染出一张没有选项的空卡片，
 * 用户点不动、运行也回不来。校验失败就让调用方把错误当普通工具错误回灌给模型。
 */
export function parseAskQuestions(rawArguments: Record<string, unknown>): AskQuestion[] {
  const parsed = askUserArgs.safeParse(rawArguments);
  if (!parsed.success) {
    throw new ToolError(`ask_user 参数不合法: ${JSON.stringify(parsed.error.issues)}`);
  }
  return parsed.data.questions;
}

export const askUser = defineTool({
  name: ASK_USER_TOOL_NAME,
  description:
    "向用户提问并等待回答，用来获取只有用户才知道的信息（偏好、目标、优先级、取舍）。" +
    "必须给出 2-6 个候选选项，用户点选即可；每题还可以自由填写「其他」。一次最多问 4 个问题。" +
    "不要用它问「回答完任务就结束」的事——那种情况直接在回答里问即可。",
  args: askUserArgs,
  handler: async () => {
    throw new ToolError("ask_user 只能由运行期挂起处理，不应被直接执行");
  },
});
