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
// Simulated peers declare the `inventory_batch` and `neighbor_view` subscribe
// features like the SDK and Node peer do. Pass --neighbor-view false to see the
// whole audience, or --inventory-batch false to measure legacy clients that
// receive one message per inventory report.
//
// Reports, per peer count: probe latency for a REST lookup of a segment peers
// currently hold (p50/p95/p99) and failed probes, WebSocket messages and
// megabytes delivered per second, connection failures and drops, and tracker
// CPU (CPU time used during the stage divided by its wall time) and peak RSS
// when --tracker-pid is given.

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
const inventoryBatch = (args["inventory-batch"] ?? "true") !== "false";
const neighborView = inventoryBatch && (args["neighbor-view"] ?? "true") !== "false";
const features = [
  ...(inventoryBatch ? ["inventory_batch"] : []),
  ...(neighborView ? ["neighbor_view"] : []),
];
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

// `ps -o time` is cumulative CPU time ([dd-]hh:mm:ss or mm:ss.ss); `%cpu` is a
// lifetime or decaying average and would blend stages together.
const cpuSeconds = (value) => {
  const [days, clock] = value.includes("-") ? value.split("-") : ["0", value];
  return clock
    .split(":")
    .map(Number)
    .reduce((total, part) => total * 60 + part, 0) + Number(days) * 86_400;
};

const sampleTracker = () => {
  if (!trackerPid) return undefined;
  const [time, rssKb] = execFileSync("ps", ["-o", "time=,rss=", "-p", String(trackerPid)], { encoding: "utf8" })
    .trim()
    .split(/\s+/);
  return { cpuSeconds: cpuSeconds(time), rssMb: Number(rssKb) / 1_024 };
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

  // Join in concurrent batches: joining thousands of peers one by one takes
  // longer than the tracker's stale-peer timeout, and the first peers expire
  // before they connect.
  const peers = [];
  const joinStarted = Date.now();
  for (let start = 0; start < peerCount; start += CONNECT_BATCH) {
    const indexes = Array.from(
      { length: Math.min(CONNECT_BATCH, peerCount - start) },
      (_, offset) => start + offset,
    );
    peers.push(
      ...(await Promise.all(
        indexes.map(async (index) => {
          const peerId = `cap-${index}`;
          const { sessionToken } = await json(
            `/api/v1/broadcasts/${broadcastId}/peers`,
            { method: "POST", body: JSON.stringify({ id: peerId, address: `webrtc://${peerId}` }) },
            index,
          );
          return { index, peerId, sessionToken, segment: 0, received: 0, receivedBytes: 0, socket: undefined };
        }),
      )),
    );
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
          socket.on("message", (data) => {
            peer.received += 1;
            peer.receivedBytes += data.length;
          });
          socket.on("error", () => {
            errors += 1;
            resolve();
          });
          socket.on("close", (code, reason) => {
            // Group reasons that differ only by a quoted peer ID.
            const key = `${code} ${reason.toString().replace(/'[^']*'/g, "'…'")}`.trim();
            if (!peer.closing) closeCodes.set(key, (closeCodes.get(key) ?? 0) + 1);
            resolve();
          });
          socket.once("open", () => {
            socket.send(
              JSON.stringify({
                type: "subscribe",
                broadcastId,
                peerId: peer.peerId,
                ...(features.length > 0 ? { features } : {}),
              }),
            );
            // Real clients report right after subscribing, which also keeps a
            // slow ramp-up from expiring the first peers.
            socket.send(
              JSON.stringify({ type: "heartbeat", broadcastId, peerId: peer.peerId, latencyMs: 20 }),
            );
            resolve();
          });
        });
  const connectStarted = Date.now();
  // Connect in batches like an arriving audience; a single burst of thousands
  // of handshakes overflows the OS accept queue and measures that instead.
  for (let start = 0; start < peers.length; start += CONNECT_BATCH) {
    await Promise.all(peers.slice(start, start + CONNECT_BATCH).map(connect));
  }
  const connectFailures = peers.filter((peer) => peer.socket?.readyState !== WebSocket.OPEN).length;
  process.stderr.write(
    `  joined in ${((connectStarted - joinStarted) / 1_000).toFixed(1)} s, ` +
      `connected in ${((Date.now() - connectStarted) / 1_000).toFixed(1)} s\n`,
  );
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
  const receivedBytesBefore = peers.reduce((sum, peer) => sum + peer.receivedBytes, 0);
  const latencies = [];
  const samples = [];
  let probeFailures = 0;
  const startSample = sampleTracker();
  const startedAt = Date.now();
  while (Date.now() - startedAt < durationMs) {
    // Look up a segment that peers still hold, not one they already evicted.
    const latest = Math.max(1, ...peers.map((peer) => peer.segment));
    const probeSegment = `seg_${String(Math.max(1, latest - 1)).padStart(6, "0")}.ts`;
    const probeStarted = performance.now();
    try {
      await json(`/api/v1/broadcasts/${broadcastId}/peers?segment=${probeSegment}`);
      latencies.push(performance.now() - probeStarted);
    } catch {
      probeFailures += 1;
    }
    const sample = sampleTracker();
    if (sample) samples.push(sample);
    await delay(500);
  }
  const elapsedSeconds = (Date.now() - startedAt) / 1_000;
  const endSample = sampleTracker();
  const delivered = peers.reduce((sum, peer) => sum + peer.received, 0) - receivedBefore;
  const deliveredBytes = peers.reduce((sum, peer) => sum + peer.receivedBytes, 0) - receivedBytesBefore;

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
    probeP50Ms: latencies.length ? percentile(latencies, 0.5) : undefined,
    probeP95Ms: latencies.length ? percentile(latencies, 0.95) : undefined,
    probeP99Ms: latencies.length ? percentile(latencies, 0.99) : undefined,
    probeFailures,
    wsMessagesPerSecond: delivered / elapsedSeconds,
    wsMegabytesPerSecond: deliveredBytes / elapsedSeconds / 1_000_000,
    errors,
    connectFailures,
    openAtEnd,
    closeCodes: Object.fromEntries(closeCodes),
    cpuPercent:
      startSample && endSample
        ? ((endSample.cpuSeconds - startSample.cpuSeconds) / elapsedSeconds) * 100
        : undefined,
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
const ms = (value) => (value === undefined ? "n/a" : `${fixed(value)} ms`);
console.log("| Peers | Probe p50 | Probe p95 | Probe p99 | Failed probes | WS msgs/s delivered | WS MB/s delivered | Tracker CPU | Tracker RSS | Connect failures | Dropped during run |");
console.log("| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const result of results) {
  console.log(
    `| ${result.peers} | ${ms(result.probeP50Ms)} | ${ms(result.probeP95Ms)} | ${ms(result.probeP99Ms)} | ${result.probeFailures} | ` +
      `${fixed(result.wsMessagesPerSecond, 0)} | ${fixed(result.wsMegabytesPerSecond)} | ${fixed(result.cpuPercent)}% | ${fixed(result.rssMaxMb, 0)} MB | ` +
      `${result.connectFailures} | ${result.peers - result.connectFailures - result.openAtEnd} |`,
  );
}
for (const result of results) {
  if (Object.keys(result.closeCodes).length > 0) {
    process.stderr.write(`${result.peers} peers: unexpected close codes ${JSON.stringify(result.closeCodes)}\n`);
  }
}
