/**
 * Scoped lease/permit object returned by Semaphore acquisition.
 */
export interface Permit {
  acquired: boolean;
  release: () => void;
}

/**
 * Counting semaphore for limiting concurrent async operations with FIFO fairness,
 * max permit capping, and lease-based release idempotency.
 */
export class Semaphore {
  private readonly maxPermits: number;
  private permits: number;
  private waitQueue: Array<() => void> = [];

  constructor(permits: number) {
    if (permits < 1) throw new Error('Semaphore permits must be >= 1');
    this.maxPermits = permits;
    this.permits = permits;
  }

  async acquire(timeoutMs?: number): Promise<boolean> {
    const permit = await this.acquirePermit(timeoutMs);
    return permit.acquired;
  }

  async acquirePermit(timeoutMs?: number): Promise<Permit> {
    if (this.permits > 0) {
      this.permits--;
      let released = false;
      return {
        acquired: true,
        release: () => {
          if (!released) {
            released = true;
            this.release();
          }
        }
      };
    }

    if (timeoutMs !== undefined && timeoutMs <= 0) {
      return {
        acquired: false,
        release: () => {}
      };
    }

    return new Promise<Permit>(resolve => {
      let wrapper: () => void;
      let timer: NodeJS.Timeout | undefined;

      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          const idx = this.waitQueue.indexOf(wrapper);
          if (idx !== -1) {
            this.waitQueue.splice(idx, 1);
          }
          resolve({
            acquired: false,
            release: () => {}
          });
        }, timeoutMs);
      }

      let released = false;
      wrapper = () => {
        if (timer) clearTimeout(timer);
        resolve({
          acquired: true,
          release: () => {
            if (!released) {
              released = true;
              this.release();
            }
          }
        });
      };

      this.waitQueue.push(wrapper);
    });
  }

  release(): void {
    const next = this.waitQueue.shift();
    if (next) {
      next();
    } else if (this.permits < this.maxPermits) {
      this.permits++;
    }
  }

  get available(): number {
    return this.permits;
  }

  get waiting(): number {
    return this.waitQueue.length;
  }

  get max(): number {
    return this.maxPermits;
  }
}
