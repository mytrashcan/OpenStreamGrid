import {
  createLogger,
  planBatch,
  planSegmentSafely,
  validatePeerHttpBaseUrl,
  type BatchSegmentRequest,
  type DeadlineKind,
  type Peer,
  type PeerFailureReport,
  type SchedulerDecision,
  type SchedulingPeer,
  type SegmentDeadline,
  type SegmentScheduler,
  type SegmentSchedulingContext,
  type SegmentSchedulingPlan,
} from "@openstreamgrid/common";
import type { SegmentCache } from "./cache.js";
import { DeadlineAwareScheduler } from "./deadline-aware-scheduler.js";
import { OriginLatencyEstimator } from "./origin-latency-estimator.js";
import type { TrafficStats } from "./stats.js";
import type {
  FetchFunction,
  SegmentIntegrityVerifier,
} from "./verifier.js";
import type { TransportManager } from "./transport-manager.js";
import { keepAliveFetch } from "./http-client.js";
import {
  MAX_PARALLEL_DOWNLOADS_VALUE,
  schedulerDecisionFor,
  WeightedScoreScheduler,
} from "./weighted-score-scheduler.js";

const DEFAULT_P2P_TIMEOUT_MS = 2_000;
const DEFAULT_ORIGIN_TIMEOUT_MS = 10_000;
const MAX_TRACKED_SEGMENT_SOURCES = 2_000;

const logger = createLogger("peer");

export {
  calculatePeerScore,
  clamp,
  exponentialMovingAverage,
  LATENCY_WEIGHT_VALUE,
  MAX_PARALLEL_DOWNLOADS_VALUE,
  METRIC_EMA_ALPHA_VALUE,
  MINIMUM_TRUST_SCORE_VALUE,
  SUCCESS_RATE_WEIGHT_VALUE,
  TRUST_SCORE_WEIGHT_VALUE,
  UPLOAD_BANDWIDTH_WEIGHT_VALUE,
  URGENT_THRESHOLD_SEGMENTS_VALUE,
} from "./weighted-score-scheduler.js";
export type { PeerQualityMetrics } from "./weighted-score-scheduler.js";

/** Peer discovery and failure-reporting operations required by the fetcher. */
export interface PeerDirectory {
  listPeers(segmentName: string): Promise<Peer[]>;
  reportFailure(peerId: string, reason: PeerFailureReport["reason"]): Promise<void>;
}

export interface FetcherOptions {
  selfPeerId: string;
  originBaseUrl: URL;
  cache: SegmentCache;
  directory: PeerDirectory;
  verifier: SegmentIntegrityVerifier;
  stats: TrafficStats;
  fetchImpl?: FetchFunction;
  p2pTimeoutMs?: number;
  maxParallel?: number;
  transportManager?: TransportManager;
  scheduler?: SegmentScheduler;
  segmentDurationMs?: number;
  deadlineSchedulingEnabled?: boolean;
  originLatencyEstimator?: OriginLatencyEstimator;
  deadlineSafetyMarginMs?: number;
  deadlineMaximumPeerProbeWindowMs?: number;
  deadlineMaximumHedgeDelayMs?: number;
  onSchedulerDecision?: (decision: SchedulerDecision) => void;
  onSchedulerOutcome?: (outcome: SchedulerOutcome) => void;
}

/** Segment bytes and the delivery path that supplied them. */
export interface SegmentFetchResult {
  data: Buffer;
  source: "cache" | "p2p" | "origin";
}

export interface SchedulerOutcome {
  policy: string;
  deadlineKind: DeadlineKind;
  plannedStrategy: NonNullable<
    SegmentSchedulingPlan["execution"]
  >["strategy"];
  plannedMode: SegmentSchedulingPlan["mode"];
  finalSource: SegmentFetchResult["source"] | "none";
  hedgeStarted: boolean;
  outcome: "success" | "failure" | "aborted";
}

interface InFlightSegment {
  internalController: AbortController;
  peerId?: string;
  promise: Promise<SegmentFetchResult>;
  consumerControllers: Set<AbortController>;
  settled: boolean;
}

type HedgedAttempt =
  | {
      source: "p2p" | "origin";
      status: "fulfilled";
      data: Buffer;
      elapsedMs: number;
    }
  | {
      source: "p2p" | "origin";
      status: "rejected";
      error: unknown;
      elapsedMs: number;
    };

interface HedgedFetchResult extends SegmentFetchResult {
  source: "p2p" | "origin";
  hedgeStarted: boolean;
}

interface PeerFetchOptions {
  accountSuccess?: boolean;
  attemptBudgetMs?: number;
}

class PeerFetchError extends Error {
  constructor(
    message: string,
    readonly reason: PeerFailureReport["reason"],
  ) {
    super(message);
  }
}

/** Fetches verified segments from cache, peers, or origin in priority order. */
export class HybridSegmentFetcher {
  private readonly fetchImpl: FetchFunction;
  private readonly p2pTimeoutMs: number;
  private readonly maxParallel: number;
  private readonly scheduler: SegmentScheduler;
  private readonly segmentDurationMs: number | undefined;
  private readonly originLatencyEstimator: OriginLatencyEstimator | undefined;
  private readonly inFlightSegments = new Map<string, InFlightSegment>();
  private readonly lastSources = new Map<
    string,
    SegmentFetchResult["source"]
  >();
  private readonly shutdownController = new AbortController();

  constructor(private readonly options: FetcherOptions) {
    this.fetchImpl = options.fetchImpl ?? keepAliveFetch;
    this.p2pTimeoutMs = options.p2pTimeoutMs ?? DEFAULT_P2P_TIMEOUT_MS;
    this.maxParallel = options.maxParallel ?? MAX_PARALLEL_DOWNLOADS_VALUE;
    if (!Number.isSafeInteger(this.maxParallel) || this.maxParallel <= 0) {
      throw new Error("Maximum parallel downloads must be a positive integer");
    }
    this.segmentDurationMs = options.segmentDurationMs;
    if (
      this.segmentDurationMs !== undefined &&
      (!Number.isFinite(this.segmentDurationMs) || this.segmentDurationMs <= 0)
    ) {
      throw new Error("Segment duration must be a positive finite number");
    }
    const useDeadlineScheduler =
      options.deadlineSchedulingEnabled === true &&
      this.segmentDurationMs !== undefined;
    if (options.scheduler) {
      this.originLatencyEstimator = options.originLatencyEstimator;
      this.scheduler = options.scheduler;
    } else if (useDeadlineScheduler) {
      const estimator =
        options.originLatencyEstimator ?? new OriginLatencyEstimator();
      this.originLatencyEstimator = estimator;
      this.scheduler = new DeadlineAwareScheduler({
        baseScheduler: new WeightedScoreScheduler(),
        originLatencyEstimator: estimator,
        ...(options.deadlineSafetyMarginMs === undefined
          ? {}
          : { safetyMarginMs: options.deadlineSafetyMarginMs }),
        ...(options.deadlineMaximumPeerProbeWindowMs === undefined
          ? {}
          : {
              maximumPeerProbeWindowMs:
                options.deadlineMaximumPeerProbeWindowMs,
            }),
        ...(options.deadlineMaximumHedgeDelayMs === undefined
          ? {}
          : {
              maximumHedgeDelayMs:
                options.deadlineMaximumHedgeDelayMs,
            }),
      });
    } else {
      this.originLatencyEstimator = options.originLatencyEstimator;
      this.scheduler = new WeightedScoreScheduler();
    }
  }

  async fetchSegment(
    segmentName: string,
    segmentsAhead: number,
    signal?: AbortSignal,
  ): Promise<SegmentFetchResult> {
    if (signal?.aborted) throw this.abortReason(signal);
    const cached = this.options.cache.get(segmentName);
    if (cached) {
      this.setLastSource(segmentName, "cache");
      return { data: cached, source: "cache" };
    }

    const existing = this.inFlightSegments.get(segmentName);
    if (existing) {
      const result = await this.waitForSegment(existing, signal);
      this.setLastSource(segmentName, result.source);
      return result;
    }

    const request = this.startUncachedSegment(segmentName, segmentsAhead);
    return this.waitForSegment(request, signal);
  }

  private async fetchUncachedSegment(
    segmentName: string,
    segmentsAhead: number,
    signal: AbortSignal,
  ): Promise<SegmentFetchResult> {
    let peers: Peer[] = [];
    let plan: SegmentSchedulingPlan | undefined;
    const complete = (
      result: SegmentFetchResult,
      hedgeStarted = false,
    ): SegmentFetchResult => {
      this.recordSchedulerOutcome(
        plan,
        segmentsAhead,
        result.source,
        hedgeStarted,
        "success",
      );
      return result;
    };
    try {
      const selection = this.planPeers(
        await this.options.directory.listPeers(segmentName),
        segmentName,
        segmentsAhead,
      );
      peers = selection.peers;
      plan = selection.plan;
    } catch (error) {
      this.options.stats.recordFallback();
      logger.error("peer_discovery_failed", error, { segmentName });
    }
    const peer = peers[0];
    if (
      peer &&
      plan?.execution?.strategy === "hedged-origin"
    ) {
      let hedgeStarted = false;
      try {
        const hedgedResult = await this.hedgedFetch(
          peer,
          segmentName,
          plan.execution.originHedgeDelayMs ?? 0,
          plan.execution.peerAttemptBudgetMs,
          signal,
          () => {
            hedgeStarted = true;
          },
        );
        const { hedgeStarted: observedHedgeStart, ...result } = hedgedResult;
        this.cache(segmentName, result.data);
        this.setLastSource(segmentName, result.source);
        return complete(result, observedHedgeStart);
      } catch (error) {
        this.recordSchedulerOutcome(
          plan,
          segmentsAhead,
          "none",
          hedgeStarted,
          signal.aborted || this.shutdownController.signal.aborted
            ? "aborted"
            : "failure",
        );
        throw error;
      }
    }

    if (peer) {
      const startedAt = performance.now();
      try {
        const data = await this.fetchFromPeer(peer, segmentName, signal);
        this.observePeer({
          peerId: peer.id,
          succeeded: true,
          latencyMs: performance.now() - startedAt,
          bytes: data.byteLength,
        });
        this.cache(segmentName, data);
        this.setLastSource(segmentName, "p2p");
        return complete({ data, source: "p2p" });
      } catch (error) {
        if (signal.aborted || this.shutdownController.signal.aborted) {
          this.recordSchedulerOutcome(
            plan,
            segmentsAhead,
            "none",
            false,
            "aborted",
          );
          throw this.activeAbortReason(signal);
        }
        this.recordPeerFailure(
          peer,
          error,
          performance.now() - startedAt,
        );
      }
    }

    try {
      const data = await this.fetchFromOrigin(segmentName, signal);
      this.options.stats.recordOriginBytes(data.byteLength);
      this.cache(segmentName, data);
      this.setLastSource(segmentName, "origin");
      return complete({ data, source: "origin" });
    } catch (error) {
      this.recordSchedulerOutcome(
        plan,
        segmentsAhead,
        "none",
        false,
        signal.aborted || this.shutdownController.signal.aborted
          ? "aborted"
          : "failure",
      );
      throw error;
    }
  }

  /**
   * Fetches playlist-ordered segments, prioritizing later (more urgent) entries.
   */
  async fetchSegments(
    requests: readonly BatchSegmentRequest[],
    peers: Peer[],
  ): Promise<Map<string, Buffer>> {
    const candidates = this.schedulingPeersFor(peers);
    this.reconcilePeers(candidates);
    const { assignments, warnings } = planBatch(
      this.scheduler,
      requests,
      candidates,
      this.options.selfPeerId,
      this.maxParallel,
      this.options.deadlineSchedulingEnabled === true &&
        this.segmentDurationMs !== undefined
        ? {
            kind: "synthetic",
            segmentDurationMs: this.segmentDurationMs,
          }
        : undefined,
    );
    for (const warning of warnings) {
      logger.warn("scheduler_plan_invalid", {
        policy: this.scheduler.policyName,
        segmentId: warning.segmentId,
        validationFailure: warning.code,
        message: warning.message,
      });
    }
    const peersById = new Map(peers.map((peer) => [peer.id, peer]));
    const fetched = new Map<string, Buffer>();
    const failures: unknown[] = [];

    for (
      let offset = 0;
      offset < assignments.length;
      offset += this.maxParallel
    ) {
      const wave = assignments.slice(offset, offset + this.maxParallel);
      const tasks = wave.map((assignment) => {
        const segmentName = assignment.segmentId;
        const cached = this.options.cache.get(segmentName);
        if (cached) {
          this.setLastSource(segmentName, "cache");
          return Promise.resolve<SegmentFetchResult>({
            data: cached,
            source: "cache",
          });
        }

        const existing = this.inFlightSegments.get(segmentName);
        if (existing) return this.waitForSegment(existing);

        const peer =
          assignment.peerId === undefined
            ? undefined
            : peersById.get(assignment.peerId);
        return this.waitForSegment(this.startSegmentFetch(segmentName, peer));
      });

      const settled = await Promise.allSettled(tasks);
      for (const [index, result] of settled.entries()) {
        const segmentName = wave[index]?.segmentId;
        if (segmentName === undefined) continue;
        if (result.status === "fulfilled") {
          fetched.set(segmentName, result.value.data);
          this.setLastSource(segmentName, result.value.source);
        } else {
          failures.push(result.reason);
        }
      }
    }

    if (failures.length > 0) {
      throw new AggregateError(failures, "One or more segments could not be fetched");
    }
    return fetched;
  }

  getLastSource(segmentName: string): SegmentFetchResult["source"] | undefined {
    return this.lastSources.get(segmentName);
  }

  /** Aborts outstanding peer and Origin requests during application shutdown. */
  stop(): void {
    if (this.shutdownController.signal.aborted) return;
    const reason = new Error("Segment fetcher stopped");
    this.shutdownController.abort(reason);
    for (const request of this.inFlightSegments.values()) {
      for (const controller of request.consumerControllers) {
        controller.abort(reason);
      }
      request.internalController.abort(reason);
    }
    try {
      this.scheduler.reset?.();
    } catch (error) {
      logger.warn("scheduler_reset_failed", {
        policy: this.scheduler.policyName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private startSegmentFetch(
    segmentName: string,
    peer: Peer | undefined,
  ): InFlightSegment {
    const internalController = new AbortController();
    let request: InFlightSegment;
    const promise = this.fetchAssignedSegment(
      segmentName,
      peer,
      internalController.signal,
    ).finally(() => {
      request.settled = true;
      const current = this.inFlightSegments.get(segmentName);
      if (current?.promise === promise) this.inFlightSegments.delete(segmentName);
    });
    request = {
      internalController,
      ...(peer ? { peerId: peer.id } : {}),
      promise,
      consumerControllers: new Set(),
      settled: false,
    };
    this.inFlightSegments.set(segmentName, request);
    return request;
  }

  private async fetchAssignedSegment(
    segmentName: string,
    peer: Peer | undefined,
    signal: AbortSignal,
  ): Promise<SegmentFetchResult> {
    if (peer) {
      const startedAt = performance.now();
      try {
        const data = await this.fetchFromPeer(peer, segmentName, signal);
        this.observePeer({
          peerId: peer.id,
          succeeded: true,
          latencyMs: performance.now() - startedAt,
          bytes: data.byteLength,
        });
        this.cache(segmentName, data);
        return { data, source: "p2p" };
      } catch (error) {
        if (signal.aborted || this.shutdownController.signal.aborted) {
          throw this.activeAbortReason(signal);
        }
        this.recordPeerFailure(
          peer,
          error,
          performance.now() - startedAt,
        );
      }
    }

    const data = await this.fetchFromOrigin(segmentName, signal);
    this.options.stats.recordOriginBytes(data.byteLength);
    this.cache(segmentName, data);
    return { data, source: "origin" };
  }

  private planPeers(
    peers: Peer[],
    segmentName = "",
    segmentsAhead?: number,
  ): { peers: Peer[]; plan: SegmentSchedulingPlan } {
    const candidates = this.schedulingPeersFor(peers);
    const deadline = this.syntheticDeadline(segmentsAhead);
    const context: SegmentSchedulingContext = {
      segmentId: segmentName,
      ...(segmentsAhead === undefined ? {} : { segmentsAhead }),
      ...(deadline === undefined ? {} : { deadline }),
      candidates,
      selfPeerId: this.options.selfPeerId,
      maximumParallelism: this.maxParallel,
    };
    this.reconcilePeers(context.candidates, context.segmentId);
    const { plan, warnings } = planSegmentSafely(this.scheduler, context);
    for (const warning of warnings) {
      logger.warn("scheduler_plan_invalid", {
        policy: this.scheduler.policyName,
        segmentId: context.segmentId,
        validationFailure: warning.code,
        message: warning.message,
      });
    }
    this.recordSchedulerDecision(schedulerDecisionFor(plan, candidates.length));
    if (plan.mode === "origin") return { peers: [], plan };

    const peersById = new Map(peers.map((peer) => [peer.id, peer]));
    const orderedPeerIds = [
      ...plan.peerIds,
      ...plan.rankedPeers
        .map(({ peerId }) => peerId)
        .filter((peerId) => !plan.peerIds.includes(peerId)),
    ];
    return {
      plan,
      peers: orderedPeerIds.flatMap((peerId) => {
        const peer = peersById.get(peerId);
        return peer ? [peer] : [];
      }),
    };
  }

  private schedulingPeersFor(peers: readonly Peer[]): SchedulingPeer[] {
    return peers.map((peer, originalIndex) => ({
      id: peer.id,
      latencyMs: peer.latencyMs,
      successRate: peer.successRate,
      uploadBandwidthBps: peer.uploadBandwidthBps ?? 0,
      trustScore: peer.trustScore,
      segments: peer.segments,
      originalIndex,
    }));
  }

  private reconcilePeers(
    candidates: readonly SchedulingPeer[],
    segmentId = "",
  ): void {
    try {
      this.scheduler.reconcilePeers?.(candidates);
    } catch (error) {
      logger.warn("scheduler_reconcile_failed", {
        policy: this.scheduler.policyName,
        segmentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private observePeer(
    observation: Parameters<NonNullable<SegmentScheduler["observePeer"]>>[0],
  ): void {
    try {
      this.scheduler.observePeer?.(observation);
    } catch (error) {
      logger.warn("scheduler_observation_failed", {
        policy: this.scheduler.policyName,
        peerId: observation.peerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private recordSchedulerDecision(decision: SchedulerDecision): void {
    try {
      this.options.onSchedulerDecision?.(decision);
    } catch (error) {
      logger.warn("scheduler_decision_callback_failed", {
        policy: decision.policy,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private syntheticDeadline(
    segmentsAhead: number | undefined,
  ): SegmentDeadline | undefined {
    if (
      this.options.deadlineSchedulingEnabled !== true ||
      segmentsAhead === undefined ||
      this.segmentDurationMs === undefined
    ) {
      return undefined;
    }
    return {
      kind: "synthetic",
      slackMs: segmentsAhead * this.segmentDurationMs,
      segmentDurationMs: this.segmentDurationMs,
    };
  }

  private recordSchedulerOutcome(
    plan: SegmentSchedulingPlan | undefined,
    segmentsAhead: number,
    finalSource: SchedulerOutcome["finalSource"],
    hedgeStarted: boolean,
    outcome: SchedulerOutcome["outcome"],
  ): void {
    const deadlineKind =
      this.syntheticDeadline(segmentsAhead)?.kind ?? "unknown";
    const plannedStrategy =
      plan?.execution?.strategy ??
      (plan?.mode === "origin" ? "origin-only" : "legacy-p2p-first");
    const schedulerOutcome: SchedulerOutcome = {
      policy: plan?.policy ?? this.scheduler.policyName,
      deadlineKind,
      plannedStrategy,
      plannedMode: plan?.mode ?? "origin",
      finalSource,
      hedgeStarted,
      outcome,
    };
    try {
      this.options.onSchedulerOutcome?.(schedulerOutcome);
    } catch (error) {
      logger.warn("scheduler_outcome_callback_failed", {
        policy: schedulerOutcome.policy,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async fetchFromPeer(
    peer: Peer,
    segmentName: string,
    signal?: AbortSignal,
    options: PeerFetchOptions = {},
  ): Promise<Buffer> {
    this.options.stats.recordP2PRequest();
    const controller = new AbortController();
    const onShutdown = (): void => {
      controller.abort(
        this.shutdownController.signal.reason ?? new Error("Segment fetcher stopped"),
      );
    };
    this.shutdownController.signal.addEventListener("abort", onShutdown, {
      once: true,
    });
    const onConsumerAbort = (): void => {
      controller.abort(this.abortReason(signal));
    };
    signal?.addEventListener("abort", onConsumerAbort, { once: true });
    if (this.shutdownController.signal.aborted) onShutdown();
    if (signal?.aborted) onConsumerAbort();
    const standardTimeoutMs = this.options.transportManager
      ? undefined
      : this.p2pTimeoutMs;
    const timeoutMs =
      options.attemptBudgetMs === undefined
        ? standardTimeoutMs
        : standardTimeoutMs === undefined
          ? options.attemptBudgetMs
          : Math.min(standardTimeoutMs, options.attemptBudgetMs);
    const budgetIsLimiting =
      options.attemptBudgetMs !== undefined &&
      (standardTimeoutMs === undefined ||
        options.attemptBudgetMs <= standardTimeoutMs);
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(
            () =>
              controller.abort(
                new Error(
                  budgetIsLimiting
                    ? "Peer attempt budget expired"
                    : "P2P request timed out",
                ),
              ),
            timeoutMs,
          );
    try {
      let data: Buffer;
      if (this.options.transportManager) {
        this.options.transportManager.registerPeer(peer);
        try {
          data = await this.options.transportManager.fetchSegment(
            segmentName,
            peer.address,
            controller.signal,
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Peer connection failed";
          const reason = /HTTP \d+/i.test(message)
            ? "http"
            : /timed out|abort/i.test(message)
              ? "timeout"
              : "connection";
          throw new PeerFetchError(message, reason);
        }
      } else {
        let response: Response;
        try {
          response = await this.fetchImpl(
            new URL(
              `/segments/${encodeURIComponent(segmentName)}`,
              validatePeerHttpBaseUrl(peer.address),
            ),
            {
              signal: controller.signal,
              ...(peer.metadata?.uploadToken
                ? {
                    headers: {
                      Authorization: `Bearer ${peer.metadata.uploadToken}`,
                    },
                  }
                : {}),
            },
          );
        } catch (error) {
          throw new PeerFetchError(
            error instanceof Error ? error.message : "Peer connection failed",
            controller.signal.aborted ? "timeout" : "connection",
          );
        }
        if (!response.ok) {
          throw new PeerFetchError(`Peer returned HTTP ${response.status}`, "http");
        }
        data = Buffer.from(await response.arrayBuffer());
      }
      if (!(await this.options.verifier.verify(segmentName, data))) {
        this.options.stats.recordIntegrityFailure();
        throw new PeerFetchError("Peer segment integrity check failed", "integrity");
      }
      if (options.accountSuccess !== false) {
        this.options.stats.recordP2PSuccess(data.byteLength);
      }
      return data;
    } finally {
      if (timer) clearTimeout(timer);
      this.shutdownController.signal.removeEventListener("abort", onShutdown);
      signal?.removeEventListener("abort", onConsumerAbort);
    }
  }

  private async fetchFromOrigin(
    segmentName: string,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    this.options.stats.recordOriginRequest();
    const startedAt = performance.now();
    const controller = new AbortController();
    const abort = (reason: unknown): void => controller.abort(reason);
    const onShutdown = (): void =>
      abort(
        this.shutdownController.signal.reason ??
          new Error("Segment fetcher stopped"),
      );
    const onConsumerAbort = (): void => abort(this.abortReason(signal));
    this.shutdownController.signal.addEventListener("abort", onShutdown, {
      once: true,
    });
    signal?.addEventListener("abort", onConsumerAbort, { once: true });
    if (this.shutdownController.signal.aborted) onShutdown();
    if (signal?.aborted) onConsumerAbort();
    const timer = setTimeout(
      () => abort(new Error("Origin request timed out")),
      DEFAULT_ORIGIN_TIMEOUT_MS,
    );
    try {
      const response = await this.fetchImpl(
        new URL(encodeURIComponent(segmentName), this.options.originBaseUrl),
        { signal: controller.signal },
      );
      if (!response.ok) {
        throw new Error(
          `Origin returned HTTP ${response.status} for '${segmentName}'`,
        );
      }
      const data = Buffer.from(await response.arrayBuffer());
      if (!(await this.options.verifier.verify(segmentName, data))) {
        this.options.stats.recordIntegrityFailure();
        throw new Error(
          `Origin segment '${segmentName}' failed integrity verification`,
        );
      }
      this.originLatencyEstimator?.observe(performance.now() - startedAt);
      return data;
    } finally {
      clearTimeout(timer);
      this.shutdownController.signal.removeEventListener("abort", onShutdown);
      signal?.removeEventListener("abort", onConsumerAbort);
    }
  }

  private startUncachedSegment(
    segmentName: string,
    segmentsAhead: number,
  ): InFlightSegment {
    const internalController = new AbortController();
    let request: InFlightSegment;
    const promise = this.fetchUncachedSegment(
      segmentName,
      segmentsAhead,
      internalController.signal,
    ).finally(() => {
      request.settled = true;
      if (this.inFlightSegments.get(segmentName) === request) {
        this.inFlightSegments.delete(segmentName);
      }
    });
    request = {
      internalController,
      promise,
      consumerControllers: new Set(),
      settled: false,
    };
    this.inFlightSegments.set(segmentName, request);
    return request;
  }

  private async waitForSegment(
    request: InFlightSegment,
    signal?: AbortSignal,
  ): Promise<SegmentFetchResult> {
    if (signal?.aborted) throw this.abortReason(signal);
    const consumerController = new AbortController();
    request.consumerControllers.add(consumerController);
    const onSignalAbort = (): void =>
      consumerController.abort(this.abortReason(signal));
    signal?.addEventListener("abort", onSignalAbort, { once: true });

    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (callback: () => void): void => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener("abort", onSignalAbort);
        consumerController.signal.removeEventListener("abort", onConsumerAbort);
        request.consumerControllers.delete(consumerController);
        callback();
        if (
          request.consumerControllers.size === 0 &&
          !request.settled &&
          consumerController.signal.aborted
        ) {
          request.internalController.abort(
            consumerController.signal.reason ??
              new Error("All segment consumers aborted"),
          );
        }
      };
      const onConsumerAbort = (): void =>
        finish(() => reject(this.abortReason(consumerController.signal)));
      consumerController.signal.addEventListener("abort", onConsumerAbort, {
        once: true,
      });
      request.promise.then(
        (result) => finish(() => resolve(result)),
        (error: unknown) => finish(() => reject(error)),
      );
      if (signal?.aborted) onSignalAbort();
    });
  }

  private async hedgedFetch(
    peer: Peer,
    segmentName: string,
    hedgeDelayMs: number,
    peerAttemptBudgetMs: number | undefined,
    signal: AbortSignal,
    onHedgeStart: () => void,
  ): Promise<HedgedFetchResult> {
    const peerController = new AbortController();
    const originController = new AbortController();
    const abortBoth = (): void => {
      const reason = this.activeAbortReason(signal);
      peerController.abort(reason);
      originController.abort(reason);
    };
    signal.addEventListener("abort", abortBoth, { once: true });
    this.shutdownController.signal.addEventListener("abort", abortBoth, {
      once: true,
    });
    if (signal.aborted || this.shutdownController.signal.aborted) abortBoth();

    const peerBudgetDeadline =
      peerAttemptBudgetMs === undefined
        ? undefined
        : performance.now() + peerAttemptBudgetMs;
    const peerAttempt = this.captureHedgedAttempt(
      "p2p",
      () => {
        const remainingPeerBudgetMs =
          peerBudgetDeadline === undefined
            ? undefined
            : Math.max(0, peerBudgetDeadline - performance.now());
        return this.fetchFromPeer(
          peer,
          segmentName,
          peerController.signal,
          {
            accountSuccess: false,
            ...(remainingPeerBudgetMs === undefined
              ? {}
              : { attemptBudgetMs: remainingPeerBudgetMs }),
          },
        );
      },
    );
    const hedgeStart = this.createHedgeStart(
      hedgeDelayMs,
      originController.signal,
      onHedgeStart,
    );
    const originAttempt = this.captureHedgedAttempt("origin", async () => {
      await hedgeStart.promise;
      return this.fetchFromOrigin(segmentName, originController.signal);
    });
    const pending = new Map([
      ["p2p", peerAttempt],
      ["origin", originAttempt],
    ]);
    const failures: unknown[] = [];

    try {
      while (pending.size > 0) {
        const attempt = await Promise.race(pending.values());
        pending.delete(attempt.source);
        if (signal.aborted || this.shutdownController.signal.aborted) {
          throw this.activeAbortReason(signal);
        }
        if (attempt.status === "rejected") {
          failures.push(attempt.error);
          if (attempt.source === "p2p") {
            this.recordPeerFailure(peer, attempt.error, attempt.elapsedMs);
            hedgeStart.startNow();
          }
          continue;
        }

        if (attempt.source === "p2p") {
          originController.abort(new Error("P2P hedge won"));
          this.observePeer({
            peerId: peer.id,
            succeeded: true,
            latencyMs: attempt.elapsedMs,
            bytes: attempt.data.byteLength,
          });
          this.options.stats.recordP2PSuccess(attempt.data.byteLength);
        } else {
          peerController.abort(new Error("Origin hedge won"));
          this.options.stats.recordOriginBytes(attempt.data.byteLength);
        }
        return {
          data: attempt.data,
          source: attempt.source,
          hedgeStarted: hedgeStart.started(),
        };
      }
      throw new AggregateError(
        failures,
        `P2P and Origin failed for '${segmentName}'`,
      );
    } finally {
      peerController.abort(new Error("Hedged fetch settled"));
      originController.abort(new Error("Hedged fetch settled"));
      signal.removeEventListener("abort", abortBoth);
      this.shutdownController.signal.removeEventListener("abort", abortBoth);
    }
  }

  private async captureHedgedAttempt(
    source: HedgedAttempt["source"],
    fetch: () => Promise<Buffer>,
  ): Promise<HedgedAttempt> {
    const startedAt = performance.now();
    try {
      return {
        source,
        status: "fulfilled",
        data: await fetch(),
        elapsedMs: performance.now() - startedAt,
      };
    } catch (error) {
      return {
        source,
        status: "rejected",
        error,
        elapsedMs: performance.now() - startedAt,
      };
    }
  }

  private createHedgeStart(
    delayMs: number,
    signal: AbortSignal,
    onStart: () => void,
  ): {
    promise: Promise<void>;
    startNow(): void;
    started(): boolean;
  } {
    let startNow = (): void => {};
    let started = false;
    const promise = new Promise<void>((resolve, reject) => {
      let finished = false;
      const finish = (callback: () => void): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        callback();
      };
      const start = (): void =>
        finish(() => {
          started = true;
          onStart();
          resolve();
        });
      const onAbort = (): void =>
        finish(() => reject(this.abortReason(signal)));
      const timer = setTimeout(start, delayMs);
      startNow = start;
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    return {
      promise,
      startNow: () => startNow(),
      started: () => started,
    };
  }

  private recordPeerFailure(
    peer: Peer,
    error: unknown,
    latencyMs: number,
  ): void {
    const failure =
      error instanceof PeerFetchError
        ? error
        : new PeerFetchError("Peer request failed", "connection");
    this.observePeer({
      peerId: peer.id,
      succeeded: false,
      latencyMs,
      bytes: 0,
      failureReason: failure.reason,
    });
    this.options.stats.recordP2PFailure();
    this.options.stats.recordFallback();
    void this.options.directory
      .reportFailure(peer.id, failure.reason)
      .catch((reportError: unknown) => {
        logger.error("peer_failure_report_failed", reportError, {
          peerId: peer.id,
        });
      });
  }

  private activeAbortReason(signal: AbortSignal): unknown {
    return this.shutdownController.signal.aborted
      ? (this.shutdownController.signal.reason ??
          new Error("Segment fetcher stopped"))
      : this.abortReason(signal);
  }

  private abortReason(signal?: AbortSignal): unknown {
    return signal?.reason ?? new Error("Segment fetch aborted");
  }

  private cache(segmentName: string, data: Buffer): void {
    this.options.cache.set(segmentName, data);
    this.options.stats.setSegmentsCached(this.options.cache.size);
  }

  private setLastSource(
    segmentName: string,
    source: SegmentFetchResult["source"],
  ): void {
    this.lastSources.delete(segmentName);
    this.lastSources.set(segmentName, source);
    while (this.lastSources.size > MAX_TRACKED_SEGMENT_SOURCES) {
      const oldest = this.lastSources.keys().next().value;
      if (oldest === undefined) break;
      this.lastSources.delete(oldest);
    }
  }
}
