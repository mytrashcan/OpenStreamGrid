import assert from "node:assert/strict";
import test from "node:test";
import { HttpTransport } from "../src/http-transport.js";

test("manages peer addresses without exposing mutable state", async () => {
  const transport = new HttpTransport();
  const addresses = ["http://peer-a:9090"];
  transport.setPeers(addresses);
  addresses.push("http://peer-b:9090");
  assert.deepEqual(transport.peers, ["http://peer-a:9090"]);
  const returned = transport.peers;
  returned.push("http://external:9090");
  assert.deepEqual(transport.peers, ["http://peer-a:9090"]);

  await transport.start({
    signalUrl: "ws://tracker:7070/ws",
    peerId: "peer-a",
    broadcastId: "live",
  });
  await transport.stop();
  assert.deepEqual(transport.peers, []);
});

test("fetches verified segments and returns isolated statistics", async () => {
  const verified: Array<{ segmentName: string; data: string }> = [];
  const transport = new HttpTransport({
    fetchImpl: async (input, init) => {
      assert.equal(String(input), "http://peer-a:9090/segments/folder%2Fsegment.ts");
      assert.equal(init?.signal?.aborted, false);
      return new Response("peer-data");
    },
    verifier: {
      async verify(segmentName, data) {
        verified.push({ segmentName, data: data.toString() });
        return true;
      },
    },
  });

  assert.equal(
    (await transport.requestSegment(
      "http://peer-a:9090",
      "folder/segment.ts",
    )).toString(),
    "peer-data",
  );
  assert.deepEqual(verified, [
    { segmentName: "folder/segment.ts", data: "peer-data" },
  ]);
  const stats = transport.getStats();
  assert.equal(stats.segmentsFetched, 1);
  assert.equal(stats.segmentsFailed, 0);
  assert.equal(stats.bytesTransferred, 9);
  assert.ok(Number.isFinite(stats.latencyMs.min));
  stats.latencyMs.min = -1;
  assert.notEqual(transport.getStats().latencyMs.min, -1);

  transport.resetStats();
  assert.deepEqual(transport.getStats(), {
    segmentsFetched: 0,
    segmentsFailed: 0,
    bytesTransferred: 0,
    latencyMs: { min: Infinity, max: 0, average: 0 },
  });
});

test("counts HTTP and integrity failures", async () => {
  const unavailable = new HttpTransport({
    fetchImpl: async () => new Response("unavailable", { status: 503 }),
  });
  await assert.rejects(
    unavailable.requestSegment("http://peer-a:9090", "segment.ts"),
    /Peer returned HTTP 503/,
  );
  assert.equal(unavailable.getStats().segmentsFailed, 1);

  const corrupt = new HttpTransport({
    fetchImpl: async () => new Response("corrupt"),
    verifier: { async verify() { return false; } },
  });
  await assert.rejects(
    corrupt.requestSegment("http://peer-a:9090", "segment.ts"),
    /integrity verification failed/,
  );
  assert.deepEqual(corrupt.getStats(), {
    segmentsFetched: 0,
    segmentsFailed: 1,
    bytesTransferred: 0,
    latencyMs: { min: Infinity, max: 0, average: 0 },
  });
});

test("forwards external abort reasons to in-flight requests", async () => {
  const controller = new AbortController();
  const reason = new Error("caller stopped");
  const transport = new HttpTransport({
    fetchImpl: async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
          once: true,
        });
      }),
  });

  const pending = transport.requestSegment(
    "http://peer-a:9090",
    "segment.ts",
    controller.signal,
  );
  controller.abort(reason);
  await assert.rejects(pending, reason);
  assert.equal(transport.getStats().segmentsFailed, 1);
});
