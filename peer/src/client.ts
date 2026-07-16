#!/usr/bin/env node
import { hostname } from "node:os";
import { pathToFileURL } from "node:url";
import type { Peer, PeerFailureReport, PeerJoinRequest } from "@openstreamgrid/common";
import { SegmentCache } from "./cache.js";
import {
  HybridSegmentFetcher,
  type PeerDirectory,
} from "./fetcher.js";
import { StatsReporter, TrafficStats } from "./stats.js";
import { UploadServer } from "./uploader.js";
import { OriginHashVerifier, type FetchFunction } from "./verifier.js";

const DEFAULT_TRACKER_URL = "http://tracker:7070";
const DEFAULT_BROADCAST_ID = "live";
const DEFAULT_CACHE_SIZE = 200 * 1_000_000;
const DEFAULT_UPLOAD_SPEED_BPS = 1_000_000;
const DEFAULT_MAX_CONNECTIONS = 3;
const DEFAULT_PLAYLIST_POLL_MS = 500;

interface PeerConfiguration {
  trackerUrl: string;
  broadcastId: string;
  originBaseUrl: URL;
  playlistUrl: URL;
  peerAddress: string;
  peerId: string;
  cacheSizeBytes: number;
  maxUploadSpeedBps: number;
  maxConnections: number;
  playlistPollMs: number;
}

class TrackerClient implements PeerDirectory {
  constructor(
    private readonly trackerUrl: string,
    private readonly broadcastId: string,
    private readonly peerId: string,
    private readonly fetchImpl: FetchFunction = fetch,
  ) {}

  async join(request: PeerJoinRequest): Promise<Peer> {
    return this.requestJson<Peer>(this.peersUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  }

  async leave(): Promise<void> {
    const response = await this.fetchImpl(
      new URL(`${this.peersUrl().pathname}/${encodeURIComponent(this.peerId)}`, this.trackerUrl),
      { method: "DELETE" },
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(`Tracker leave returned HTTP ${response.status}`);
    }
  }

  async listPeers(segmentName: string): Promise<Peer[]> {
    const endpoint = this.peersUrl();
    endpoint.searchParams.set("segment", segmentName);
    const result = await this.requestJson<{ peers: Peer[] }>(endpoint);
    if (!Array.isArray(result.peers)) throw new Error("Tracker returned an invalid peer list");
    return result.peers;
  }

  async reportFailure(
    peerId: string,
    reason: PeerFailureReport["reason"],
  ): Promise<void> {
    const endpoint = new URL(
      `${this.peersUrl().pathname}/${encodeURIComponent(peerId)}/reports`,
      this.trackerUrl,
    );
    await this.requestJson(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reporterId: this.peerId, reason }),
    });
  }

  private peersUrl(): URL {
    return new URL(
      `/api/v1/broadcasts/${encodeURIComponent(this.broadcastId)}/peers`,
      this.trackerUrl,
    );
  }

  private async requestJson<T = unknown>(
    endpoint: URL,
    init?: RequestInit,
  ): Promise<T> {
    const response = await this.fetchImpl(endpoint, init);
    if (!response.ok) {
      throw new Error(`Tracker returned HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  }
}

const delay = async (milliseconds: number, signal: AbortSignal): Promise<void> => {
  await new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
};

const playlistSegments = (playlist: string, playlistUrl: URL): string[] =>
  playlist
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => pathName(new URL(line, playlistUrl)))
    .filter((name): name is string => name !== undefined);

const pathName = (url: URL): string | undefined => {
  const name = url.pathname.split("/").at(-1);
  return name && /^[-A-Za-z0-9_.]+\.ts$/.test(name) ? name : undefined;
};

class PeerApplication {
  private readonly cache: SegmentCache;
  private readonly stats = new TrafficStats();
  private readonly tracker: TrackerClient;
  private readonly reporter: StatsReporter;
  private readonly uploader: UploadServer;
  private readonly fetcher: HybridSegmentFetcher;

  constructor(private readonly configuration: PeerConfiguration) {
    this.cache = new SegmentCache(configuration.cacheSizeBytes);
    this.tracker = new TrackerClient(
      configuration.trackerUrl,
      configuration.broadcastId,
      configuration.peerId,
    );
    this.reporter = new StatsReporter({
      trackerUrl: configuration.trackerUrl,
      broadcastId: configuration.broadcastId,
      peerId: configuration.peerId,
      uploadBandwidthBps: configuration.maxUploadSpeedBps,
      stats: this.stats,
      cache: this.cache,
    });
    this.uploader = new UploadServer({
      cache: this.cache,
      stats: this.stats,
      maxUploadSpeedBps: configuration.maxUploadSpeedBps,
      maxConnections: configuration.maxConnections,
      ready: () => this.cache.size > 0,
    });
    const verifier = new OriginHashVerifier(configuration.originBaseUrl);
    this.fetcher = new HybridSegmentFetcher({
      selfPeerId: configuration.peerId,
      originBaseUrl: configuration.originBaseUrl,
      cache: this.cache,
      directory: this.tracker,
      verifier,
      stats: this.stats,
    });
  }

  async run(signal: AbortSignal): Promise<void> {
    const address = new URL(this.configuration.peerAddress);
    const port = Number.parseInt(address.port || "80", 10);
    await this.uploader.start(port);
    try {
      await this.tracker.join({
        id: this.configuration.peerId,
        address: this.configuration.peerAddress,
        uploadBandwidthBps: this.configuration.maxUploadSpeedBps,
      });
      await this.reporter.report();
      this.reporter.start();
      console.log(
        JSON.stringify({
          event: "peer_started",
          peerId: this.configuration.peerId,
          address: this.configuration.peerAddress,
        }),
      );
      await this.consumePlaylist(signal);
    } finally {
      await this.shutdown();
    }
  }

  private async consumePlaylist(signal: AbortSignal): Promise<void> {
    const processed = new Set<string>();
    while (!signal.aborted) {
      try {
        const response = await fetch(this.configuration.playlistUrl, { signal });
        if (!response.ok) {
          throw new Error(`Playlist returned HTTP ${response.status}`);
        }
        const segments = playlistSegments(
          await response.text(),
          this.configuration.playlistUrl,
        );
        const current = new Set(segments);
        for (const segment of processed) {
          if (!current.has(segment)) processed.delete(segment);
        }
        for (const [index, segmentName] of segments.entries()) {
          if (signal.aborted || processed.has(segmentName)) continue;
          const result = await this.fetcher.fetchSegment(
            segmentName,
            segments.length - index - 1,
          );
          processed.add(segmentName);
          await this.reporter.reportSegments();
          console.log(
            JSON.stringify({
              event: "segment_fetched",
              peerId: this.configuration.peerId,
              segment: segmentName,
              source: result.source,
              bytes: result.data.byteLength,
            }),
          );
        }
      } catch (error) {
        if (!signal.aborted) console.error("playlist processing failed", error);
      }
      await delay(this.configuration.playlistPollMs, signal);
    }
  }

  private async shutdown(): Promise<void> {
    console.log(
      JSON.stringify({ event: "peer_stopping", peerId: this.configuration.peerId }),
    );
    const results = await Promise.allSettled([
      this.reporter.stop(),
      this.uploader.stop(),
    ]);
    for (const result of results) {
      if (result.status === "rejected") {
        console.error("peer shutdown operation failed", result.reason);
      }
    }
    try {
      await this.tracker.leave();
    } catch (error) {
      console.error("peer leave failed", error);
    }
  }
}

const parsePositiveInteger = (value: string, label: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
};

const parseDataSize = (value: string): number => {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i);
  if (!match?.[1]) throw new Error("Cache size must be a byte count or use KB/MB/GB");
  const units: Record<string, number> = {
    b: 1,
    kb: 1_000,
    mb: 1_000_000,
    gb: 1_000_000_000,
  };
  const multiplier = units[(match[2] ?? "b").toLowerCase()];
  const bytes = Number(match[1]) * (multiplier ?? 1);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error("Cache size is outside the supported range");
  }
  return bytes;
};

const parseBitRate = (value: string): number => {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(bps|kbps|mbps|gbps)?$/i);
  if (!match?.[1]) throw new Error("Upload speed must be in bps, Kbps, Mbps, or Gbps");
  const units: Record<string, number> = {
    bps: 1,
    kbps: 1_000,
    mbps: 1_000_000,
    gbps: 1_000_000_000,
  };
  const multiplier = units[(match[2] ?? "bps").toLowerCase()];
  const bitsPerSecond = Number(match[1]) * (multiplier ?? 1);
  if (!Number.isSafeInteger(bitsPerSecond) || bitsPerSecond <= 0) {
    throw new Error("Upload speed is outside the supported range");
  }
  return bitsPerSecond;
};

const originUrls = (value: string): { base: URL; playlist: URL } => {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Origin URL must use HTTP or HTTPS");
  }
  if (url.pathname.endsWith(".m3u8")) {
    return { base: new URL(".", url), playlist: url };
  }
  const base = new URL(url.href.endsWith("/") ? url.href : `${url.href}/`);
  return { base, playlist: new URL("stream.m3u8", base) };
};

export const parseArguments = (
  arguments_: string[],
  environment: NodeJS.ProcessEnv = process.env,
): PeerConfiguration => {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid CLI argument near '${key ?? ""}'`);
    }
    values.set(key.slice(2), value);
  }
  const supported = new Set([
    "tracker-url",
    "broadcast-id",
    "origin-url",
    "peer-address",
    "peer-id",
    "cache-size",
    "max-upload-speed",
    "max-connections",
  ]);
  for (const key of values.keys()) {
    if (!supported.has(key)) throw new Error(`Unknown CLI argument '--${key}'`);
  }

  const peerAddress = values.get("peer-address") ?? environment.PEER_ADDRESS;
  const originValue = values.get("origin-url") ?? environment.ORIGIN_URL;
  if (!peerAddress) throw new Error("--peer-address is required");
  if (!originValue) throw new Error("--origin-url is required");
  const peerUrl = new URL(peerAddress);
  if (peerUrl.protocol !== "http:") throw new Error("Peer address must use HTTP");
  if (!peerUrl.port) throw new Error("Peer address must include an upload port");
  const origin = originUrls(originValue);

  return {
    trackerUrl:
      values.get("tracker-url") ?? environment.TRACKER_URL ?? DEFAULT_TRACKER_URL,
    broadcastId:
      values.get("broadcast-id") ??
      environment.BROADCAST_ID ??
      DEFAULT_BROADCAST_ID,
    originBaseUrl: origin.base,
    playlistUrl: origin.playlist,
    peerAddress: peerUrl.href.replace(/\/$/, ""),
    peerId: values.get("peer-id") ?? environment.PEER_ID ?? hostname(),
    cacheSizeBytes: parseDataSize(
      values.get("cache-size") ??
        environment.CACHE_SIZE ??
        String(DEFAULT_CACHE_SIZE),
    ),
    maxUploadSpeedBps: parseBitRate(
      values.get("max-upload-speed") ??
        environment.MAX_UPLOAD_SPEED ??
        String(DEFAULT_UPLOAD_SPEED_BPS),
    ),
    maxConnections: parsePositiveInteger(
      values.get("max-connections") ??
        environment.MAX_CONNECTIONS ??
        String(DEFAULT_MAX_CONNECTIONS),
      "Maximum connections",
    ),
    playlistPollMs: parsePositiveInteger(
      environment.PLAYLIST_POLL_MS ?? String(DEFAULT_PLAYLIST_POLL_MS),
      "Playlist poll interval",
    ),
  };
};

const run = async (): Promise<void> => {
  const configuration = parseArguments(process.argv.slice(2));
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());
  await new PeerApplication(configuration).run(controller.signal);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error: unknown) => {
    console.error("peer failed", error);
    process.exitCode = 1;
  });
}
