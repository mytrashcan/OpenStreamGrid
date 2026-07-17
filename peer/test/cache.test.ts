import assert from "node:assert/strict";
import test from "node:test";
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
