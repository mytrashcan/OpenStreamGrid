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
import type { BroadcastRegistration, HealthStatus } from "@openstreamgrid/common";
import { HlsStreamer, type StreamController } from "./streamer.js";

const DEFAULT_PORT = 8080;
const DEFAULT_TRACKER_URL = "http://tracker:7070";
const DEFAULT_BROADCAST_ID = "live";
const REGISTER_RETRY_MS = 1_000;

interface OriginServerOptions {
  hlsDirectory: string;
  streamer: StreamController;
}

interface RegistrationOptions {
  trackerUrl: string;
  registration: BroadcastRegistration;
  signal?: AbortSignal;
  retryMs?: number;
  fetchImpl?: (
    input: string | URL,
    init?: RequestInit,
  ) => Promise<Response>;
}

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

export const createOriginHandler = (
  hlsDirectory: string,
  streamer: StreamController,
) =>
  async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://origin.local");
      if (method === "GET" && url.pathname === "/health") {
        const playlistAvailable = await fileExists(streamer.playlistPath);
        const running = streamer.isRunning();
        const health: HealthStatus = {
          status: running && playlistAvailable ? "ok" : "starting",
          service: "origin",
          details: { ffmpegRunning: running, playlistAvailable },
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

      let filePath = path.join(hlsDirectory, fileName);
      if (extension === ".sha256" && !(await fileExists(filePath))) {
        const segmentName = fileName.slice(0, -".sha256".length);
        try {
          filePath = await streamer.ensureHash(segmentName);
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
        "cache-control":
          extension === ".m3u8" ? "no-store" : "public, max-age=3600, immutable",
      });
      if (method === "HEAD") {
        response.end();
        return;
      }
      await pipeline(createReadStream(filePath), response);
    } catch (error) {
      console.error("origin request failed", error);
      if (!response.headersSent) {
        sendJson(response, 500, { error: "Internal server error" });
      } else {
        response.destroy();
      }
    }
  };

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

export const registerBroadcast = async ({
  trackerUrl,
  registration,
  signal,
  retryMs = REGISTER_RETRY_MS,
  fetchImpl = fetch,
}: RegistrationOptions): Promise<void> => {
  const endpoint = new URL("/api/v1/broadcasts", trackerUrl);
  while (!signal?.aborted) {
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(registration),
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) {
        throw new Error(`Tracker returned HTTP ${response.status}`);
      }
      return;
    } catch (error) {
      if (signal?.aborted) throw error;
      console.error("broadcast registration failed; retrying", error);
      await delay(retryMs, signal);
    }
  }
  throw signal?.reason ?? new Error("Broadcast registration aborted");
};

const run = async (): Promise<void> => {
  const port = Number.parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);
  const hlsDirectory = process.env.HLS_DIRECTORY ?? "/tmp/openstreamgrid-hls";
  const trackerUrl = process.env.TRACKER_URL ?? DEFAULT_TRACKER_URL;
  const broadcastId = process.env.BROADCAST_ID ?? DEFAULT_BROADCAST_ID;
  const publicOriginUrl = process.env.PUBLIC_ORIGIN_URL ?? `http://origin:${port}`;
  const streamer = new HlsStreamer({
    outputDirectory: hlsDirectory,
    ...(process.env.FFMPEG_PATH ? { ffmpegPath: process.env.FFMPEG_PATH } : {}),
  });
  const server = new OriginServer({ hlsDirectory, streamer });
  const shutdownController = new AbortController();
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ event: "origin_stopping", signal }));
    shutdownController.abort(new Error(`Received ${signal}`));
    await server.stop();
  };
  const requestShutdown = (signal: string): void => {
    void shutdown(signal).catch((error: unknown) => {
      console.error("origin shutdown failed", error);
      process.exitCode = 1;
    });
  };
  process.once("SIGTERM", () => requestShutdown("SIGTERM"));
  process.once("SIGINT", () => requestShutdown("SIGINT"));

  const actualPort = await server.start(port);
  await registerBroadcast({
    trackerUrl,
    registration: {
      id: broadcastId,
      playlistUrl: new URL("/hls/stream.m3u8", publicOriginUrl).href,
      metadata: {
        protocol: "hls",
        source: "test-pattern",
        abr: "true",
        qualities: "low,med,high",
      },
    },
    signal: shutdownController.signal,
  });
  console.log(
    JSON.stringify({ event: "origin_started", port: actualPort, broadcastId }),
  );
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error: unknown) => {
    if (!(error instanceof Error && error.message.startsWith("Received SIG"))) {
      console.error("origin failed to start", error);
      process.exitCode = 1;
    }
  });
}
