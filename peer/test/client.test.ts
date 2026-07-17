import assert from "node:assert/strict";
import test from "node:test";
import { parseArguments } from "../src/client.js";

const environment = {
  PEER_ADDRESS: "http://peer-a:9090",
  ORIGIN_URL: "http://origin:8080/hls",
};

test("parses the parallel download limit with a default of three", () => {
  assert.equal(parseArguments([], environment).maxParallelDownloads, 3);
  assert.equal(parseArguments([], environment).p2pTimeoutMs, 2_000);
  assert.equal(parseArguments([], environment).uploadHost, "0.0.0.0");
  assert.equal(
    parseArguments([], { ...environment, UPLOAD_HOST: "127.0.0.1" }).uploadHost,
    "127.0.0.1",
  );
  assert.equal(
    parseArguments(["--parallel-downloads", "5"], environment)
      .maxParallelDownloads,
    5,
  );
});

test("supports disabling WebRTC for deterministic HTTP fallback", () => {
  assert.equal(parseArguments([], environment).webRtcEnabled, true);
  assert.equal(
    parseArguments([], { ...environment, WEBRTC_ENABLED: "false" })
      .webRtcEnabled,
    false,
  );
  assert.equal(
    parseArguments(["--webrtc-enabled", "no"], environment).webRtcEnabled,
    false,
  );
  assert.throws(
    () => parseArguments(["--webrtc-enabled", "sometimes"], environment),
    /WebRTC enabled must be true or false/,
  );
});

test("validates required peer environment configuration", () => {
  assert.throws(
    () => parseArguments([], {}),
    /--peer-address or PEER_ADDRESS is required/,
  );
  assert.throws(
    () => parseArguments([], { ...environment, ORIGIN_URL: " " }),
    /--origin-url or ORIGIN_URL is required/,
  );
  assert.throws(
    () => parseArguments([], { ...environment, TRACKER_URL: "ftp://tracker" }),
    /Tracker URL must use HTTP or HTTPS/,
  );
  assert.throws(
    () => parseArguments([], { ...environment, PEER_ADDRESS: "http://peer-a:0" }),
    /Peer address port must be between 1 and 65535/,
  );
  assert.throws(
    () => parseArguments([], { ...environment, BROADCAST_ID: "" }),
    /Broadcast ID must not be empty/,
  );
  assert.throws(
    () => parseArguments([], { ...environment, MAX_CONNECTIONS: "2.5" }),
    /Maximum connections must be a positive integer/,
  );
  assert.throws(
    () => parseArguments([], { ...environment, P2P_TIMEOUT_MS: "0" }),
    /P2P timeout must be a positive integer/,
  );
});
