import assert from "node:assert/strict";
import test from "node:test";
import type {
  SchedulingPeer,
  SegmentScheduler,
  SegmentSchedulingContext,
  SegmentSchedulingPlan,
} from "@openstreamgrid/common";
import { validateSchedulerPlan } from "@openstreamgrid/common";
import { DeadlineAwareScheduler } from "../src/deadline-aware-scheduler.js";
import { OriginLatencyEstimator } from "../src/origin-latency-estimator.js";

const candidate: SchedulingPeer = {
  id: "peer-a",
  latencyMs: 50,
  successRate: 1,
  uploadBandwidthBps: 1_000_000,
  trustScore: 1,
  segments: ["segment.ts"],
};

const peerPlan = (policy: string): SegmentSchedulingPlan => ({
  policy,
  mode: "single-peer",
  peerIds: [candidate.id],
  rankedPeers: [
    {
      peerId: candidate.id,
      rank: 1,
      reasons: ["base"],
    },
  ],
  reason: "peer_selected",
});

const makeBaseScheduler = (
  planSegment: SegmentScheduler["planSegment"] = () => peerPlan("base"),
): SegmentScheduler => ({
  policyName: "base",
  planSegment,
});

const makeContext = (
  slackMs: number,
  kind: NonNullable<
    SegmentSchedulingContext["deadline"]
  >["kind"] = "player-derived",
): SegmentSchedulingContext => ({
  segmentId: "segment.ts",
  deadline: {
    kind,
    slackMs,
    segmentDurationMs: 2_000,
    bufferAheadMs: 4_000,
  },
  candidates: [candidate],
  selfPeerId: "self",
  maximumParallelism: 1,
});

const makeScheduler = (
  overrides: Partial<ConstructorParameters<typeof DeadlineAwareScheduler>[0]> = {},
): DeadlineAwareScheduler =>
  new DeadlineAwareScheduler({
    baseScheduler: makeBaseScheduler(),
    originLatencyEstimator: new OriginLatencyEstimator(),
    ...overrides,
  });

test("delegates unknown deadlines to the base scheduler", () => {
  let receivedContext: SegmentSchedulingContext | undefined;
  const context = makeContext(1_000, "unknown");
  const scheduler = makeScheduler({
    baseScheduler: makeBaseScheduler((baseContext) => {
      receivedContext = baseContext;
      return peerPlan("base");
    }),
  });

  const plan = scheduler.planSegment(context);

  assert.equal(receivedContext, context);
  assert.equal(plan.mode, "single-peer");
  assert.deepEqual(plan.peerIds, ["peer-a"]);
  assert.equal(plan.reason, "deadline_unknown_legacy");
  assert.deepEqual(plan.execution, {
    strategy: "legacy-p2p-first",
    deadlineSlackMs: 1_000,
  });
});

test("uses Origin when the deadline cannot cover estimated Origin latency", () => {
  const plan = makeScheduler().planSegment(makeContext(700));

  assert.deepEqual(plan, {
    policy: "deadline-aware",
    mode: "origin",
    peerIds: [],
    rankedPeers: [],
    reason: "deadline_origin",
    execution: {
      strategy: "origin-only",
      deadlineSlackMs: 700,
    },
  });
});

test("hedges tight deadlines at the bounded latest safe Origin start", () => {
  const plan = makeScheduler().planSegment(makeContext(3_000));

  assert.equal(plan.mode, "single-peer");
  assert.equal(plan.reason, "deadline_hedged");
  assert.deepEqual(plan.execution, {
    strategy: "hedged-origin",
    peerAttemptBudgetMs: 1_500,
    originHedgeDelayMs: 1_500,
    deadlineSlackMs: 3_000,
  });
});

test("keeps the base P2P plan when the deadline is relaxed", () => {
  const plan = makeScheduler().planSegment(makeContext(4_000));

  assert.equal(plan.mode, "single-peer");
  assert.deepEqual(plan.peerIds, ["peer-a"]);
  assert.equal(plan.reason, "deadline_relaxed_p2p");
  assert.deepEqual(plan.execution, {
    strategy: "legacy-p2p-first",
    deadlineSlackMs: 4_000,
  });
});

test("contains invalid base plans behind an Origin fallback", () => {
  const scheduler = makeScheduler({
    baseScheduler: makeBaseScheduler(() => {
      return {
        ...peerPlan("base"),
        peerIds: ["unknown-peer"],
      };
    }),
  });

  const plan = scheduler.planSegment(makeContext(2_000, "unknown"));

  assert.equal(plan.mode, "origin");
  assert.equal(plan.reason, "origin_fallback");
  assert.deepEqual(plan.execution, {
    strategy: "origin-only",
    deadlineSlackMs: 2_000,
  });
});

test("does not mutate frozen scheduling inputs and is deterministic", () => {
  const context = makeContext(2_000);
  Object.freeze(context.deadline);
  Object.freeze(context.candidates);
  Object.freeze(context);
  const scheduler = makeScheduler();

  const first = scheduler.planSegment(context);
  const second = scheduler.planSegment(context);

  assert.deepEqual(first, second);
  assert.deepEqual(validateSchedulerPlan(first, scheduler, context), []);
  assert.deepEqual(context.candidates, [candidate]);
  assert.equal(context.deadline?.slackMs, 2_000);
});

test("keeps Origin latency estimates isolated between instances", () => {
  const firstEstimator = new OriginLatencyEstimator({ alpha: 1 });
  const secondEstimator = new OriginLatencyEstimator({ alpha: 1 });
  const first = makeScheduler({ originLatencyEstimator: firstEstimator });
  const second = makeScheduler({ originLatencyEstimator: secondEstimator });
  const context = makeContext(1_000);

  firstEstimator.observe(2_000);

  assert.equal(first.planSegment(context).reason, "deadline_origin");
  assert.equal(second.planSegment(context).reason, "deadline_hedged");
  assert.equal(secondEstimator.estimateMs, 500);
});
