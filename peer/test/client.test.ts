import assert from "node:assert/strict";
import test from "node:test";
import { parseArguments } from "../src/client.js";

const environment = {
  PEER_ADDRESS: "http://peer-a:9090",
  ORIGIN_URL: "http://origin:8080/hls",
};

test("parses the parallel download limit with a default of three", () => {
  assert.equal(parseArguments([], environment).maxParallelDownloads, 3);
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
