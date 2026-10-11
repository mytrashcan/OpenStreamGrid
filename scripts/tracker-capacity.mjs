#!/usr/bin/env node

// Control-plane load test for a single tracker. Simulates N peers in one
// broadcast that join, subscribe over WebSocket, report a new segment every
// segment duration, and send heartbeats and stats like real peers. Media is
// not transferred. Each simulated peer uses its own X-Forwarded-For address,
// so run the tracker with TRUST_PROXY_HOPS=1 and limits high enough for N:
//
//   TRUST_PROXY_HOPS=1 RATE_LIMIT_RPS=100000 RATE_LIMIT_BURST=100000 \
//   MAX_PEERS_PER_BROADCAST=5000 TRACKER_API_KEY=... node tracker/dist/server.js
//
//   node scripts/tracker-capacity.mjs --api-key ... --peers 100,250,500 \
//     --tracker-pid <pid>
//
// Reports, per peer count: probe latency for a REST peer lookup (p50/p95/p99),
// WebSocket messages delivered per second, errors, and tracker CPU and RSS
// (sampled with `ps` when --tracker-pid is given).

import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (value.startsWith("--")) pairs.push([value.slice(2), all[index + 1]]);
    return pairs;
  }, []),
);
const trackerUrl = new URL(args["tracker-url"] ?? "http://127.0.0.1:7070");
const apiKey = args["api-key"] ?? process.env.TRACKER_API_KEY;
const peerCounts = (args.peers ?? "100,250,500").split(",").map(Number);
const durationMs = Number(args.duration ?? 30) * 1_000;
const segmentIntervalMs = Number(args["segment-interval"] ?? 2) * 1_000;
const reportIntervalMs = Number(args["report-interval"] ?? 5) * 1_000;
const trackerPid = args["tracker-pid"];
const cachedSegments = 12;
const CONNECT_BATCH = 50;

if (!apiKey) throw new Error("Pass --api-key or TRACKER_API_KEY");
for (const count of peerCounts) {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error(`Invalid peer count '${count}'`);
}

const percentile = (values, fraction) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
};

const sampleTracker = () => {
  if (!trackerPid) return undefined;
  const [cpu, rssKb] = execFileSync("ps", ["-o", "%cpu=,rss=", "-p", String(trackerPid)], { encoding: "utf8" })
    .trim()
    .split(/\s+/)
    .map(Number);
  return { cpu, rssMb: rssKb / 1_024 };
};

const forwardedFor = (index) => `198.18.${Math.floor(index / 250)}.${(index % 250) + 1}`;

const json = async (path, init = {}, index) => {
  const response = await fetch(new URL(path, trackerUrl), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(index === undefined ? { "x-api-key": apiKey } : { "x-forwarded-for": forwardedFor(index) }),
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path}: HTTP ${response.status}`);
  return response.status === 204 ? undefined : response.json();
};

const emptyStats = (segments) => ({
  bytesDownloadedP2P: 0,
  bytesDownloadedOrigin: segments * 400_000,
  bytesUploadedP2P: 0,
  p2pRequests: 0,
  p2pSuccesses: 0,
  p2pFailures: 0,
  originRequests: segments,
  integrityFailures: 0,
  fallbacks: 0,
  segmentsCached: Math.min(segments, cachedSegments),
});

const runStage = async (peerCount) => {
  const broadcastId = `capacity-${peerCount}-${Date.now()}`;
  await json("/api/v1/broadcasts", {
    method: "POST",
    body: JSON.stringify({ id: broadcastId, playlistUrl: "http://origin.invalid/live.m3u8" }),
  });

  const peers = [];
  for (let index = 0; index < peerCount; index += 1) {
    const peerId = `cap-${index}`;
    const { sessionToken } = await json(
      `/api/v1/broadcasts/${broadcastId}/peers`,
      { method: "POST", body: JSON.stringify({ id: peerId, address: `webrtc://${peerId}` }) },
      index,
    );
    peers.push({ index, peerId, sessionToken, segment: 0, received: 0, socket: undefined });
  }

  let errors = 0;
  const closeCodes = new Map();
  const wsUrl = new URL("/ws", trackerUrl);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  const connect = (peer) =>
        new Promise((resolve) => {
          const socket = new WebSocket(wsUrl, {
            headers: {
              authorization: `Bearer ${peer.sessionToken}`,
              "x-forwarded-for": forwardedFor(peer.index),
            },
          });
          peer.socket = socket;
          socket.on("message", () => {
            peer.received += 1;
          });
          socket.on("error", () => {
            errors += 1;
            resolve();
          });
          socket.on("close", (code) => {
            if (!peer.closing) closeCodes.set(code, (closeCodes.get(code) ?? 0) + 1);
            resolve();
          });
          socket.once("open", () => {
            socket.send(JSON.stringify({ type: "subscribe", broadcastId, peerId: peer.peerId }));
            resolve();
          });
        });
  // Connect in batches like an arriving audience; a single burst of thousands
  // of handshakes overflows the OS accept queue and measures that instead.
  for (let start = 0; start < peers.length; start += CONNECT_BATCH) {
    await Promise.all(peers.slice(start, start + CONNECT_BATCH).map(connect));
  }
  const connectFailures = peers.filter((peer) => peer.socket?.readyState !== WebSocket.OPEN).length;
  closeCodes.clear();

  const send = (peer, message) => {
    if (peer.socket?.readyState === WebSocket.OPEN) {
      peer.socket.send(JSON.stringify({ broadcastId, peerId: peer.peerId, ...message }));
    }
  };
  // Stagger peers across the interval like independent players would be.
  const timers = peers.flatMap((peer) => {
    const offset = Math.floor((peer.index / peerCount) * segmentIntervalMs);
    const segmentTimer = setTimeout(() => {
      const tick = () => {
        peer.segment += 1;
        send(peer, {
          type: "report_segments",
          added: [`seg_${String(peer.segment).padStart(6, "0")}.ts`],
          removed:
            peer.segment > cachedSegments
              ? [`seg_${String(peer.segment - cachedSegments).padStart(6, "0")}.ts`]
              : [],
        });
      };
      tick();
      peer.segmentInterval = setInterval(tick, segmentIntervalMs);
    }, offset);
    const reportTimer = setInterval(() => {
      send(peer, { type: "heartbeat", latencyMs: 20, uploadBandwidthBps: 4_000_000, successRate: 1 });
      send(peer, { type: "report_stats", stats: emptyStats(peer.segment) });
    }, reportIntervalMs);
    return [segmentTimer, reportTimer];
  });

  const receivedBefore = peers.reduce((sum, peer) => sum + peer.received, 0);
  const latencies = [];
  const samples = [];
  const startedAt = Date.now();
  while (Date.now() - startedAt < durationMs) {
    const probeStarted = performance.now();
    try {
      await json(`/api/v1/broadcasts/${broadcastId}/peers?segment=seg_000001.ts`);
      latencies.push(performance.now() - probeStarted);
    } catch {
      errors += 1;
    }
    const sample = sampleTracker();
    if (sample) samples.push(sample);
    await delay(500);
  }
  const elapsedSeconds = (Date.now() - startedAt) / 1_000;
  const delivered = peers.reduce((sum, peer) => sum + peer.received, 0) - receivedBefore;

  const openAtEnd = peers.filter((peer) => peer.socket?.readyState === WebSocket.OPEN).length;
  for (const timer of timers) {
    clearTimeout(timer);
    clearInterval(timer);
  }
  for (const peer of peers) {
    clearInterval(peer.segmentInterval);
    peer.closing = true;
    peer.socket?.close();
  }
  await json(`/api/v1/broadcasts/${broadcastId}`, { method: "DELETE" }).catch(() => undefined);

  return {
    peers: peerCount,
    probeP50Ms: percentile(latencies, 0.5),
    probeP95Ms: percentile(latencies, 0.95),
    probeP99Ms: percentile(latencies, 0.99),
    wsMessagesPerSecond: delivered / elapsedSeconds,
    errors,
    connectFailures,
    openAtEnd,
    closeCodes: Object.fromEntries(closeCodes),
    cpuAvg: samples.length ? samples.reduce((sum, sample) => sum + sample.cpu, 0) / samples.length : undefined,
    rssMaxMb: samples.length ? Math.max(...samples.map((sample) => sample.rssMb)) : undefined,
  };
};

const results = [];
for (const peerCount of peerCounts) {
  process.stderr.write(`Running ${peerCount} peers for ${durationMs / 1_000} s...\n`);
  results.push(await runStage(peerCount));
  await delay(2_000);
}

const fixed = (value, digits = 1) => (value === undefined ? "n/a" : value.toFixed(digits));
console.log("| Peers | Probe p50 | Probe p95 | Probe p99 | WS msgs/s delivered | Tracker CPU | Tracker RSS | Connect failures | Dropped during run |");
console.log("| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const result of results) {
  console.log(
    `| ${result.peers} | ${fixed(result.probeP50Ms)} ms | ${fixed(result.probeP95Ms)} ms | ${fixed(result.probeP99Ms)} ms | ` +
      `${fixed(result.wsMessagesPerSecond, 0)} | ${fixed(result.cpuAvg)}% | ${fixed(result.rssMaxMb, 0)} MB | ` +
      `${result.connectFailures} | ${result.peers - result.connectFailures - result.openAtEnd} |`,
  );
}
for (const result of results) {
  if (Object.keys(result.closeCodes).length > 0) {
    process.stderr.write(`${result.peers} peers: unexpected close codes ${JSON.stringify(result.closeCodes)}\n`);
  }
}
