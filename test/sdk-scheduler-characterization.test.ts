import assert from "node:assert/strict";
import test from "node:test";
import {
  OpenStreamGridHlsPlugin,
  sortBrowserCandidates,
  type PeerCandidate,
} from "../sdk/src/hls-plugin.js";

const makeCandidate = (
  id: string,
  trustScore: number,
  latencyMs: number,
): PeerCandidate => ({
  peer: {
    id,
    address: `http://${id}:9090`,
    segments: ["segment.ts"],
    latencyMs,
    successRate: 1,
    trustScore,
  },
  segmentId: "segment.ts",
});

const makePlugin = (): OpenStreamGridHlsPlugin =>
  new OpenStreamGridHlsPlugin({
    trackerUrl: "ws://tracker.example/ws",
    broadcastId: "live",
    verifySegments: false,
    peerParticipation: false,
  });

type BrowserPeerFetchResult = {
  data: Uint8Array;
  peerId: string;
};

type BrowserSchedulerHarness = {
  fetchFromPeers(
    candidates: PeerCandidate[],
    signal: AbortSignal,
  ): Promise<BrowserPeerFetchResult | null>;
  fetchFromPeer(
    candidate: PeerCandidate,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<Uint8Array>;
};

const schedulerHarness = (
  plugin: OpenStreamGridHlsPlugin,
): BrowserSchedulerHarness =>
  plugin as unknown as BrowserSchedulerHarness;

test("sorts browser candidates by trust score descending", () => {
  const candidates = [
    makeCandidate("medium", 0.6, 10),
    makeCandidate("low", 0.2, 1),
    makeCandidate("high", 0.9, 100),
  ];

  assert.deepEqual(
    sortBrowserCandidates(candidates).map((candidate) => candidate.peer.id),
    ["high", "medium", "low"],
  );
  assert.deepEqual(
    candidates.map((candidate) => candidate.peer.id),
    ["medium", "low", "high"],
  );
});

test("uses ascending latency as the equal-trust browser tie breaker", () => {
  const candidates = [
    makeCandidate("slow", 0.8, 300),
    makeCandidate("fast", 0.8, 20),
    makeCandidate("medium", 0.8, 100),
  ];

  assert.deepEqual(
    sortBrowserCandidates(candidates).map((candidate) => candidate.peer.id),
    ["fast", "medium", "slow"],
  );
});

test("probes at most three browser peers in parallel", async () => {
  const scheduler = schedulerHarness(makePlugin());
  const attempted: string[] = [];
  scheduler.fetchFromPeer = async (candidate) => {
    attempted.push(candidate.peer.id);
    throw new Error("unavailable");
  };

  const result = await scheduler.fetchFromPeers(
    [
      makeCandidate("first", 1, 10),
      makeCandidate("second", 0.9, 20),
      makeCandidate("third", 0.8, 30),
      makeCandidate("fourth", 0.7, 40),
    ],
    new AbortController().signal,
  );

  assert.equal(result, null);
  assert.deepEqual(attempted, ["first", "second", "third"]);
});

test("returns the first successful browser probe and aborts the rest", async () => {
  const scheduler = schedulerHarness(makePlugin());
  const aborted = new Set<string>();
  let releaseWinner: (() => void) | undefined;
  const winnerReady = new Promise<void>((resolve) => {
    releaseWinner = resolve;
  });
  scheduler.fetchFromPeer = async (candidate, _timeoutMs, signal) => {
    if (candidate.peer.id === "failed-fast") {
      throw new Error("unavailable");
    }
    if (candidate.peer.id === "winner") {
      await winnerReady;
      return new Uint8Array([2]);
    }
    return new Promise<Uint8Array>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          aborted.add(candidate.peer.id);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  };

  const pending = scheduler.fetchFromPeers(
    [
      makeCandidate("failed-fast", 1, 10),
      makeCandidate("winner", 0.9, 20),
      makeCandidate("still-pending", 0.8, 30),
    ],
    new AbortController().signal,
  );
  await new Promise((resolve) => setImmediate(resolve));
  releaseWinner?.();

  const result = await pending;
  assert.deepEqual(result, {
    data: new Uint8Array([2]),
    peerId: "winner",
  });
  assert.deepEqual(aborted, new Set(["still-pending"]));
});

test("returns null when all browser probes fail", async () => {
  const scheduler = schedulerHarness(makePlugin());
  scheduler.fetchFromPeer = async () => {
    throw new Error("unavailable");
  };

  assert.equal(
    await scheduler.fetchFromPeers(
      [
        makeCandidate("first", 1, 10),
        makeCandidate("second", 0.9, 20),
        makeCandidate("third", 0.8, 30),
      ],
      new AbortController().signal,
    ),
    null,
  );
});

test("cancels all browser probes when the caller aborts", async () => {
  const scheduler = schedulerHarness(makePlugin());
  const observedSignals: AbortSignal[] = [];
  scheduler.fetchFromPeer = async (
    _candidate: PeerCandidate,
    _timeoutMs: number,
    signal: AbortSignal,
  ) => {
    observedSignals.push(signal);
    return new Promise<Uint8Array>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  };
  const controller = new AbortController();
  const pending = scheduler.fetchFromPeers(
    [
      makeCandidate("first", 1, 10),
      makeCandidate("second", 0.9, 20),
      makeCandidate("third", 0.8, 30),
    ],
    controller.signal,
  );
  await new Promise((resolve) => setImmediate(resolve));

  controller.abort(new DOMException("Caller aborted", "AbortError"));

  assert.equal(await pending, null);
  assert.equal(observedSignals.length, 3);
  assert.ok(observedSignals.every((signal) => signal.aborted));
});
