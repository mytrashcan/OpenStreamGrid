#!/usr/bin/env node

import { createServer } from "node:http";

const environment = process.env;

const DEFAULTS = {
  trackerUrl: environment.TRACKER_URL ?? "http://127.0.0.1:7070",
  originUrl: environment.ORIGIN_URL ?? "http://127.0.0.1:8080/hls",
  broadcastId: environment.BROADCAST_ID ?? "live",
  advertiseUrl: environment.ADVERTISE_URL ?? "",
  peers: Number(environment.PEERS ?? 10),
  rampUpSeconds: Number(environment.RAMP_UP ?? 5),
  durationSeconds: Number(environment.DURATION ?? 60),
  churn: Number(environment.CHURN ?? 0),
  intervalMinSeconds: Number(environment.INTERVAL_MIN ?? 1),
  intervalMaxSeconds: Number(environment.INTERVAL_MAX ?? 3),
  reportIntervalSeconds: Number(environment.REPORT_INTERVAL ?? 10),
  uploadBandwidthMbps: Number(environment.UPLOAD_BANDWIDTH_MBPS ?? 4),
  uploadPort: Number(environment.UPLOAD_PORT ?? 9090),
  maxUploadConnections: Number(environment.MAX_UPLOAD_CONNECTIONS ?? 3),
  cacheSegments: Number(environment.CACHE_SEGMENTS ?? 24),
  p2pTimeoutMs: Number(environment.P2P_TIMEOUT_MS ?? 2_000),
  maxPeerAttempts: Number(environment.MAX_PEER_ATTEMPTS ?? 2),
  quality: environment.QUALITY ?? "low",
  p2pEnabled: !["0", "false", "no"].includes(
    (environment.P2P_ENABLED ?? "true").toLowerCase(),
  ),
};

const HELP = `OpenStreamGrid virtual-peer load test

Usage:
  node test/load-test.mjs [options]

Options:
  --tracker-url URL                 Tracker base URL
  --origin-url URL                  HLS base URL or playlist URL
  --broadcast-id ID                 Broadcast to join
  --advertise-url URL               Shared upload server URL
  --peers N                         Number of virtual peers
  --ramp-up SECONDS                 Spread joins over this period (0 = burst)
  --duration SECONDS                Test duration
  --churn FRACTION                  Leave/rejoin probability per churn check (0-1)
  --interval-min SECONDS            Minimum playlist polling interval
  --interval-max SECONDS            Maximum playlist polling interval
  --report-interval SECONDS         Metrics reporting interval
  --upload-bandwidth-mbps MBPS      Upload limit for each virtual peer
  --upload-port PORT                Shared upload server listen port
  --max-upload-connections N        Concurrent uploads allowed per peer
  --cache-segments N                Cached segments per peer
  --p2p-timeout-ms MS               Timeout for a peer request
  --max-peer-attempts N             Peers tried before Origin fallback
  --quality NAME                    Preferred HLS variant (default: low)
  --p2p-enabled BOOLEAN             Enable or disable P2P fetches
  --help                            Show this help
`;

const optionNames = new Map([
  ["tracker-url", "trackerUrl"],
  ["origin-url", "originUrl"],
  ["broadcast-id", "broadcastId"],
  ["advertise-url", "advertiseUrl"],
  ["peers", "peers"],
  ["ramp-up", "rampUpSeconds"],
  ["duration", "durationSeconds"],
  ["churn", "churn"],
  ["interval-min", "intervalMinSeconds"],
  ["interval-max", "intervalMaxSeconds"],
  ["report-interval", "reportIntervalSeconds"],
  ["upload-bandwidth-mbps", "uploadBandwidthMbps"],
  ["upload-port", "uploadPort"],
  ["max-upload-connections", "maxUploadConnections"],
  ["cache-segments", "cacheSegments"],
  ["p2p-timeout-ms", "p2pTimeoutMs"],
  ["max-peer-attempts", "maxPeerAttempts"],
  ["quality", "quality"],
  ["p2p-enabled", "p2pEnabled"],
]);

const integerOptions = new Set([
  "peers",
  "uploadPort",
  "maxUploadConnections",
  "cacheSegments",
  "p2pTimeoutMs",
  "maxPeerAttempts",
]);

const numericOptions = new Set([
  ...integerOptions,
  "rampUpSeconds",
  "durationSeconds",
  "churn",
  "intervalMinSeconds",
  "intervalMaxSeconds",
  "reportIntervalSeconds",
  "uploadBandwidthMbps",
]);

const parseBoolean = (value, label) => {
  if (["1", "true", "yes"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no"].includes(value.toLowerCase())) return false;
  throw new Error(`${label} must be true or false`);
};

const parseArguments = (arguments_) => {
  const config = { ...DEFAULTS };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help") {
      console.log(HELP);
      return undefined;
    }
    if (!argument?.startsWith("--")) {
      throw new Error(`Unexpected argument '${argument ?? ""}'`);
    }
    const option = argument.slice(2);
    const property = optionNames.get(option);
    if (!property) throw new Error(`Unknown option '--${option}'`);
    const value = arguments_[++index];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Option '--${option}' requires a value`);
    }
    if (property === "p2pEnabled") {
      config[property] = parseBoolean(value, argument);
    } else if (numericOptions.has(property)) {
      config[property] = Number(value);
    } else {
      config[property] = value;
    }
  }

  const positive = [
    "peers",
    "durationSeconds",
    "intervalMinSeconds",
    "intervalMaxSeconds",
    "reportIntervalSeconds",
    "uploadBandwidthMbps",
    "uploadPort",
    "maxUploadConnections",
    "cacheSegments",
    "p2pTimeoutMs",
    "maxPeerAttempts",
  ];
  for (const property of positive) {
    if (!Number.isFinite(config[property]) || config[property] <= 0) {
      throw new Error(`${property} must be a positive number`);
    }
  }
  for (const property of integerOptions) {
    if (!Number.isSafeInteger(config[property])) {
      throw new Error(`${property} must be an integer`);
    }
  }
  if (!Number.isFinite(config.rampUpSeconds) || config.rampUpSeconds < 0) {
    throw new Error("rampUpSeconds must be zero or a positive number");
  }
  if (!Number.isFinite(config.churn) || config.churn < 0 || config.churn > 1) {
    throw new Error("churn must be between 0 and 1");
  }
  if (config.intervalMinSeconds > config.intervalMaxSeconds) {
    throw new Error("intervalMinSeconds cannot exceed intervalMaxSeconds");
  }
  if (config.uploadPort > 65_535) throw new Error("uploadPort is invalid");

  for (const property of ["trackerUrl", "originUrl"]) {
    const url = new URL(config[property]);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`${property} must use HTTP or HTTPS`);
    }
    config[property] = url.href.replace(/\/$/, "");
  }
  config.advertiseUrl = (
    config.advertiseUrl || `http://127.0.0.1:${config.uploadPort}`
  ).replace(/\/$/, "");
  const advertiseUrl = new URL(config.advertiseUrl);
  if (advertiseUrl.protocol !== "http:") {
    throw new Error("advertiseUrl must use HTTP");
  }
  return config;
};

const randomBetween = (minimum, maximum) =>
  minimum + Math.random() * (maximum - minimum);

const shuffle = (values) => {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
};

const delay = (milliseconds, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, milliseconds);
    timer.unref();
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

const requestSignal = (signal, timeoutMs) =>
  signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);

const responseBody = async (response) => {
  const body = await response.text().catch(() => "");
  return body ? `: ${body.slice(0, 200)}` : "";
};

const fetchText = async (url, signal, timeoutMs = 5_000) => {
  const response = await fetch(url, {
    signal: requestSignal(signal, timeoutMs),
    headers: { "user-agent": "OpenStreamGrid-LoadTest/1.0" },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}${await responseBody(response)}`);
  }
  return response.text();
};

const playlistLines = (text) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));

const originConfiguration = (originUrl) => {
  const input = new URL(originUrl);
  if (input.pathname.endsWith(".m3u8")) {
    return { baseUrl: new URL(".", input), masterUrl: input };
  }
  const baseUrl = new URL(input.href.endsWith("/") ? input.href : `${input.href}/`);
  return { baseUrl, masterUrl: new URL("stream.m3u8", baseUrl) };
};

const waitForMediaPlaylist = async (masterUrl, quality, signal) => {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (!signal.aborted && Date.now() < deadline) {
    try {
      const text = await fetchText(masterUrl, signal);
      if (text.includes("#EXTINF")) return masterUrl;
      const variants = playlistLines(text)
        .filter((line) => new URL(line, masterUrl).pathname.endsWith(".m3u8"))
        .map((line) => new URL(line, masterUrl));
      if (variants.length === 0) {
        throw new Error(`No media playlist found in ${masterUrl.href}`);
      }
      return (
        variants.find((url) => url.pathname.split("/").includes(quality)) ??
        variants[0]
      );
    } catch (error) {
      lastError = error;
      await delay(500, signal);
    }
  }
  throw lastError ?? new Error("Timed out waiting for the Origin playlist");
};

const mediaSegments = (playlist, playlistUrl, originBaseUrl) =>
  playlistLines(playlist)
    .map((line) => new URL(line, playlistUrl))
    .filter((url) => url.pathname.endsWith(".ts"))
    .map((url) => {
      const relativePath = url.pathname.startsWith(originBaseUrl.pathname)
        ? url.pathname.slice(originBaseUrl.pathname.length)
        : url.pathname.replace(/^\/+/, "");
      const key = decodeURIComponent(relativePath);
      if (
        key === "" ||
        key.split("/").includes("..") ||
        !/^[-A-Za-z0-9_./]+\.ts$/.test(key)
      ) {
        return undefined;
      }
      return { key, url };
    })
    .filter(Boolean);

class SegmentCache {
  constructor(maximumEntries) {
    this.maximumEntries = maximumEntries;
    this.entries = new Map();
  }

  get size() {
    return this.entries.size;
  }

  get(key) {
    const value = this.entries.get(key);
    if (!value) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key, value) {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.maximumEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  keys() {
    return [...this.entries.keys()];
  }
}

class TokenBucket {
  constructor(bitsPerSecond) {
    this.bytesPerSecond = bitsPerSecond / 8;
    this.tokens = this.bytesPerSecond;
    this.updatedAt = performance.now();
  }

  get chunkBytes() {
    return Math.max(1, Math.min(64 * 1024, Math.floor(this.bytesPerSecond)));
  }

  async consume(bytes) {
    while (true) {
      const now = performance.now();
      const elapsedSeconds = Math.max(0, now - this.updatedAt) / 1_000;
      this.tokens = Math.min(
        this.bytesPerSecond,
        this.tokens + elapsedSeconds * this.bytesPerSecond,
      );
      this.updatedAt = now;
      if (this.tokens >= bytes) {
        this.tokens -= bytes;
        return;
      }
      await delay(Math.max(1, ((bytes - this.tokens) / this.bytesPerSecond) * 1_000));
    }
  }
}

const emptyStats = () => ({
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
});

class VirtualPeer {
  constructor(options) {
    this.id = options.id;
    this.ws = undefined;
    this.cache = new SegmentCache(options.config.cacheSegments);
    this.stats = emptyStats();
    this.options = options;
    this.peers = new Map();
    this.active = false;
    this.activeUploads = 0;
    this.sessionController = undefined;
    this.intentionalClose = false;
    this.segmentsDirty = true;
    this.lastHeartbeatAt = 0;
    this.lastStatsAt = 0;
    this.latencies = { p2p: [], origin: [] };
    this.events = {
      sessions: 0,
      churns: 0,
      errors: 0,
      segmentFailures: 0,
      websocketDisconnects: 0,
    };
    this.uploadBucket = new TokenBucket(
      options.config.uploadBandwidthMbps * 1_000_000,
    );
    this.address = `${options.config.advertiseUrl}/peers/${encodeURIComponent(this.id)}`;
  }

  async run(signal) {
    await delay(this.options.joinDelayMs + randomBetween(0, 250), signal);
    while (!signal.aborted) {
      const session = new AbortController();
      const abortSession = () => session.abort(signal.reason);
      signal.addEventListener("abort", abortSession, { once: true });
      this.sessionController = session;
      let churned = false;
      try {
        await this.startSession(session.signal);
        const fetchLoop = this.fetchLoop(session.signal);
        if (this.options.config.churn > 0) {
          churned = await this.waitForChurn(session.signal);
          if (churned) session.abort(new Error("Simulated peer churn"));
        }
        await fetchLoop;
      } catch (error) {
        if (!signal.aborted && !session.signal.aborted) {
          this.events.errors += 1;
          if (this.events.errors <= 3 || this.events.errors % 10 === 0) {
            console.error(`[LoadTest] peer=${this.id} session_error=${error.message}`);
          }
        }
      } finally {
        session.abort();
        await this.stopSession();
        signal.removeEventListener("abort", abortSession);
        if (this.sessionController === session) this.sessionController = undefined;
      }
      if (signal.aborted) break;
      if (churned) this.events.churns += 1;
      await delay(churned ? randomBetween(1_000, 5_000) : 1_000, signal);
    }
  }

  async startSession(signal) {
    await this.connectWebSocket(signal);
    await this.joinTracker(signal);
    this.active = true;
    this.events.sessions += 1;
    this.reportState(true);
  }

  async stopSession() {
    const wasActive = this.active;
    this.active = false;
    if (wasActive) await this.leaveTracker();
    this.intentionalClose = true;
    const ws = this.ws;
    this.ws = undefined;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.close(1000, "Virtual peer leaving");
    }
    this.intentionalClose = false;
    this.peers.clear();
  }

  connectWebSocket(signal) {
    return new Promise((resolve, reject) => {
      const tracker = new URL(this.options.config.trackerUrl);
      tracker.protocol = tracker.protocol === "https:" ? "wss:" : "ws:";
      tracker.pathname = "/ws";
      tracker.search = "";
      const ws = new WebSocket(tracker);
      this.ws = ws;
      let settled = false;

      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve();
      };
      const onAbort = () => finish(new Error("WebSocket connection aborted"));
      const timer = setTimeout(
        () => finish(new Error("WebSocket subscription timed out")),
        10_000,
      );
      timer.unref();

      ws.addEventListener("open", () => {
        ws.send(
          JSON.stringify({
            type: "subscribe",
            broadcastId: this.options.config.broadcastId,
            peerId: this.id,
          }),
        );
      });
      ws.addEventListener("message", (event) => {
        try {
          if (typeof event.data !== "string") return;
          const message = JSON.parse(event.data);
          this.handleTrackerMessage(message);
          if (
            message.type === "peer_list" &&
            message.broadcastId === this.options.config.broadcastId
          ) {
            finish();
          }
        } catch {
          // Ignore malformed tracker messages; the tracker closes invalid sessions.
        }
      });
      ws.addEventListener("error", (event) => {
        if (!settled) {
          finish(
            new Error(event.error?.message ?? "WebSocket connection failed"),
          );
        }
      });
      ws.addEventListener("close", () => {
        if (!settled) finish(new Error("WebSocket closed before subscription"));
        if (!this.intentionalClose && this.active) {
          this.events.websocketDisconnects += 1;
          this.sessionController?.abort(new Error("Tracker WebSocket disconnected"));
        }
      });
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  handleTrackerMessage(message) {
    if (message.broadcastId !== this.options.config.broadcastId) return;
    if (message.type === "peer_list" && Array.isArray(message.peers)) {
      this.peers.clear();
      for (const peer of message.peers) this.peers.set(peer.id, peer);
      return;
    }
    if (message.type === "peer_joined" && message.peer) {
      this.peers.set(message.peer.id, message.peer);
      return;
    }
    if (message.type === "peer_left") {
      this.peers.delete(message.peerId);
      return;
    }
    if (message.type === "segment_available") {
      const peer = this.peers.get(message.peerId);
      if (peer && Array.isArray(message.segments)) {
        peer.segments = [...new Set([...peer.segments, ...message.segments])];
      }
    }
  }

  sendTracker(message) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          ...message,
          broadcastId: this.options.config.broadcastId,
          peerId: this.id,
        }),
      );
    }
  }

  async joinTracker(signal) {
    const endpoint = new URL(
      `/api/v1/broadcasts/${encodeURIComponent(this.options.config.broadcastId)}/peers`,
      this.options.config.trackerUrl,
    );
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: this.id,
        address: this.address,
        uploadBandwidthBps: this.options.config.uploadBandwidthMbps * 1_000_000,
        metadata: { type: "virtual-load-test-peer" },
      }),
      signal: requestSignal(signal, 5_000),
    });
    if (!response.ok) {
      throw new Error(`Tracker join returned HTTP ${response.status}${await responseBody(response)}`);
    }
  }

  async leaveTracker() {
    const endpoint = new URL(
      `/api/v1/broadcasts/${encodeURIComponent(this.options.config.broadcastId)}/peers/${encodeURIComponent(this.id)}`,
      this.options.config.trackerUrl,
    );
    try {
      const response = await fetch(endpoint, {
        method: "DELETE",
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok && response.status !== 404) {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch (error) {
      this.events.errors += 1;
    }
  }

  async waitForChurn(signal) {
    while (!signal.aborted) {
      await delay(randomBetween(5_000, 10_000), signal);
      if (!signal.aborted && Math.random() < this.options.config.churn) return true;
    }
    return false;
  }

  async fetchLoop(signal) {
    while (!signal.aborted) {
      try {
        const playlist = await fetchText(
          this.options.mediaPlaylistUrl,
          signal,
          5_000,
        );
        const segments = mediaSegments(
          playlist,
          this.options.mediaPlaylistUrl,
          this.options.originBaseUrl,
        );
        for (const segment of segments) {
          if (signal.aborted) break;
          if (!this.cache.get(segment.key)) await this.fetchSegment(segment, signal);
        }
        this.reportState();
      } catch (error) {
        if (!signal.aborted) {
          this.events.segmentFailures += 1;
          if (this.events.segmentFailures <= 3) {
            console.error(`[LoadTest] peer=${this.id} playlist_error=${error.message}`);
          }
        }
      }
      await delay(
        randomBetween(
          this.options.config.intervalMinSeconds * 1_000,
          this.options.config.intervalMaxSeconds * 1_000,
        ),
        signal,
      );
    }
  }

  async fetchSegment(segment, signal) {
    let attemptedPeer = false;
    if (this.options.config.p2pEnabled) {
      const candidates = shuffle(
        [...this.peers.values()].filter(
          (peer) =>
            peer.id !== this.id &&
            Array.isArray(peer.segments) &&
            peer.segments.includes(segment.key),
        ),
      ).slice(0, this.options.config.maxPeerAttempts);
      for (const peer of candidates) {
        attemptedPeer = true;
        this.stats.p2pRequests += 1;
        const startedAt = performance.now();
        try {
          const data = await this.fetchFromPeer(peer, segment.key, signal);
          this.stats.p2pSuccesses += 1;
          this.stats.bytesDownloadedP2P += data.byteLength;
          this.recordLatency("p2p", performance.now() - startedAt);
          this.cacheSegment(segment.key, data);
          return;
        } catch {
          this.stats.p2pFailures += 1;
        }
      }
    }

    if (attemptedPeer) this.stats.fallbacks += 1;
    this.stats.originRequests += 1;
    const startedAt = performance.now();
    try {
      const response = await fetch(segment.url, {
        signal: requestSignal(signal, 5_000),
        headers: { "user-agent": "OpenStreamGrid-LoadTest/1.0" },
      });
      if (!response.ok) throw new Error(`Origin returned HTTP ${response.status}`);
      const data = Buffer.from(await response.arrayBuffer());
      this.stats.bytesDownloadedOrigin += data.byteLength;
      this.recordLatency("origin", performance.now() - startedAt);
      this.cacheSegment(segment.key, data);
    } catch (error) {
      if (!signal.aborted) this.events.segmentFailures += 1;
    }
  }

  async fetchFromPeer(peer, segmentKey, signal) {
    const base = peer.address.endsWith("/") ? peer.address : `${peer.address}/`;
    const endpoint = new URL(`segments/${encodeURIComponent(segmentKey)}`, base);
    const response = await fetch(endpoint, {
      signal: requestSignal(signal, this.options.config.p2pTimeoutMs),
      headers: { "user-agent": "OpenStreamGrid-LoadTest/1.0" },
    });
    if (!response.ok) throw new Error(`Peer returned HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  cacheSegment(key, data) {
    this.cache.set(key, data);
    this.stats.segmentsCached = this.cache.size;
    this.segmentsDirty = true;
    this.reportState();
  }

  recordLatency(source, latencyMs) {
    const values = this.latencies[source];
    values.push(latencyMs);
    if (values.length > 2_000) values.splice(0, values.length - 2_000);
  }

  reportState(force = false) {
    if (!this.active) return;
    const now = Date.now();
    if (force || this.segmentsDirty) {
      this.sendTracker({
        type: "report_segments",
        segments: this.cache.keys(),
        replace: true,
      });
      this.segmentsDirty = false;
    }
    if (force || now - this.lastHeartbeatAt >= 5_000) {
      this.sendTracker({
        type: "heartbeat",
        uploadBandwidthBps: this.options.config.uploadBandwidthMbps * 1_000_000,
        successRate:
          this.stats.p2pRequests === 0
            ? 1
            : this.stats.p2pSuccesses / this.stats.p2pRequests,
      });
      this.lastHeartbeatAt = now;
    }
    if (force || now - this.lastStatsAt >= 5_000) {
      this.sendTracker({ type: "report_stats", stats: { ...this.stats } });
      this.lastStatsAt = now;
    }
  }
}

class VirtualPeerUploadServer {
  constructor(config) {
    this.config = config;
    this.peers = new Map();
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
  }

  add(peer) {
    this.peers.set(peer.id, peer);
  }

  async start() {
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.config.uploadPort, "0.0.0.0", () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  async stop() {
    if (!this.server.listening) return;
    await new Promise((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
      this.server.closeAllConnections();
    });
  }

  async handle(request, response) {
    try {
      const url = new URL(request.url ?? "/", "http://load-test.local");
      if (request.method === "GET" && url.pathname === "/health") {
        this.sendJson(response, 200, {
          status: "ok",
          activePeers: [...this.peers.values()].filter((peer) => peer.active).length,
        });
        return;
      }
      const match = url.pathname.match(/^\/peers\/([^/]+)\/segments\/([^/]+)$/);
      if (request.method !== "GET" || !match?.[1] || !match[2]) {
        this.sendJson(response, 404, { error: "Route not found" });
        return;
      }
      const peer = this.peers.get(decodeURIComponent(match[1]));
      if (!peer) {
        this.sendJson(response, 404, { error: "Peer not found" });
        return;
      }
      if (!peer.active) {
        this.sendJson(response, 503, { error: "Peer is offline" });
        return;
      }
      if (peer.activeUploads >= this.config.maxUploadConnections) {
        response.writeHead(429, { "retry-after": "1" });
        response.end();
        return;
      }
      let segmentKey;
      try {
        segmentKey = decodeURIComponent(match[2]);
      } catch {
        this.sendJson(response, 400, { error: "Invalid segment name" });
        return;
      }
      const data = peer.cache.get(segmentKey);
      if (!data) {
        this.sendJson(response, 404, { error: "Segment not found" });
        return;
      }

      peer.activeUploads += 1;
      try {
        response.writeHead(200, {
          "content-type": "video/mp2t",
          "content-length": data.byteLength,
          "cache-control": "private, max-age=30",
        });
        for (
          let offset = 0;
          offset < data.byteLength && !response.destroyed;
          offset += peer.uploadBucket.chunkBytes
        ) {
          const chunk = data.subarray(
            offset,
            Math.min(offset + peer.uploadBucket.chunkBytes, data.byteLength),
          );
          await peer.uploadBucket.consume(chunk.byteLength);
          if (response.destroyed) break;
          if (!response.write(chunk)) await this.waitForDrain(response);
          peer.stats.bytesUploadedP2P += chunk.byteLength;
        }
        if (!response.destroyed) response.end();
      } finally {
        peer.activeUploads -= 1;
      }
    } catch (error) {
      if (!response.headersSent) {
        this.sendJson(response, 500, { error: "Upload failed" });
      } else {
        response.destroy();
      }
    }
  }

  waitForDrain(response) {
    return new Promise((resolve) => {
      const done = () => {
        response.off("drain", done);
        response.off("close", done);
        resolve();
      };
      response.once("drain", done);
      response.once("close", done);
    });
  }

  sendJson(response, statusCode, value) {
    const body = JSON.stringify(value);
    response.writeHead(statusCode, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
    });
    response.end(body);
  }
}

const percentile = (values, quantile) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
};

const aggregate = (peers) => {
  const stats = emptyStats();
  const events = {
    sessions: 0,
    churns: 0,
    errors: 0,
    segmentFailures: 0,
    websocketDisconnects: 0,
  };
  const latencies = [];
  for (const peer of peers) {
    for (const key of Object.keys(stats)) stats[key] += peer.stats[key];
    for (const key of Object.keys(events)) events[key] += peer.events[key];
    latencies.push(...peer.latencies.p2p, ...peer.latencies.origin);
  }
  const downloaded = stats.bytesDownloadedP2P + stats.bytesDownloadedOrigin;
  return {
    stats,
    events,
    activePeers: peers.filter((peer) => peer.active).length,
    p2pSuccessPercent:
      stats.p2pRequests === 0 ? 0 : (stats.p2pSuccesses / stats.p2pRequests) * 100,
    cdnSavingsPercent:
      downloaded === 0 ? 0 : (stats.bytesDownloadedP2P / downloaded) * 100,
    latency: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
    },
  };
};

const formatBytes = (bytes) => {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)}GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)}MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)}KB`;
  return `${bytes}B`;
};

const printReport = (peers, totalPeers, startedAt, final = false) => {
  const result = aggregate(peers);
  const elapsed = ((Date.now() - startedAt) / 1_000).toFixed(0);
  const prefix = final ? "[LoadTest] FINAL" : "[LoadTest]";
  console.log(
    `${prefix} t=${elapsed}s peers=${result.activePeers}/${totalPeers}` +
      ` p2p=${result.stats.p2pSuccesses}/${result.stats.p2pRequests}` +
      ` (${result.p2pSuccessPercent.toFixed(1)}%)` +
      ` origin=${result.stats.originRequests}` +
      ` fallbacks=${result.stats.fallbacks}` +
      ` p2p_bytes=${formatBytes(result.stats.bytesDownloadedP2P)}` +
      ` origin_bytes=${formatBytes(result.stats.bytesDownloadedOrigin)}` +
      ` uploaded=${formatBytes(result.stats.bytesUploadedP2P)}` +
      ` cdn_savings=${result.cdnSavingsPercent.toFixed(1)}%` +
      ` latency_ms=${result.latency.p50.toFixed(0)}/${result.latency.p95.toFixed(0)}/${result.latency.p99.toFixed(0)}` +
      ` churns=${result.events.churns}` +
      ` errors=${result.events.errors + result.events.segmentFailures}`,
  );
};

const reportLoop = async (peers, config, startedAt, signal) => {
  while (!signal.aborted) {
    await delay(config.reportIntervalSeconds * 1_000, signal);
    if (!signal.aborted) printReport(peers, config.peers, startedAt);
  }
};

const main = async () => {
  const config = parseArguments(process.argv.slice(2));
  if (!config) return;

  const controller = new AbortController();
  const stop = (signal) => {
    if (!controller.signal.aborted) {
      console.log(`[LoadTest] received=${signal} shutting_down=true`);
      controller.abort(new Error(`Received ${signal}`));
    }
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));

  const origin = originConfiguration(config.originUrl);
  const mediaPlaylistUrl = await waitForMediaPlaylist(
    origin.masterUrl,
    config.quality,
    controller.signal,
  );
  const uploadServer = new VirtualPeerUploadServer(config);
  const peers = Array.from({ length: config.peers }, (_, index) => {
    const joinDelayMs =
      config.peers === 1
        ? 0
        : (index / (config.peers - 1)) * config.rampUpSeconds * 1_000;
    return new VirtualPeer({
      id: `loadtest-${String(index + 1).padStart(3, "0")}`,
      config,
      joinDelayMs,
      mediaPlaylistUrl,
      originBaseUrl: origin.baseUrl,
    });
  });
  for (const peer of peers) uploadServer.add(peer);
  await uploadServer.start();

  const startedAt = Date.now();
  console.log(
    `[LoadTest] starting peers=${config.peers} duration=${config.durationSeconds}s` +
      ` ramp_up=${config.rampUpSeconds}s churn=${config.churn}` +
      ` playlist=${mediaPlaylistUrl.href}` +
      ` p2p=${config.p2pEnabled ? "enabled" : "disabled"}`,
  );

  const peerRuns = peers.map((peer) => peer.run(controller.signal));
  const reporting = reportLoop(peers, config, startedAt, controller.signal);
  await delay(config.durationSeconds * 1_000, controller.signal);
  controller.abort(new Error("Load-test duration elapsed"));
  await Promise.allSettled(peerRuns);
  await reporting;
  await uploadServer.stop();
  printReport(peers, config.peers, startedAt, true);
};

main().catch((error) => {
  console.error(`[LoadTest] fatal=${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
