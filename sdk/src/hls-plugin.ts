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

import type Hls from "hls.js";
import type {
  HlsConfig,
  Loader,
  LoaderCallbacks,
  LoaderConfiguration,
  LoaderContext,
  LoaderStats,
} from "hls.js";
import { SegmentCache } from "./cache.js";
import { OriginHashVerifier } from "./verifier.js";
import { WsTrackerClient } from "./ws-client.js";
import type {
  HlsjsPluginConfig,
  PeerInfo,
  PeerTrafficStats,
  SdkEvent,
} from "./types.js";

// Default max bytes: 100 MB
const DEFAULT_MAX_CACHE_BYTES = 100 * 1024 * 1024;
const DEFAULT_PEER_TIMEOUT_MS = 3_000;

type PeerFetchAttempt =
  | { index: number; data: Uint8Array }
  | { index: number; data?: never };

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
      config,
      callbacks,
      this.abortController.signal,
    );
  }

  // ---- internal ----

  private async loadThroughGrid(
    segmentName: string,
    url: string,
    context: LoaderContext,
    config: LoaderConfiguration,
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
    } catch {
      if (!this.aborted) this.fallbackToOrigin(context, config, callbacks);
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
  private readonly onEvent: ((event: SdkEvent) => void) | undefined;

  constructor(config: HlsjsPluginConfig) {
    this.peerId = config.peerId ?? generatePeerId();
    this.peerTimeoutMs = config.peerTimeoutMs ?? DEFAULT_PEER_TIMEOUT_MS;
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

    this.verifier =
      config.verifySegments !== false
        ? new OriginHashVerifier(
            config.originBaseUrl ?? "http://origin:8080",
          )
        : undefined;

    this.wsClient = new WsTrackerClient({
      trackerUrl: config.trackerUrl,
      broadcastId: config.broadcastId,
      peerId: this.peerId,
      getSegments: () => this.cache.keys(),
      getStats: () => ({ ...this.stats }),
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
    const DefaultLoader = hls.config.loader;

    // Register the custom loader
    hls.config.loader = createP2PLoader(this, DefaultLoader);

    // Start WebSocket connection
    this.wsClient.start().catch((error: unknown) => {
      console.warn(
        "[OpenStreamGrid] Failed to connect to tracker, continuing with origin-only",
        error,
      );
    });
  }

  /**
   * Detach from Hls.js and clean up.
   */
  detach(): void {
    this.wsClient.stop();
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
    // 1. Check cache
    const cached = this.cache.get(segmentName);
    if (cached) {
      this.emit({ type: "cache_hit", segment: segmentName });
      return { data: cached };
    }
    this.emit({ type: "cache_miss", segment: segmentName });

    // 2. Try P2P first
    const peers = this.wsClient.getPeersWithSegment(segmentName);
    if (peers.length > 0) {
      try {
        const result = await this.fetchFromPeers(
          segmentName,
          peers,
          signal,
        );
        if (result && !signal.aborted) {
          this.stats.bytesDownloadedP2P += result.byteLength;
          this.stats.p2pRequests++;
          this.stats.p2pSuccesses++;

          // Verify integrity
          if (this.verifier) {
            const verification = await this.verifier.verify(
              segmentName,
              result,
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

          // Cache it
          this.cache.set(segmentName, result);
          this.stats.segmentsCached = this.cache.size;
          this.wsClient.reportSegments();

          this.emit({
            type: "peer_fetched",
            segment: segmentName,
            ...(peers[0] ? { peerId: peers[0].id } : {}),
          });

          return { data: result };
        }
      } catch {
        // P2P failed, fall through to origin
        this.stats.p2pFailures++;
        this.stats.fallbacks++;
        this.emit({
          type: "origin_fallback",
          segment: segmentName,
          message: "P2P failed, falling back to origin",
        });
      }
    }

    // 3. Fallback to origin
    const originData = await this.fetchFromOrigin(segmentUrl, signal);
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");

    this.stats.bytesDownloadedOrigin += originData.byteLength;
    this.stats.originRequests++;

    // Cache it
    this.cache.set(segmentName, originData);
    this.stats.segmentsCached = this.cache.size;
    this.wsClient.reportSegments();

    this.emit({
      type: "origin_fallback",
      segment: segmentName,
      message: "Served from origin",
    });

    return { data: originData };
  }

  /**
   * Try fetching a segment from peers in order.
   * Parallel probes the top 3 peers (sorted by trust score / latency),
   * returns the first success.
   */
  private async fetchFromPeers(
    segmentName: string,
    peers: PeerInfo[],
    signal: AbortSignal,
  ): Promise<Uint8Array | null> {
    const sorted = [...peers].sort((a, b) => {
      if (b.trustScore !== a.trustScore) return b.trustScore - a.trustScore;
      return a.latencyMs - b.latencyMs;
    });

    const topPeers = sorted.slice(0, 3);
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    try {
      const pending = new Map(
        topPeers.map((peer, index) => [
          index,
          this.fetchPeerAttempt(
            index,
            peer,
            segmentName,
            controller.signal,
          ),
        ]),
      );
      while (pending.size > 0) {
        const result = await Promise.race(pending.values());
        pending.delete(result.index);
        if (result.data) return result.data;
      }
      return null;
    } finally {
      controller.abort();
      signal.removeEventListener("abort", onAbort);
    }
  }

  private async fetchPeerAttempt(
    index: number,
    peer: PeerInfo,
    segmentName: string,
    signal: AbortSignal,
  ): Promise<PeerFetchAttempt> {
    try {
      const data = await this.fetchFromPeer(
        peer,
        segmentName,
        this.peerTimeoutMs,
        signal,
      );
      return { index, data };
    } catch {
      return { index };
    }
  }

  /**
   * Fetch a single segment from a peer via HTTP.
   * Peer address is `http://<peer.address>/segments/<segmentName>`.
   */
  private async fetchFromPeer(
    peer: PeerInfo,
    segmentName: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const onAbort = () => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      const url = `http://${peer.address}/segments/${encodeURIComponent(segmentName)}`;
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
      console.error("[OpenStreamGrid] onEvent callback failed", error);
    }
  }
}

/** Generate a random peer ID using Web Crypto API. */
function generatePeerId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
