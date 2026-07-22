import type { CachedSegment } from "./types.js";

/**
 * Browser-compatible LRU segment cache.
 * Uses a Map (preserves insertion order in modern JS engines) + head/tail linked list
 * for O(1) eviction. Stores raw Uint8Array — no Node Buffer.
 */
export class SegmentCache {
  private readonly map = new Map<string, CacheNode>();
  private head: CacheNode | null = null;
  private tail: CacheNode | null = null;
  private totalBytes = 0;

  constructor(readonly maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error("maxBytes must be a positive integer");
    }
  }

  /** Number of cached segments. */
  get size(): number {
    return this.map.size;
  }

  /** Total bytes stored. */
  get bytes(): number {
    return this.totalBytes;
  }

  /** Retrieve a segment (bumps to front on hit). */
  get(segmentName: string): Uint8Array | undefined {
    const node = this.map.get(segmentName);
    if (!node) return undefined;
    this.bumpToFront(node);
    return new Uint8Array(node.data);
  }

  /** Check existence without bumping LRU order. */
  has(segmentName: string): boolean {
    return this.map.has(segmentName);
  }

  /** Store a segment. Returns false if the segment is larger than maxBytes. */
  set(segmentName: string, data: Uint8Array, hash?: string): boolean {
    if (data.byteLength === 0 || data.byteLength > this.maxBytes) return false;

    const existing = this.map.get(segmentName);
    if (existing) {
      this.totalBytes -= existing.data.byteLength;
      this.removeNode(existing);
    }

    const node: CacheNode = {
      key: segmentName,
      data: new Uint8Array(data),
      ...(hash !== undefined ? { hash } : {}),
      storedAt: Date.now(),
      prev: null,
      next: null,
    };

    this.map.set(segmentName, node);
    this.prepend(node);
    this.totalBytes += data.byteLength;

    // Evict from tail until under limit
    while (this.totalBytes > this.maxBytes && this.tail) {
      this.evict(this.tail.key);
    }

    return true;
  }

  /** List all cached segment names. */
  keys(): string[] {
    return [...this.map.keys()];
  }

  /** Get metadata about a cached entry without bumping. */
  peek(segmentName: string): CachedSegment | undefined {
    const node = this.map.get(segmentName);
    if (!node) return undefined;
    return {
      data: node.data,
      storedAt: node.storedAt,
      ...(node.hash !== undefined ? { hash: node.hash } : {}),
    };
  }

  /** Delete all entries. */
  clear(): void {
    this.map.clear();
    this.head = null;
    this.tail = null;
    this.totalBytes = 0;
  }

  // ---- private helpers ----

  private bumpToFront(node: CacheNode): void {
    // If already front, nothing to do
    if (node === this.head) return;
    this.removeNode(node);
    this.prepend(node);
  }

  /** Insert at front (head). */
  private prepend(node: CacheNode): void {
    node.prev = null;
    node.next = this.head;
    if (this.head) this.head.prev = node;
    this.head = node;
    if (!this.tail) this.tail = node;
  }

  /** Unlink a node from the list. */
  private removeNode(node: CacheNode): void {
    if (node.prev) node.prev.next = node.next;
    if (node.next) node.next.prev = node.prev;
    if (this.head === node) this.head = node.next;
    if (this.tail === node) this.tail = node.prev;
    node.prev = null;
    node.next = null;
  }

  /** Evict a specific key. */
  private evict(segmentName: string): void {
    const node = this.map.get(segmentName);
    if (!node) return;
    this.totalBytes -= node.data.byteLength;
    this.removeNode(node);
    this.map.delete(segmentName);
  }
}

interface CacheNode {
  key: string;
  data: Uint8Array;
  hash?: string;
  storedAt: number;
  prev: CacheNode | null;
  next: CacheNode | null;
}
