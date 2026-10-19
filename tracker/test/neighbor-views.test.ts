import assert from "node:assert/strict";
import test from "node:test";
import { NeighborViews } from "../src/neighbor-views.js";

const ids = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `peer-${index}`);

test("small audiences see every peer through mutual links", () => {
  const views = new NeighborViews(8);
  const peers: string[] = [];
  for (const peerId of ids(5)) {
    peers.push(peerId);
    views.fill("live", peerId, [...peers]);
  }
  for (const peerId of peers) {
    assert.deepEqual(
      [...(views.view("live", peerId) ?? [])].sort(),
      peers.filter((other) => other !== peerId).sort(),
    );
  }
});

/** Deterministic generator so the statistical assertions cannot flake. */
const seededRandom = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
};

test("views stay bounded and newcomers stay visible in a full audience", () => {
  const size = 4;
  const views = new NeighborViews(size, seededRandom(7));
  const peers: string[] = [];
  for (const peerId of ids(500)) {
    peers.push(peerId);
    // fill reorders its candidates, so keep `peers` in join order.
    const { added, reciprocal, evicted } = views.fill("live", peerId, [...peers]);
    assert.ok(added.length <= size);
    // Every link is mutual at the time it is made, even when views are full.
    assert.deepEqual(reciprocal.sort(), added.sort());
    for (const { watcher, peerId: dropped } of evicted) {
      assert.ok(!views.view("live", watcher)?.has(dropped));
    }
  }
  const watchedBy = new Map(peers.map((peerId) => [peerId, 0]));
  for (const peerId of peers) {
    const view = views.view("live", peerId);
    assert.ok(view && view.size <= size);
    assert.ok(!view.has(peerId));
    for (const neighbor of view) watchedBy.set(neighbor, (watchedBy.get(neighbor) ?? 0) + 1);
  }
  // The newest peers joined a full audience and are still seen by others.
  for (const peerId of peers.slice(-20)) assert.ok((watchedBy.get(peerId) ?? 0) > 0);
  const unwatched = [...watchedBy.values()].filter((count) => count === 0).length;
  assert.ok(unwatched < peers.length * 0.05, `${unwatched} peers are not watched`);
});

test("leaving removes the peer everywhere and reports who lost it", () => {
  const views = new NeighborViews(3);
  const peers = ids(4);
  for (const peerId of peers) views.fill("live", peerId, [...peers]);
  const watchers = peers.filter((peerId) => views.view("live", peerId)?.has("peer-0"));

  assert.deepEqual(views.leave("live", "peer-0").sort(), watchers.sort());
  const remaining = peers.slice(1);
  for (const peerId of remaining) assert.ok(!views.view("live", peerId)?.has("peer-0"));
  assert.equal(views.view("live", "peer-0"), undefined);

  // Refilling from the remaining audience cannot bring the peer back.
  for (const peerId of watchers) views.fill("live", peerId, [...remaining]);
  for (const peerId of remaining) assert.ok(!views.view("live", peerId)?.has("peer-0"));
});

test("broadcasts are independent and can be removed", () => {
  const views = new NeighborViews(2);
  views.fill("a", "peer-1", ["peer-1", "peer-2"]);
  views.fill("b", "peer-1", ["peer-1", "peer-3"]);
  assert.deepEqual([...(views.view("a", "peer-1") ?? [])], ["peer-2"]);
  assert.deepEqual([...(views.view("b", "peer-1") ?? [])], ["peer-3"]);
  views.removeBroadcast("a");
  assert.equal(views.view("a", "peer-1"), undefined);
  assert.equal(views.view("a", "peer-2"), undefined);
  assert.deepEqual([...(views.view("b", "peer-1") ?? [])], ["peer-3"]);
});

test("refilling after a mass departure costs per view, not per audience", () => {
  const views = new NeighborViews(64, seededRandom(11));
  const peers = ids(5_000);
  for (let index = 0; index < peers.length; index += 1) {
    views.fill("live", peers[index] as string, peers.slice(0, index + 1));
  }
  const leaving = new Set(peers.slice(0, 1_000));
  const remaining = peers.slice(1_000);
  const started = performance.now();
  for (const peerId of leaving) {
    for (const watcher of views.leave("live", peerId)) views.fill("live", watcher, remaining);
  }
  const elapsedMs = performance.now() - started;
  // Shuffling the whole audience per refill would cost up to 64 x 5000 steps
  // per departure; sampling costs about one view's worth.
  assert.ok(elapsedMs < 2_000, `refills took ${elapsedMs.toFixed(0)} ms`);
  for (const peerId of remaining) {
    const view = views.view("live", peerId);
    assert.ok(view && view.size === 64);
    for (const neighbor of view) assert.ok(!leaving.has(neighbor));
  }
});
