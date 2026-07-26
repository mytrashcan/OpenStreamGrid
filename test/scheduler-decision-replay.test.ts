import assert from "node:assert/strict";
import test from "node:test";
import type {
  SchedulingPeer,
  SegmentSchedulingContext,
  SegmentSchedulingPlan,
} from "@openstreamgrid/common";
import { WeightedScoreScheduler } from "../peer/src/weighted-score-scheduler.js";
import { TrustLatencyProbeScheduler } from "../sdk/src/trust-latency-probe-scheduler.js";

interface RecordedDecision {
  policy: string;
  mode: SegmentSchedulingPlan["mode"];
  reason: SegmentSchedulingPlan["reason"];
  peerIds: readonly string[];
  rankedPeerIds: readonly string[];
}

const peers: readonly SchedulingPeer[] = [
  {
    id: "peer-a",
    latencyMs: 40,
    successRate: 0.95,
    uploadBandwidthBps: 500_000,
    trustScore: 0.8,
    segments: ["segment.ts"],
  },
  {
    id: "peer-b",
    latencyMs: 120,
    successRate: 0.9,
    uploadBandwidthBps: 2_000_000,
    trustScore: 0.9,
    segments: ["segment.ts"],
  },
  {
    id: "peer-c",
    latencyMs: 15,
    successRate: 0.7,
    uploadBandwidthBps: 1_000_000,
    trustScore: 0.9,
    segments: ["segment.ts"],
  },
  {
    id: "peer-d",
    latencyMs: 30,
    successRate: 0.6,
    uploadBandwidthBps: 250_000,
    trustScore: 0.7,
    segments: ["segment.ts"],
  },
  {
    id: "self",
    latencyMs: 1,
    successRate: 1,
    uploadBandwidthBps: 10_000_000,
    trustScore: 1,
    segments: ["segment.ts"],
  },
];

const fixture: SegmentSchedulingContext = {
  segmentId: "segment.ts",
  segmentsAhead: 3,
  candidates: peers,
  selfPeerId: "self",
  maximumParallelism: 3,
};

const expected: readonly RecordedDecision[] = [
  {
    policy: "weighted-score",
    mode: "single-peer",
    reason: "peer_selected",
    peerIds: ["peer-b"],
    rankedPeerIds: ["peer-b", "peer-c", "peer-a", "peer-d"],
  },
  {
    policy: "trust-latency-probe",
    mode: "parallel-peers",
    reason: "parallel_peer_probe",
    peerIds: ["peer-c", "peer-b", "peer-a"],
    rankedPeerIds: ["peer-c", "peer-b", "peer-a", "peer-d"],
  },
];

const recordDecision = (
  plan: SegmentSchedulingPlan,
): RecordedDecision => ({
  policy: plan.policy,
  mode: plan.mode,
  reason: plan.reason,
  peerIds: plan.peerIds,
  rankedPeerIds: plan.rankedPeers.map(({ peerId }) => peerId),
});

test("replays the recorded Node and browser scheduler decisions", () => {
  const actual = [
    new WeightedScoreScheduler().planSegment(fixture),
    new TrustLatencyProbeScheduler().planSegment(fixture),
  ].map(recordDecision);

  assert.deepEqual(actual, expected);
});
