import assert from "node:assert/strict";
import test from "node:test";
import type {
  Peer,
  SegmentScheduler,
  SegmentSchedulingPlan,
} from "@openstreamgrid/common";
import { SegmentCache } from "../src/cache.js";
import {
  HybridSegmentFetcher,
  type FetcherOptions,
  type SchedulerOutcome,
} from "../src/fetcher.js";
import { OriginLatencyEstimator } from "../src/origin-latency-estimator.js";
import { TrafficStats } from "../src/stats.js";
import type { FetchFunction } from "../src/verifier.js";

const segmentPeer: Peer = {
  id: "peer-a",
  address: "http://peer-a:9090",
  segments: ["segment.ts"],
  joinedAt: "2026-07-26T00:00:00.000Z",
  lastSeenAt: "2026-07-26T00:00:00.000Z",
  latencyMs: 10,
  successRate: 1,
  trustScore: 1,
  uploadBandwidthBps: 1_000_000,
};

const hedgedScheduler = (hedgeDelayMs: number): SegmentScheduler => ({
  policyName: "test-hedged",
  planSegment(context): SegmentSchedulingPlan {
    const peerId = context.candidates[0]?.id;
    assert.ok(peerId);
    return {
      policy: this.policyName,
      mode: "single-peer",
      peerIds: [peerId],
      rankedPeers: [{ peerId, rank: 1, reasons: ["test"] }],
      reason: "deadline_hedged",
      execution: {
        strategy: "hedged-origin",
        peerAttemptBudgetMs: hedgeDelayMs,
        originHedgeDelayMs: hedgeDelayMs,
      },
    };
  },
});

const createFetcher = (
  fetchImpl: FetchFunction,
  options: Partial<FetcherOptions> = {},
): { fetcher: HybridSegmentFetcher; stats: TrafficStats } => {
  const stats = options.stats ?? new TrafficStats();
  return {
    stats,
    fetcher: new HybridSegmentFetcher({
      selfPeerId: "self",
      originBaseUrl: new URL("http://origin:8080/hls/"),
      cache: new SegmentCache(1_000),
      directory: {
        async listPeers(): Promise<Peer[]> {
          return [segmentPeer];
        },
        async reportFailure(): Promise<void> {},
      },
      verifier: {
        async verify(): Promise<boolean> {
          return true;
        },
      },
      scheduler: hedgedScheduler(25),
      ...options,
      stats,
      fetchImpl,
    }),
  };
};

const deferred = <T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
} => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const abortable = (
  pending: Promise<Response>,
  signal: AbortSignal | null | undefined,
  onAbort?: () => void,
): Promise<Response> =>
  new Promise((resolve, reject) => {
    const abort = (): void => {
      onAbort?.();
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
    pending.then(
      (response) => {
        signal?.removeEventListener("abort", abort);
        resolve(response);
      },
      (error: unknown) => {
        signal?.removeEventListener("abort", abort);
        reject(error);
      },
    );
    if (signal?.aborted) abort();
  });

const flushMicrotasks = async (): Promise<void> => {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
};

test("P2P wins before the Origin hedge delay", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const requests: string[] = [];
  const { fetcher, stats } = createFetcher(async (input) => {
    requests.push(String(input));
    return new Response("from-peer");
  });

  const result = await fetcher.fetchSegment("segment.ts", 3);

  assert.equal(result.source, "p2p");
  assert.deepEqual(requests, [
    "http://peer-a:9090/segments/segment.ts",
  ]);
  assert.equal(stats.snapshot().p2pRequests, 1);
  assert.equal(stats.snapshot().originRequests, 0);
});

test("starts Origin immediately when P2P fails before the hedge delay", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const requests: string[] = [];
  const outcomes: SchedulerOutcome[] = [];
  const { fetcher, stats } = createFetcher(
    async (input) => {
      requests.push(String(input));
      return String(input).startsWith("http://peer-a")
        ? new Response("peer unavailable", { status: 503 })
        : new Response("from-origin");
    },
    { onSchedulerOutcome: (outcome) => outcomes.push(outcome) },
  );

  const result = await fetcher.fetchSegment("segment.ts", 3);

  assert.equal(result.source, "origin");
  assert.deepEqual(requests, [
    "http://peer-a:9090/segments/segment.ts",
    "http://origin:8080/hls/segment.ts",
  ]);
  assert.equal(stats.snapshot().originRequests, 1);
  assert.deepEqual(outcomes, [
    {
      policy: "test-hedged",
      deadlineKind: "unknown",
      plannedStrategy: "hedged-origin",
      plannedMode: "single-peer",
      finalSource: "origin",
      hedgeStarted: true,
      outcome: "success",
    },
  ]);
});

test("P2P can win after the Origin hedge has started", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const peerResponse = deferred<Response>();
  const originResponse = deferred<Response>();
  let originAborted = false;
  const { fetcher, stats } = createFetcher(async (input, init) => {
    if (String(input).startsWith("http://peer-a")) {
      return abortable(peerResponse.promise, init?.signal);
    }
    return abortable(
      originResponse.promise,
      init?.signal,
      () => {
        originAborted = true;
      },
    );
  });

  const pending = fetcher.fetchSegment("segment.ts", 3);
  await flushMicrotasks();
  context.mock.timers.tick(25);
  await flushMicrotasks();
  assert.equal(stats.snapshot().originRequests, 1);

  peerResponse.resolve(new Response("late-peer"));
  const result = await pending;

  assert.equal(result.source, "p2p");
  assert.equal(result.data.toString(), "late-peer");
  assert.equal(originAborted, true);
  assert.equal(stats.snapshot().bytesDownloadedOrigin, 0);
});

test("Origin wins after the hedge delay and cancels P2P", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const peerResponse = deferred<Response>();
  let peerAborted = false;
  const { fetcher, stats } = createFetcher(async (input, init) => {
    if (String(input).startsWith("http://peer-a")) {
      return abortable(
        peerResponse.promise,
        init?.signal,
        () => {
          peerAborted = true;
        },
      );
    }
    return new Response("from-origin");
  });

  const pending = fetcher.fetchSegment("segment.ts", 3);
  await flushMicrotasks();
  context.mock.timers.tick(25);
  const result = await pending;

  assert.equal(result.source, "origin");
  assert.equal(result.data.toString(), "from-origin");
  assert.equal(peerAborted, true);
  assert.equal(stats.snapshot().p2pFailures, 0);
  assert.equal(stats.snapshot().bytesDownloadedP2P, 0);
  assert.equal(stats.snapshot().bytesDownloadedOrigin, 11);
});

test("reports an error when both hedged attempts fail", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { fetcher } = createFetcher(async (input) =>
    String(input).startsWith("http://peer-a")
      ? new Response("peer unavailable", { status: 503 })
      : new Response("origin unavailable", { status: 503 }),
  );

  const pending = fetcher.fetchSegment("segment.ts", 3);
  await flushMicrotasks();
  context.mock.timers.tick(25);

  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof AggregateError &&
      error.errors.length === 2 &&
      /P2P and Origin failed/.test(error.message),
  );
});

test("consumer abort cancels both hedged requests", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const peerResponse = deferred<Response>();
  const originResponse = deferred<Response>();
  const aborted = new Set<string>();
  const { fetcher } = createFetcher(async (input, init) => {
    const source = String(input).startsWith("http://peer-a")
      ? "p2p"
      : "origin";
    return abortable(
      source === "p2p" ? peerResponse.promise : originResponse.promise,
      init?.signal,
      () => aborted.add(source),
    );
  });
  const consumer = new AbortController();

  const pending = fetcher.fetchSegment("segment.ts", 3, consumer.signal);
  await flushMicrotasks();
  context.mock.timers.tick(25);
  await flushMicrotasks();
  consumer.abort(new Error("consumer stopped"));

  await assert.rejects(pending, /consumer stopped/);
  assert.deepEqual(aborted, new Set(["p2p", "origin"]));
});

test("successful Origin fetches update the latency estimator", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const observations: number[] = [];
  const estimator = new OriginLatencyEstimator();
  context.mock.method(estimator, "observe", (elapsedMs: number) => {
    observations.push(elapsedMs);
  });
  const peerResponse = deferred<Response>();
  const { fetcher } = createFetcher(
    async (input, init) =>
      String(input).startsWith("http://peer-a")
        ? abortable(peerResponse.promise, init?.signal)
        : new Response("origin"),
    { originLatencyEstimator: estimator },
  );

  const pending = fetcher.fetchSegment("segment.ts", 3);
  await flushMicrotasks();
  context.mock.timers.tick(25);
  await pending;

  assert.equal(observations.length, 1);
  assert.ok(Number.isFinite(observations[0]));
  assert.ok((observations[0] ?? -1) >= 0);
});

test("counts Origin requests only after the hedge starts", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const peerResponse = deferred<Response>();
  const originResponse = deferred<Response>();
  const { fetcher, stats } = createFetcher(async (input, init) =>
    abortable(
      String(input).startsWith("http://peer-a")
        ? peerResponse.promise
        : originResponse.promise,
      init?.signal,
    ),
  );

  const pending = fetcher.fetchSegment("segment.ts", 3);
  await flushMicrotasks();
  assert.equal(stats.snapshot().p2pRequests, 1);
  assert.equal(stats.snapshot().originRequests, 0);

  context.mock.timers.tick(25);
  await flushMicrotasks();
  assert.equal(stats.snapshot().originRequests, 1);

  originResponse.resolve(new Response("origin"));
  await pending;
});

test("coalesces consumers into one P2P request and one Origin hedge", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const peerResponse = deferred<Response>();
  const originResponse = deferred<Response>();
  const requests: string[] = [];
  const { fetcher } = createFetcher(async (input, init) => {
    requests.push(String(input));
    return abortable(
      String(input).startsWith("http://peer-a")
        ? peerResponse.promise
        : originResponse.promise,
      init?.signal,
    );
  });

  const first = fetcher.fetchSegment("segment.ts", 3);
  const second = fetcher.fetchSegment("segment.ts", 3);
  await flushMicrotasks();
  context.mock.timers.tick(25);
  await flushMicrotasks();
  originResponse.resolve(new Response("shared-origin"));

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.data.toString(), "shared-origin");
  assert.equal(secondResult.data.toString(), "shared-origin");
  assert.deepEqual(requests, [
    "http://peer-a:9090/segments/segment.ts",
    "http://origin:8080/hls/segment.ts",
  ]);
});
