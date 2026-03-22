/**
 * Simple Rate Limiter to throttle function executions
 */
export class RateLimiter {
  private queue: Array<() => void> = [];
  private timestamps: number[] = [];
  private maxRequests: number;
  private intervalMs: number;
  private timeoutId: NodeJS.Timeout | null = null;

  constructor(maxRequests: number, intervalMs: number) {
    this.maxRequests = maxRequests;
    this.intervalMs = intervalMs;
  }

  /**
   * Schedule a task to be executed subject to rate limiting
   */
  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const execute = async () => {
        try {
          const result = await fn();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      };

      this.queue.push(execute);
      this.processQueue();
    });
  }

  private processQueue() {
    if (this.queue.length === 0) return;
    if (this.timeoutId) return; // Already waiting

    const now = Date.now();
    // Filter out timestamps older than the interval
    this.timestamps = this.timestamps.filter((t) => now - t < this.intervalMs);

    if (this.timestamps.length < this.maxRequests) {
      const nextTask = this.queue.shift();
      if (nextTask) {
        this.timestamps.push(now);
        nextTask();
        // Try to process more if possible
        this.processQueue();
      }
    } else {
      // Wait until the oldest timestamp expires
      const oldest = this.timestamps[0];
      const waitTime = Math.max(0, this.intervalMs - (now - oldest));

      this.timeoutId = setTimeout(() => {
        this.timeoutId = null;
        this.processQueue();
      }, waitTime);
    }
  }
}
