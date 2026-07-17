import assert from "node:assert/strict";
import test from "node:test";
import { BufferPool } from "../src/buffer-pool.js";
import { SegmentCache } from "../src/cache.js";

test("evicts the least recently used segments within the byte limit", () => {
  const cache = new SegmentCache(6);
  cache.set("a.ts", Buffer.from("aa"));
  cache.set("b.ts", Buffer.from("bb"));
  assert.equal(cache.get("a.ts")?.toString(), "aa");
  cache.set("c.ts", Buffer.from("cccc"));

  assert.equal(cache.has("a.ts"), true);
  assert.equal(cache.has("b.ts"), false);
  assert.equal(cache.has("c.ts"), true);
  assert.equal(cache.bytes, 6);
});

test("does not cache a segment larger than the cache", () => {
  const cache = new SegmentCache(2);
  assert.equal(cache.set("large.ts", Buffer.from("abc")), false);
  assert.equal(cache.size, 0);
});

test("does not allow zero-byte entries to bypass the byte limit", () => {
  const cache = new SegmentCache(2);

  assert.equal(cache.set("empty.ts", Buffer.alloc(0)), false);
  assert.equal(cache.size, 0);
  assert.equal(cache.bytes, 0);
});

test("evicts expired entries and returns their buffers to the pool", () => {
  let now = 1_000;
  const pool = new BufferPool();
  const cache = new SegmentCache(100, 50, pool, () => now);
  cache.set("segment.ts", Buffer.from("data"));
  assert.equal(cache.has("segment.ts"), true);

  now = 1_050;
  assert.equal(cache.get("segment.ts"), undefined);
  assert.equal(cache.size, 0);
  assert.equal(cache.bytes, 0);
  assert.equal(pool.retainedCount(), 1);
});

test("clear releases all pooled entries", () => {
  const pool = new BufferPool();
  const cache = new SegmentCache(100, Number.POSITIVE_INFINITY, pool);
  cache.set("a.ts", Buffer.from("a"));
  cache.set("b.ts", Buffer.from("bb"));
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.bytes, 0);
  assert.equal(pool.retainedCount(), 2);
});

test("does not recycle leased bytes until the consumer releases them", () => {
  const pool = new BufferPool();
  const cache = new SegmentCache(4, Number.POSITIVE_INFINITY, pool);
  cache.set("a.ts", Buffer.from("aaaa"));
  const lease = cache.lease("a.ts");
  assert.ok(lease);

  cache.set("b.ts", Buffer.from("bbbb"));
  assert.equal(lease.data.toString(), "aaaa");
  assert.equal(pool.retainedCount(), 0);

  lease.release();
  lease.release();
  assert.equal(pool.retainedCount(), 1);
});
