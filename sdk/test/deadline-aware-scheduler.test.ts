import assert from "node:assert/strict";
import test from "node:test";
import type {
  SchedulingPeer,
  SegmentSchedulingContext,
} from "@openstreamgrid/common";
import { DeadlineAwareScheduler } from "../src/deadline-aware-scheduler.js";

const peer: SchedulingPeer = {
  id: "peer-a",
  latencyMs: 50,
  successRate: 1,
  uploadBandwidthBps: 1_000_000,
  trustScore: 1,
  segments: ["segment.ts"],
};

const context = (
  deadline: SegmentSchedulingContext["deadline"],
): SegmentSchedulingContext => ({
  segmentId: "segment.ts",
  ...(deadline === undefined ? {} : { deadline }),
  candidates: [peer],
  selfPeerId: "self",
  maximumParallelism: 3,
});

test("wraps the trust/latency scheduler by default", () => {
  const plan = new DeadlineAwareScheduler().planSegment(context(undefined));

  assert.equal(plan.policy, "deadline-aware");
  assert.equal(plan.mode, "parallel-peers");
  assert.deepEqual(plan.peerIds, ["peer-a"]);
  assert.equal(plan.reason, "deadline_unknown_legacy");
});

test("adds browser-safe hedged execution hints for a tight deadline", () => {
  const plan = new DeadlineAwareScheduler().planSegment(
    context({
      kind: "playlist-derived",
      slackMs: 1_700,
    }),
  );

  assert.equal(plan.reason, "deadline_hedged");
  assert.deepEqual(plan.execution, {
    strategy: "hedged-origin",
    peerAttemptBudgetMs: 1_000,
    originHedgeDelayMs: 1_000,
    deadlineSlackMs: 1_700,
  });
});
