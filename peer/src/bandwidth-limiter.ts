const MAX_CHUNK_BYTES = 64 * 1024;

/** Shared token bucket for bounding aggregate upload bytes across transports. */
export class BandwidthLimiter {
  private tokens: number;
  private lastRefill = performance.now();

  constructor(private readonly bytesPerSecond: number) {
    if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
      throw new Error("Upload speed must be positive");
    }
    this.tokens = bytesPerSecond;
  }

  get maximumChunkBytes(): number {
    return Math.max(1, Math.min(MAX_CHUNK_BYTES, Math.floor(this.bytesPerSecond)));
  }

  async consume(bytes: number, signal?: AbortSignal): Promise<void> {
    while (true) {
      if (signal?.aborted) throw signal.reason;
      this.refill();
      if (this.tokens >= bytes) {
        this.tokens -= bytes;
        return;
      }
      const waitMs = Math.max(
        1,
        ((bytes - this.tokens) / this.bytesPerSecond) * 1_000,
      );
      await new Promise<void>((resolve, reject) => {
        const finish = (): void => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        const timer = setTimeout(finish, waitMs);
        timer.unref();
        const onAbort = (): void => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(signal?.reason);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }

  private refill(): void {
    const now = performance.now();
    const elapsedSeconds = Math.max(0, now - this.lastRefill) / 1_000;
    this.tokens = Math.min(
      this.bytesPerSecond,
      this.tokens + elapsedSeconds * this.bytesPerSecond,
    );
    this.lastRefill = now;
  }
}
