/** 简易计数信号量：限制同时执行的工具数量（对标 asyncio.Semaphore）。 */

export class Semaphore {
  private permits: number;
  private queue: Array<() => void> = [];

  constructor(count: number) {
    this.permits = count;
  }

  /** 获取一个许可，返回释放函数 */
  async acquire(): Promise<() => void> {
    if (this.permits > 0) {
      this.permits--;
      return this.release;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    // 被唤醒时许可已由上一个释放者"转交"，无需再减
    return this.release;
  }

  private release = (): void => {
    const next = this.queue.shift();
    if (next) {
      // 直接把许可转交给排队者，permits 不增加
      next();
    } else {
      this.permits++;
    }
  };
}
