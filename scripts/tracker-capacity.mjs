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
// Pass --churn <fraction> to replace that share of the audience every second.
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
// Fraction of the audience replaced per second: that many peers leave and as
// many new ones join, connect, and start reporting.
const churnPerSecond = Number(args.churn ?? 0);
if (!Number.isFinite(churnPerSecond) || churnPerSecond < 0 || churnPerSecond > 1) {
  throw new Error("--churn must be a fraction between 0 and 1 (peers replaced per second)");
}
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

// The tracker's event-loop delay since the previous read, from /metrics. It
// separates delay on the tracker from delay in this load generator, which
// shares a machine and also times the probes.
const trackerLoopDelay = async () => {
  try {
    const response = await fetch(new URL("/metrics", trackerUrl), { headers: { "x-api-key": apiKey } });
    const text = await response.text();
    const seconds = (name) =>
      Number(new RegExp(`^openstreamgrid_event_loop_delay_${name}_seconds (\\S+)$`, "m").exec(text)?.[1]);
    const p99 = seconds("p99");
    const max = seconds("max");
    return Number.isFinite(p99) && Number.isFinite(max) ? { p99Ms: p99 * 1_000, maxMs: max * 1_000 } : undefined;
  } catch {
    return undefined;
  }
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

  const join = async (index) => {
    const peerId = `cap-${index}`;
    const { sessionToken } = await json(
      `/api/v1/broadcasts/${broadcastId}/peers`,
      { method: "POST", body: JSON.stringify({ id: peerId, address: `webrtc://${peerId}` }) },
      index,
    );
    return { index, peerId, sessionToken, segment: 0, received: 0, receivedBytes: 0, socket: undefined, timers: [] };
  };
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
    peers.push(...(await Promise.all(indexes.map(join))));
  }
  // Every peer that took part, for traffic totals; `peers` holds the active ones.
  const everyPeer = [...peers];

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
  const startReporting = (peer) => {
    const offset = Math.floor(((peer.index % peerCount) / peerCount) * segmentIntervalMs);
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
    // Spread heartbeats and stats over the report interval too: started
    // together, all peers reported in the same instant every interval.
    const reportOffset = Math.floor(((peer.index % peerCount) / peerCount) * reportIntervalMs);
    const reportTimer = setTimeout(() => {
      const report = () => {
        send(peer, { type: "heartbeat", latencyMs: 20, uploadBandwidthBps: 4_000_000, successRate: 1 });
        send(peer, { type: "report_stats", stats: emptyStats(peer.segment) });
      };
      peer.timers.push(setInterval(report, reportIntervalMs));
    }, reportOffset);
    peer.timers.push(segmentTimer, reportTimer);
  };
  const stopReporting = (peer) => {
    for (const timer of peer.timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    clearInterval(peer.segmentInterval);
  };
  for (const peer of peers) startReporting(peer);

  // Churn: replace a share of the audience every second, like viewers who
  // leave and others who arrive. Leaving peers close their socket and leave
  // over REST; arrivals join, connect, and pick up at the current segment.
  let churned = 0;
  let churnCarry = 0;
  let nextIndex = peerCount;
  const churnOnce = async () => {
    churnCarry += churnPerSecond * peerCount;
    const count = Math.min(Math.floor(churnCarry), peers.length);
    churnCarry -= count;
    if (count === 0) return;
    const leaving = [];
    for (let left = 0; left < count; left += 1) {
      leaving.push(...peers.splice(Math.floor(Math.random() * peers.length), 1));
    }
    await Promise.all(
      leaving.map(async (peer) => {
        stopReporting(peer);
        peer.closing = true;
        peer.socket?.close();
        await json(`/api/v1/broadcasts/${broadcastId}/peers/${peer.peerId}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${peer.sessionToken}` },
        }).catch(() => undefined);
      }),
    );
    const latest = Math.max(0, ...peers.map((peer) => peer.segment));
    const arrivals = await Promise.all(
      Array.from({ length: count }, () => join((nextIndex += 1))),
    );
    for (const peer of arrivals) peer.segment = Math.max(0, latest - 1);
    await Promise.all(arrivals.map(connect));
    for (const peer of arrivals) startReporting(peer);
    peers.push(...arrivals);
    everyPeer.push(...arrivals);
    churned += count;
  };
  let churning = Promise.resolve();
  const churnTimer =
    churnPerSecond > 0
      ? setInterval(() => {
          churning = churning.then(churnOnce).catch(() => undefined);
        }, 1_000)
      : undefined;

  const receivedBefore = everyPeer.reduce((sum, peer) => sum + peer.received, 0);
  const receivedBytesBefore = everyPeer.reduce((sum, peer) => sum + peer.receivedBytes, 0);
  const latencies = [];
  const samples = [];
  let probeFailures = 0;
  const startSample = sampleTracker();
  await trackerLoopDelay(); // Reset: measure only this stage.
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
  clearInterval(churnTimer);
  await churning;
  const loopDelay = await trackerLoopDelay();
  const elapsedSeconds = (Date.now() - startedAt) / 1_000;
  const endSample = sampleTracker();
  const delivered = everyPeer.reduce((sum, peer) => sum + peer.received, 0) - receivedBefore;
  const deliveredBytes =
    everyPeer.reduce((sum, peer) => sum + peer.receivedBytes, 0) - receivedBytesBefore;

  const openAtEnd = peers.filter((peer) => peer.socket?.readyState === WebSocket.OPEN).length;
  for (const peer of peers) {
    stopReporting(peer);
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
    active: peers.length,
    churned,
    loopDelay,
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
const churnColumn = churnPerSecond > 0;
console.log(
  "| Peers | Probe p50 | Probe p95 | Probe p99 | Failed probes | WS msgs/s delivered | WS MB/s delivered | Tracker CPU | Tracker RSS | Tracker loop delay p99 / max | Connect failures | Dropped during run |" +
    (churnColumn ? " Peers replaced |" : ""),
);
console.log(
  "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |" + (churnColumn ? " ---: |" : ""),
);
for (const result of results) {
  const dropped = Math.max(0, result.active - result.connectFailures - result.openAtEnd);
  console.log(
    `| ${result.peers} | ${ms(result.probeP50Ms)} | ${ms(result.probeP95Ms)} | ${ms(result.probeP99Ms)} | ${result.probeFailures} | ` +
      `${fixed(result.wsMessagesPerSecond, 0)} | ${fixed(result.wsMegabytesPerSecond)} | ${fixed(result.cpuPercent)}% | ${fixed(result.rssMaxMb, 0)} MB | ` +
      `${result.loopDelay ? `${fixed(result.loopDelay.p99Ms)} / ${fixed(result.loopDelay.maxMs)} ms` : "n/a"} | ` +
      `${result.connectFailures} | ${dropped} |` +
      (churnColumn ? ` ${result.churned} |` : ""),
  );
}
for (const result of results) {
  if (Object.keys(result.closeCodes).length > 0) {
    process.stderr.write(`${result.peers} peers: unexpected close codes ${JSON.stringify(result.closeCodes)}\n`);
  }
}
