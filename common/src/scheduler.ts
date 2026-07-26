import type {
  SchedulingPeer,
  SegmentScheduler,
  SegmentSchedulingContext,
  SegmentSchedulingPlan,
} from "./index.js";

export interface SchedulerPlanValidationFailure {
  code:
    | "invalid_plan"
    | "invalid_mode"
    | "policy_mismatch"
    | "invalid_peer_count"
    | "duplicate_peer"
    | "unknown_peer"
    | "self_peer"
    | "segment_unavailable"
    | "parallelism_exceeded"
    | "invalid_rank"
    | "non_finite_score";
  message: string;
}

export interface BatchSegmentRequest {
  segmentId: string;
  segmentsAhead?: number;
}

export interface BatchAssignment {
  segmentId: string;
  peerId?: string;
  mode: "origin" | "single-peer";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const originFallbackPlan = (policy: string): SegmentSchedulingPlan => ({
  policy,
  mode: "origin",
  peerIds: [],
  rankedPeers: [],
  reason: "origin_fallback",
});

const failure = (
  code: SchedulerPlanValidationFailure["code"],
  message: string,
): SchedulerPlanValidationFailure => ({ code, message });

/**
 * Validates an untrusted scheduler plan against the context it was given.
 *
 * Every independently detectable failure is returned so custom scheduler
 * authors can correct a plan in one iteration.
 */
export function validateSchedulerPlan(
  plan: unknown,
  scheduler: { policyName: string },
  context: SegmentSchedulingContext,
): SchedulerPlanValidationFailure[] {
  if (!isRecord(plan)) {
    return [failure("invalid_plan", "Scheduler plan must be a non-null object")];
  }

  const failures: SchedulerPlanValidationFailure[] = [];
  const mode = plan.mode;
  const validMode =
    mode === "origin" ||
    mode === "single-peer" ||
    mode === "parallel-peers";
  if (!validMode) {
    failures.push(
      failure(
        "invalid_mode",
        "Scheduler plan mode must be origin, single-peer, or parallel-peers",
      ),
    );
  }

  if (plan.policy !== scheduler.policyName) {
    failures.push(
      failure(
        "policy_mismatch",
        `Scheduler plan policy must match '${scheduler.policyName}'`,
      ),
    );
  }

  const peerIdsValue = plan.peerIds;
  const peerIds = Array.isArray(peerIdsValue)
    ? peerIdsValue.filter((peerId): peerId is string => typeof peerId === "string")
    : [];
  if (
    !Array.isArray(peerIdsValue) ||
    peerIds.length !== peerIdsValue.length
  ) {
    failures.push(
      failure("invalid_plan", "Scheduler plan peerIds must be an array of strings"),
    );
  }

  if (Array.isArray(peerIdsValue)) {
    if (
      (mode === "origin" && peerIdsValue.length !== 0) ||
      (mode === "single-peer" && peerIdsValue.length !== 1) ||
      (mode === "parallel-peers" && peerIdsValue.length < 1)
    ) {
      failures.push(
        failure(
          "invalid_peer_count",
          `Scheduler plan mode '${String(mode)}' has an invalid peer count`,
        ),
      );
    }
    if (peerIdsValue.length > context.maximumParallelism) {
      failures.push(
        failure(
          "parallelism_exceeded",
          `Scheduler plan selects ${peerIdsValue.length} peers but maximumParallelism is ${context.maximumParallelism}`,
        ),
      );
    }
  }

  const duplicatePeerIds = new Set<string>();
  const seenPeerIds = new Set<string>();
  for (const peerId of peerIds) {
    if (seenPeerIds.has(peerId)) duplicatePeerIds.add(peerId);
    seenPeerIds.add(peerId);
  }
  if (duplicatePeerIds.size > 0) {
    failures.push(
      failure(
        "duplicate_peer",
        `Scheduler plan contains duplicate peers: ${[...duplicatePeerIds].join(", ")}`,
      ),
    );
  }

  const candidatesById = new Map(
    context.candidates.map((candidate) => [candidate.id, candidate]),
  );
  for (const peerId of peerIds) {
    const candidate = candidatesById.get(peerId);
    if (!candidate) {
      failures.push(
        failure("unknown_peer", `Selected peer '${peerId}' is not a candidate`),
      );
    }
    if (peerId === context.selfPeerId) {
      failures.push(
        failure("self_peer", `Scheduler plan selects the local peer '${peerId}'`),
      );
    }
    if (
      candidate &&
      context.segmentId.length > 0 &&
      !candidate.segments.includes(context.segmentId)
    ) {
      failures.push(
        failure(
          "segment_unavailable",
          `Selected peer '${peerId}' does not advertise '${context.segmentId}'`,
        ),
      );
    }
  }

  const rankedPeersValue = plan.rankedPeers;
  if (!Array.isArray(rankedPeersValue)) {
    failures.push(
      failure("invalid_plan", "Scheduler plan rankedPeers must be an array"),
    );
    return failures;
  }

  const seenRanks = new Set<number>();
  const duplicateRanks = new Set<number>();
  for (const rankedPeer of rankedPeersValue) {
    if (!isRecord(rankedPeer) || typeof rankedPeer.peerId !== "string") {
      failures.push(
        failure(
          "invalid_plan",
          "Every rankedPeers entry must be an object with a string peerId",
        ),
      );
      continue;
    }

    const peerId = rankedPeer.peerId;
    if (!candidatesById.has(peerId)) {
      failures.push(
        failure("unknown_peer", `Ranked peer '${peerId}' is not a candidate`),
      );
    }
    if (peerId === context.selfPeerId) {
      failures.push(
        failure("self_peer", `Scheduler plan ranks the local peer '${peerId}'`),
      );
    }

    const rank = rankedPeer.rank;
    if (
      typeof rank !== "number" ||
      !Number.isSafeInteger(rank) ||
      rank < 1 ||
      rank > rankedPeersValue.length
    ) {
      failures.push(
        failure(
          "invalid_rank",
          `Rank for peer '${peerId}' must be an integer between 1 and ${rankedPeersValue.length}`,
        ),
      );
    } else {
      if (seenRanks.has(rank)) duplicateRanks.add(rank);
      seenRanks.add(rank);
    }

    if (
      rankedPeer.score !== undefined &&
      (typeof rankedPeer.score !== "number" ||
        !Number.isFinite(rankedPeer.score))
    ) {
      failures.push(
        failure(
          "non_finite_score",
          `Score for peer '${peerId}' must be finite when provided`,
        ),
      );
    }
  }

  if (duplicateRanks.size > 0) {
    failures.push(
      failure(
        "invalid_rank",
        `Scheduler plan contains duplicate ranks: ${[...duplicateRanks].join(", ")}`,
      ),
    );
  }

  return failures;
}

/**
 * Contains custom scheduler exceptions and rejects invalid plans.
 */
export function planSegmentSafely(
  scheduler: SegmentScheduler,
  context: SegmentSchedulingContext,
): {
  plan: SegmentSchedulingPlan;
  warnings: SchedulerPlanValidationFailure[];
} {
  try {
    const candidatePlan: unknown = scheduler.planSegment(context);
    const warnings = validateSchedulerPlan(candidatePlan, scheduler, context);
    if (warnings.length === 0) {
      return {
        plan: candidatePlan as SegmentSchedulingPlan,
        warnings,
      };
    }
    return {
      plan: originFallbackPlan(scheduler.policyName),
      warnings,
    };
  } catch (error) {
    return {
      plan: originFallbackPlan(scheduler.policyName),
      warnings: [
        failure(
          "invalid_plan",
          `Scheduler '${scheduler.policyName}' threw: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      ],
    };
  }
}

/**
 * Plans playlist work in bounded waves while keeping peer assignments distinct
 * within each wave.
 */
export function planBatch(
  scheduler: SegmentScheduler,
  requests: readonly BatchSegmentRequest[],
  candidates: readonly SchedulingPeer[],
  selfPeerId: string,
  maximumParallelism: number,
): BatchAssignment[] {
  if (
    !Number.isSafeInteger(maximumParallelism) ||
    maximumParallelism <= 0
  ) {
    throw new RangeError("maximumParallelism must be a positive integer");
  }

  const prioritized = [
    ...new Map(requests.map((request) => [request.segmentId, request])).values(),
  ].reverse();
  const assignments: BatchAssignment[] = [];

  for (
    let offset = 0;
    offset < prioritized.length;
    offset += maximumParallelism
  ) {
    const wave = prioritized.slice(offset, offset + maximumParallelism);
    const assignedPeerIds = new Set<string>();

    for (const request of wave) {
      const availableCandidates = candidates.filter(
        (candidate) => !assignedPeerIds.has(candidate.id),
      );
      const context: SegmentSchedulingContext = {
        segmentId: request.segmentId,
        ...(request.segmentsAhead === undefined
          ? {}
          : { segmentsAhead: request.segmentsAhead }),
        candidates: availableCandidates,
        selfPeerId,
        maximumParallelism,
      };
      const { plan } = planSegmentSafely(scheduler, context);
      const peerId = plan.mode === "origin" ? undefined : plan.peerIds[0];
      if (peerId === undefined) {
        assignments.push({
          segmentId: request.segmentId,
          mode: "origin",
        });
        continue;
      }

      assignedPeerIds.add(peerId);
      assignments.push({
        segmentId: request.segmentId,
        peerId,
        mode: "single-peer",
      });
    }
  }

  return assignments;
}
