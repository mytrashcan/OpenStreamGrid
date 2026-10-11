import assert from "node:assert/strict";
import test from "node:test";
import { issueTurnCredentials } from "../src/turn-credentials.js";

test("issues coturn REST API credentials that expire with the session", () => {
  const options = {
    urls: ["turn:turn.example.com:3478?transport=udp", "turns:turn.example.com:5349"],
    sharedSecret: "north-shared-secret-01",
  };
  const server = issueTurnCredentials(options, "peer-a", 1_700_000_000_999);

  // Reference value computed independently:
  // base64(HMAC-SHA1("north-shared-secret-01", "1700000000:peer-a")).
  assert.deepEqual(server, {
    urls: options.urls,
    username: "1700000000:peer-a",
    credential: "B3KvwkGhhXSacpV5TZPQT9gLlkM=",
  });
  assert.notEqual(server.urls, options.urls, "urls must be copied");
});
