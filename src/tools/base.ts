/** 工具定义：zod schema 校验参数并生成 JSON Schema，对标 Python 版 @tool 装饰器。 */

import type { ToolResult } from "../core/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { z, ZodTypeAny } from "zod";

/** 用户实现工具时提供的定义 */
export interface ToolDefinition<TSchema extends ZodTypeAny> {
  name: string;
  description: string;
  /** 参数的 zod schema（z.object({...})） */
  args: TSchema;
  /**
   * 本工具的独立超时（秒）；不填则用运行时的默认超时。
   * 给「本身就要跑很多轮」的工具用（如子 agent）。
   */
  timeoutSeconds?: number;
  /** 工具处理函数，入参类型由 schema 自动推导；signal 用于外部取消 */
  handler: (
    args: z.infer<TSchema>,
    signal: AbortSignal,
  ) => Promise<unknown>;
}

/** 不含泛型的工具接口：注册表/运行时只依赖它，避免泛型不变性带来的赋值问题 */
export interface BaseTool {
  readonly name: string;
  readonly description: string;
  readonly timeoutSeconds?: number;
  run(
    rawArguments: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult>;
  toPayload(): Record<string, unknown>;
}

export class Tool<TSchema extends ZodTypeAny> implements BaseTool {
  readonly name: string;
  readonly description: string;
  readonly timeoutSeconds?: number;
  private readonly schema: TSchema;
  private readonly handler: (
    args: z.infer<TSchema>,
    signal: AbortSignal,
  ) => Promise<unknown>;

  constructor(definition: ToolDefinition<TSchema>) {
    this.name = definition.name;
    this.description = definition.description;
    this.timeoutSeconds = definition.timeoutSeconds;
    this.schema = definition.args;
    this.handler = definition.handler;
  }

  /** 校验参数并执行；任何异常都归一化为 ToolResult，由调用方隔离 */
  async run(
    rawArguments: Record<string, unknown>,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ToolResult> {
    const parsed = this.schema.safeParse(rawArguments);
    if (!parsed.success) {
      return {
        ok: false,
        error: `参数校验失败: ${JSON.stringify(parsed.error.issues)}`,
      };
    }
    try {
      const data = await this.handler(parsed.data, signal);
      return { ok: true, data };
    } catch (error) {
      // 工具业务异常 → 模型可见的错误结果
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `${(error as Error).name}: ${message}` };
    }
  }

  /** 生成 DeepSeek tools 字段所需的函数描述 */
  toPayload(): Record<string, unknown> {
    return {
      type: "function",
      function: {
        name: this.name,
        description: this.description,
        // DeepSeek 采用 JSON Schema 2020-12 校验，需把 draft-07 的布尔标记归一化为数值
        parameters: toJsonSchema2020(zodToJsonSchema(this.schema)),
      },
    };
  }
}

/** 定义一个工具（等价于 Python 版的 @tool） */
export function defineTool<TSchema extends ZodTypeAny>(
  definition: ToolDefinition<TSchema>,
): Tool<TSchema> {
  return new Tool(definition);
}

/**
 * 递归把 draft-07 风格的 exclusiveMinimum/exclusiveMaximum 布尔标记
 * 转换为 JSON Schema 2020-12 的数值形式：
 *   { minimum: N, exclusiveMinimum: true } → { exclusiveMinimum: N }
 */
function toJsonSchema2020(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toJsonSchema2020);
  if (node === null || typeof node !== "object") return node;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    result[key] = toJsonSchema2020(value);
  }

  if (result.exclusiveMinimum === true && typeof result.minimum === "number") {
    result.exclusiveMinimum = result.minimum;
    delete result.minimum;
  }
  if (result.exclusiveMaximum === true && typeof result.maximum === "number") {
    result.exclusiveMaximum = result.maximum;
    delete result.maximum;
  }
  return result;
}
