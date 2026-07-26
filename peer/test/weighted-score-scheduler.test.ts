import assert from "node:assert/strict";
import test from "node:test";
import type {
  Peer,
  SchedulingPeer,
  SegmentScheduler,
  SegmentSchedulingContext,
  SegmentSchedulingPlan,
} from "@openstreamgrid/common";
import { planSegmentSafely } from "@openstreamgrid/common";
import { SegmentCache } from "../src/cache.js";
import { HybridSegmentFetcher } from "../src/fetcher.js";
import { TrafficStats } from "../src/stats.js";
import {
  METRIC_EMA_ALPHA_VALUE,
  schedulerDecisionFor,
  WeightedScoreScheduler,
} from "../src/weighted-score-scheduler.js";

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
  segmentsAhead: 3,
  candidates,
  selfPeerId: "self",
  maximumParallelism: 3,
  ...overrides,
});

test("returns a valid single-peer plan for the highest weighted score", () => {
  const scheduler = new WeightedScoreScheduler();
  const plan = scheduler.planSegment(
    makeContext([
      makePeer("slow", { latencyMs: 900, successRate: 0.5 }),
      makePeer("best", { latencyMs: 20, successRate: 0.99 }),
    ]),
  );

  assert.equal(plan.policy, "weighted-score");
  assert.equal(plan.mode, "single-peer");
  assert.equal(plan.reason, "peer_selected");
  assert.deepEqual(plan.peerIds, ["best"]);
  assert.deepEqual(
    plan.rankedPeers.map(({ peerId, rank }) => ({ peerId, rank })),
    [
      { peerId: "best", rank: 1 },
      { peerId: "slow", rank: 2 },
    ],
  );
});

test("uses Origin for an urgent segment", () => {
  const plan = new WeightedScoreScheduler().planSegment(
    makeContext([makePeer("peer-a")], { segmentsAhead: 1 }),
  );

  assert.deepEqual(plan, {
    policy: "weighted-score",
    mode: "origin",
    peerIds: [],
    rankedPeers: [],
    reason: "urgent_origin",
  });
});

test("uses Origin when the candidate list is empty", () => {
  const plan = new WeightedScoreScheduler().planSegment(makeContext([]));

  assert.equal(plan.mode, "origin");
  assert.equal(plan.reason, "no_candidates");
});

test("uses Origin when every candidate is below the trust threshold", () => {
  const plan = new WeightedScoreScheduler().planSegment(
    makeContext([
      makePeer("untrusted-a", { trustScore: 0.29 }),
      makePeer("untrusted-b", { trustScore: 0 }),
    ]),
  );

  assert.equal(plan.mode, "origin");
  assert.equal(plan.reason, "no_eligible_candidates");
});

test("filters the local peer before ranking", () => {
  const plan = new WeightedScoreScheduler().planSegment(
    makeContext([
      makePeer("self", { latencyMs: 1 }),
      makePeer("remote", { latencyMs: 500 }),
    ]),
  );

  assert.deepEqual(plan.peerIds, ["remote"]);
  assert.deepEqual(
    plan.rankedPeers.map(({ peerId }) => peerId),
    ["remote"],
  );
});

test("filters peers that do not possess the requested segment", () => {
  const plan = new WeightedScoreScheduler().planSegment(
    makeContext([
      makePeer("missing", { latencyMs: 1, segments: ["other.ts"] }),
      makePeer("available", { latencyMs: 900 }),
    ]),
  );

  assert.deepEqual(plan.peerIds, ["available"]);
  assert.deepEqual(
    plan.rankedPeers.map(({ peerId }) => peerId),
    ["available"],
  );
});

test("preserves candidate order when weighted scores are equal", () => {
  const candidates = [
    makePeer("peer-z"),
    makePeer("peer-a"),
    makePeer("peer-m"),
  ];
  const plan = new WeightedScoreScheduler().planSegment(
    makeContext(candidates),
  );

  assert.deepEqual(
    plan.rankedPeers.map(({ peerId }) => peerId),
    ["peer-z", "peer-a", "peer-m"],
  );
});

test("normalizes negative and non-finite metrics into finite scores", () => {
  const plan = new WeightedScoreScheduler().planSegment(
    makeContext([
      makePeer("non-finite", {
        latencyMs: Number.POSITIVE_INFINITY,
        successRate: Number.NaN,
        uploadBandwidthBps: Number.POSITIVE_INFINITY,
      }),
      makePeer("negative", {
        latencyMs: -100,
        successRate: -1,
        uploadBandwidthBps: -1,
      }),
    ]),
  );

  assert.equal(plan.mode, "single-peer");
  assert.ok(
    plan.rankedPeers.every(
      ({ score }) => score !== undefined && Number.isFinite(score),
    ),
  );
});

test("does not mutate candidate snapshots or segment inventories", () => {
  const segments = Object.freeze(["segment.ts"]);
  const peer = Object.freeze(makePeer("peer-a", { segments }));
  const candidates = Object.freeze([peer]);
  const before = JSON.stringify(candidates);

  new WeightedScoreScheduler().planSegment(makeContext(candidates));

  assert.equal(JSON.stringify(candidates), before);
  assert.deepEqual(peer.segments, ["segment.ts"]);
});

test("returns deterministic plans for repeated identical decisions", () => {
  const scheduler = new WeightedScoreScheduler();
  const context = makeContext([makePeer("peer-a"), makePeer("peer-b")]);

  assert.deepEqual(
    scheduler.planSegment(context),
    scheduler.planSegment(context),
  );
});

test("updates observed peer metrics using the legacy EMA", () => {
  const scheduler = new WeightedScoreScheduler();
  scheduler.planSegment(makeContext([makePeer("peer-a")]));
  scheduler.observePeer({
    peerId: "peer-a",
    succeeded: true,
    latencyMs: 200,
    bytes: 25_000,
  });

  assert.deepEqual(scheduler.getPeerMetrics("peer-a"), {
    latencyMs:
      METRIC_EMA_ALPHA_VALUE * 200 +
      (1 - METRIC_EMA_ALPHA_VALUE) * 100,
    successRate:
      METRIC_EMA_ALPHA_VALUE * 1 +
      (1 - METRIC_EMA_ALPHA_VALUE) * 0.8,
    uploadBandwidthBps: 1_000_000,
    trustScore:
      METRIC_EMA_ALPHA_VALUE * 0.8 +
      (1 - METRIC_EMA_ALPHA_VALUE) * 0.8,
  });
});

test("removes stale observation state when peers are reconciled", () => {
  const scheduler = new WeightedScoreScheduler();
  const peerA = makePeer("peer-a");
  const peerB = makePeer("peer-b");
  scheduler.planSegment(makeContext([peerA, peerB]));

  scheduler.reconcilePeers([peerA]);

  assert.notEqual(scheduler.getPeerMetrics("peer-a"), undefined);
  assert.equal(scheduler.getPeerMetrics("peer-b"), undefined);
  scheduler.reset();
  assert.equal(scheduler.getPeerMetrics("peer-a"), undefined);
});

test("rejects invalid scheduler output and returns an Origin fallback", () => {
  const invalidPlans: SegmentSchedulingPlan[] = [
    {
      policy: "invalid-mode",
      mode: "unsupported" as SegmentSchedulingPlan["mode"],
      peerIds: [],
      rankedPeers: [],
      reason: "peer_selected",
    },
    {
      policy: "unknown-peer",
      mode: "single-peer",
      peerIds: ["not-a-candidate"],
      rankedPeers: [],
      reason: "peer_selected",
    },
    {
      policy: "invalid-score",
      mode: "single-peer",
      peerIds: ["peer-a"],
      rankedPeers: [
        {
          peerId: "peer-a",
          score: Number.NaN,
          rank: 1,
          reasons: [],
        },
      ],
      reason: "peer_selected",
    },
  ];
  const warnings: string[] = [];

  for (const invalidPlan of invalidPlans) {
    const scheduler: SegmentScheduler = {
      policyName: invalidPlan.policy,
      planSegment: () => invalidPlan,
    };
    const { plan, warnings: planWarnings } = planSegmentSafely(
      scheduler,
      makeContext([makePeer("peer-a")]),
    );
    warnings.push(...planWarnings.map(({ code }) => code));
    assert.equal(plan.mode, "origin");
    assert.equal(plan.reason, "origin_fallback");
  }
  assert.deepEqual(warnings, [
    "invalid_mode",
    "unknown_peer",
    "non_finite_score",
  ]);
});

test("records scheduler decision dimensions", () => {
  const candidates = [makePeer("peer-a"), makePeer("peer-b")];
  const plan = new WeightedScoreScheduler().planSegment(
    makeContext(candidates),
  );

  assert.deepEqual(schedulerDecisionFor(plan, candidates.length), {
    policy: "weighted-score",
    mode: "single-peer",
    reason: "peer_selected",
    candidateCount: 2,
    eligibleCount: 2,
    selectedPeerCount: 1,
  });
});

const fetchPeer: Peer = {
  id: "peer-a",
  address: "http://peer-a:9090",
  segments: ["segment.ts"],
  joinedAt: "2026-07-26T00:00:00.000Z",
  lastSeenAt: "2026-07-26T00:00:00.000Z",
  latencyMs: 10,
  successRate: 1,
  trustScore: 1,
  uploadBandwidthBps: 1_000_000,
};

const peerPlan = (policy: string): SegmentSchedulingPlan => ({
  policy,
  mode: "single-peer",
  peerIds: [fetchPeer.id],
  rankedPeers: [
    {
      peerId: fetchPeer.id,
      rank: 1,
      reasons: ["test"],
    },
  ],
  reason: "peer_selected",
});

const createFetcher = (scheduler: SegmentScheduler): HybridSegmentFetcher =>
  new HybridSegmentFetcher({
    selfPeerId: "self",
    originBaseUrl: new URL("http://origin:8080/hls/"),
    cache: new SegmentCache(1_000),
    directory: {
      async listPeers(): Promise<Peer[]> {
        return [fetchPeer];
      },
      async reportFailure(): Promise<void> {},
    },
    verifier: {
      async verify(): Promise<boolean> {
        return true;
      },
    },
    stats: new TrafficStats(),
    scheduler,
    fetchImpl: async () => new Response("from-peer"),
  });

test("contains throwing peer observations without breaking fetch", async (context) => {
  context.mock.method(console, "warn", () => {});
  const scheduler: SegmentScheduler = {
    policyName: "throwing-observer",
    planSegment(): SegmentSchedulingPlan {
      return peerPlan(this.policyName);
    },
    observePeer(): void {
      throw new Error("observation failed");
    },
  };

  const result = await createFetcher(scheduler).fetchSegment("segment.ts", 3);

  assert.equal(result.source, "p2p");
  assert.equal(result.data.toString(), "from-peer");
});

test("routes urgent uncached segments through the injected scheduler", async () => {
  let plannedSegmentsAhead: number | undefined;
  const scheduler: SegmentScheduler = {
    policyName: "custom-urgent",
    planSegment(segmentContext): SegmentSchedulingPlan {
      plannedSegmentsAhead = segmentContext.segmentsAhead;
      return peerPlan(this.policyName);
    },
  };

  const result = await createFetcher(scheduler).fetchSegment("segment.ts", 0);

  assert.equal(plannedSegmentsAhead, 0);
  assert.equal(result.source, "p2p");
});

test("contains throwing peer reconciliation without breaking fetch", async (context) => {
  context.mock.method(console, "warn", () => {});
  const scheduler: SegmentScheduler = {
    policyName: "throwing-reconciler",
    planSegment(): SegmentSchedulingPlan {
      return peerPlan(this.policyName);
    },
    reconcilePeers(): void {
      throw new Error("reconciliation failed");
    },
  };

  const result = await createFetcher(scheduler).fetchSegment("segment.ts", 3);

  assert.equal(result.source, "p2p");
  assert.equal(result.data.toString(), "from-peer");
});

test("resets the scheduler when the fetcher stops", () => {
  let resets = 0;
  const scheduler: SegmentScheduler = {
    policyName: "resettable",
    planSegment(): SegmentSchedulingPlan {
      return peerPlan(this.policyName);
    },
    reset(): void {
      resets += 1;
    },
  };
  const fetcher = createFetcher(scheduler);

  fetcher.stop();
  fetcher.stop();

  assert.equal(resets, 1);
});

test("contains scheduler reset failures during stop", (context) => {
  context.mock.method(console, "warn", () => {});
  const scheduler: SegmentScheduler = {
    policyName: "throwing-reset",
    planSegment(): SegmentSchedulingPlan {
      return peerPlan(this.policyName);
    },
    reset(): void {
      throw new Error("reset failed");
    },
  };
  const fetcher = createFetcher(scheduler);

  assert.doesNotThrow(() => fetcher.stop());
});
