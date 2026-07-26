import assert from "node:assert/strict";
import test from "node:test";
import type {
  Peer,
  SegmentSchedulingContext,
} from "@openstreamgrid/common";
import {
  calculatePeerScore,
  clamp,
  exponentialMovingAverage,
  LATENCY_WEIGHT_VALUE,
  MAX_PARALLEL_DOWNLOADS_VALUE,
  METRIC_EMA_ALPHA_VALUE,
  MINIMUM_TRUST_SCORE_VALUE,
  SUCCESS_RATE_WEIGHT_VALUE,
  TRUST_SCORE_WEIGHT_VALUE,
  UPLOAD_BANDWIDTH_WEIGHT_VALUE,
  URGENT_THRESHOLD_SEGMENTS_VALUE,
  WeightedScoreScheduler,
} from "../peer/src/weighted-score-scheduler.js";

const approximatelyEqual = (actual: number, expected: number): void => {
  assert.ok(
    Math.abs(actual - expected) < Number.EPSILON * 10,
    `Expected ${actual} to approximately equal ${expected}`,
  );
};

const makePeer = (id: string, overrides: Partial<Peer> = {}): Peer => ({
  id,
  address: `http://${id}:9090`,
  segments: ["segment.ts"],
  joinedAt: "2026-07-26T00:00:00.000Z",
  lastSeenAt: "2026-07-26T00:00:00.000Z",
  latencyMs: 100,
  successRate: 0.8,
  trustScore: 0.8,
  uploadBandwidthBps: 1_000_000,
  ...overrides,
});

const makeContext = (
  candidates: readonly Peer[],
  selfPeerId = "self",
): SegmentSchedulingContext => ({
  segmentId: "segment.ts",
  segmentsAhead: 3,
  candidates: candidates.map((peer, originalIndex) => ({
    id: peer.id,
    latencyMs: peer.latencyMs,
    successRate: peer.successRate,
    uploadBandwidthBps: peer.uploadBandwidthBps ?? 0,
    trustScore: peer.trustScore,
    segments: peer.segments,
    originalIndex,
  })),
  selfPeerId,
  maximumParallelism: 3,
});

const rankedPeerIds = (
  scheduler: WeightedScoreScheduler,
  candidates: readonly Peer[],
  selfPeerId = "self",
): string[] =>
  scheduler
    .planSegment(makeContext(candidates, selfPeerId))
    .rankedPeers.map(({ peerId }) => peerId);

const makeScheduler = (): WeightedScoreScheduler =>
  new WeightedScoreScheduler({
    urgentThresholdSegments: URGENT_THRESHOLD_SEGMENTS_VALUE,
  });

test("exports the legacy Node scheduler defaults", () => {
  assert.equal(MINIMUM_TRUST_SCORE_VALUE, 0.3);
  assert.equal(METRIC_EMA_ALPHA_VALUE, 0.3);
  assert.equal(LATENCY_WEIGHT_VALUE, 0.3);
  assert.equal(SUCCESS_RATE_WEIGHT_VALUE, 0.3);
  assert.equal(UPLOAD_BANDWIDTH_WEIGHT_VALUE, 0.2);
  assert.equal(TRUST_SCORE_WEIGHT_VALUE, 0.2);
  assert.equal(URGENT_THRESHOLD_SEGMENTS_VALUE, 2);
  assert.equal(MAX_PARALLEL_DOWNLOADS_VALUE, 3);
});

test("scores fully normalized metrics as one", () => {
  assert.equal(
    calculatePeerScore(
      {
        latencyMs: 0,
        successRate: 1,
        uploadBandwidthBps: 1_000,
        trustScore: 1,
      },
      1_000,
    ),
    1,
  );
});

test("scores zero normalized metrics as zero", () => {
  assert.equal(
    calculatePeerScore(
      {
        latencyMs: 1_000,
        successRate: 0,
        uploadBandwidthBps: 0,
        trustScore: 0,
      },
      1_000,
    ),
    0,
  );
});

test("maps zero latency to a full latency contribution", () => {
  assert.equal(
    calculatePeerScore(
      {
        latencyMs: 0,
        successRate: 0,
        uploadBandwidthBps: 0,
        trustScore: 0,
      },
      1_000,
    ),
    LATENCY_WEIGHT_VALUE,
  );
});

test("maps latency above 1000 ms to no latency contribution", () => {
  assert.equal(
    calculatePeerScore(
      {
        latencyMs: 1_001,
        successRate: 0,
        uploadBandwidthBps: 0,
        trustScore: 0,
      },
      1_000,
    ),
    0,
  );
});

test("clamps success rate to the normalized range", () => {
  const score = (successRate: number): number =>
    calculatePeerScore(
      {
        latencyMs: 1_000,
        successRate,
        uploadBandwidthBps: 0,
        trustScore: 0,
      },
      1_000,
    );

  assert.equal(score(-1), 0);
  assert.equal(score(2), SUCCESS_RATE_WEIGHT_VALUE);
});

test("normalizes upload bandwidth against the candidate maximum", () => {
  const score = (uploadBandwidthBps: number): number =>
    calculatePeerScore(
      {
        latencyMs: 1_000,
        successRate: 0,
        uploadBandwidthBps,
        trustScore: 0,
      },
      1_000,
    );

  approximatelyEqual(score(500), UPLOAD_BANDWIDTH_WEIGHT_VALUE / 2);
  assert.equal(score(2_000), UPLOAD_BANDWIDTH_WEIGHT_VALUE);
  assert.equal(score(-1), 0);
});

test("clamps trust score to the normalized range", () => {
  const score = (trustScore: number): number =>
    calculatePeerScore(
      {
        latencyMs: 1_000,
        successRate: 0,
        uploadBandwidthBps: 0,
        trustScore,
      },
      1_000,
    );

  assert.equal(score(-1), 0);
  assert.equal(score(2), TRUST_SCORE_WEIGHT_VALUE);
});

test("assigns no bandwidth contribution when maximum bandwidth is zero", () => {
  assert.equal(
    calculatePeerScore(
      {
        latencyMs: 1_000,
        successRate: 0,
        uploadBandwidthBps: 1_000,
        trustScore: 0,
      },
      0,
    ),
    0,
  );
});

test("preserves input order for equal Node peer scores", () => {
  const peers = [makePeer("peer-z"), makePeer("peer-a"), makePeer("peer-m")];

  assert.deepEqual(rankedPeerIds(makeScheduler(), peers), [
    "peer-z",
    "peer-a",
    "peer-m",
  ]);
});

test("calculates EMA with the legacy default alpha", () => {
  assert.equal(exponentialMovingAverage(10, 20), 13);
  assert.equal(
    exponentialMovingAverage(10, 20),
    METRIC_EMA_ALPHA_VALUE * 20 + (1 - METRIC_EMA_ALPHA_VALUE) * 10,
  );
});

test("uses the raw metrics for a peer's initial observation", () => {
  const peer = makePeer("peer-a", {
    latencyMs: 125,
    successRate: 0.75,
    uploadBandwidthBps: 750_000,
    trustScore: 0.9,
  });
  const scheduler = makeScheduler();
  scheduler.planSegment(makeContext([peer]));

  assert.deepEqual(scheduler.getPeerMetrics(peer.id), {
    latencyMs: 125,
    successRate: 0.75,
    uploadBandwidthBps: 750_000,
    trustScore: 0.9,
  });
});

test("repeated EMA observations converge toward the observed value", () => {
  let current = 0;
  for (let observation = 0; observation < 20; observation += 1) {
    current = exponentialMovingAverage(current, 1);
  }

  assert.ok(current > 0.99);
  assert.ok(current < 1);
});

test("excludes peers below the minimum trust score", () => {
  const peers = [
    makePeer("below-threshold", {
      trustScore: MINIMUM_TRUST_SCORE_VALUE - Number.EPSILON,
    }),
    makePeer("at-threshold", { trustScore: MINIMUM_TRUST_SCORE_VALUE }),
  ];

  assert.deepEqual(rankedPeerIds(makeScheduler(), peers), ["at-threshold"]);
});

test("excludes the local peer from Node scheduling", () => {
  const peers = [makePeer("self"), makePeer("remote")];

  assert.deepEqual(rankedPeerIds(makeScheduler(), peers, "self"), ["remote"]);
});

test("clamps values within explicit bounds", () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(11, 0, 10), 10);
});
