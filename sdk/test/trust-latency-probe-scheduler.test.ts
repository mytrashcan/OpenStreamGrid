import assert from "node:assert/strict";
import test from "node:test";
import type {
  SchedulingPeer,
  SegmentSchedulingContext,
} from "@openstreamgrid/common";
import { TrustLatencyProbeScheduler } from "../src/trust-latency-probe-scheduler.js";

const makePeer = (
  id: string,
  overrides: Partial<SchedulingPeer> = {},
): SchedulingPeer => ({
  id,
  latencyMs: 100,
  successRate: 0.8,
  uploadBandwidthBps: 1_000_000,
  trustScore: 0.8,
  segments: ["segment.ts"],
  ...overrides,
});

const makeContext = (
  candidates: readonly SchedulingPeer[],
  overrides: Partial<SegmentSchedulingContext> = {},
): SegmentSchedulingContext => ({
  segmentId: "segment.ts",
  candidates,
  selfPeerId: "self",
  maximumParallelism: 3,
  ...overrides,
});

test("ranks browser peers by trust score descending", () => {
  const plan = new TrustLatencyProbeScheduler().planSegment(
    makeContext([
      makePeer("medium", { trustScore: 0.6, latencyMs: 10 }),
      makePeer("low", { trustScore: 0.2, latencyMs: 1 }),
      makePeer("high", { trustScore: 0.9, latencyMs: 100 }),
    ]),
  );

  assert.deepEqual(
    plan.rankedPeers.map(({ peerId }) => peerId),
    ["high", "medium", "low"],
  );
});

test("uses ascending latency for equal-trust browser peers", () => {
  const plan = new TrustLatencyProbeScheduler().planSegment(
    makeContext([
      makePeer("slow", { trustScore: 0.8, latencyMs: 300 }),
      makePeer("fast", { trustScore: 0.8, latencyMs: 20 }),
      makePeer("medium", { trustScore: 0.8, latencyMs: 100 }),
    ]),
  );

  assert.deepEqual(
    plan.rankedPeers.map(({ peerId }) => peerId),
    ["fast", "medium", "slow"],
  );
});

test("uses Origin when the candidate list is empty", () => {
  assert.deepEqual(
    new TrustLatencyProbeScheduler().planSegment(makeContext([])),
    {
      policy: "trust-latency-probe",
      mode: "origin",
      peerIds: [],
      rankedPeers: [],
      reason: "no_candidates",
    },
  );
});

test("filters the local browser peer before ranking", () => {
  const plan = new TrustLatencyProbeScheduler().planSegment(
    makeContext([
      makePeer("self", { trustScore: 1, latencyMs: 1 }),
      makePeer("remote", { trustScore: 0.5, latencyMs: 500 }),
    ]),
  );

  assert.deepEqual(plan.peerIds, ["remote"]);
  assert.deepEqual(
    plan.rankedPeers.map(({ peerId }) => peerId),
    ["remote"],
  );
});

test("selects at most three parallel browser probes", () => {
  const plan = new TrustLatencyProbeScheduler().planSegment(
    makeContext([
      makePeer("first", { trustScore: 1 }),
      makePeer("second", { trustScore: 0.9 }),
      makePeer("third", { trustScore: 0.8 }),
      makePeer("fourth", { trustScore: 0.7 }),
    ]),
  );

  assert.equal(plan.mode, "parallel-peers");
  assert.equal(plan.reason, "parallel_peer_probe");
  assert.deepEqual(plan.peerIds, ["first", "second", "third"]);
});

test("does not mutate browser candidate snapshots", () => {
  const segments = Object.freeze(["segment.ts"]);
  const peer = Object.freeze(
    makePeer("peer-a", { latencyMs: 20, segments }),
  );
  const candidates = Object.freeze([
    makePeer("peer-b", { latencyMs: 200 }),
    peer,
  ]);
  const before = JSON.stringify(candidates);

  new TrustLatencyProbeScheduler().planSegment(makeContext(candidates));

  assert.equal(JSON.stringify(candidates), before);
  assert.deepEqual(peer.segments, ["segment.ts"]);
});

test("returns deterministic plans for repeated identical decisions", () => {
  const scheduler = new TrustLatencyProbeScheduler();
  const context = makeContext([
    makePeer("peer-a", { trustScore: 0.9, latencyMs: 20 }),
    makePeer("peer-b", { trustScore: 0.8, latencyMs: 10 }),
  ]);

  assert.deepEqual(
    scheduler.planSegment(context),
    scheduler.planSegment(context),
  );
});

test("returns the peer plan whose failed probes fall back to Origin", () => {
  const plan = new TrustLatencyProbeScheduler().planSegment(
    makeContext([
      makePeer("first", { trustScore: 1 }),
      makePeer("second", { trustScore: 0.9 }),
      makePeer("third", { trustScore: 0.8 }),
    ]),
  );

  assert.deepEqual(
    {
      mode: plan.mode,
      peerIds: plan.peerIds,
      reason: plan.reason,
    },
    {
      mode: "parallel-peers",
      peerIds: ["first", "second", "third"],
      reason: "parallel_peer_probe",
    },
  );
});
