import {
  createLogger,
  planBatch,
  planSegmentSafely,
  validatePeerHttpBaseUrl,
  type Peer,
  type PeerFailureReport,
  type SchedulerDecision,
  type SchedulingPeer,
  type SegmentScheduler,
  type SegmentSchedulingContext,
  type SegmentSchedulingPlan,
} from "@openstreamgrid/common";
import type { SegmentCache } from "./cache.js";
import type { OriginLatencyEstimator } from "./origin-latency-estimator.js";
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
  originLatencyEstimator?: OriginLatencyEstimator;
  onSchedulerDecision?: (decision: SchedulerDecision) => void;
}

/** Segment bytes and the delivery path that supplied them. */
export interface SegmentFetchResult {
  data: Buffer;
  source: "cache" | "p2p" | "origin";
}

interface InFlightSegment {
  controller: AbortController;
  peerId?: string;
  promise: Promise<SegmentFetchResult>;
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
    this.scheduler = options.scheduler ?? new WeightedScoreScheduler();
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
      const result = await this.hedgedFetch(
        peer,
        segmentName,
        plan.execution.originHedgeDelayMs ?? 0,
        signal,
      );
      this.cache(segmentName, result.data);
      this.setLastSource(segmentName, result.source);
      return result;
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
    this.setLastSource(segmentName, "origin");
    return { data, source: "origin" };
  }

  /**
   * Fetches playlist-ordered segments, prioritizing later (more urgent) entries.
   */
  async fetchSegments(
    segments: string[],
    peers: Peer[],
  ): Promise<Map<string, Buffer>> {
    const candidates = this.schedulingPeersFor(peers);
    this.reconcilePeers(candidates);
    const { assignments, warnings } = planBatch(
      this.scheduler,
      segments.map((segmentId) => ({ segmentId })),
      candidates,
      this.options.selfPeerId,
      this.maxParallel,
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
        if (existing) return existing.promise;

        const peer =
          assignment.peerId === undefined
            ? undefined
            : peersById.get(assignment.peerId);
        return this.startSegmentFetch(segmentName, peer);
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
    this.shutdownController.abort(new Error("Segment fetcher stopped"));
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
  ): Promise<SegmentFetchResult> {
    const controller = new AbortController();
    const promise = this.fetchAssignedSegment(
      segmentName,
      peer,
      controller.signal,
    ).finally(() => {
      const current = this.inFlightSegments.get(segmentName);
      if (current?.promise === promise) this.inFlightSegments.delete(segmentName);
    });
    this.inFlightSegments.set(segmentName, {
      controller,
      ...(peer ? { peerId: peer.id } : {}),
      promise,
    });
    return promise;
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
    const context: SegmentSchedulingContext = {
      segmentId: segmentName,
      ...(segmentsAhead === undefined ? {} : { segmentsAhead }),
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

  private async fetchFromPeer(
    peer: Peer,
    segmentName: string,
    signal?: AbortSignal,
    accountSuccess = true,
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
    const timer = this.options.transportManager
      ? undefined
      : setTimeout(
          () => controller.abort(new Error("P2P request timed out")),
          this.p2pTimeoutMs,
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
      if (accountSuccess) {
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
      this.options.originLatencyEstimator?.observe(
        performance.now() - startedAt,
      );
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
    const controller = new AbortController();
    let request: InFlightSegment;
    const promise = this.fetchUncachedSegment(
      segmentName,
      segmentsAhead,
      controller.signal,
    ).finally(() => {
      if (this.inFlightSegments.get(segmentName) === request) {
        this.inFlightSegments.delete(segmentName);
      }
    });
    request = { controller, promise };
    this.inFlightSegments.set(segmentName, request);
    return request;
  }

  private async waitForSegment(
    request: InFlightSegment,
    signal?: AbortSignal,
  ): Promise<SegmentFetchResult> {
    if (!signal) return request.promise;
    if (signal.aborted) throw this.abortReason(signal);
    const onAbort = (): void => request.controller.abort(this.abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      if (signal.aborted) onAbort();
      return await request.promise;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  private async hedgedFetch(
    peer: Peer,
    segmentName: string,
    hedgeDelayMs: number,
    signal: AbortSignal,
  ): Promise<SegmentFetchResult> {
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

    const peerAttempt = this.captureHedgedAttempt(
      "p2p",
      () =>
        this.fetchFromPeer(
          peer,
          segmentName,
          peerController.signal,
          false,
        ),
    );
    const originAttempt = this.captureHedgedAttempt("origin", async () => {
      await this.waitForHedge(hedgeDelayMs, originController.signal);
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
        return { data: attempt.data, source: attempt.source };
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

  private waitForHedge(delayMs: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (callback: () => void): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = (): void =>
        finish(() => reject(this.abortReason(signal)));
      const timer = setTimeout(() => finish(resolve), delayMs);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
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
