/**
 * Hls.js loader plugin for OpenStreamGrid.
 *
 * Intercepts Hls.js fragment (segment) loading via custom loader
 * and routes requests through the P2P grid — trying peers first,
 * falling back to origin.
 *
 * Architecture:
 *   Hls.js → OpenStreamGridLoader (custom loader)
 *       ├── P2P path: ws client → peer list → fetch from peer HTTP → cache → verify → return
 *       └── Origin path: fallback to HTTP GET → cache → return
 *
 * Integration:
 *   const hls = new Hls();
 *   const plugin = new OpenStreamGridHlsPlugin({ trackerUrl: "ws://tracker:7070/ws", broadcastId: "test" });
 *   plugin.attach(hls);
 *   hls.loadSource("http://origin:8080/stream.m3u8");
 *   hls.attachMedia(videoElement);
 */

import {
  createLogger,
  planSegmentSafely,
  validatePeerHttpBaseUrl,
  type SchedulerDecision,
  type SchedulingPeer,
  type SegmentScheduler,
  type SegmentSchedulingContext,
  type SegmentSchedulingPlan,
} from "@openstreamgrid/common";
import type {
  default as Hls,
  HlsConfig,
  Loader,
  LoaderCallbacks,
  LoaderConfiguration,
  LoaderContext,
  LoaderStats,
} from "hls.js";
import { SegmentCache } from "./cache.js";
import { DeadlineAwareScheduler } from "./deadline-aware-scheduler.js";
import {
  compareTrustAndLatency,
  MAX_PARALLEL_PEER_PROBES,
} from "./trust-latency-probe-scheduler.js";
import { OriginHashVerifier } from "./verifier.js";
import { BrowserWebRtcPeer } from "./webrtc-peer.js";
import { WsTrackerClient } from "./ws-client.js";
import type {
  HlsjsPluginConfig,
  PeerInfo,
  PeerTrafficStats,
  SdkEvent,
} from "./types.js";

const DEFAULT_MAX_CACHE_BYTES = 100 * 1024 * 1024;
const DEFAULT_PEER_TIMEOUT_MS = 3_000;
const DEFAULT_ORIGIN_LATENCY_ESTIMATE_MS = 500;
const ORIGIN_LATENCY_EMA_ALPHA = 0.3;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const logger = createLogger("sdk");

type PeerFetchAttempt =
  | { index: number; peerId: string; data: Uint8Array }
  | { index: number; data?: never };

interface PeerFetchResult {
  data: Uint8Array;
  peerId: string;
}

type SegmentLoadResult =
  | { source: "p2p"; data: Uint8Array; peerId: string }
  | { source: "origin"; data: Uint8Array };

type HedgedLoadAttempt =
  | { source: SegmentLoadResult["source"]; status: "fulfilled"; result: SegmentLoadResult }
  | { source: SegmentLoadResult["source"]; status: "rejected"; error: unknown };

interface PlannedPeerFetch {
  plan: SegmentSchedulingPlan;
  candidates: PeerCandidate[];
}

export interface PeerCandidate {
  peer: PeerInfo;
  segmentId: string;
}

export function sortBrowserCandidates(
  candidates: PeerCandidate[],
): PeerCandidate[] {
  return [...candidates].sort((left, right) =>
    compareTrustAndLatency(left.peer, right.peer),
  );
}

interface InFlightSegment {
  controller: AbortController;
  promise: Promise<{ data: Uint8Array }>;
  consumers: number;
  settled: boolean;
}

/**
 * Custom loader for Hls.js that routes segment requests through the
 * OpenStreamGrid P2P network.
 */
class OpenStreamGridLoader implements Loader<LoaderContext> {
  public stats: LoaderStats;
  public context: LoaderContext | null = null;

  private callbacks: LoaderCallbacks<LoaderContext> | null = null;
  private aborted = false;
  private timedOut = false;
  private abortController: AbortController | null = null;
  private fallbackLoader: Loader<LoaderContext> | null = null;

  constructor(
    private readonly hlsConfig: HlsConfig,
    private readonly plugin: OpenStreamGridHlsPlugin,
    private readonly fallbackLoaderConstructor: HlsConfig["loader"],
  ) {
    this.stats = this.createStats();
  }

  destroy(): void {
    this.abortController?.abort();
    this.fallbackLoader?.destroy();
    this.fallbackLoader = null;
    this.callbacks = null;
    this.context = null;
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    this.stats.aborted = true;
    this.abortController?.abort();
    if (this.fallbackLoader) {
      this.fallbackLoader.abort();
    } else if (this.context) {
      this.callbacks?.onAbort?.(this.stats, this.context, null);
    }
  }

  load(
    context: LoaderContext,
    config: LoaderConfiguration,
    callbacks: LoaderCallbacks<LoaderContext>,
  ): void {
    this.context = context;
    this.callbacks = callbacks;
    this.stats = this.createStats();
    this.stats.loading.start = performance.now();
    this.aborted = false;
    this.timedOut = false;
    this.abortController = new AbortController();

    const url = context.url;
    if (!url) {
      this.fallbackToOrigin(context, config, callbacks);
      return;
    }

    // Only intercept .ts segments, let playlists pass through to default loader
    if (!this.isTransportStreamUrl(url)) {
      this.fallbackToOrigin(context, config, callbacks);
      return;
    }

    const segmentName = this.extractSegmentName(url);
    const timeoutMs = config.timeout || config.loadPolicy.maxLoadTimeMs;
    const timeout = setTimeout(() => {
      if (this.aborted || this.timedOut) return;
      this.timedOut = true;
      this.stats.aborted = true;
      this.abortController?.abort(
        new DOMException("Loader timed out", "TimeoutError"),
      );
      callbacks.onTimeout(this.stats, context, null);
    }, timeoutMs);
    void this.loadThroughGrid(
      segmentName,
      url,
      context,
      callbacks,
      this.abortController.signal,
    ).finally(() => clearTimeout(timeout));
  }

  // ---- internal ----

  private async loadThroughGrid(
    segmentName: string,
    url: string,
    context: LoaderContext,
    callbacks: LoaderCallbacks<LoaderContext>,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const result = await this.plugin.loadSegment(segmentName, url, signal);
      if (this.aborted || this.timedOut) return;
      this.stats.loading.end = performance.now();
      this.stats.loading.first = this.stats.loading.end;
      this.stats.loaded = result.data.byteLength;
      this.stats.total = result.data.byteLength;
      this.stats.chunkCount = 1;
      const durationMs = Math.max(
        1,
        this.stats.loading.end - this.stats.loading.start,
      );
      this.stats.bwEstimate =
        (result.data.byteLength * 8 * 1_000) / durationMs;
      callbacks.onSuccess(
        { url, data: Uint8Array.from(result.data).buffer },
        this.stats,
        context,
        null,
      );
    } catch (error) {
      if (this.aborted || this.timedOut) return;
      this.stats.loading.end = performance.now();
      callbacks.onError(
        {
          code: 0,
          text:
            error instanceof Error
              ? error.message
              : "OpenStreamGrid segment load failed",
        },
        context,
        null,
        this.stats,
      );
    }
  }

  private fallbackToOrigin(
    context: LoaderContext,
    config: LoaderConfiguration,
    callbacks: LoaderCallbacks<LoaderContext>,
  ): void {
    if (this.aborted) return;
    const fallback = new this.fallbackLoaderConstructor(this.hlsConfig);
    this.fallbackLoader = fallback;
    this.stats = fallback.stats;
    fallback.load(context, config, callbacks);
  }

  private isTransportStreamUrl(url: string): boolean {
    try {
      return new URL(url, globalThis.location?.href).pathname.endsWith(".ts");
    } catch {
      return false;
    }
  }

  private extractSegmentName(url: string): string {
    const parts = url.split("/");
    return parts[parts.length - 1] || url;
  }

  private createStats(): LoaderStats {
    return {
      aborted: false,
      loaded: 0,
      total: 0,
      retry: 0,
      chunkCount: 0,
      bwEstimate: 0,
      loading: { start: 0, first: 0, end: 0 },
      parsing: { start: 0, end: 0 },
      buffering: { start: 0, first: 0, end: 0 },
    };
  }
}

const createP2PLoader = (
  plugin: OpenStreamGridHlsPlugin,
  fallbackLoader: HlsConfig["loader"],
): HlsConfig["loader"] =>
  class extends OpenStreamGridLoader {
    constructor(config: HlsConfig) {
      super(config, plugin, fallbackLoader);
    }
  };

/**
 * OpenStreamGrid Hls.js plugin.
 *
 * Attach to an Hls.js instance to enable P2P segment sharing.
 *
 * Usage:
 * ```typescript
 * const plugin = new OpenStreamGridHlsPlugin({
 *   trackerUrl: "ws://tracker:7070/ws",
 *   broadcastId: "test-broadcast",
 *   originBaseUrl: "http://origin:8080/hls",
 * });
 * plugin.attach(hls);
 * ```
 */
export class OpenStreamGridHlsPlugin {
  public readonly cache: SegmentCache;
  public readonly wsClient: WsTrackerClient;
  public readonly stats: PeerTrafficStats;
  private readonly verifier: OriginHashVerifier | undefined;
  private readonly peerTimeoutMs: number;
  private readonly peerId: string;
  private readonly broadcastId: string;
  private readonly trackerUrl: string;
  private readonly peerParticipation: boolean;
  private readonly scheduler: SegmentScheduler;
  private readonly webRtcOptions: Pick<
    HlsjsPluginConfig,
    | "iceServers"
    | "maxUploadConnections"
    | "maxUploadBitrate"
    | "peerConnectionFactory"
  >;
  private readonly onEvent: ((event: SdkEvent) => void) | undefined;
  private readonly inFlightSegments = new Map<string, InFlightSegment>();
  private readonly cacheKeysBySegmentId = new Map<string, string>();
  private originLatencyEstimateMs = DEFAULT_ORIGIN_LATENCY_ESTIMATE_MS;
  private webRtcPeer: BrowserWebRtcPeer | undefined;
  private registered = false;
  private peerSessionToken: string | undefined;
  private registrationRetry: ReturnType<typeof setTimeout> | undefined;
  private sessionRefresh: ReturnType<typeof setTimeout> | undefined;
  private attachedHls: Hls | undefined;
  private originalLoader: HlsConfig["loader"] | undefined;
  private installedLoader: HlsConfig["loader"] | undefined;

  constructor(config: HlsjsPluginConfig) {
    if (config.peerId !== undefined && config.peerId.trim() === "") {
      throw new Error("peerId must not be empty");
    }
    this.peerId = config.peerId?.trim() ?? generatePeerId();
    this.broadcastId = config.broadcastId;
    this.trackerUrl = config.trackerUrl;
    this.peerParticipation = config.peerParticipation !== false;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const plugin = this;
    this.scheduler =
      config.scheduler ??
      new DeadlineAwareScheduler({
        originLatencyEstimator: {
          get estimateMs(): number {
            return plugin.originLatencyEstimateMs;
          },
          reset(): void {
            plugin.originLatencyEstimateMs =
              DEFAULT_ORIGIN_LATENCY_ESTIMATE_MS;
          },
        },
      });
    this.webRtcOptions = {
      ...(config.iceServers ? { iceServers: config.iceServers } : {}),
      ...(config.maxUploadConnections !== undefined
        ? { maxUploadConnections: config.maxUploadConnections }
        : {}),
      ...(config.maxUploadBitrate !== undefined
        ? { maxUploadBitrate: config.maxUploadBitrate }
        : {}),
      ...(config.peerConnectionFactory
        ? { peerConnectionFactory: config.peerConnectionFactory }
        : {}),
    };
    this.peerTimeoutMs = config.peerTimeoutMs ?? DEFAULT_PEER_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.peerTimeoutMs) || this.peerTimeoutMs <= 0) {
      throw new Error("peerTimeoutMs must be a positive integer");
    }
    this.onEvent = config.onEvent;

    this.cache = new SegmentCache(
      config.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES,
    );

    this.stats = {
      bytesDownloadedP2P: 0,
      bytesDownloadedOrigin: 0,
      bytesUploadedP2P: 0,
      p2pRequests: 0,
      p2pSuccesses: 0,
      p2pFailures: 0,
      originRequests: 0,
      integrityFailures: 0,
      fallbacks: 0,
      segmentsCached: 0,
    };

    if (config.verifySegments !== false && !config.originBaseUrl?.trim()) {
      throw new Error(
        "originBaseUrl is required when segment verification is enabled",
      );
    }
    this.verifier =
      config.verifySegments !== false && config.originBaseUrl
        ? new OriginHashVerifier(config.originBaseUrl, config.hashUrlResolver)
        : undefined;

    this.wsClient = new WsTrackerClient({
      trackerUrl: config.trackerUrl,
      broadcastId: config.broadcastId,
      peerId: this.peerId,
      getSegments: () => this.cachedSegmentIds(),
      getStats: () => ({ ...this.stats }),
      reportPeerState: false,
      onWebRtcSignal: (message) => this.webRtcPeer?.handleSignal(message),
      onConnected: () => {
        this.emit({ type: "ws_connected" });
        config.onReady?.();
      },
      onDisconnected: () => {
        this.emit({ type: "ws_disconnected" });
      },
    });
  }

  /**
   * Attach the plugin to an Hls.js instance.
   * Replaces the default loader with OpenStreamGrid's P2P-aware loader.
   */
  attach(hls: Hls): void {
    if (this.attachedHls && this.attachedHls !== hls) {
      throw new Error("Plugin is already attached to another Hls.js instance");
    }
    if (this.attachedHls === hls) return;
    const DefaultLoader = hls.config.loader;
    const loader = createP2PLoader(this, DefaultLoader);
    this.attachedHls = hls;
    this.originalLoader = DefaultLoader;
    this.installedLoader = loader;
    hls.config.loader = loader;

    this.webRtcPeer = this.createWebRtcPeer();

    if (this.peerParticipation) {
      this.startPeerRegistration();
    }
  }

  /**
   * Detach from Hls.js and clean up.
   */
  detach(): void {
    for (const request of this.inFlightSegments.values()) {
      request.controller.abort(new DOMException("Plugin detached", "AbortError"));
    }
    this.wsClient.stop();
    this.webRtcPeer?.stop();
    this.webRtcPeer = undefined;
    try {
      this.scheduler.reset?.();
    } catch (error) {
      logger.warn("scheduler_reset_failed", {
        policy: this.scheduler.policyName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (this.registrationRetry) clearTimeout(this.registrationRetry);
    if (this.sessionRefresh) clearTimeout(this.sessionRefresh);
    this.registrationRetry = undefined;
    this.sessionRefresh = undefined;
    if (this.registered) void this.unregisterPeer();
    if (
      this.attachedHls &&
      this.originalLoader &&
      this.attachedHls.config.loader === this.installedLoader
    ) {
      this.attachedHls.config.loader = this.originalLoader;
    }
    this.attachedHls = undefined;
    this.originalLoader = undefined;
    this.installedLoader = undefined;
  }

  /**
   * Core segment loading logic:
   * 1. Check local cache
   * 2. If miss, ask tracker for peers with this segment
   * 3. Try fetching from best peer
   * 4. On failure, fall back to an HTTP GET from origin
   * 5. Cache the result
   */
  async loadSegment(
    segmentName: string,
    segmentUrl: string,
    signal: AbortSignal,
  ): Promise<{ data: Uint8Array }> {
    if (signal.aborted) throw this.abortReason(signal);
    const cacheKey = this.segmentCacheKey(segmentUrl);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.emit({ type: "cache_hit", segment: segmentName });
      return { data: cached };
    }

    let request = this.inFlightSegments.get(cacheKey);
    if (!request) {
      request = this.startSharedSegment(cacheKey, segmentName, segmentUrl);
    }
    return this.waitForSharedSegment(request, signal);
  }

  private startSharedSegment(
    cacheKey: string,
    segmentName: string,
    segmentUrl: string,
  ): InFlightSegment {
    const controller = new AbortController();
    let request: InFlightSegment;
    const promise = this.loadUncachedSegment(
      segmentName,
      segmentUrl,
      controller.signal,
    ).finally(() => {
      request.settled = true;
      if (this.inFlightSegments.get(cacheKey) === request) {
        this.inFlightSegments.delete(cacheKey);
      }
    });
    request = { controller, promise, consumers: 0, settled: false };
    this.inFlightSegments.set(cacheKey, request);
    return request;
  }

  private async loadUncachedSegment(
    segmentName: string,
    segmentUrl: string,
    signal: AbortSignal,
  ): Promise<{ data: Uint8Array }> {
    this.emit({ type: "cache_miss", segment: segmentName });

    const segmentId = this.segmentPeerId(segmentUrl);
    const candidates = this.peerCandidates(segmentId, segmentName);
    const planned =
      candidates.length > 0
        ? this.planPeerFetch(candidates, (decision) => {
            this.emit({
              type: "scheduler_decision",
              policy: decision.policy,
              mode: decision.mode,
              reason: decision.reason,
              candidateCount: decision.candidateCount,
              selectedPeerCount: decision.selectedPeerCount,
            });
          })
        : undefined;

    if (
      planned &&
      planned.candidates.length > 0 &&
      planned.plan.execution?.strategy === "hedged-origin"
    ) {
      const result = await this.hedgedLoad(
        planned.candidates,
        segmentName,
        segmentUrl,
        planned.plan.execution.originHedgeDelayMs ?? 0,
        signal,
      );
      return this.completeSegmentLoad(
        result,
        segmentName,
        segmentUrl,
        segmentId,
      );
    }

    if (planned && planned.candidates.length > 0) {
      try {
        const result = await this.fetchFromPeers(
          planned.candidates,
          segmentName,
          segmentUrl,
          signal,
        );
        if (result && !signal.aborted) {
          return this.completeSegmentLoad(
            { ...result, source: "p2p" },
            segmentName,
            segmentUrl,
            segmentId,
          );
        }
      } catch {
        this.stats.p2pFailures++;
        this.stats.fallbacks++;
        this.emit({
          type: "origin_fallback",
          segment: segmentName,
          message: "P2P failed, falling back to origin",
        });
      }
    }

    const originResult = await this.fetchVerifiedOrigin(
      segmentName,
      segmentUrl,
      signal,
    );
    return this.completeSegmentLoad(
      originResult,
      segmentName,
      segmentUrl,
      segmentId,
    );
  }

  private waitForSharedSegment(
    request: InFlightSegment,
    signal: AbortSignal,
  ): Promise<{ data: Uint8Array }> {
    if (signal.aborted) {
      return Promise.reject(this.abortReason(signal));
    }
    request.consumers += 1;
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (
        callback: () => void,
      ): void => {
        if (finished) return;
        finished = true;
        signal.removeEventListener("abort", onAbort);
        request.consumers -= 1;
        callback();
        if (request.consumers === 0 && !request.settled) {
          request.controller.abort(
            new DOMException("All segment consumers aborted", "AbortError"),
          );
        }
      };
      const onAbort = (): void => finish(() => reject(this.abortReason(signal)));
      signal.addEventListener("abort", onAbort, { once: true });
      request.promise.then(
        (result) => finish(() => resolve(result)),
        (error: unknown) => finish(() => reject(error)),
      );
      if (signal.aborted) onAbort();
    });
  }

  private abortReason(signal: AbortSignal): unknown {
    return signal.reason ?? new DOMException("Aborted", "AbortError");
  }

  /**
   * Try fetching a segment from peers in order.
   * Probes the highest-ranked peers in parallel and uses the first success.
   * returns the first success.
   */
  private async fetchFromPeers(
    candidates: PeerCandidate[],
    segmentName: string,
    segmentUrl: string,
    signal: AbortSignal,
  ): Promise<PeerFetchResult | null> {
    if (candidates.length === 0) return null;
    this.stats.p2pRequests++;
    const topPeers = candidates.slice(0, MAX_PARALLEL_PEER_PROBES);
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    try {
      const pending = new Map(
        topPeers.map((candidate, index) => [
          index,
          this.fetchPeerAttempt(
            index,
            candidate,
            segmentName,
            segmentUrl,
            controller.signal,
          ),
        ]),
      );
      while (pending.size > 0) {
        const result = await Promise.race(pending.values());
        pending.delete(result.index);
        if (result.data) return { data: result.data, peerId: result.peerId };
      }
      return null;
    } finally {
      controller.abort();
      signal.removeEventListener("abort", onAbort);
    }
  }

  private planPeerFetch(
    candidates: PeerCandidate[],
    onDecision?: (decision: SchedulerDecision) => void,
  ): PlannedPeerFetch | undefined {
    const context = this.schedulingContext(candidates);
    try {
      this.scheduler.reconcilePeers?.(context.candidates);
    } catch (error) {
      this.emit({
        type: "scheduler_warning",
        policy: this.scheduler.policyName,
        code: "invalid_plan",
        message: `Scheduler reconciliation failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        segment: context.segmentId,
      });
      return undefined;
    }
    const { plan, warnings } = planSegmentSafely(this.scheduler, context);
    for (const warning of warnings) {
      this.emit({
        type: "scheduler_warning",
        policy: this.scheduler.policyName,
        code: warning.code,
        message: warning.message,
        segment: context.segmentId,
      });
    }
    onDecision?.(this.schedulerDecision(plan, candidates.length));
    const candidatesById = new Map(
      candidates.map((candidate) => [candidate.peer.id, candidate]),
    );
    const plannedPeerIds =
      plan.mode === "single-peer" || plan.mode === "parallel-peers"
        ? plan.peerIds
        : [];
    const topPeers = plannedPeerIds
      .slice(0, MAX_PARALLEL_PEER_PROBES)
      .map((peerId) => candidatesById.get(peerId))
      .filter((candidate): candidate is PeerCandidate => candidate !== undefined);
    return { plan, candidates: topPeers };
  }

  private schedulingContext(
    candidates: readonly PeerCandidate[],
  ): SegmentSchedulingContext {
    const schedulingPeers: SchedulingPeer[] = candidates.map(
      ({ peer, segmentId }, originalIndex) => ({
        id: peer.id,
        latencyMs: peer.latencyMs,
        successRate: peer.successRate,
        uploadBandwidthBps: peer.uploadBandwidthBps ?? 0,
        trustScore: peer.trustScore,
        segments: peer.segments.includes(segmentId)
          ? peer.segments
          : [...peer.segments, segmentId],
        originalIndex,
      }),
    );
    return {
      segmentId: candidates[0]?.segmentId ?? "",
      candidates: schedulingPeers,
      selfPeerId: this.peerId,
      maximumParallelism: MAX_PARALLEL_PEER_PROBES,
    };
  }

  private schedulerDecision(
    plan: SegmentSchedulingPlan,
    candidateCount: number,
  ): SchedulerDecision {
    return {
      policy: plan.policy,
      mode: plan.mode,
      reason: plan.reason,
      candidateCount,
      eligibleCount: plan.rankedPeers.length,
      selectedPeerCount: plan.peerIds.length,
    };
  }

  private async fetchPeerAttempt(
    index: number,
    candidate: PeerCandidate,
    segmentName: string,
    segmentUrl: string,
    signal: AbortSignal,
  ): Promise<PeerFetchAttempt> {
    try {
      const data = await this.fetchFromPeer(
        candidate,
        this.peerTimeoutMs,
        signal,
      );
      await this.verifySegment(segmentName, segmentUrl, data, "peer");
      return { index, peerId: candidate.peer.id, data };
    } catch {
      return { index };
    }
  }

  /** Fetch a segment through browser WebRTC or the Node peer HTTP endpoint. */
  private async fetchFromPeer(
    candidate: PeerCandidate,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const { peer, segmentId } = candidate;
    const webRtcOnly =
      peer.address.startsWith("webrtc:") ||
      peer.metadata?.transport === "webrtc";
    if (this.webRtcPeer && webRtcOnly) {
      try {
        return await this.webRtcPeer.requestSegment(
          peer.id,
          segmentId,
          signal,
          peer.uploadBandwidthBps,
        );
      } catch {
        throw new Error("WebRTC peer unavailable");
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const onAbort = () => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();

    try {
      const peerBaseUrl = validatePeerHttpBaseUrl(peer.address);
      if (globalThis.location?.protocol === "https:" && peerBaseUrl.protocol === "http:") {
        throw new Error("Mixed-content HTTP peer transport is unavailable on HTTPS pages");
      }
      const url = new URL(
        `/segments/${encodeURIComponent(this.segmentFileName(segmentId))}`,
        peerBaseUrl,
      );
      const response = await fetch(url, {
        signal: controller.signal,
        method: "GET",
        ...(peer.metadata?.uploadToken
          ? {
              headers: {
                Authorization: `Bearer ${peer.metadata.uploadToken}`,
              },
            }
          : {}),
      });
      if (!response.ok) {
        throw new Error(`Peer returned HTTP ${response.status}`);
      }
      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > 16 * 1024 * 1024) {
        throw new Error("Peer segment exceeds the 16 MiB safety limit");
      }
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > 16 * 1024 * 1024) {
        throw new Error("Peer segment exceeds the 16 MiB safety limit");
      }
      return new Uint8Array(buffer);
    } finally {
      clearTimeout(timeoutId);
      signal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Fallback fetch from origin via HTTP GET.
   */
  private async fetchFromOrigin(
    url: string,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    this.stats.originRequests++;
    const response = await fetch(url, { signal, method: "GET" });
    if (!response.ok) {
      throw new Error(`Origin returned HTTP ${response.status}`);
    }
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }

  private async fetchVerifiedOrigin(
    segmentName: string,
    segmentUrl: string,
    signal: AbortSignal,
  ): Promise<SegmentLoadResult> {
    const startedAt = performance.now();
    const data = await this.fetchFromOrigin(segmentUrl, signal);
    await this.verifySegment(segmentName, segmentUrl, data, "origin");
    this.observeOriginLatency(performance.now() - startedAt);
    return { source: "origin", data };
  }

  private async verifySegment(
    segmentName: string,
    segmentUrl: string,
    data: Uint8Array,
    source: "peer" | "origin",
  ): Promise<void> {
    if (!this.verifier) return;
    const verification = await this.verifier.verifyUrl(segmentUrl, data);
    if (verification.valid) return;
    this.stats.integrityFailures++;
    this.emit({
      type: "integrity_fail",
      segment: segmentName,
      message: `Expected ${verification.expectedHash}, got ${verification.actualHash}`,
    });
    throw new Error(
      source === "origin"
        ? "Origin segment integrity check failed"
        : "Segment integrity check failed",
    );
  }

  private completeSegmentLoad(
    result: SegmentLoadResult,
    segmentName: string,
    segmentUrl: string,
    segmentId: string,
  ): { data: Uint8Array } {
    if (this.verifier) {
      this.emit({ type: "integrity_ok", segment: segmentName });
    }
    if (result.source === "p2p") {
      this.stats.bytesDownloadedP2P += result.data.byteLength;
      this.stats.p2pSuccesses++;
      this.emit({
        type: "peer_fetched",
        segment: segmentName,
        peerId: result.peerId,
      });
    } else {
      this.stats.bytesDownloadedOrigin += result.data.byteLength;
      this.emit({
        type: "origin_fallback",
        segment: segmentName,
        message: "Served from origin",
      });
    }
    this.cacheSegment(cacheKeyFrom(segmentUrl), segmentId, result.data);
    return { data: result.data };
  }

  private async hedgedLoad(
    candidates: PeerCandidate[],
    segmentName: string,
    segmentUrl: string,
    hedgeDelayMs: number,
    signal: AbortSignal,
  ): Promise<SegmentLoadResult> {
    const peerController = new AbortController();
    const originController = new AbortController();
    const abortBoth = (): void => {
      peerController.abort(this.abortReason(signal));
      originController.abort(this.abortReason(signal));
    };
    signal.addEventListener("abort", abortBoth, { once: true });
    if (signal.aborted) abortBoth();

    const peerAttempt = this.captureHedgedLoad("p2p", async () => {
      const result = await this.fetchFromPeers(
        candidates,
        segmentName,
        segmentUrl,
        peerController.signal,
      );
      if (!result) throw new Error("P2P probes failed");
      return { ...result, source: "p2p" };
    });
    const originAttempt = this.captureHedgedLoad("origin", async () => {
      await this.waitForHedge(hedgeDelayMs, originController.signal);
      return this.fetchVerifiedOrigin(
        segmentName,
        segmentUrl,
        originController.signal,
      );
    });
    const pending = new Map([
      ["p2p", peerAttempt],
      ["origin", originAttempt],
    ]);
    const failures: unknown[] = [];
    let peerFailed = false;

    try {
      while (pending.size > 0) {
        const attempt = await Promise.race(pending.values());
        pending.delete(attempt.source);
        if (signal.aborted) throw this.abortReason(signal);
        if (attempt.status === "rejected") {
          failures.push(attempt.error);
          if (attempt.source === "p2p") {
            peerFailed = true;
            this.stats.p2pFailures++;
            this.stats.fallbacks++;
          }
          continue;
        }

        if (attempt.source === "p2p") {
          originController.abort(
            new DOMException("P2P hedge won", "AbortError"),
          );
        } else {
          peerController.abort(
            new DOMException("Origin hedge won", "AbortError"),
          );
          if (!peerFailed) this.stats.fallbacks++;
        }
        return attempt.result;
      }
      throw new Error(
        `P2P and Origin failed for '${segmentName}': ${failures
          .map((error) =>
            error instanceof Error ? error.message : String(error),
          )
          .join("; ")}`,
      );
    } finally {
      peerController.abort(
        new DOMException("Hedged load settled", "AbortError"),
      );
      originController.abort(
        new DOMException("Hedged load settled", "AbortError"),
      );
      signal.removeEventListener("abort", abortBoth);
    }
  }

  private async captureHedgedLoad(
    source: SegmentLoadResult["source"],
    load: () => Promise<SegmentLoadResult>,
  ): Promise<HedgedLoadAttempt> {
    try {
      return { source, status: "fulfilled", result: await load() };
    } catch (error) {
      return { source, status: "rejected", error };
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

  private observeOriginLatency(observedMs: number): void {
    if (!Number.isFinite(observedMs) || observedMs < 0) return;
    this.originLatencyEstimateMs =
      ORIGIN_LATENCY_EMA_ALPHA * observedMs +
      (1 - ORIGIN_LATENCY_EMA_ALPHA) * this.originLatencyEstimateMs;
  }

  private emit(event: SdkEvent): void {
    try {
      this.onEvent?.(event);
    } catch (error) {
      logger.error("event_callback_failed", error);
    }
  }

  private segmentCacheKey(segmentUrl: string): string {
    return cacheKeyFrom(segmentUrl);
  }

  private segmentPeerId(segmentUrl: string): string {
    try {
      const url = new URL(segmentUrl, globalThis.location?.href);
      const pathname = url.pathname.replace(/^\/+/, "");
      if (!url.search) return pathname;
      const suffix = urlFingerprint(url.search);
      return pathname.endsWith(".ts")
        ? `${pathname.slice(0, -3)}~q-${suffix}.ts`
        : `${pathname}~q-${suffix}`;
    } catch {
      return segmentUrl.replace(/^\/+/, "");
    }
  }

  private segmentFileName(segmentId: string): string {
    const parts = segmentId.split("/");
    return parts[parts.length - 1] ?? segmentId;
  }

  private peerCandidates(segmentId: string, segmentName: string): PeerCandidate[] {
    const candidates = new Map<string, PeerCandidate>();
    for (const peer of this.wsClient.getPeersWithSegment(segmentId)) {
      if (peer.id !== this.peerId) candidates.set(peer.id, { peer, segmentId });
    }
    for (const peer of this.wsClient.getPeersWithSegment(segmentName)) {
      if (peer.id !== this.peerId && !candidates.has(peer.id)) {
        candidates.set(peer.id, { peer, segmentId: segmentName });
      }
    }
    return [...candidates.values()];
  }

  private cacheSegment(cacheKey: string, segmentId: string, data: Uint8Array): void {
    if (!this.cache.set(cacheKey, data)) return;
    this.cacheKeysBySegmentId.set(segmentId, cacheKey);
    this.stats.segmentsCached = this.cache.size;
    if (this.registered) this.wsClient.reportSegments();
  }

  private cachedSegmentIds(): string[] {
    for (const [segmentId, cacheKey] of this.cacheKeysBySegmentId) {
      if (!this.cache.has(cacheKey)) this.cacheKeysBySegmentId.delete(segmentId);
    }
    return [...this.cacheKeysBySegmentId.keys()];
  }

  private createWebRtcPeer(): BrowserWebRtcPeer | undefined {
    if (typeof RTCPeerConnection === "undefined" && !this.webRtcOptions.peerConnectionFactory) {
      return undefined;
    }
    return new BrowserWebRtcPeer({
      broadcastId: this.broadcastId,
      peerId: this.peerId,
      sendSignal: (message) => this.wsClient.sendWebRtcSignal(message),
      segmentProvider: (segmentId) => {
        const cacheKey = this.cacheKeysBySegmentId.get(segmentId);
        return cacheKey ? this.cache.get(cacheKey) : undefined;
      },
      onUpload: (bytes) => {
        this.stats.bytesUploadedP2P += bytes;
      },
      timeoutMs: this.peerTimeoutMs,
      ...this.webRtcOptions,
    });
  }

  private async registerPeer(): Promise<void> {
    const response = await fetch(this.peerCollectionUrl(), {
      method: "POST",
      headers: this.trackerHeaders(true),
      body: JSON.stringify({
        id: this.peerId,
        address: `webrtc://${this.peerId}`,
        uploadBandwidthBps: this.webRtcOptions.maxUploadBitrate ?? 1_000_000,
        metadata: { runtime: "browser", transport: "webrtc" },
      }),
    });
    if (!response.ok) throw new Error(`Tracker registration returned HTTP ${response.status}`);
    const payload: unknown = await response.json();
    if (
      payload === null ||
      typeof payload !== "object" ||
      typeof (payload as Record<string, unknown>).sessionToken !== "string" ||
      typeof (payload as Record<string, unknown>).expiresAt !== "string" ||
      !Number.isFinite(Date.parse((payload as { expiresAt: string }).expiresAt))
    ) {
      throw new Error("Tracker registration did not return a peer session token");
    }
    this.peerSessionToken = (payload as { sessionToken: string }).sessionToken;
    this.scheduleSessionRefresh(Date.parse((payload as { expiresAt: string }).expiresAt));
    this.wsClient.setSessionToken(this.peerSessionToken);
    this.registered = true;
    if (!this.attachedHls) {
      await this.unregisterPeer();
      return;
    }
    await this.wsClient.start();
    this.wsClient.enablePeerStateReporting();
  }

  private startPeerRegistration(): void {
    void this.registerPeer().catch((error: unknown) => {
      logger.warn("browser_peer_registration_failed", {
        error: error instanceof Error ? error.message : String(error),
        fallback: "origin",
      });
      if (!this.attachedHls || this.registrationRetry) return;
      this.registrationRetry = setTimeout(() => {
        this.registrationRetry = undefined;
        if (this.attachedHls && !this.registered) this.startPeerRegistration();
      }, 5_000);
    });
  }

  private async unregisterPeer(): Promise<void> {
    this.registered = false;
    if (this.sessionRefresh) clearTimeout(this.sessionRefresh);
    this.sessionRefresh = undefined;
    try {
      await fetch(`${this.peerCollectionUrl()}/${encodeURIComponent(this.peerId)}`, {
        method: "DELETE",
        headers: this.trackerHeaders(false),
        keepalive: true,
      });
    } catch {
      // The tracker expires stale peers if page teardown prevents delivery.
    }
    this.peerSessionToken = undefined;
  }

  private scheduleSessionRefresh(expiresAt: number): void {
    if (this.sessionRefresh) clearTimeout(this.sessionRefresh);
    const remainingMs = Math.max(1_000, expiresAt - Date.now() - 60_000);
    this.sessionRefresh = setTimeout(() => {
      this.sessionRefresh = undefined;
      if (remainingMs > MAX_TIMER_DELAY_MS) {
        this.scheduleSessionRefresh(expiresAt);
        return;
      }
      if (!this.attachedHls || !this.registered) return;
      void this.registerPeer().catch((error: unknown) => {
        logger.warn("browser_peer_session_refresh_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        if (this.attachedHls && this.registered) {
          this.scheduleSessionRefresh(Date.now() + 65_000);
        }
      });
    }, Math.min(MAX_TIMER_DELAY_MS, remainingMs));
  }

  private peerCollectionUrl(): string {
    const url = new URL(this.trackerUrl);
    if (url.protocol === "ws:") url.protocol = "http:";
    if (url.protocol === "wss:") url.protocol = "https:";
    url.pathname = `/api/v1/broadcasts/${encodeURIComponent(this.broadcastId)}/peers`;
    url.search = "";
    url.hash = "";
    return url.href;
  }

  private trackerHeaders(json: boolean): Headers {
    const headers = new Headers();
    if (json) headers.set("Content-Type", "application/json");
    if (this.peerSessionToken) {
      headers.set("Authorization", `Bearer ${this.peerSessionToken}`);
    }
    return headers;
  }
}

const cacheKeyFrom = (segmentUrl: string): string => {
  try {
    const url = new URL(segmentUrl, globalThis.location?.href);
    url.hash = "";
    return url.href;
  } catch {
    return segmentUrl;
  }
};

const urlFingerprint = (value: string): string => {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
};

/** Generate a random peer ID using Web Crypto API. */
function generatePeerId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
