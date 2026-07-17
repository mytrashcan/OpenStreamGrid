import assert from "node:assert/strict";
import test from "node:test";
import {
  OriginHashVerifier,
  parseSha256,
  sha256,
  verifySegmentHash,
} from "../src/verifier.js";

test("parses standard checksum files and verifies segment bytes", () => {
  const data = Buffer.from("verified-segment");
  const digest = sha256(data);
  assert.equal(parseSha256(`${digest}  segment.ts\n`), digest);
  assert.equal(verifySegmentHash(data, digest), true);
  assert.equal(verifySegmentHash(Buffer.from("tampered"), digest), false);
});

test("rejects malformed checksums", () => {
  assert.throws(() => parseSha256("not-a-checksum"), /Invalid SHA-256/);
});

test("deduplicates concurrent hash requests and evicts old hashes", async () => {
  const segments = new Map([
    ["a.ts", Buffer.from("segment-a")],
    ["b.ts", Buffer.from("segment-b")],
  ]);
  let requests = 0;
  const verifier = new OriginHashVerifier(
    new URL("http://origin/"),
    async (input) => {
      requests += 1;
      const segmentName = decodeURIComponent(new URL(input).pathname.slice(1, -7));
      const data = segments.get(segmentName);
      assert.ok(data);
      await Promise.resolve();
      return new Response(sha256(data));
    },
    1,
  );

  const segmentA = segments.get("a.ts");
  const segmentB = segments.get("b.ts");
  assert.ok(segmentA);
  assert.ok(segmentB);
  assert.deepEqual(
    await Promise.all([
      verifier.verify("a.ts", segmentA),
      verifier.verify("a.ts", segmentA),
    ]),
    [true, true],
  );
  assert.equal(requests, 1);

  assert.equal(await verifier.verify("b.ts", segmentB), true);
  assert.equal(await verifier.verify("a.ts", segmentA), true);
  assert.equal(requests, 3);
});
