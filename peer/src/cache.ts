export interface CacheEntry {
  readonly data: Buffer;
  readonly storedAt: number;
}

export class SegmentCache {
  private readonly entries = new Map<string, CacheEntry>();
  private totalBytes = 0;

  constructor(readonly maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error("Cache size must be a positive integer");
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  get(segmentName: string): Buffer | undefined {
    const entry = this.entries.get(segmentName);
    if (!entry) return undefined;
    this.entries.delete(segmentName);
    this.entries.set(segmentName, entry);
    return entry.data;
  }

  has(segmentName: string): boolean {
    return this.entries.has(segmentName);
  }

  set(segmentName: string, data: Buffer): boolean {
    if (data.byteLength === 0 || data.byteLength > this.maxBytes) return false;

    const existing = this.entries.get(segmentName);
    if (existing) {
      this.totalBytes -= existing.data.byteLength;
      this.entries.delete(segmentName);
    }
    this.entries.set(segmentName, { data, storedAt: Date.now() });
    this.totalBytes += data.byteLength;
    while (this.totalBytes > this.maxBytes) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      if (oldest) this.totalBytes -= oldest.data.byteLength;
    }
    return true;
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }
}
