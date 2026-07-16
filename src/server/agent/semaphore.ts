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

  async acquire(timeoutMs?: number): Promise<boolean> {
    if (this.permits > 0) {
      this.permits--;
      return true;
    }
    if (timeoutMs && timeoutMs <= 0) {
      return false;
    }
    return new Promise<boolean>(resolve => {
      if (timeoutMs) {
        let wrapper: () => void;
        const timer = setTimeout(() => {
          const idx = this.waitQueue.indexOf(wrapper);
          if (idx !== -1) {
            this.waitQueue.splice(idx, 1);
          }
          resolve(false);
        }, timeoutMs);
        wrapper = () => {
          clearTimeout(timer);
          resolve(true);
        };
        this.waitQueue.push(wrapper);
      } else {
        this.waitQueue.push(() => resolve(true));
      }
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
