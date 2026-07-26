import type {
  SchedulingPeer,
  SegmentScheduler,
  SegmentSchedulingContext,
  SegmentSchedulingPlan,
} from "@openstreamgrid/common";

export const MAX_PARALLEL_PEER_PROBES = 3;

type TrustLatencyMetrics = Pick<
  SchedulingPeer,
  "trustScore" | "latencyMs"
>;

/** Preserves the browser SDK's legacy trust and latency ordering. */
export const compareTrustAndLatency = (
  left: TrustLatencyMetrics,
  right: TrustLatencyMetrics,
): number =>
  right.trustScore - left.trustScore ||
  left.latencyMs - right.latencyMs;

const originPlan = (
  policy: string,
  reason: SegmentSchedulingPlan["reason"],
): SegmentSchedulingPlan => ({
  policy,
  mode: "origin",
  peerIds: [],
  rankedPeers: [],
  reason,
});

/**
 * Stateless browser scheduling policy using tracker trust and latency data.
 *
 * The scheduler only produces a plan. The Hls.js plugin remains responsible
 * for parallel probes, cancellation, transport, and Origin fallback.
 */
export class TrustLatencyProbeScheduler implements SegmentScheduler {
  readonly policyName = "trust-latency-probe";

  planSegment(context: SegmentSchedulingContext): SegmentSchedulingPlan {
    if (context.candidates.length === 0) {
      return originPlan(this.policyName, "no_candidates");
    }

    const ranked = context.candidates
      .filter((peer) => peer.id !== context.selfPeerId)
      .map((peer, inputIndex) => ({ peer, inputIndex }))
      .sort(
        (left, right) =>
          compareTrustAndLatency(left.peer, right.peer) ||
          (left.peer.originalIndex ?? left.inputIndex) -
            (right.peer.originalIndex ?? right.inputIndex),
      );

    if (ranked.length === 0) {
      return originPlan(this.policyName, "no_eligible_candidates");
    }

    const parallelism = Math.max(
      0,
      Math.min(MAX_PARALLEL_PEER_PROBES, context.maximumParallelism),
    );
    const peerIds = ranked
      .slice(0, parallelism)
      .map(({ peer }) => peer.id);
    if (peerIds.length === 0) {
      return originPlan(this.policyName, "no_eligible_candidates");
    }

    return {
      policy: this.policyName,
      mode: "parallel-peers",
      peerIds,
      rankedPeers: ranked.map(({ peer }, index) => ({
        peerId: peer.id,
        rank: index + 1,
        reasons: ["trusted", "latency_ranked", "parallel_probe"],
      })),
      reason: "parallel_peer_probe",
    };
  }

  observePeer(): void {}

  reconcilePeers(): void {}

  reset(): void {}
}
