import assert from "node:assert/strict";
import test from "node:test";
import {
  InventoryRateLimiter,
  MAX_SEGMENT_ID_LENGTH,
  MAX_SEGMENTS_PER_REPORT,
  segmentIdList,
} from "../src/inventory-limits.js";

test("accepts only bounded lists of non-empty segment IDs", () => {
  assert.deepEqual(segmentIdList(["a.ts", "b.ts"]), ["a.ts", "b.ts"]);
  assert.deepEqual(segmentIdList([]), []);
  assert.equal(segmentIdList("a.ts"), undefined);
  assert.equal(segmentIdList([1]), undefined);
  assert.equal(segmentIdList([""]), undefined);
  assert.equal(segmentIdList(["x".repeat(MAX_SEGMENT_ID_LENGTH + 1)]), undefined);
  assert.equal(segmentIdList(Array.from({ length: MAX_SEGMENTS_PER_REPORT + 1 }, () => "a.ts")), undefined);
});

test("limits reported characters per peer with a refilling burst", () => {
  let now = 0;
  const limiter = new InventoryRateLimiter(100, 1_000, () => now);
  const ids = (characters: number): string[] => ["x".repeat(characters)];

  assert.equal(limiter.consume("live", "a", [ids(600)]), true);
  assert.equal(limiter.consume("live", "a", [ids(300), ids(100)]), true);
  // The burst is spent, and an over-budget report charges nothing.
  assert.equal(limiter.consume("live", "a", [ids(1)]), false);
  // Other peers and broadcasts have their own budgets.
  assert.equal(limiter.consume("live", "b", [ids(1_000)]), true);
  assert.equal(limiter.consume("other", "a", [ids(1_000)]), true);

  now = 2_000; // refills 200 characters
  assert.equal(limiter.consume("live", "a", [ids(250)]), false);
  assert.equal(limiter.consume("live", "a", [ids(200)]), true);
  now = 60_000; // never beyond the burst
  assert.equal(limiter.consume("live", "a", [ids(1_001)]), false);
  assert.equal(limiter.consume("live", "a", [ids(1_000)]), true);
});
