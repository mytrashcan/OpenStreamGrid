import type {
  PeerFetchObservation,
  SchedulerDecision,
  SchedulingPeer,
  SegmentScheduler,
  SegmentSchedulingContext,
  SegmentSchedulingPlan,
} from "@openstreamgrid/common";

const MINIMUM_TRUST_SCORE = 0.3;
const METRIC_EMA_ALPHA = 0.3;
const DEFAULT_URGENT_THRESHOLD_SEGMENTS = 2;
const DEFAULT_MAX_PARALLEL_DOWNLOADS = 3;

const LATENCY_WEIGHT = 0.3;
const SUCCESS_RATE_WEIGHT = 0.3;
const UPLOAD_BANDWIDTH_WEIGHT = 0.2;
const TRUST_SCORE_WEIGHT = 0.2;

export const MINIMUM_TRUST_SCORE_VALUE = MINIMUM_TRUST_SCORE;
export const METRIC_EMA_ALPHA_VALUE = METRIC_EMA_ALPHA;
export const LATENCY_WEIGHT_VALUE = LATENCY_WEIGHT;
export const SUCCESS_RATE_WEIGHT_VALUE = SUCCESS_RATE_WEIGHT;
export const UPLOAD_BANDWIDTH_WEIGHT_VALUE = UPLOAD_BANDWIDTH_WEIGHT;
export const TRUST_SCORE_WEIGHT_VALUE = TRUST_SCORE_WEIGHT;
export const URGENT_THRESHOLD_SEGMENTS_VALUE =
  DEFAULT_URGENT_THRESHOLD_SEGMENTS;
export const MAX_PARALLEL_DOWNLOADS_VALUE = DEFAULT_MAX_PARALLEL_DOWNLOADS;

export const clamp = (
  value: number,
  minimum: number,
  maximum: number,
): number => Math.min(maximum, Math.max(minimum, value));

/** Quality measurements used to rank a potential segment source. */
export interface PeerQualityMetrics {
  latencyMs: number;
  successRate: number;
  uploadBandwidthBps: number;
  trustScore: number;
}

/** Updates a metric using the selector's exponential moving average. */
export const exponentialMovingAverage = (
  previous: number,
  observed: number,
): number => METRIC_EMA_ALPHA * observed + (1 - METRIC_EMA_ALPHA) * previous;

/** Produces a normalized weighted quality score for a peer. */
export const calculatePeerScore = (
  metrics: PeerQualityMetrics,
  maximumUploadBandwidthBps: number,
): number => {
  const latencyScore = 1 - Math.min(Math.max(metrics.latencyMs, 0) / 1_000, 1);
  const successRateScore = clamp(metrics.successRate, 0, 1);
  const uploadBandwidthScore =
    maximumUploadBandwidthBps <= 0
      ? 0
      : clamp(metrics.uploadBandwidthBps / maximumUploadBandwidthBps, 0, 1);
  const trustScore = clamp(metrics.trustScore, 0, 1);
  return (
    LATENCY_WEIGHT * latencyScore +
    SUCCESS_RATE_WEIGHT * successRateScore +
    UPLOAD_BANDWIDTH_WEIGHT * uploadBandwidthScore +
    TRUST_SCORE_WEIGHT * trustScore
  );
};

interface WeightedScoreSchedulerOptions {
  urgentThresholdSegments?: number;
}

interface RankedCandidate {
  peer: SchedulingPeer;
  metrics: PeerQualityMetrics;
  score: number;
  inputIndex: number;
}

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

const finiteOrZero = (value: number): number =>
  Number.isFinite(value) ? value : 0;

/**
 * Stateful Node scheduling policy using the legacy weighted peer score.
 *
 * The scheduler owns only peer-quality observations and performs no I/O.
 */
export class WeightedScoreScheduler implements SegmentScheduler {
  readonly policyName = "weighted-score";

  private readonly urgentThresholdSegments: number;
  private readonly peerMetrics = new Map<string, PeerQualityMetrics>();
  private readonly peerTrustScores = new Map<string, number>();

  constructor(options: WeightedScoreSchedulerOptions = {}) {
    this.urgentThresholdSegments =
      options.urgentThresholdSegments ?? DEFAULT_URGENT_THRESHOLD_SEGMENTS;
  }

  planSegment(context: SegmentSchedulingContext): SegmentSchedulingPlan {
    if (
      context.segmentsAhead !== undefined &&
      context.segmentsAhead < this.urgentThresholdSegments
    ) {
      return originPlan(this.policyName, "urgent_origin");
    }
    if (context.candidates.length === 0) {
      return originPlan(this.policyName, "no_candidates");
    }

    const candidates = context.candidates
      .map((peer, inputIndex) => ({ peer, inputIndex }))
      .filter(
        ({ peer }) =>
          peer.id !== context.selfPeerId &&
          peer.trustScore >= MINIMUM_TRUST_SCORE &&
          (context.segmentId.length === 0 ||
            peer.segments.includes(context.segmentId)),
      )
      .map(({ peer, inputIndex }) => ({
        peer,
        inputIndex,
        metrics: this.metricsFor(peer),
      }))
      .filter(({ metrics }) => metrics.trustScore >= MINIMUM_TRUST_SCORE);

    if (candidates.length === 0) {
      return originPlan(this.policyName, "no_eligible_candidates");
    }

    const maximumUploadBandwidthBps = Math.max(
      0,
      ...candidates.map(({ metrics }) => metrics.uploadBandwidthBps),
    );
    const ranked: RankedCandidate[] = candidates
      .map(({ peer, inputIndex, metrics }) => ({
        peer,
        inputIndex,
        metrics,
        score: calculatePeerScore(metrics, maximumUploadBandwidthBps),
      }))
      .sort(
        (left, right) =>
          right.score - left.score ||
          (left.peer.originalIndex ?? left.inputIndex) -
            (right.peer.originalIndex ?? right.inputIndex),
      );
    const selected = ranked[0];
    if (!selected) {
      return originPlan(this.policyName, "no_eligible_candidates");
    }

    return {
      policy: this.policyName,
      mode: "single-peer",
      peerIds: [selected.peer.id],
      rankedPeers: ranked.map(({ peer, score }, index) => ({
        peerId: peer.id,
        score,
        rank: index + 1,
        reasons: ["trusted", "segment_available", "weighted_score"],
      })),
      reason: "peer_selected",
    };
  }

  observePeer(observation: PeerFetchObservation): void {
    const previous = this.peerMetrics.get(observation.peerId);
    if (!previous) return;

    const latencyMs = Math.max(0, finiteOrZero(observation.latencyMs));
    const bytes = Math.max(0, finiteOrZero(observation.bytes));
    const elapsedSeconds = Math.max(latencyMs, 1) / 1_000;
    const observed: PeerQualityMetrics = {
      latencyMs,
      successRate: observation.succeeded ? 1 : 0,
      uploadBandwidthBps: observation.succeeded
        ? (bytes * 8) / elapsedSeconds
        : 0,
      trustScore:
        observation.failureReason === "integrity"
          ? 0
          : (this.peerTrustScores.get(observation.peerId) ??
            previous.trustScore),
    };
    this.peerMetrics.set(
      observation.peerId,
      this.smoothMetrics(previous, observed),
    );
  }

  reconcilePeers(peers: readonly SchedulingPeer[]): void {
    const currentPeerIds = new Set(peers.map((peer) => peer.id));
    for (const peerId of this.peerMetrics.keys()) {
      if (!currentPeerIds.has(peerId)) {
        this.peerMetrics.delete(peerId);
        this.peerTrustScores.delete(peerId);
      }
    }
  }

  reset(): void {
    this.peerMetrics.clear();
    this.peerTrustScores.clear();
  }

  /** Returns an isolated metric snapshot for tests and diagnostics. */
  getPeerMetrics(peerId: string): PeerQualityMetrics | undefined {
    const metrics = this.peerMetrics.get(peerId);
    return metrics ? { ...metrics } : undefined;
  }

  private metricsFor(peer: SchedulingPeer): PeerQualityMetrics {
    const observed: PeerQualityMetrics = {
      latencyMs: Math.max(0, finiteOrZero(peer.latencyMs)),
      successRate: clamp(finiteOrZero(peer.successRate), 0, 1),
      uploadBandwidthBps: Math.max(
        0,
        finiteOrZero(peer.uploadBandwidthBps),
      ),
      trustScore: clamp(finiteOrZero(peer.trustScore), 0, 1),
    };
    this.peerTrustScores.set(peer.id, observed.trustScore);
    const previous = this.peerMetrics.get(peer.id);
    if (!previous) {
      this.peerMetrics.set(peer.id, observed);
      return observed;
    }
    const smoothed = this.smoothMetrics(previous, observed);
    this.peerMetrics.set(peer.id, smoothed);
    return smoothed;
  }

  private smoothMetrics(
    previous: PeerQualityMetrics,
    observed: PeerQualityMetrics,
  ): PeerQualityMetrics {
    return {
      latencyMs: exponentialMovingAverage(
        previous.latencyMs,
        observed.latencyMs,
      ),
      successRate: exponentialMovingAverage(
        previous.successRate,
        observed.successRate,
      ),
      uploadBandwidthBps: exponentialMovingAverage(
        previous.uploadBandwidthBps,
        observed.uploadBandwidthBps,
      ),
      trustScore: exponentialMovingAverage(
        previous.trustScore,
        observed.trustScore,
      ),
    };
  }
}

/** Builds the observable counter dimensions for one scheduling plan. */
export const schedulerDecisionFor = (
  plan: SegmentSchedulingPlan,
  candidateCount: number,
): SchedulerDecision => ({
  policy: plan.policy,
  mode: plan.mode,
  reason: plan.reason,
  candidateCount,
  eligibleCount: plan.rankedPeers.length,
  selectedPeerCount: plan.peerIds.length,
});
