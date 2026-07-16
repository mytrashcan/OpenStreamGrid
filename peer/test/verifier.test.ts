import assert from "node:assert/strict";
import test from "node:test";
import { parseSha256, sha256, verifySegmentHash } from "../src/verifier.js";

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
