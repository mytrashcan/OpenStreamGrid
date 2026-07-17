import assert from "node:assert/strict";
import test from "node:test";
import { BufferPool } from "../src/buffer-pool.js";

test("reuses a released size-classed buffer", () => {
  const pool = new BufferPool(1024 * 1024, 2);
  const first = pool.acquire(70_000);
  const backing = first.buffer;
  first.fill(7);
  pool.release(first);

  assert.equal(pool.retainedCount(128 * 1024), 1);
  const second = pool.acquire(80_000);
  assert.equal(second.buffer, backing);
  assert.equal(second.every((value) => value === 0), true);
});

test("does not retain oversized or excess buffers", () => {
  const pool = new BufferPool(64 * 1024, 1);
  const first = pool.acquire(32_000);
  const second = pool.acquire(32_000);
  const oversized = pool.acquire(70_000);
  pool.release(first);
  pool.release(second);
  pool.release(oversized);
  assert.equal(pool.retainedCount(), 1);
});
