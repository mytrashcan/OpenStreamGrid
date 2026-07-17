import assert from "node:assert/strict";
import test from "node:test";
import {
  constantTimeEqual,
  OriginHashVerifier,
  parseSha256,
  sha256Hex,
  verifySegmentHash,
} from "../src/verifier.js";

const data = new TextEncoder().encode("segment-data");
const digest = "f554040cf9955040894e4b537fd87fdcf345ca5751905b1e6f7fe067d7798e71";

test("computes, parses, and compares SHA-256 hashes", async () => {
  assert.equal(await sha256Hex(data), digest);
  assert.equal(parseSha256(`${digest.toUpperCase()}  segment.ts\n`), digest);
  assert.throws(() => parseSha256(""), /Invalid SHA-256/);
  assert.throws(() => parseSha256("abc"), /Invalid SHA-256/);
  assert.equal(constantTimeEqual(digest, digest), true);
  assert.equal(constantTimeEqual(digest, `${digest.slice(0, -1)}0`), false);
  assert.equal(constantTimeEqual("short", "longer"), false);
  assert.deepEqual(await verifySegmentHash(data, digest), {
    valid: true,
    actualHash: digest,
    expectedHash: digest,
  });
});

test("validates origin URLs and coalesces concurrent hash requests", async (context) => {
  assert.throws(() => new OriginHashVerifier("relative/path"), /valid absolute URL/);
  assert.throws(() => new OriginHashVerifier("file:///tmp/hash"), /HTTP or HTTPS/);
  let requests = 0;
  context.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    requests += 1;
    assert.equal(String(input), "https://origin.example/hls/folder%2Fsegment.ts.sha256");
    return new Response(`${digest}  segment.ts\n`);
  });
  const verifier = new OriginHashVerifier("https://origin.example/hls");

  const [first, second] = await Promise.all([
    verifier.verify("folder/segment.ts", data),
    verifier.verify("folder/segment.ts", data),
  ]);
  assert.equal(first.valid, true);
  assert.deepEqual(second, first);
  assert.equal(requests, 1);
  await verifier.verify("folder/segment.ts", data);
  assert.equal(requests, 2);
});

test("reports hash endpoint failures and mismatched content", async (context) => {
  context.mock.method(globalThis, "fetch", async () =>
    new Response("missing", { status: 404 }),
  );
  const verifier = new OriginHashVerifier("http://origin/hls/");
  await assert.rejects(
    verifier.verify("missing.ts", data),
    /Failed to fetch hash for 'missing.ts': HTTP 404/,
  );

  context.mock.restoreAll();
  context.mock.method(globalThis, "fetch", async () =>
    new Response(`${"0".repeat(64)}  segment.ts`),
  );
  const mismatch = await verifier.verify("segment.ts", data);
  assert.equal(mismatch.valid, false);
  assert.equal(mismatch.actualHash, digest);
  assert.equal(mismatch.expectedHash, "0".repeat(64));
});
