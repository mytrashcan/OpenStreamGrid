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
    | "non_finite_score"
    | "invalid_deadline"
    | "invalid_execution_hints";
  message: string;
}

export interface BatchSegmentRequest {
  segmentId: string;
  segmentsAhead?: number;
}

export interface BatchSyntheticDeadlineConfig {
  kind: "synthetic";
  segmentDurationMs: number;
}

export interface BatchAssignment {
  segmentId: string;
  peerId?: string;
  mode: "origin" | "single-peer";
}

export interface BatchPlanningResult {
  assignments: readonly BatchAssignment[];
  warnings: readonly {
    segmentId: string;
    code: string;
    message: string;
  }[];
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

const supportedDeadlineKinds = new Set([
  "player-derived",
  "playlist-derived",
  "synthetic",
  "unknown",
]);

const supportedExecutionStrategies = new Set([
  "legacy-p2p-first",
  "origin-only",
  "hedged-origin",
]);

const validateOptionalNonNegativeFiniteNumber = (
  value: unknown,
  fieldName: string,
  code: SchedulerPlanValidationFailure["code"],
  failures: SchedulerPlanValidationFailure[],
): value is number | undefined => {
  if (value === undefined) return true;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return true;
  }
  failures.push(
    failure(code, `${fieldName} must be a finite, non-negative number`),
  );
  return false;
};

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
  const deadline = context.deadline;
  if (deadline !== undefined) {
    if (!isRecord(deadline)) {
      failures.push(
        failure("invalid_deadline", "Segment deadline must be an object"),
      );
    } else {
      if (
        typeof deadline.kind !== "string" ||
        !supportedDeadlineKinds.has(deadline.kind)
      ) {
        failures.push(
          failure(
            "invalid_deadline",
            "Segment deadline kind is not supported",
          ),
        );
      }
      if (
        typeof deadline.slackMs !== "number" ||
        !Number.isFinite(deadline.slackMs)
      ) {
        failures.push(
          failure("invalid_deadline", "Segment deadline slackMs must be finite"),
        );
      }
      validateOptionalNonNegativeFiniteNumber(
        deadline.segmentDurationMs,
        "Segment deadline segmentDurationMs",
        "invalid_deadline",
        failures,
      );
      validateOptionalNonNegativeFiniteNumber(
        deadline.bufferAheadMs,
        "Segment deadline bufferAheadMs",
        "invalid_deadline",
        failures,
      );
    }
  }

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

  const execution = plan.execution;
  if (execution !== undefined) {
    if (!isRecord(execution)) {
      failures.push(
        failure(
          "invalid_execution_hints",
          "Scheduler plan execution hints must be an object",
        ),
      );
      return failures;
    }

    const strategy = execution.strategy;
    if (
      typeof strategy !== "string" ||
      !supportedExecutionStrategies.has(strategy)
    ) {
      failures.push(
        failure(
          "invalid_execution_hints",
          "Scheduler plan execution strategy is not supported",
        ),
      );
    }

    const peerAttemptBudgetMs = execution.peerAttemptBudgetMs;
    const originHedgeDelayMs = execution.originHedgeDelayMs;
    const executionDeadlineSlackMs = execution.deadlineSlackMs;
    validateOptionalNonNegativeFiniteNumber(
      peerAttemptBudgetMs,
      "Scheduler plan peerAttemptBudgetMs",
      "invalid_execution_hints",
      failures,
    );
    const validOriginHedgeDelay =
      validateOptionalNonNegativeFiniteNumber(
        originHedgeDelayMs,
        "Scheduler plan originHedgeDelayMs",
        "invalid_execution_hints",
        failures,
      );
    const validDeadlineSlack =
      validateOptionalNonNegativeFiniteNumber(
        executionDeadlineSlackMs,
        "Scheduler plan deadlineSlackMs",
        "invalid_execution_hints",
        failures,
      );

    if (
      peerAttemptBudgetMs !== undefined &&
      peerIds.length === 0
    ) {
      failures.push(
        failure(
          "invalid_execution_hints",
          "Scheduler plan cannot set a P2P attempt budget without selected peers",
        ),
      );
    }
    if (
      originHedgeDelayMs !== undefined &&
      (strategy === "origin-only" || mode === "origin")
    ) {
      failures.push(
        failure(
          "invalid_execution_hints",
          "Scheduler plan cannot hedge an Origin-only execution",
        ),
      );
    }

    const deadlineSlackMs =
      validDeadlineSlack && executionDeadlineSlackMs !== undefined
        ? executionDeadlineSlackMs
        : deadline?.slackMs;
    if (
      validOriginHedgeDelay &&
      typeof originHedgeDelayMs === "number" &&
      typeof deadlineSlackMs === "number" &&
      Number.isFinite(deadlineSlackMs) &&
      originHedgeDelayMs > deadlineSlackMs
    ) {
      failures.push(
        failure(
          "invalid_execution_hints",
          "Scheduler plan Origin hedge delay cannot exceed deadline slack",
        ),
      );
    }

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
  deadlineConfig?: BatchSyntheticDeadlineConfig,
): BatchPlanningResult {
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
  const warnings: BatchPlanningResult["warnings"][number][] = [];

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
        ...(deadlineConfig === undefined ||
        request.segmentsAhead === undefined
          ? {}
          : {
              deadline: {
                kind: deadlineConfig.kind,
                slackMs:
                  request.segmentsAhead * deadlineConfig.segmentDurationMs,
                segmentDurationMs: deadlineConfig.segmentDurationMs,
              },
            }),
        candidates: availableCandidates,
        selfPeerId,
        maximumParallelism,
      };
      const { plan, warnings: segmentWarnings } = planSegmentSafely(
        scheduler,
        context,
      );
      warnings.push(
        ...segmentWarnings.map((warning) => ({
          segmentId: request.segmentId,
          code: warning.code,
          message: warning.message,
        })),
      );
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

  return { assignments, warnings };
}
