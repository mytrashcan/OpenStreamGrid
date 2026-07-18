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

import { createLogger } from "@openstreamgrid/common";
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
const MAX_PARALLEL_PEER_PROBES = 3;
const logger = createLogger("sdk");

type PeerFetchAttempt =
  | { index: number; peerId: string; data: Uint8Array }
  | { index: number; data?: never };

interface PeerFetchResult {
  data: Uint8Array;
  peerId: string;
}

interface PeerCandidate {
  peer: PeerInfo;
  segmentId: string;
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
    void this.loadThroughGrid(
      segmentName,
      url,
      context,
      callbacks,
      this.abortController.signal,
    );
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
      if (this.aborted) return;
      this.stats.loading.end = performance.now();
      this.stats.loaded = result.data.byteLength;
      this.stats.total = result.data.byteLength;
      callbacks.onSuccess(
        { url, data: Uint8Array.from(result.data).buffer },
        this.stats,
        context,
        null,
      );
    } catch (error) {
      if (this.aborted) return;
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
  private readonly trackerApiKey: string | undefined;
  private readonly peerParticipation: boolean;
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
  private webRtcPeer: BrowserWebRtcPeer | undefined;
  private registered = false;
  private registrationRetry: ReturnType<typeof setTimeout> | undefined;
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
    this.trackerApiKey = config.trackerApiKey?.trim() || undefined;
    this.peerParticipation = config.peerParticipation !== false;
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
        ? new OriginHashVerifier(config.originBaseUrl)
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

    this.wsClient.start().catch((error: unknown) => {
      logger.warn("tracker_connection_failed", {
        error: error instanceof Error ? error.message : String(error),
        fallback: "origin",
      });
    });
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
    if (this.registrationRetry) clearTimeout(this.registrationRetry);
    this.registrationRetry = undefined;
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
    if (candidates.length > 0) {
      this.stats.p2pRequests++;
      try {
        const result = await this.fetchFromPeers(
          candidates,
          signal,
        );
        if (result && !signal.aborted) {
          this.stats.bytesDownloadedP2P += result.data.byteLength;
          this.stats.p2pSuccesses++;

          if (this.verifier) {
            const verification = await this.verifier.verifyUrl(
              segmentUrl,
              result.data,
            );
            if (!verification.valid) {
              this.stats.integrityFailures++;
              this.emit({
                type: "integrity_fail",
                segment: segmentName,
                message: `Expected ${verification.expectedHash}, got ${verification.actualHash}`,
              });
              throw new Error("Segment integrity check failed");
            }
            this.emit({ type: "integrity_ok", segment: segmentName });
          }

          this.cacheSegment(cacheKeyFrom(segmentUrl), segmentId, result.data);

          this.emit({
            type: "peer_fetched",
            segment: segmentName,
            peerId: result.peerId,
          });

          return { data: result.data };
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

    const originData = await this.fetchFromOrigin(segmentUrl, signal);
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");

    this.stats.bytesDownloadedOrigin += originData.byteLength;
    this.stats.originRequests++;

    if (this.verifier) {
      const verification = await this.verifier.verifyUrl(segmentUrl, originData);
      if (!verification.valid) {
        this.stats.integrityFailures++;
        this.emit({
          type: "integrity_fail",
          segment: segmentName,
          message: `Expected ${verification.expectedHash}, got ${verification.actualHash}`,
        });
        throw new Error("Origin segment integrity check failed");
      }
      this.emit({ type: "integrity_ok", segment: segmentName });
    }

    this.cacheSegment(cacheKeyFrom(segmentUrl), segmentId, originData);

    this.emit({
      type: "origin_fallback",
      segment: segmentName,
      message: "Served from origin",
    });

    return { data: originData };
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
    signal: AbortSignal,
  ): Promise<PeerFetchResult | null> {
    const sorted = [...candidates].sort((a, b) => {
      if (b.peer.trustScore !== a.peer.trustScore) {
        return b.peer.trustScore - a.peer.trustScore;
      }
      return a.peer.latencyMs - b.peer.latencyMs;
    });

    const topPeers = sorted.slice(0, MAX_PARALLEL_PEER_PROBES);
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

  private async fetchPeerAttempt(
    index: number,
    candidate: PeerCandidate,
    signal: AbortSignal,
  ): Promise<PeerFetchAttempt> {
    try {
      const data = await this.fetchFromPeer(
        candidate,
        this.peerTimeoutMs,
        signal,
      );
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
      const url = new URL(
        `/segments/${encodeURIComponent(this.segmentFileName(segmentId))}`,
        peer.address,
      );
      const response = await fetch(url, {
        signal: controller.signal,
        method: "GET",
      });
      if (!response.ok) {
        throw new Error(`Peer returned HTTP ${response.status}`);
      }
      const buffer = await response.arrayBuffer();
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
    const response = await fetch(url, { signal, method: "GET" });
    if (!response.ok) {
      throw new Error(`Origin returned HTTP ${response.status}`);
    }
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
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
      return new URL(segmentUrl, globalThis.location?.href).pathname.replace(/^\/+/, "");
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
    this.registered = true;
    if (!this.attachedHls) {
      await this.unregisterPeer();
      return;
    }
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
    try {
      await fetch(`${this.peerCollectionUrl()}/${encodeURIComponent(this.peerId)}`, {
        method: "DELETE",
        headers: this.trackerHeaders(false),
        keepalive: true,
      });
    } catch {
      // The tracker expires stale peers if page teardown prevents delivery.
    }
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
    if (this.trackerApiKey) headers.set("X-API-Key", this.trackerApiKey);
    return headers;
  }
}

const cacheKeyFrom = (segmentUrl: string): string => {
  try {
    const url = new URL(segmentUrl, globalThis.location?.href);
    return `${url.origin}${url.pathname}`;
  } catch {
    return segmentUrl;
  }
};

/** Generate a random peer ID using Web Crypto API. */
function generatePeerId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
