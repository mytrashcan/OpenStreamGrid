const DEFAULT_MIN_BUCKET_BYTES = 1;
const DEFAULT_MAX_RETAINED_PER_BUCKET = 8;
const DEFAULT_MAX_RETAINED_BYTES = 32 * 1024 * 1024;

/** Reuses dedicated Buffer allocations grouped into power-of-two size classes. */
export class BufferPool {
  private readonly available = new Map<number, Buffer[]>();
  private readonly leases = new WeakMap<Buffer, Buffer>();
  private retainedBytes = 0;

  constructor(
    private readonly maxPooledBufferBytes = 8 * 1024 * 1024,
    private readonly maxRetainedPerBucket = DEFAULT_MAX_RETAINED_PER_BUCKET,
    private readonly maxRetainedBytes = DEFAULT_MAX_RETAINED_BYTES,
  ) {
    if (!Number.isSafeInteger(maxPooledBufferBytes) || maxPooledBufferBytes <= 0) {
      throw new Error("Maximum pooled buffer size must be a positive integer");
    }
    if (!Number.isSafeInteger(maxRetainedPerBucket) || maxRetainedPerBucket <= 0) {
      throw new Error("Retained buffers per bucket must be a positive integer");
    }
    if (!Number.isSafeInteger(maxRetainedBytes) || maxRetainedBytes <= 0) {
      throw new Error("Maximum retained bytes must be a positive integer");
    }
  }

  acquire(size: number): Buffer {
    if (!Number.isSafeInteger(size) || size <= 0) {
      throw new Error("Buffer size must be a positive integer");
    }
    const bucketSize = this.bucketSize(size);
    const retained = this.available.get(bucketSize);
    const reused = retained?.pop();
    if (reused) this.retainedBytes -= reused.byteLength;
    const backing = reused ?? Buffer.allocUnsafeSlow(bucketSize);
    const view = backing.subarray(0, size);
    if (bucketSize <= this.maxPooledBufferBytes) this.leases.set(view, backing);
    return view;
  }

  copy(source: Uint8Array): Buffer {
    const target = this.acquire(source.byteLength);
    target.set(source);
    return target;
  }

  release(buffer: Buffer): void {
    const backing = this.leases.get(buffer);
    if (!backing) return;
    this.leases.delete(buffer);
    const bucketSize = backing.byteLength;
    const retained = this.available.get(bucketSize) ?? [];
    if (
      retained.length >= this.maxRetainedPerBucket ||
      this.retainedBytes + bucketSize > this.maxRetainedBytes
    ) return;
    backing.fill(0);
    retained.push(backing);
    this.retainedBytes += bucketSize;
    this.available.set(bucketSize, retained);
  }

  retainedCount(bucketSize?: number): number {
    if (bucketSize !== undefined) return this.available.get(bucketSize)?.length ?? 0;
    return [...this.available.values()].reduce(
      (total, buffers) => total + buffers.length,
      0,
    );
  }

  allocationSize(buffer: Buffer): number {
    return this.leases.get(buffer)?.byteLength ?? buffer.byteLength;
  }

  private bucketSize(size: number): number {
    if (size > this.maxPooledBufferBytes) return size;
    let bucket = DEFAULT_MIN_BUCKET_BYTES;
    while (bucket < size) bucket *= 2;
    return bucket;
  }
}
