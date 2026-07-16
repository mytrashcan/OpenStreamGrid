import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { HealthStatus } from "@openstreamgrid/common";
import type { SegmentCache } from "./cache.js";
import type { TrafficStats } from "./stats.js";

const MAX_WRITE_CHUNK_BYTES = 64 * 1024;

class TokenBucket {
  private tokens: number;
  private lastRefill = performance.now();

  constructor(private readonly bytesPerSecond: number) {
    if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
      throw new Error("Upload speed must be positive");
    }
    this.tokens = bytesPerSecond;
  }

  get maximumChunkBytes(): number {
    return Math.max(1, Math.min(MAX_WRITE_CHUNK_BYTES, Math.floor(this.bytesPerSecond)));
  }

  async consume(bytes: number): Promise<void> {
    while (true) {
      this.refill();
      if (this.tokens >= bytes) {
        this.tokens -= bytes;
        return;
      }
      const waitMs = Math.max(1, ((bytes - this.tokens) / this.bytesPerSecond) * 1_000);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, waitMs);
        timer.unref();
      });
    }
  }

  private refill(): void {
    const now = performance.now();
    const elapsedSeconds = Math.max(0, now - this.lastRefill) / 1_000;
    this.tokens = Math.min(
      this.bytesPerSecond,
      this.tokens + elapsedSeconds * this.bytesPerSecond,
    );
    this.lastRefill = now;
  }
}

interface UploadServerOptions {
  cache: SegmentCache;
  stats: TrafficStats;
  maxUploadSpeedBps: number;
  maxConnections: number;
  ready?: () => boolean;
}

export class UploadServer {
  private readonly server;
  private readonly bucket: TokenBucket;
  private activeConnections = 0;

  constructor(private readonly options: UploadServerOptions) {
    if (!Number.isSafeInteger(options.maxConnections) || options.maxConnections <= 0) {
      throw new Error("Maximum connections must be a positive integer");
    }
    this.bucket = new TokenBucket(options.maxUploadSpeedBps / 8);
    this.server = createServer((request, response) =>
      void this.handle(request, response),
    );
  }

  async start(port: number, host = "0.0.0.0"): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    const address = this.server.address();
    return typeof address === "object" && address ? address.port : port;
  }

  async stop(): Promise<void> {
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
      this.server.closeAllConnections();
    });
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://peer.local");
      if (method === "GET" && url.pathname === "/health") {
        const ready = this.options.ready?.() ?? true;
        const health: HealthStatus = {
          status: ready ? "ok" : "starting",
          service: "peer",
          details: {
            cachedSegments: this.options.cache.size,
            cacheBytes: this.options.cache.bytes,
            activeUploads: this.activeConnections,
          },
        };
        this.sendJson(response, ready ? 200 : 503, health);
        return;
      }

      const match = url.pathname.match(/^\/segments\/([^/]+)$/);
      if (!match?.[1] || (method !== "GET" && method !== "HEAD")) {
        this.sendJson(response, 404, { error: "Route not found" });
        return;
      }
      if (this.activeConnections >= this.options.maxConnections) {
        response.writeHead(429, { "retry-after": "1" });
        response.end();
        return;
      }

      let segmentName: string;
      try {
        segmentName = decodeURIComponent(match[1]);
      } catch {
        this.sendJson(response, 400, { error: "Invalid segment name" });
        return;
      }
      if (!/^[-A-Za-z0-9_.]+\.ts$/.test(segmentName)) {
        this.sendJson(response, 400, { error: "Invalid segment name" });
        return;
      }
      const data = this.options.cache.get(segmentName);
      if (!data) {
        this.sendJson(response, 404, { error: "Segment not found" });
        return;
      }

      this.activeConnections += 1;
      try {
        response.writeHead(200, {
          "content-type": "video/mp2t",
          "content-length": data.byteLength,
          "cache-control": "private, max-age=60",
        });
        if (method === "HEAD") {
          response.end();
          return;
        }
        await this.writeLimited(response, data);
        response.end();
      } finally {
        this.activeConnections -= 1;
      }
    } catch (error) {
      console.error("peer upload request failed", error);
      if (!response.headersSent) {
        this.sendJson(response, 500, { error: "Internal server error" });
      } else {
        response.destroy();
      }
    }
  }

  private async writeLimited(response: ServerResponse, data: Buffer): Promise<void> {
    const chunkSize = this.bucket.maximumChunkBytes;
    for (let offset = 0; offset < data.byteLength; offset += chunkSize) {
      if (response.destroyed) return;
      const chunk = data.subarray(offset, Math.min(offset + chunkSize, data.byteLength));
      await this.bucket.consume(chunk.byteLength);
      if (response.destroyed) return;
      const canContinue = response.write(chunk);
      this.options.stats.recordUpload(chunk.byteLength);
      if (!canContinue) await this.waitForDrainOrClose(response);
    }
  }

  private async waitForDrainOrClose(response: ServerResponse): Promise<void> {
    await new Promise<void>((resolve) => {
      const done = (): void => {
        response.off("drain", done);
        response.off("close", done);
        resolve();
      };
      response.once("drain", done);
      response.once("close", done);
    });
  }

  private sendJson(
    response: ServerResponse,
    statusCode: number,
    value: unknown,
  ): void {
    const body = JSON.stringify(value);
    response.writeHead(statusCode, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
    });
    response.end(body);
  }
}
