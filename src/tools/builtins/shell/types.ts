/** 通用执行通道的适配器契约：把「一条命令」翻译成各平台的执行方式。 */

/** 一次执行的原始结果：适配器只负责跑，不管档位策略 */
export interface RunOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunContext {
  /** 工作目录，固定为 workspace */
  cwd: string;
  /** 本次执行的超时（秒） */
  timeoutSeconds: number;
  /** 用户取消信号 */
  signal: AbortSignal;
  /** 已解析的可执行文件；POSIX readonly 不用它（走白名单里的裸命令名） */
  executable: string;
}

/**
 * 平台适配器。
 *
 * readonly 与 full 分成两个方法而不是一个带 flag 的方法：两者的危险程度差一个量级，
 * 分开后「readonly 走了 full 的实现」这种错误在类型层面就写不出来。
 */
export interface ShellAdapter {
  /** 解析可执行文件：留空时各平台给默认值 */
  executable(configured: string): string;
  /**
   * readonly 档。由平台自己保证「不可能写」：
   *   Windows 靠元字符黑名单 + cmdlet 白名单拦
   *   POSIX   靠不经 shell、直接 exec argv 让写机制不存在
   */
  runReadonly(command: string, ctx: RunContext): Promise<RunOutcome>;
  /** full 档：命令不受限 */
  runFull(command: string, ctx: RunContext): Promise<RunOutcome>;
  /** 工具描述里的参数示例，如 "Get-Date" / "date -u" */
  commandExample(): string;
  /** 工具描述里的平台使用提示（语法与「不能用什么」） */
  usageHint(): string;
  /** 档位说明，供 describeShell 拼日志 */
  readonlyHint(): string;
  /** ENOENT 时给「下一步该做什么」的安装提示 */
  missingExecutableHint(executable: string): string;
}
