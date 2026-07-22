import assert from "node:assert/strict";
import test from "node:test";
import {
  bearerToken,
  PeerSessionTokenService,
} from "../src/peer-session.js";

const SECRET = "0123456789abcdef0123456789abcdef";

test("issues peer-scoped sessions and rejects tampering and expiry", () => {
  let now = Date.parse("2026-07-20T00:00:00.000Z");
  const sessions = new PeerSessionTokenService(SECRET, 1_000, () => now);
  const issued = sessions.issue("live", "peer-a");

  assert.deepEqual(sessions.verify(issued.token), {
    broadcastId: "live",
    peerId: "peer-a",
    expiresAt: now + 1_000,
  });
  assert.equal(sessions.verify(`${issued.token}x`), undefined);
  assert.equal(sessions.verify("not-a-token"), undefined);

  now += 1_000;
  assert.equal(sessions.verify(issued.token), undefined);
});

test("parses bearer authorization without accepting ambiguous values", () => {
  assert.equal(bearerToken("Bearer token-value"), "token-value");
  assert.equal(bearerToken("bearer token-value"), "token-value");
  assert.equal(bearerToken("Basic token-value"), undefined);
  assert.equal(bearerToken(["Bearer one", "Bearer two"]), undefined);
});
