/** 结构化 JSON 日志：用 AsyncLocalStorage 给每条日志自动注入 runId。 */

import { AsyncLocalStorage } from "node:async_hooks";

export const runIdStorage = new AsyncLocalStorage<string>();

type Level = "DEBUG" | "INFO" | "WARNING" | "ERROR";

export class Logger {
  private level: Level;

  constructor(
    private readonly name: string,
    level: Level = "INFO",
  ) {
    this.level = level;
  }

  setLevel(level: Level): void {
    this.level = level;
  }

  private write(level: Level, message: string, extra?: Record<string, unknown>): void {
    const order: Level[] = ["DEBUG", "INFO", "WARNING", "ERROR"];
    if (order.indexOf(level) < order.indexOf(this.level)) return;

    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      logger: this.name,
      message,
    };
    const runId = runIdStorage.getStore();
    if (runId) entry.run_id = runId;
    if (extra) Object.assign(entry, extra);
    process.stderr.write(`${JSON.stringify(entry)}\n`);
  }

  debug(message: string, extra?: Record<string, unknown>): void {
    this.write("DEBUG", message, extra);
  }

  info(message: string, extra?: Record<string, unknown>): void {
    this.write("INFO", message, extra);
  }

  warning(message: string, extra?: Record<string, unknown>): void {
    this.write("WARNING", message, extra);
  }

  error(message: string, extra?: Record<string, unknown>): void {
    this.write("ERROR", message, extra);
  }
}

const rootLevel: { value: Level } = { value: "INFO" };

export function setupLogging(level: string = "INFO"): void {
  rootLevel.value = level.toUpperCase() as Level;
}

export function getLogger(name: string): Logger {
  return new Logger(name, rootLevel.value);
}
