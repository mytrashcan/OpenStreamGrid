import { BufferPool } from "./buffer-pool.js";

/** Immutable data and insertion metadata for one cached segment. */
export interface CacheEntry {
  readonly data: Buffer;
  readonly storedAt: number;
  readonly allocatedBytes: number;
  leases: number;
  evicted: boolean;
}

/** Pins cached bytes until an asynchronous consumer has finished with them. */
export interface CacheLease {
  readonly data: Buffer;
  release(): void;
}

/** Byte- and TTL-limited least-recently-used cache for peer segment data. */
export class SegmentCache {
  private readonly entries = new Map<string, CacheEntry>();
  private totalBytes = 0;

  constructor(
    readonly maxBytes: number,
    readonly ttlMs = Number.POSITIVE_INFINITY,
    private readonly bufferPool = new BufferPool(),
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error("Cache size must be a positive integer");
    }
    if (!(ttlMs > 0)) throw new Error("Cache TTL must be positive");
  }

  get size(): number {
    this.evictExpired();
    return this.entries.size;
  }

  get bytes(): number {
    this.evictExpired();
    return this.totalBytes;
  }

  get(segmentName: string): Buffer | undefined {
    const data = this.touch(segmentName)?.data;
    return data ? Buffer.from(data) : undefined;
  }

  lease(segmentName: string): CacheLease | undefined {
    const entry = this.touch(segmentName);
    if (!entry) return undefined;
    entry.leases += 1;
    let released = false;
    return {
      data: entry.data,
      release: () => {
        if (released) return;
        released = true;
        entry.leases -= 1;
        if (entry.evicted && entry.leases === 0) {
          this.bufferPool.release(entry.data);
        }
      },
    };
  }

  has(segmentName: string): boolean {
    const entry = this.entries.get(segmentName);
    if (!entry) return false;
    if (this.isExpired(entry)) {
      this.remove(segmentName, entry);
      return false;
    }
    return true;
  }

  set(segmentName: string, data: Buffer): boolean {
    if (data.byteLength === 0 || data.byteLength > this.maxBytes) return false;

    const existing = this.entries.get(segmentName);
    if (existing) this.remove(segmentName, existing);
    const pooledData = this.bufferPool.copy(data);
    const allocatedBytes = this.bufferPool.allocationSize(pooledData);
    if (allocatedBytes > this.maxBytes) {
      this.bufferPool.release(pooledData);
      return false;
    }
    this.entries.set(segmentName, {
      data: pooledData,
      storedAt: this.now(),
      allocatedBytes,
      leases: 0,
      evicted: false,
    });
    this.totalBytes += allocatedBytes;
    while (this.totalBytes > this.maxBytes) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.entries.get(oldestKey);
      if (oldest) this.remove(oldestKey, oldest);
    }
    return true;
  }

  keys(): string[] {
    this.evictExpired();
    return [...this.entries.keys()];
  }

  clear(): void {
    for (const [segmentName, entry] of this.entries) {
      this.remove(segmentName, entry);
    }
  }

  private isExpired(entry: CacheEntry): boolean {
    return this.now() - entry.storedAt >= this.ttlMs;
  }

  private touch(segmentName: string): CacheEntry | undefined {
    const entry = this.entries.get(segmentName);
    if (!entry) return undefined;
    if (this.isExpired(entry)) {
      this.remove(segmentName, entry);
      return undefined;
    }
    this.entries.delete(segmentName);
    this.entries.set(segmentName, entry);
    return entry;
  }

  private evictExpired(): void {
    if (!Number.isFinite(this.ttlMs)) return;
    for (const [segmentName, entry] of this.entries) {
      if (this.isExpired(entry)) this.remove(segmentName, entry);
    }
  }

  private remove(segmentName: string, entry: CacheEntry): void {
    if (!this.entries.delete(segmentName)) return;
    this.totalBytes -= entry.allocatedBytes;
    entry.evicted = true;
    if (entry.leases === 0) this.bufferPool.release(entry.data);
  }
}
