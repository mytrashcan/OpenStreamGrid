import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import {
  createLogger,
  type BroadcastRegistration,
  type HealthStatus,
} from "@openstreamgrid/common";
import {
  DEFAULT_HASH_INTERVAL_MS,
  DEFAULT_PLAYLIST_SIZE,
  DEFAULT_SEGMENT_DURATION_SECONDS,
  MultiHlsStreamer,
  type MultiStreamController,
  type StreamController,
} from "./streamer.js";

const DEFAULT_PORT = 8080;
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_TRACKER_URL = "http://tracker:7070";
const DEFAULT_BROADCAST_ID = "live";
const DEFAULT_MULTI_STREAM_COUNT = 1;
const MAX_MULTI_STREAM_COUNT = 5;
const DEFAULT_HLS_DIRECTORY = "/tmp/openstreamgrid-hls";
const REGISTER_RETRY_MS = 1_000;
const REGISTER_MAX_RETRY_MS = 30_000;
const TRACKER_REQUEST_TIMEOUT_MS = 5_000;
const IMMUTABLE_CACHE_MAX_AGE_SECONDS = 3_600;
const logger = createLogger("origin");

interface OriginServerOptions {
  hlsDirectory: string;
  streamer: StreamController;
}

interface RegistrationOptions {
  trackerUrl: string;
  apiKey?: string;
  registration: BroadcastRegistration;
  signal?: AbortSignal;
  retryMs?: number;
  requestTimeoutMs?: number;
  random?: () => number;
  fetchImpl?: (
    input: string | URL,
    init?: RequestInit,
  ) => Promise<Response>;
}

interface MultiRegistrationOptions extends Omit<RegistrationOptions, "registration"> {
  registrations: readonly BroadcastRegistration[];
}

export interface OriginConfiguration {
  port: number;
  host: string;
  hlsDirectory: string;
  trackerUrl: string;
  trackerApiKey?: string;
  broadcastId: string;
  multiStreamCount: number;
  streamIds: readonly string[];
  publicOriginUrl: string;
  segmentDurationSeconds: number;
  playlistSize: number;
  hashIntervalMs: number;
  ffmpegPath?: string;
}

const parsePort = (value: string): number => {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
};

const parsePositiveNumber = (value: string, label: string): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return parsed;
};

const parsePositiveInteger = (value: string, label: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
};

const nonEmpty = (
  value: string | undefined,
  fallback: string,
  label: string,
): string => {
  const resolved = value ?? fallback;
  if (resolved.trim() === "") throw new Error(`${label} must not be empty`);
  return resolved.trim();
};

const httpUrl = (value: string, label: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid absolute URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must use HTTP or HTTPS`);
  }
  return url.href;
};

/** Parses and validates origin process configuration before startup. */
export const parseOriginConfiguration = (
  environment: NodeJS.ProcessEnv = process.env,
): OriginConfiguration => {
  const port = parsePort(environment.PORT ?? String(DEFAULT_PORT));
  const publicOriginUrl = httpUrl(
    environment.PUBLIC_ORIGIN_URL ?? `http://origin:${port}`,
    "PUBLIC_ORIGIN_URL",
  );
  const ffmpegPath = environment.FFMPEG_PATH?.trim();
  const trackerApiKey = environment.TRACKER_API_KEY;
  if (trackerApiKey !== undefined && trackerApiKey.trim() === "") {
    throw new Error("TRACKER_API_KEY must not be empty");
  }
  const broadcastId = nonEmpty(
    environment.BROADCAST_ID,
    DEFAULT_BROADCAST_ID,
    "BROADCAST_ID",
  );
  if (!/^[-A-Za-z0-9_.]+$/.test(broadcastId)) {
    throw new Error("BROADCAST_ID must be a safe stream ID");
  }
  const multiStreamCount = parsePositiveInteger(
    environment.MULTI_STREAM_COUNT ?? String(DEFAULT_MULTI_STREAM_COUNT),
    "MULTI_STREAM_COUNT",
  );
  if (multiStreamCount > MAX_MULTI_STREAM_COUNT) {
    throw new Error(`MULTI_STREAM_COUNT must not exceed ${MAX_MULTI_STREAM_COUNT}`);
  }
  const streamIds = multiStreamCount === 1
    ? [broadcastId]
    : Array.from({ length: multiStreamCount }, (_, index) => `stream-${index + 1}`);
  return {
    port,
    host: nonEmpty(environment.HOST, DEFAULT_HOST, "HOST"),
    hlsDirectory: nonEmpty(
      environment.HLS_DIRECTORY,
      DEFAULT_HLS_DIRECTORY,
      "HLS_DIRECTORY",
    ),
    trackerUrl: httpUrl(
      environment.TRACKER_URL ?? DEFAULT_TRACKER_URL,
      "TRACKER_URL",
    ),
    ...(trackerApiKey ? { trackerApiKey } : {}),
    broadcastId,
    multiStreamCount,
    streamIds,
    publicOriginUrl,
    segmentDurationSeconds: parsePositiveNumber(
      environment.SEGMENT_DURATION_SECONDS ??
        String(DEFAULT_SEGMENT_DURATION_SECONDS),
      "SEGMENT_DURATION_SECONDS",
    ),
    playlistSize: parsePositiveInteger(
      environment.PLAYLIST_SIZE ?? String(DEFAULT_PLAYLIST_SIZE),
      "PLAYLIST_SIZE",
    ),
    hashIntervalMs: parsePositiveInteger(
      environment.HASH_INTERVAL_MS ?? String(DEFAULT_HASH_INTERVAL_MS),
      "HASH_INTERVAL_MS",
    ),
    ...(ffmpegPath ? { ffmpegPath } : {}),
  };
};

const contentTypes: Record<string, string> = {
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
  ".sha256": "text/plain; charset=utf-8",
};

const sendJson = (
  response: ServerResponse,
  statusCode: number,
  value: unknown,
): void => {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  response.end(body);
};

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    return (await stat(filePath)).isFile();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
};

const resolveHlsAssetPath = (hlsDirectory: string, fileName: string): string => {
  const root = path.resolve(hlsDirectory);
  const assetPath = path.resolve(root, fileName);
  if (!assetPath.startsWith(`${root}${path.sep}`)) {
    throw new Error("Invalid file path");
  }
  return assetPath;
};

const isMultiStreamController = (
  streamer: StreamController,
): streamer is MultiStreamController =>
  "streamIds" in streamer && "getStream" in streamer;

interface ResolvedStreamAsset {
  assetDirectory: string;
  assetName: string;
  streamer: StreamController;
}

const resolveStreamAsset = (
  hlsDirectory: string,
  fileName: string,
  streamer: StreamController,
): ResolvedStreamAsset | undefined => {
  if (!isMultiStreamController(streamer)) {
    return { assetDirectory: hlsDirectory, assetName: fileName, streamer };
  }
  const separator = fileName.indexOf("/");
  const requestedStreamId = separator > 0 ? fileName.slice(0, separator) : "";
  const requestedStreamer = streamer.getStream(requestedStreamId);
  if (requestedStreamer && separator > 0) {
    return {
      assetDirectory: path.join(hlsDirectory, requestedStreamId),
      assetName: fileName.slice(separator + 1),
      streamer: requestedStreamer,
    };
  }
  if (streamer.streamIds.length !== 1) return undefined;
  const streamId = streamer.streamIds[0]!;
  const soleStreamer = streamer.getStream(streamId);
  return soleStreamer
    ? {
        assetDirectory: path.join(hlsDirectory, streamId),
        assetName: fileName,
        streamer: soleStreamer,
      }
    : undefined;
};

/** Creates the HTTP handler that serves health and generated HLS assets. */
export const createOriginHandler = (
  hlsDirectory: string,
  streamer: StreamController,
) =>
  async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://origin.local");
      if (method === "GET" && url.pathname === "/health") {
        const streams = isMultiStreamController(streamer)
          ? await Promise.all(
              streamer.streamIds.map(async (streamId) => {
                const controller = streamer.getStream(streamId);
                return {
                  streamId,
                  running: controller?.isRunning() ?? false,
                  playlistAvailable: controller
                    ? await fileExists(controller.playlistPath)
                    : false,
                };
              }),
            )
          : undefined;
        const playlistAvailable = streams
          ? streams.every((stream) => stream.playlistAvailable)
          : await fileExists(streamer.playlistPath);
        const running = streamer.isRunning();
        const failureReason = streamer.failureReason?.();
        const health: HealthStatus = {
          status: running && playlistAvailable
            ? "ok"
            : failureReason
              ? "error"
              : "starting",
          service: "origin",
          details: {
            ffmpegRunning: running,
            playlistAvailable,
            ...(failureReason ? { failureReason } : {}),
            ...(streams
              ? {
                  streamCount: streams.length,
                  readyStreams: streams.filter(
                    (stream) => stream.running && stream.playlistAvailable,
                  ).length,
                }
              : {}),
          },
        };
        sendJson(response, health.status === "ok" ? 200 : 503, health);
        return;
      }

      if ((method !== "GET" && method !== "HEAD") || !url.pathname.startsWith("/hls/")) {
        sendJson(response, 404, { error: "Route not found" });
        return;
      }

      let fileName: string;
      try {
        fileName = decodeURIComponent(url.pathname.slice("/hls/".length));
      } catch {
        sendJson(response, 400, { error: "Invalid file path" });
        return;
      }
      if (!/^[-A-Za-z0-9_./]+$/.test(fileName)) {
        sendJson(response, 400, { error: "Invalid file path" });
        return;
      }
      const extension = path.extname(fileName);
      if (!(extension in contentTypes)) {
        sendJson(response, 404, { error: "File not found" });
        return;
      }

      const resolved = resolveStreamAsset(hlsDirectory, fileName, streamer);
      if (!resolved) {
        sendJson(response, 404, { error: "Stream not found" });
        return;
      }
      let filePath: string;
      try {
        filePath = resolveHlsAssetPath(
          resolved.assetDirectory,
          resolved.assetName,
        );
      } catch {
        sendJson(response, 400, { error: "Invalid file path" });
        return;
      }
      if (extension === ".sha256" && !(await fileExists(filePath))) {
        const segmentName = resolved.assetName.slice(0, -".sha256".length);
        try {
          filePath = await resolved.streamer.ensureHash(segmentName);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
            throw error;
          }
        }
      }

      let fileStats;
      try {
        fileStats = await stat(filePath);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          sendJson(response, 404, { error: "File not found" });
          return;
        }
        throw error;
      }
      if (!fileStats.isFile()) {
        sendJson(response, 404, { error: "File not found" });
        return;
      }

      response.writeHead(200, {
        "content-type": contentTypes[extension] ?? "application/octet-stream",
        "content-length": fileStats.size,
        "access-control-allow-origin": "*",
        "cache-control":
          extension === ".m3u8"
            ? "no-store"
            : `public, max-age=${IMMUTABLE_CACHE_MAX_AGE_SECONDS}, immutable`,
      });
      if (method === "HEAD") {
        response.end();
        return;
      }
      await pipeline(createReadStream(filePath), response);
    } catch (error) {
      logger.error("request_failed", error, {
        method: request.method ?? "GET",
        path: request.url ?? "/",
      });
      if (!response.headersSent) {
        sendJson(response, 500, { error: "Internal server error" });
      } else {
        response.destroy();
      }
    }
  };

/** Coordinates the origin HTTP server and its FFmpeg stream controller. */
export class OriginServer {
  private readonly server;
  private startPromise: Promise<number> | undefined;
  private stopPromise: Promise<void> | undefined;

  constructor(private readonly options: OriginServerOptions) {
    this.server = createServer(
      createOriginHandler(options.hlsDirectory, options.streamer),
    );
  }

  async start(port = DEFAULT_PORT, host = "0.0.0.0"): Promise<number> {
    if (this.stopPromise) {
      throw new Error("Origin server cannot be started after shutdown begins");
    }
    if (this.startPromise) return this.startPromise;
    const startPromise = this.startOnce(port, host).catch((error: unknown) => {
      if (this.startPromise === startPromise) this.startPromise = undefined;
      throw error;
    });
    this.startPromise = startPromise;
    return startPromise;
  }

  private async startOnce(port: number, host: string): Promise<number> {
    await mkdir(this.options.hlsDirectory, { recursive: true });
    await this.options.streamer.start();
    try {
      await new Promise<void>((resolve, reject) => {
        this.server.once("error", reject);
        this.server.listen(port, host, () => {
          this.server.off("error", reject);
          resolve();
        });
      });
    } catch (error) {
      await this.options.streamer.stop();
      throw error;
    }
    const address = this.server.address();
    return typeof address === "object" && address ? address.port : port;
  }

  async stop(): Promise<void> {
    this.stopPromise ??= (async (): Promise<void> => {
      await this.startPromise?.catch(() => undefined);
      await Promise.all([this.stopHttpServer(), this.options.streamer.stop()]);
    })();
    return this.stopPromise;
  }

  private async stopHttpServer(): Promise<void> {
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

const delay = async (milliseconds: number, signal?: AbortSignal): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
    const onTimeout = (): void => {
      cleanup();
      resolve();
    };
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason);
    };
    const timer = setTimeout(onTimeout, milliseconds);
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
};

/** Registers a broadcast with retry-until-success or abort semantics. */
export const registerBroadcast = async ({
  trackerUrl,
  apiKey,
  registration,
  signal,
  retryMs = REGISTER_RETRY_MS,
  requestTimeoutMs = TRACKER_REQUEST_TIMEOUT_MS,
  random = Math.random,
  fetchImpl = fetch,
}: RegistrationOptions): Promise<void> => {
  const endpoint = new URL("/api/v1/broadcasts", trackerUrl);
  let attempt = 0;
  while (!signal?.aborted) {
    try {
      const timeoutSignal = AbortSignal.timeout(requestTimeoutMs);
      const requestSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { "X-API-Key": apiKey } : {}),
        },
        body: JSON.stringify(registration),
        signal: requestSignal,
      });
      if (!response.ok) {
        if (
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 408 &&
          response.status !== 429
        ) {
          throw new PermanentRegistrationError(
            `Tracker rejected broadcast registration with HTTP ${response.status}`,
          );
        }
        throw new Error(`Tracker returned HTTP ${response.status}`);
      }
      return;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof PermanentRegistrationError) throw error;
      const exponentialDelay = Math.min(
        retryMs * 2 ** attempt,
        REGISTER_MAX_RETRY_MS,
      );
      const retryDelayMs = Math.max(
        1,
        Math.round(exponentialDelay * (0.8 + random() * 0.4)),
      );
      attempt += 1;
      logger.error("broadcast_registration_retry", error, {
        trackerUrl: endpoint.href,
        broadcastId: registration.id,
        retryMs: retryDelayMs,
      });
      await delay(retryDelayMs, signal);
    }
  }
  throw signal?.reason ?? new Error("Broadcast registration aborted");
};

class PermanentRegistrationError extends Error {}

/** Registers every origin stream as an independent tracker broadcast. */
export const registerBroadcasts = async ({
  registrations,
  ...options
}: MultiRegistrationOptions): Promise<void> => {
  await Promise.all(
    registrations.map((registration) =>
      registerBroadcast({ ...options, registration }),
    ),
  );
};

/** Releases origin-owned broadcast registrations during graceful shutdown. */
export const unregisterBroadcasts = async ({
  trackerUrl,
  apiKey,
  broadcastIds,
  fetchImpl = fetch,
}: {
  trackerUrl: string;
  apiKey?: string;
  broadcastIds: readonly string[];
  fetchImpl?: NonNullable<RegistrationOptions["fetchImpl"]>;
}): Promise<void> => {
  const results = await Promise.allSettled(
    broadcastIds.map(async (broadcastId) => {
      const endpoint = new URL(
        `/api/v1/broadcasts/${encodeURIComponent(broadcastId)}`,
        trackerUrl,
      );
      const response = await fetchImpl(endpoint, {
        method: "DELETE",
        ...(apiKey ? { headers: { "X-API-Key": apiKey } } : {}),
        signal: AbortSignal.timeout(TRACKER_REQUEST_TIMEOUT_MS),
      });
      if (!response.ok && response.status !== 404) {
        throw new Error(`Tracker unregister returned HTTP ${response.status}`);
      }
    }),
  );
  const failures = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      "One or more broadcasts could not be unregistered",
    );
  }
};

const run = async (): Promise<void> => {
  const configuration = parseOriginConfiguration();
  const streamer = new MultiHlsStreamer({
    outputDirectory: configuration.hlsDirectory,
    streamIds: configuration.streamIds,
    segmentDurationSeconds: configuration.segmentDurationSeconds,
    playlistSize: configuration.playlistSize,
    hashIntervalMs: configuration.hashIntervalMs,
    ...(configuration.ffmpegPath
      ? { ffmpegPath: configuration.ffmpegPath }
      : {}),
  });
  const server = new OriginServer({
    hlsDirectory: configuration.hlsDirectory,
    streamer,
  });
  const shutdownController = new AbortController();
  let registrationRefresh: NodeJS.Timeout | undefined;
  let shuttingDown = false;
  const createRegistrations = (): BroadcastRegistration[] => configuration.streamIds.map((streamId) => ({
    id: streamId,
    playlistUrl: new URL(
      `/hls/${encodeURIComponent(streamId)}/stream.m3u8`,
      configuration.publicOriginUrl,
    ).href,
    metadata: {
      protocol: "hls",
      source: "test-pattern",
      abr: "true",
      qualities: "low,med,high",
      owner: "origin",
      leaseExpiresAt: new Date(Date.now() + 90_000).toISOString(),
    },
  } satisfies BroadcastRegistration));
  const registrations = createRegistrations();

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("stopping", { signal });
    shutdownController.abort(new Error(`Received ${signal}`));
    if (registrationRefresh) clearInterval(registrationRefresh);
    try {
      await unregisterBroadcasts({
        trackerUrl: configuration.trackerUrl,
        ...(configuration.trackerApiKey
          ? { apiKey: configuration.trackerApiKey }
          : {}),
        broadcastIds: registrations.map((registration) => registration.id),
      });
    } catch (error) {
      logger.error("broadcast_unregister_failed", error);
    }
    await server.stop();
  };
  const requestShutdown = (signal: string): void => {
    void shutdown(signal).catch((error: unknown) => {
      logger.error("shutdown_failed", error);
      process.exitCode = 1;
    });
  };
  process.once("SIGTERM", () => requestShutdown("SIGTERM"));
  process.once("SIGINT", () => requestShutdown("SIGINT"));

  const actualPort = await server.start(configuration.port, configuration.host);
  await registerBroadcasts({
    trackerUrl: configuration.trackerUrl,
    ...(configuration.trackerApiKey
      ? { apiKey: configuration.trackerApiKey }
      : {}),
    registrations,
    signal: shutdownController.signal,
  });
  registrationRefresh = setInterval(() => {
    void registerBroadcasts({
      trackerUrl: configuration.trackerUrl,
      ...(configuration.trackerApiKey ? { apiKey: configuration.trackerApiKey } : {}),
      registrations: createRegistrations(),
      signal: shutdownController.signal,
    }).catch((error: unknown) => {
      if (!shutdownController.signal.aborted) logger.error("broadcast_lease_refresh_failed", error);
    });
  }, 30_000);
  registrationRefresh.unref();
  logger.info("started", {
    port: actualPort,
    host: configuration.host,
    broadcastIds: configuration.streamIds,
  });
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error: unknown) => {
    if (!(error instanceof Error && error.message.startsWith("Received SIG"))) {
      logger.error("start_failed", error);
      process.exitCode = 1;
    }
  });
}
