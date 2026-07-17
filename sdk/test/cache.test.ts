import assert from "node:assert/strict";
import test from "node:test";
import { SegmentCache } from "../src/cache.js";

test("validates capacity and rejects empty or oversized segments", () => {
  assert.throws(() => new SegmentCache(0), /positive integer/);
  assert.throws(() => new SegmentCache(1.5), /positive integer/);
  const cache = new SegmentCache(2);
  assert.equal(cache.set("empty.ts", new Uint8Array()), false);
  assert.equal(cache.set("large.ts", new Uint8Array(3)), false);
  assert.deepEqual(cache.keys(), []);
});

test("evicts least-recently-used entries and updates existing bytes", () => {
  const cache = new SegmentCache(5);
  cache.set("one.ts", new Uint8Array([1, 2]), "hash-one");
  cache.set("two.ts", new Uint8Array([3, 4]));
  assert.deepEqual(cache.get("one.ts"), new Uint8Array([1, 2]));
  cache.set("three.ts", new Uint8Array([5, 6]));
  assert.equal(cache.has("two.ts"), false);
  assert.deepEqual(cache.keys(), ["one.ts", "three.ts"]);
  assert.equal(cache.bytes, 4);

  cache.set("one.ts", new Uint8Array([7]));
  assert.equal(cache.bytes, 3);
  assert.deepEqual(cache.get("one.ts"), new Uint8Array([7]));
  assert.equal(cache.peek("one.ts")?.hash, undefined);
});

test("returns cache metadata and clears all linked-list state", () => {
  const cache = new SegmentCache(10);
  cache.set("segment.ts", new Uint8Array([1, 2, 3]), "digest");
  const entry = cache.peek("segment.ts");
  assert.deepEqual(entry?.data, new Uint8Array([1, 2, 3]));
  assert.equal(entry?.hash, "digest");
  assert.ok(Number.isFinite(entry?.storedAt));
  assert.equal(cache.peek("missing.ts"), undefined);
  assert.equal(cache.get("missing.ts"), undefined);

  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.bytes, 0);
  assert.deepEqual(cache.keys(), []);
  cache.set("new.ts", new Uint8Array([4]));
  assert.deepEqual(cache.keys(), ["new.ts"]);
});
