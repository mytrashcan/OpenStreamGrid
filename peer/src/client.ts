#!/usr/bin/env node
import { hostname } from "node:os";
import { pathToFileURL } from "node:url";
import { createLogger } from "@openstreamgrid/common";
import WebSocket from "ws";
import { SegmentCache } from "./cache.js";
import { HybridSegmentFetcher } from "./fetcher.js";
import { TrafficStats } from "./stats.js";
import { TrackerClient } from "./tracker.js";
import { TransportManager } from "./transport-manager.js";
import { UploadServer } from "./uploader.js";
import { OriginHashVerifier } from "./verifier.js";
import { DEFAULT_STUN_SERVER } from "./webrtc-transport.js";

const DEFAULT_TRACKER_URL = "http://tracker:7070";
const DEFAULT_BROADCAST_ID = "live";
const DEFAULT_CACHE_SIZE = 200 * 1_000_000;
const DEFAULT_UPLOAD_SPEED_BPS = 1_000_000;
const DEFAULT_MAX_CONNECTIONS = 3;
const DEFAULT_MAX_PARALLEL_DOWNLOADS = 3;
const DEFAULT_PLAYLIST_POLL_MS = 500;
const DEFAULT_P2P_TIMEOUT_MS = 2_000;
const DEFAULT_UPLOAD_HOST = "0.0.0.0";
const MINIMUM_P2P_SEGMENTS_AHEAD = 2;
const DEFAULT_HTTP_PORT = "80";
const CLI_ARGUMENT_PAIR_SIZE = 2;
const CLI_OPTION_PREFIX_LENGTH = 2;
const PROCESS_ARGUMENT_OFFSET = 2;
const logger = createLogger("peer");

interface PeerConfiguration {
  trackerUrl: string;
  trackerApiKey?: string;
  broadcastId: string;
  originBaseUrl: URL;
  playlistUrl: URL;
  peerAddress: string;
  uploadHost: string;
  peerId: string;
  cacheSizeBytes: number;
  maxUploadSpeedBps: number;
  maxConnections: number;
  maxParallelDownloads: number;
  playlistPollMs: number;
  p2pTimeoutMs: number;
  webRtcEnabled: boolean;
  iceServers: RTCIceServer[];
}

const delay = async (milliseconds: number, signal: AbortSignal): Promise<void> => {
  await new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    timer.unref();
    signal.addEventListener("abort", finish, { once: true });
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
  private readonly uploader: UploadServer;
  private readonly transportManager: TransportManager;
  private readonly fetcher: HybridSegmentFetcher;
  private readonly inFlightSegments = new Set<string>();

  constructor(private readonly configuration: PeerConfiguration) {
    this.cache = new SegmentCache(configuration.cacheSizeBytes);
    this.tracker = new TrackerClient({
      trackerUrl: configuration.trackerUrl,
      ...(configuration.trackerApiKey
        ? { apiKey: configuration.trackerApiKey }
        : {}),
      broadcastId: configuration.broadcastId,
      peerId: configuration.peerId,
      heartbeat: () => ({
        uploadBandwidthBps: configuration.maxUploadSpeedBps,
        successRate: this.stats.p2pSuccessRate,
      }),
      stats: () => this.stats.snapshot(),
      segments: () => this.cache.keys(),
    });
    this.uploader = new UploadServer({
      cache: this.cache,
      stats: this.stats,
      maxUploadSpeedBps: configuration.maxUploadSpeedBps,
      maxConnections: configuration.maxConnections,
      ready: () => this.cache.size > 0,
    });
    const verifier = new OriginHashVerifier(configuration.originBaseUrl);
    const signalUrl = new URL("/ws", configuration.trackerUrl);
    signalUrl.protocol = signalUrl.protocol === "https:" ? "wss:" : "ws:";
    this.transportManager = new TransportManager({
      signalUrl: signalUrl.href,
      peerId: configuration.peerId,
      broadcastId: configuration.broadcastId,
      webRtcEnabled: configuration.webRtcEnabled,
      iceServers: configuration.iceServers,
      p2pTimeoutMs: configuration.p2pTimeoutMs,
      webRtc: {
        ...(configuration.trackerApiKey
          ? {
              webSocketFactory: (url) =>
                new WebSocket(url, {
                  headers: { "X-API-Key": configuration.trackerApiKey },
                }),
            }
          : {}),
        segmentProvider: (segmentName) => this.cache.get(segmentName),
        onUpload: (bytes) => this.stats.recordUpload(bytes),
        maxUploadConnections: configuration.maxConnections,
      },
    });
    this.fetcher = new HybridSegmentFetcher({
      selfPeerId: configuration.peerId,
      originBaseUrl: configuration.originBaseUrl,
      cache: this.cache,
      directory: this.tracker,
      verifier,
      stats: this.stats,
      maxParallel: configuration.maxParallelDownloads,
      p2pTimeoutMs: configuration.p2pTimeoutMs,
      transportManager: this.transportManager,
    });
  }

  async run(signal: AbortSignal): Promise<void> {
    const address = new URL(this.configuration.peerAddress);
    const port = Number.parseInt(address.port || DEFAULT_HTTP_PORT, 10);
    await this.uploader.start(port, this.configuration.uploadHost);
    try {
      await this.tracker.join({
        id: this.configuration.peerId,
        address: this.configuration.peerAddress,
        uploadBandwidthBps: this.configuration.maxUploadSpeedBps,
      });
      await Promise.all([this.tracker.start(), this.transportManager.start()]);
      logger.info("started", {
        peerId: this.configuration.peerId,
        address: this.configuration.peerAddress,
      });
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
        const pending = segments
          .map((segmentName, index) => ({
            segmentName,
            segmentsAhead: segments.length - index - 1,
          }))
          .filter(
            ({ segmentName }) =>
              !processed.has(segmentName) &&
              !this.inFlightSegments.has(segmentName),
          );
        while (!signal.aborted && pending.length > 0) {
          const nonUrgent = pending.filter(
            ({ segmentsAhead }) => segmentsAhead >= MINIMUM_P2P_SEGMENTS_AHEAD,
          );
          const batch = (
            nonUrgent.length > 0 ? nonUrgent : pending.slice(0, 1)
          ).slice(0, this.configuration.maxParallelDownloads);
          await this.fetchBatch(batch, processed);
          const attempted = new Set(batch.map(({ segmentName }) => segmentName));
          for (let index = pending.length - 1; index >= 0; index -= 1) {
            const item = pending[index];
            if (item && attempted.has(item.segmentName)) pending.splice(index, 1);
          }
        }
      } catch (error) {
        if (!signal.aborted) logger.error("playlist_processing_failed", error);
      }
      await delay(this.configuration.playlistPollMs, signal);
    }
  }

  private async fetchBatch(
    batch: Array<{ segmentName: string; segmentsAhead: number }>,
    processed: Set<string>,
  ): Promise<void> {
    for (const { segmentName } of batch) this.inFlightSegments.add(segmentName);
    let fetched: Map<string, Buffer>;
    try {
      fetched = await this.fetcher.fetchSegments(
        batch.map(({ segmentName }) => segmentName),
        this.tracker.allPeers(),
      );
    } catch (error) {
      logger.error("parallel_segment_fetch_failed", error);
      return;
    } finally {
      for (const { segmentName } of batch) {
        this.inFlightSegments.delete(segmentName);
      }
    }
    for (const [segmentName, data] of fetched) {
      processed.add(segmentName);
      const source = this.fetcher.getLastSource(segmentName);
      logger.info("segment_fetched", {
        peerId: this.configuration.peerId,
        segment: segmentName,
        source,
        bytes: data.byteLength,
        ...(source === "p2p"
          ? { transport: this.transportManager.getStats().lastTransport }
          : {}),
      });
    }
    if (fetched.size > 0) this.tracker.reportSegments();
  }

  private async shutdown(): Promise<void> {
    logger.info("stopping", { peerId: this.configuration.peerId });
    const results = await Promise.allSettled([
      this.uploader.stop(),
      this.transportManager.stop(),
    ]);
    this.tracker.stop();
    for (const result of results) {
      if (result.status === "rejected") {
        logger.error("shutdown_operation_failed", result.reason);
      }
    }
    try {
      await this.tracker.leave();
    } catch (error) {
      logger.error("leave_failed", error);
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

const parseBoolean = (value: string, label: string): boolean => {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes"].includes(normalized)) return true;
  if (["0", "false", "no"].includes(normalized)) return false;
  throw new Error(`${label} must be true or false`);
};

const requiredValue = (value: string | undefined, label: string): string => {
  if (value === undefined || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
};

const nonEmptyValue = (value: string, label: string): string => {
  if (value.trim() === "") throw new Error(`${label} must not be empty`);
  return value.trim();
};

const optionalValue = (value: string | undefined): string | undefined => {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
};

const optionalNonEmptyValue = (
  value: string | undefined,
  label: string,
): string | undefined => {
  if (value === undefined) return undefined;
  if (value.trim() === "") throw new Error(`${label} must not be empty`);
  return value;
};

const iceServerUrl = (
  value: string,
  label: string,
  protocols: readonly string[],
): string => {
  const normalized = nonEmptyValue(value, label);
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error(`${label} must be a valid absolute URL`);
  }
  const protocol = url.protocol.slice(0, -1).toLowerCase();
  if (!protocols.includes(protocol)) {
    throw new Error(
      `${label} must use ${protocols.map((item) => item.toUpperCase()).join(" or ")}`,
    );
  }

  const endpoint = normalized
    .slice(normalized.indexOf(":") + 1)
    .split(/[?#]/, 1)[0];
  try {
    const parsedEndpoint = new URL(`http://${endpoint}`);
    if (
      !parsedEndpoint.hostname ||
      parsedEndpoint.pathname !== "/" ||
      parsedEndpoint.username ||
      parsedEndpoint.password
    ) {
      throw new Error("invalid ICE endpoint");
    }
  } catch {
    throw new Error(`${label} must include a host and optional port`);
  }
  if (url.hash) throw new Error(`${label} must not include a fragment`);
  return normalized;
};

const iceServers = (environment: NodeJS.ProcessEnv): RTCIceServer[] => {
  const stunServer = iceServerUrl(
    environment.STUN_SERVER ?? DEFAULT_STUN_SERVER,
    "STUN server",
    ["stun", "stuns"],
  );
  const turnServer = optionalValue(environment.TURN_SERVER);
  const username = optionalValue(environment.TURN_USERNAME);
  const credential = optionalValue(environment.TURN_CREDENTIAL);
  if (!turnServer && (username || credential)) {
    throw new Error("TURN_SERVER is required when TURN credentials are configured");
  }

  const servers: RTCIceServer[] = [{ urls: stunServer }];
  if (turnServer) {
    servers.push({
      urls: iceServerUrl(turnServer, "TURN server", ["turn", "turns"]),
      ...(username ? { username } : {}),
      ...(credential ? { credential } : {}),
    });
  }
  return servers;
};

const httpUrl = (value: string, label: string): URL => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid absolute URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must use HTTP or HTTPS`);
  }
  return url;
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
  const url = httpUrl(value, "Origin URL");
  if (url.pathname.endsWith(".m3u8")) {
    return { base: new URL(".", url), playlist: url };
  }
  const base = new URL(url.href.endsWith("/") ? url.href : `${url.href}/`);
  return { base, playlist: new URL("stream.m3u8", base) };
};

/** Parses and validates CLI arguments into a complete peer configuration. */
export const parseArguments = (
  arguments_: string[],
  environment: NodeJS.ProcessEnv = process.env,
): PeerConfiguration => {
  const values = new Map<string, string>();
  for (
    let index = 0;
    index < arguments_.length;
    index += CLI_ARGUMENT_PAIR_SIZE
  ) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid CLI argument near '${key ?? ""}'`);
    }
    values.set(key.slice(CLI_OPTION_PREFIX_LENGTH), value);
  }
  const supported = new Set([
    "tracker-url",
    "tracker-api-key",
    "broadcast-id",
    "origin-url",
    "peer-address",
    "peer-id",
    "cache-size",
    "max-upload-speed",
    "max-connections",
    "parallel-downloads",
    "webrtc-enabled",
  ]);
  for (const key of values.keys()) {
    if (!supported.has(key)) throw new Error(`Unknown CLI argument '--${key}'`);
  }

  const peerAddress = requiredValue(
    values.get("peer-address") ?? environment.PEER_ADDRESS,
    "--peer-address or PEER_ADDRESS",
  );
  const originValue = requiredValue(
    values.get("origin-url") ?? environment.ORIGIN_URL,
    "--origin-url or ORIGIN_URL",
  );
  const peerUrl = httpUrl(peerAddress, "Peer address");
  if (peerUrl.protocol !== "http:") throw new Error("Peer address must use HTTP");
  if (!peerUrl.port) throw new Error("Peer address must include an upload port");
  const peerPort = Number(peerUrl.port);
  if (!Number.isInteger(peerPort) || peerPort < 1 || peerPort > 65_535) {
    throw new Error("Peer address port must be between 1 and 65535");
  }
  const origin = originUrls(originValue);
  const trackerUrl = httpUrl(
    values.get("tracker-url") ??
      environment.TRACKER_URL ??
      DEFAULT_TRACKER_URL,
    "Tracker URL",
  );
  const trackerApiKey = optionalNonEmptyValue(
    values.get("tracker-api-key") ?? environment.TRACKER_API_KEY,
    "Tracker API key",
  );

  return {
    trackerUrl: trackerUrl.href,
    ...(trackerApiKey ? { trackerApiKey } : {}),
    broadcastId: nonEmptyValue(
      values.get("broadcast-id") ??
        environment.BROADCAST_ID ??
        DEFAULT_BROADCAST_ID,
      "Broadcast ID",
    ),
    originBaseUrl: origin.base,
    playlistUrl: origin.playlist,
    peerAddress: peerUrl.href.replace(/\/$/, ""),
    uploadHost: nonEmptyValue(
      environment.UPLOAD_HOST ?? DEFAULT_UPLOAD_HOST,
      "Upload host",
    ),
    peerId: nonEmptyValue(
      values.get("peer-id") ?? environment.PEER_ID ?? hostname(),
      "Peer ID",
    ),
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
    maxParallelDownloads: parsePositiveInteger(
      values.get("parallel-downloads") ??
        environment.MAX_PARALLEL_DOWNLOADS ??
        String(DEFAULT_MAX_PARALLEL_DOWNLOADS),
      "Parallel downloads",
    ),
    playlistPollMs: parsePositiveInteger(
      environment.PLAYLIST_POLL_MS ?? String(DEFAULT_PLAYLIST_POLL_MS),
      "Playlist poll interval",
    ),
    p2pTimeoutMs: parsePositiveInteger(
      environment.P2P_TIMEOUT_MS ?? String(DEFAULT_P2P_TIMEOUT_MS),
      "P2P timeout",
    ),
    webRtcEnabled: parseBoolean(
      values.get("webrtc-enabled") ?? environment.WEBRTC_ENABLED ?? "true",
      "WebRTC enabled",
    ),
    iceServers: iceServers(environment),
  };
};

const run = async (): Promise<void> => {
  const configuration = parseArguments(
    process.argv.slice(PROCESS_ARGUMENT_OFFSET),
  );
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());
  await new PeerApplication(configuration).run(controller.signal);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error: unknown) => {
    logger.error("start_failed", error);
    process.exitCode = 1;
  });
}
