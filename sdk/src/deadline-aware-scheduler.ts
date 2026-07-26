import {
  planSegmentSafely,
  type PeerFetchObservation,
  type SchedulingPeer,
  type SchedulingReason,
  type SegmentScheduler,
  type SegmentSchedulingContext,
  type SegmentSchedulingPlan,
} from "@openstreamgrid/common";
import { TrustLatencyProbeScheduler } from "./trust-latency-probe-scheduler.js";

const DEFAULT_ORIGIN_LATENCY_ESTIMATE_MS = 500;
const DEFAULT_SAFETY_MARGIN_MS = 200;
const DEFAULT_MAXIMUM_PEER_PROBE_WINDOW_MS = 3_000;
const DEFAULT_MAXIMUM_HEDGE_DELAY_MS = 1_500;

/** Browser-safe structural contract for an Origin latency estimate. */
export interface OriginLatencyEstimate {
  readonly estimateMs: number;
  reset?(): void;
}

export interface DeadlineAwareSchedulerOptions {
  baseScheduler?: SegmentScheduler;
  originLatencyEstimator?: OriginLatencyEstimate;
  safetyMarginMs?: number;
  maximumPeerProbeWindowMs?: number;
  maximumHedgeDelayMs?: number;
}

const requireNonNegativeFinite = (value: number, name: string): void => {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite, non-negative number`);
  }
};

const executionSlack = (slackMs: number | undefined): number | undefined =>
  slackMs !== undefined && Number.isFinite(slackMs)
    ? Math.max(0, slackMs)
    : undefined;

const originPlan = (
  reason: SchedulingReason,
  deadlineSlackMs?: number,
): SegmentSchedulingPlan => {
  const deadlineExecutionSlackMs = executionSlack(deadlineSlackMs);
  return {
    policy: "deadline-aware",
    mode: "origin",
    peerIds: [],
    rankedPeers: [],
    reason,
    execution: {
      strategy: "origin-only",
      ...(deadlineExecutionSlackMs === undefined
        ? {}
        : { deadlineSlackMs: deadlineExecutionSlackMs }),
    },
  };
};

const copyPlan = (
  plan: SegmentSchedulingPlan,
  reason: SchedulingReason,
  execution: NonNullable<SegmentSchedulingPlan["execution"]>,
): SegmentSchedulingPlan => ({
  policy: "deadline-aware",
  mode: plan.mode,
  peerIds: [...plan.peerIds],
  rankedPeers: plan.rankedPeers.map((peer) => ({
    ...peer,
    reasons: [...peer.reasons],
  })),
  reason,
  execution,
});

/**
 * Adds deadline-derived execution hints to the browser trust/latency policy.
 */
export class DeadlineAwareScheduler implements SegmentScheduler {
  readonly policyName = "deadline-aware";

  private readonly baseScheduler: SegmentScheduler;
  private readonly originLatencyEstimator: OriginLatencyEstimate;
  private readonly safetyMarginMs: number;
  private readonly maximumPeerProbeWindowMs: number;
  private readonly maximumHedgeDelayMs: number;

  constructor(options: DeadlineAwareSchedulerOptions = {}) {
    this.baseScheduler =
      options.baseScheduler ?? new TrustLatencyProbeScheduler();
    this.originLatencyEstimator =
      options.originLatencyEstimator ?? {
        estimateMs: DEFAULT_ORIGIN_LATENCY_ESTIMATE_MS,
      };
    this.safetyMarginMs =
      options.safetyMarginMs ?? DEFAULT_SAFETY_MARGIN_MS;
    this.maximumPeerProbeWindowMs =
      options.maximumPeerProbeWindowMs ??
      DEFAULT_MAXIMUM_PEER_PROBE_WINDOW_MS;
    this.maximumHedgeDelayMs =
      options.maximumHedgeDelayMs ?? DEFAULT_MAXIMUM_HEDGE_DELAY_MS;

    requireNonNegativeFinite(this.safetyMarginMs, "safetyMarginMs");
    requireNonNegativeFinite(
      this.maximumPeerProbeWindowMs,
      "maximumPeerProbeWindowMs",
    );
    requireNonNegativeFinite(
      this.maximumHedgeDelayMs,
      "maximumHedgeDelayMs",
    );
  }

  planSegment(context: SegmentSchedulingContext): SegmentSchedulingPlan {
    const deadline = context.deadline;
    if (deadline === undefined || deadline.kind === "unknown") {
      return this.decorateBasePlan(
        context,
        "deadline_unknown_legacy",
        "legacy-p2p-first",
      );
    }

    const slackMs = deadline.slackMs;
    if (!Number.isFinite(slackMs)) {
      return originPlan("origin_fallback");
    }

    const estimatedOriginLatencyMs = this.originLatencyEstimator.estimateMs;
    if (
      !Number.isFinite(estimatedOriginLatencyMs) ||
      estimatedOriginLatencyMs < 0
    ) {
      return originPlan("origin_fallback", executionSlack(slackMs));
    }
    const latestSafeOriginStartMs =
      slackMs -
      estimatedOriginLatencyMs -
      this.safetyMarginMs;
    if (latestSafeOriginStartMs <= 0) {
      return originPlan("deadline_origin", slackMs);
    }

    if (latestSafeOriginStartMs > this.maximumPeerProbeWindowMs) {
      return this.decorateBasePlan(
        context,
        "deadline_relaxed_p2p",
        "legacy-p2p-first",
      );
    }

    const hedgeDelayMs = Math.min(
      this.maximumHedgeDelayMs,
      Math.max(0, latestSafeOriginStartMs),
    );
    return this.decorateBasePlan(
      context,
      "deadline_hedged",
      "hedged-origin",
      hedgeDelayMs,
    );
  }

  observePeer(observation: PeerFetchObservation): void {
    this.baseScheduler.observePeer?.(observation);
  }

  reconcilePeers(peers: readonly SchedulingPeer[]): void {
    this.baseScheduler.reconcilePeers?.(peers);
  }

  reset(): void {
    try {
      this.baseScheduler.reset?.();
    } finally {
      this.originLatencyEstimator.reset?.();
    }
  }

  private decorateBasePlan(
    context: SegmentSchedulingContext,
    reason: SchedulingReason,
    strategy: "legacy-p2p-first" | "hedged-origin",
    hedgeDelayMs?: number,
  ): SegmentSchedulingPlan {
    const { plan, warnings } = planSegmentSafely(this.baseScheduler, context);
    const deadlineSlackMs = context.deadline?.slackMs;
    if (warnings.length > 0) {
      return originPlan("origin_fallback", executionSlack(deadlineSlackMs));
    }
    if (plan.mode === "origin" || plan.peerIds.length === 0) {
      return originPlan(reason, executionSlack(deadlineSlackMs));
    }

    const deadlineExecutionSlackMs = executionSlack(deadlineSlackMs);
    return copyPlan(plan, reason, {
      strategy,
      ...(hedgeDelayMs === undefined
        ? {}
        : {
            peerAttemptBudgetMs: hedgeDelayMs,
            originHedgeDelayMs: hedgeDelayMs,
          }),
      ...(deadlineExecutionSlackMs === undefined
        ? {}
        : { deadlineSlackMs: deadlineExecutionSlackMs }),
    });
  }
}
