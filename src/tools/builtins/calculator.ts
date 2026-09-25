/**
 * 安全计算器：自带词法分析 + 递归下降解析器，绝不使用 eval。
 * 文法（优先级从低到高）：
 *   expr   := term (('+' | '-') term)*
 *   term   := factor (('*' | '/' | '%' | '//') factor)*
 *   factor := unary ('**' unary)*        // 右结合
 *   unary  := ('+' | '-') unary | primary
 *   primary:= 数字 | 常量(pi/e) | '(' expr ')'
 */

import { defineTool } from "../base.js";
import { ToolError } from "../../core/errors.js";
import { z } from "zod";

type TokenType = "NUMBER" | "OP" | "LPAREN" | "RPAREN" | "IDENT" | "EOF";

interface Token {
  type: TokenType;
  value: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === " " || ch === "\t") {
      i++;
    } else if (/[0-9.]/.test(ch)) {
      const start = i;
      while (i < input.length && /[0-9.]/.test(input[i]!)) i++;
      tokens.push({ type: "NUMBER", value: input.slice(start, i) });
    } else if (/[a-zA-Z]/.test(ch)) {
      const start = i;
      while (i < input.length && /[a-zA-Z]/.test(input[i]!)) i++;
      tokens.push({ type: "IDENT", value: input.slice(start, i) });
    } else if (ch === "(") {
      tokens.push({ type: "LPAREN", value: ch });
      i++;
    } else if (ch === ")") {
      tokens.push({ type: "RPAREN", value: ch });
      i++;
    } else if ("+-*/%".includes(ch)) {
      // 处理 ** 与 // 双字符运算符
      const next = input[i + 1];
      if ((ch === "*" && next === "*") || (ch === "/" && next === "/")) {
        tokens.push({ type: "OP", value: ch + next });
        i += 2;
      } else {
        tokens.push({ type: "OP", value: ch });
        i++;
      }
    } else {
      throw new ToolError(`无法识别的字符: '${ch}'`);
    }
  }
  tokens.push({ type: "EOF", value: "" });
  return tokens;
}

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): number {
    const value = this.expr();
    if (this.peek().type !== "EOF") {
      throw new ToolError(`表达式尾部有多余内容: '${this.peek().value}'`);
    }
    return value;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private consume(type: TokenType, value?: string): Token {
    const token = this.peek();
    if (token.type !== type || (value !== undefined && token.value !== value)) {
      throw new ToolError(
        `期望 ${value ?? type}，实际得到 '${token.value || token.type}'`,
      );
    }
    this.pos++;
    return token;
  }

  private expr(): number {
    let value = this.term();
    while (this.peek().type === "OP" && ["+", "-"].includes(this.peek().value)) {
      const op = this.consume("OP").value;
      const right = this.term();
      value = op === "+" ? value + right : value - right;
    }
    return value;
  }

  private term(): number {
    let value = this.factor();
    while (
      this.peek().type === "OP" &&
      ["*", "/", "%", "//"].includes(this.peek().value)
    ) {
      const op = this.consume("OP").value;
      const right = this.factor();
      if (op === "*") value *= right;
      else if (op === "/") value /= right;
      else if (op === "//") value = Math.floor(value / right);
      else value %= right;
    }
    return value;
  }

  private factor(): number {
    const base = this.unary();
    if (this.peek().type === "OP" && this.peek().value === "**") {
      this.consume("OP", "**");
      // 右结合：右侧继续解析 factor
      return base ** this.factor();
    }
    return base;
  }

  private unary(): number {
    if (this.peek().type === "OP" && ["+", "-"].includes(this.peek().value)) {
      const op = this.consume("OP").value;
      const value = this.unary();
      return op === "-" ? -value : value;
    }
    return this.primary();
  }

  private primary(): number {
    const token = this.peek();
    if (token.type === "NUMBER") {
      this.pos++;
      const value = Number(token.value);
      if (Number.isNaN(value)) throw new ToolError(`非法数字: ${token.value}`);
      return value;
    }
    if (token.type === "IDENT") {
      this.pos++;
      if (token.value === "pi") return Math.PI;
      if (token.value === "e") return Math.E;
      throw new ToolError(`未知常量: ${token.value}（仅支持 pi、e）`);
    }
    if (token.type === "LPAREN") {
      this.pos++;
      const value = this.expr();
      this.consume("RPAREN", ")");
      return value;
    }
    throw new ToolError(`期望数字或括号，实际得到 '${token.value || token.type}'`);
  }
}

export const calculator = defineTool({
  name: "calculator",
  description:
    "计算数学表达式，支持 + - * / // % ** 与常量 pi、e。例如 \"(1+2)*3\" 或 \"2**10\"。",
  args: z.object({
    expression: z.string().describe("待计算的数学表达式"),
  }),
  handler: async ({ expression }) => {
    const tokens = tokenize(expression);
    const result = new Parser(tokens).parse();
    return { expression, result };
  },
});
