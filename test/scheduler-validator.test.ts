import assert from "node:assert/strict";
import test from "node:test";
import {
  planBatch,
  planSegmentSafely,
  validateSchedulerPlan,
  type SchedulingPeer,
  type SegmentScheduler,
  type SegmentSchedulingContext,
  type SegmentSchedulingPlan,
} from "@openstreamgrid/common";

const peer = (
  id: string,
  segments: readonly string[] = ["segment.ts"],
): SchedulingPeer => ({
  id,
  latencyMs: 10,
  successRate: 1,
  uploadBandwidthBps: 1_000_000,
  trustScore: 1,
  segments,
});

const candidates = [
  peer("peer-a"),
  peer("peer-b"),
  peer("peer-missing", ["other.ts"]),
  peer("self"),
] as const;

const context: SegmentSchedulingContext = {
  segmentId: "segment.ts",
  segmentsAhead: 3,
  candidates,
  selfPeerId: "self",
  maximumParallelism: 2,
};

const scheduler = { policyName: "test-policy" };

const validPlan = (
  overrides: Partial<SegmentSchedulingPlan> = {},
): SegmentSchedulingPlan => ({
  policy: scheduler.policyName,
  mode: "single-peer",
  peerIds: ["peer-a"],
  rankedPeers: [
    {
      peerId: "peer-a",
      score: 1,
      rank: 1,
      reasons: ["test"],
    },
  ],
  reason: "peer_selected",
  ...overrides,
});

const codesFor = (plan: unknown): string[] =>
  validateSchedulerPlan(plan, scheduler, context).map(({ code }) => code);

test("accepts a valid scheduler plan", () => {
  assert.deepEqual(validateSchedulerPlan(validPlan(), scheduler, context), []);
});

test("rejects a plan that is not a non-null object", () => {
  assert.deepEqual(codesFor(null), ["invalid_plan"]);
  assert.deepEqual(codesFor([]), ["invalid_plan"]);
});

test("validates mode and scheduler policy", () => {
  assert.deepEqual(
    codesFor(validPlan({
      policy: "other-policy",
      mode: "unsupported" as SegmentSchedulingPlan["mode"],
    })),
    ["invalid_mode", "policy_mismatch"],
  );
});

test("validates peer counts for every plan mode", () => {
  assert.ok(
    codesFor(validPlan({ mode: "origin", peerIds: ["peer-a"] })).includes(
      "invalid_peer_count",
    ),
  );
  assert.ok(
    codesFor(validPlan({ mode: "single-peer", peerIds: [] })).includes(
      "invalid_peer_count",
    ),
  );
  assert.ok(
    codesFor(validPlan({ mode: "parallel-peers", peerIds: [] })).includes(
      "invalid_peer_count",
    ),
  );
});

test("rejects duplicate selected peers", () => {
  assert.ok(
    codesFor(
      validPlan({
        mode: "parallel-peers",
        peerIds: ["peer-a", "peer-a"],
      }),
    ).includes("duplicate_peer"),
  );
});

test("rejects unknown selected and ranked peers", () => {
  assert.deepEqual(
    codesFor(
      validPlan({
        peerIds: ["unknown"],
        rankedPeers: [
          {
            peerId: "also-unknown",
            rank: 1,
            reasons: [],
          },
        ],
      }),
    ).filter((code) => code === "unknown_peer"),
    ["unknown_peer", "unknown_peer"],
  );
});

test("rejects the local peer in selected and ranked peers", () => {
  assert.deepEqual(
    codesFor(
      validPlan({
        peerIds: ["self"],
        rankedPeers: [
          {
            peerId: "self",
            rank: 1,
            reasons: [],
          },
        ],
      }),
    ).filter((code) => code === "self_peer"),
    ["self_peer", "self_peer"],
  );
});

test("rejects a selected peer without the requested segment", () => {
  assert.ok(
    codesFor(validPlan({ peerIds: ["peer-missing"] })).includes(
      "segment_unavailable",
    ),
  );
});

test("rejects plans that exceed maximum parallelism", () => {
  assert.ok(
    codesFor(
      validPlan({
        mode: "parallel-peers",
        peerIds: ["peer-a", "peer-b", "peer-missing"],
      }),
    ).includes("parallelism_exceeded"),
  );
});

test("validates every ranked peer rank and optional score", () => {
  const codes = codesFor(
    validPlan({
      rankedPeers: [
        {
          peerId: "peer-a",
          score: Number.NaN,
          rank: 1,
          reasons: [],
        },
        {
          peerId: "peer-b",
          rank: 1,
          reasons: [],
        },
        {
          peerId: "peer-missing",
          rank: 4,
          reasons: [],
        },
      ],
    }),
  );

  assert.ok(codes.includes("non_finite_score"));
  assert.equal(codes.filter((code) => code === "invalid_rank").length, 2);
});

test("reports every independently detectable plan failure", () => {
  const codes = codesFor({
    policy: "wrong",
    mode: "parallel-peers",
    peerIds: ["self", "peer-missing", "self"],
    rankedPeers: [
      { peerId: "unknown", score: Number.POSITIVE_INFINITY, rank: 0 },
    ],
    reason: "parallel_peer_probe",
  });

  for (const expected of [
    "policy_mismatch",
    "duplicate_peer",
    "self_peer",
    "segment_unavailable",
    "parallelism_exceeded",
    "unknown_peer",
    "invalid_rank",
    "non_finite_score",
  ]) {
    assert.ok(codes.includes(expected), `Expected ${expected} in ${codes.join(", ")}`);
  }
});

test("contains scheduler exceptions behind an Origin fallback", () => {
  const throwingScheduler: SegmentScheduler = {
    policyName: "throwing",
    planSegment(): SegmentSchedulingPlan {
      throw new Error("custom scheduler failed");
    },
  };

  const result = planSegmentSafely(throwingScheduler, context);

  assert.equal(result.plan.mode, "origin");
  assert.equal(result.plan.reason, "origin_fallback");
  assert.deepEqual(result.warnings.map(({ code }) => code), ["invalid_plan"]);
  assert.match(result.warnings[0]?.message ?? "", /custom scheduler failed/);
});

test("plans deduplicated batch requests in reversed, distinct-peer waves", () => {
  const plannedSegments: string[] = [];
  const batchScheduler: SegmentScheduler = {
    policyName: "batch-test",
    planSegment(batchContext): SegmentSchedulingPlan {
      plannedSegments.push(batchContext.segmentId);
      const selected = batchContext.candidates.find((candidate) =>
        candidate.segments.includes(batchContext.segmentId),
      );
      if (!selected) {
        return {
          policy: this.policyName,
          mode: "origin",
          peerIds: [],
          rankedPeers: [],
          reason: "no_eligible_candidates",
        };
      }
      return {
        policy: this.policyName,
        mode: "single-peer",
        peerIds: [selected.id],
        rankedPeers: [
          {
            peerId: selected.id,
            rank: 1,
            reasons: ["test"],
          },
        ],
        reason: "peer_selected",
      };
    },
  };
  const batchCandidates = [
    peer("peer-a", ["one.ts", "two.ts", "three.ts"]),
    peer("peer-b", ["one.ts", "two.ts", "three.ts"]),
  ];

  const result = planBatch(
    batchScheduler,
    [
      { segmentId: "one.ts" },
      { segmentId: "two.ts" },
      { segmentId: "two.ts" },
      { segmentId: "three.ts" },
    ],
    batchCandidates,
    "self",
    2,
  );

  assert.deepEqual(plannedSegments, ["three.ts", "two.ts", "one.ts"]);
  assert.deepEqual(result.assignments, [
    { segmentId: "three.ts", peerId: "peer-a", mode: "single-peer" },
    { segmentId: "two.ts", peerId: "peer-b", mode: "single-peer" },
    { segmentId: "one.ts", peerId: "peer-a", mode: "single-peer" },
  ]);
  assert.deepEqual(result.warnings, []);
});

test("preserves segment-scoped validation warnings from batch planning", () => {
  const invalidScheduler: SegmentScheduler = {
    policyName: "invalid-batch",
    planSegment(): SegmentSchedulingPlan {
      return {
        policy: this.policyName,
        mode: "single-peer",
        peerIds: ["unknown-peer"],
        rankedPeers: [],
        reason: "peer_selected",
      };
    },
  };

  const result = planBatch(
    invalidScheduler,
    [{ segmentId: "one.ts" }, { segmentId: "two.ts" }],
    [peer("peer-a", ["one.ts", "two.ts"])],
    "self",
    1,
  );

  assert.deepEqual(result.assignments, [
    { segmentId: "two.ts", mode: "origin" },
    { segmentId: "one.ts", mode: "origin" },
  ]);
  assert.deepEqual(
    result.warnings.map(({ segmentId, code }) => ({ segmentId, code })),
    [
      { segmentId: "two.ts", code: "unknown_peer" },
      { segmentId: "one.ts", code: "unknown_peer" },
    ],
  );
});
