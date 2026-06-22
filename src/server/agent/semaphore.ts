/**
 * Simple counting semaphore for limiting concurrent async operations.
 */
export class Semaphore {
  private permits: number;
  private waitQueue: Array<() => void> = [];

  constructor(permits: number) {
    if (permits < 1) throw new Error('Semaphore permits must be >= 1');
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    return new Promise<void>(resolve => {
      this.waitQueue.push(resolve);
    });
  }

  release(): void {
    const next = this.waitQueue.shift();
    if (next) {
      next();
    } else {
      this.permits++;
    }
  }

  get available(): number {
    return this.permits;
  }

  get waiting(): number {
    return this.waitQueue.length;
  }
}
