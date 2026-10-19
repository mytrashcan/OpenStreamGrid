import assert from "node:assert/strict";
import test from "node:test";
import { NeighborViews } from "../src/neighbor-views.js";

const ids = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `peer-${index}`);

/** Deterministic generator so the statistical assertions cannot flake. */
const seededRandom = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
};

/** Adds peers one at a time and fills each one's view as it joins. */
const join = (views: NeighborViews, peers: string[], broadcastId = "live"): void => {
  for (const peerId of peers) {
    views.add(broadcastId, peerId);
    views.fill(broadcastId, peerId);
  }
};

test("small audiences see every peer through mutual links", () => {
  const views = new NeighborViews(8);
  const peers = ids(5);
  join(views, peers);
  for (const peerId of peers) {
    assert.deepEqual(
      [...(views.view("live", peerId) ?? [])].sort(),
      peers.filter((other) => other !== peerId).sort(),
    );
  }
});

test("views stay bounded and newcomers stay visible in a full audience", () => {
  const size = 4;
  const views = new NeighborViews(size, seededRandom(7));
  const peers = ids(500);
  for (const peerId of peers) {
    views.add("live", peerId);
    const { added, reciprocal, evicted } = views.fill("live", peerId);
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
  join(views, peers);
  const watchers = peers.filter((peerId) => views.view("live", peerId)?.has("peer-0"));

  assert.deepEqual(views.leave("live", "peer-0").sort(), watchers.sort());
  for (const peerId of peers.slice(1)) assert.ok(!views.view("live", peerId)?.has("peer-0"));
  assert.equal(views.view("live", "peer-0"), undefined);

  // Refills draw from the remaining members, so the peer cannot come back.
  for (const peerId of watchers) views.fill("live", peerId);
  for (const peerId of peers.slice(1)) {
    const view = views.view("live", peerId);
    assert.ok(view && !view.has("peer-0"));
    assert.equal(view.size, 2);
  }
});

test("a nearly full view finds the last free peer in a large audience", () => {
  // Existing neighbors used to consume the search budget, so a view one
  // short of 1000 in an audience of 1001 usually missed the remaining peer.
  const views = new NeighborViews(1_000, seededRandom(3));
  const peers = ids(1_001);
  for (const peerId of peers) views.add("live", peerId);
  views.fill("live", "peer-0");
  assert.equal(views.view("live", "peer-0")?.size, 1_000);

  views.leave("live", "peer-1");
  views.add("live", "peer-new");
  // peer-0 lost peer-1 and has exactly one candidate left: peer-new.
  views.fill("live", "peer-0");
  assert.ok(views.view("live", "peer-0")?.has("peer-new"));
});

test("broadcasts are independent and can be removed", () => {
  const views = new NeighborViews(2);
  join(views, ["peer-1", "peer-2"], "a");
  join(views, ["peer-1", "peer-3"], "b");
  assert.deepEqual([...(views.view("a", "peer-1") ?? [])], ["peer-2"]);
  assert.deepEqual([...(views.view("b", "peer-1") ?? [])], ["peer-3"]);
  assert.ok(views.has("a"));
  views.removeBroadcast("a");
  assert.ok(!views.has("a"));
  assert.equal(views.view("a", "peer-1"), undefined);
  assert.deepEqual([...(views.view("b", "peer-1") ?? [])], ["peer-3"]);
  // The last member leaving forgets the broadcast too.
  views.leave("b", "peer-1");
  views.leave("b", "peer-3");
  assert.ok(!views.has("b"));
});

test("joins and refills cost per view, not per audience", () => {
  const views = new NeighborViews(64, seededRandom(11));
  const peers = ids(5_000);
  const joinStarted = performance.now();
  join(views, peers);
  const joinMs = performance.now() - joinStarted;
  const leaving = new Set(peers.slice(0, 1_000));
  const remaining = peers.slice(1_000);
  const leaveStarted = performance.now();
  for (const peerId of leaving) {
    for (const watcher of views.leave("live", peerId)) views.fill("live", watcher);
  }
  const leaveMs = performance.now() - leaveStarted;
  // Copying or shuffling the audience per operation would cost up to 64 x
  // 5000 steps per departure; sampling costs about one view's worth.
  assert.ok(joinMs < 2_000, `joins took ${joinMs.toFixed(0)} ms`);
  assert.ok(leaveMs < 2_000, `refills took ${leaveMs.toFixed(0)} ms`);
  for (const peerId of remaining) {
    const view = views.view("live", peerId);
    assert.ok(view && view.size === 64);
    for (const neighbor of view) assert.ok(!leaving.has(neighbor));
  }
});
