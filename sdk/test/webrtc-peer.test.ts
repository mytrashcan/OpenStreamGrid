import assert from "node:assert/strict";
import test from "node:test";
import wrtc from "@roamhq/wrtc";
import { BrowserWebRtcPeer } from "../src/webrtc-peer.js";
import type { WebRtcSignalMessage } from "../src/types.js";

const peerConnectionFactory = (): RTCPeerConnection => {
  const connection = new wrtc.RTCPeerConnection({ iceServers: [] });
  return connection as unknown as RTCPeerConnection;
};

test("browser peers exchange cached segments over a real DataChannel", async () => {
  const expected = new Uint8Array(40 * 1024 + 7).fill(0x5a);
  let uploadedBytes = 0;
  let requester: BrowserWebRtcPeer;
  let responder: BrowserWebRtcPeer;
  const relay = (
    target: () => BrowserWebRtcPeer,
  ): ((message: WebRtcSignalMessage) => void) =>
    (message) => queueMicrotask(() => target().handleSignal(message));

  requester = new BrowserWebRtcPeer({
    broadcastId: "live",
    peerId: "browser-a",
    sendSignal: relay(() => responder),
    segmentProvider: () => undefined,
    iceServers: [],
    maxUploadBitrate: 100_000_000,
    peerConnectionFactory,
  });
  responder = new BrowserWebRtcPeer({
    broadcastId: "live",
    peerId: "browser-b",
    sendSignal: relay(() => requester),
    segmentProvider: (segmentId) =>
      segmentId === "hls/low/segment.ts" ? expected : undefined,
    onUpload: (bytes) => {
      uploadedBytes += bytes;
    },
    iceServers: [],
    maxUploadBitrate: 100_000_000,
    peerConnectionFactory,
  });

  try {
    const result = await requester.requestSegment(
      "browser-b",
      "hls/low/segment.ts",
      new AbortController().signal,
    );

    assert.deepEqual(result, expected);
    assert.equal(uploadedBytes, expected.byteLength);
  } finally {
    requester.stop();
    responder.stop();
  }
});

test("rejects unsafe segment identifiers before signaling", async () => {
  const peer = new BrowserWebRtcPeer({
    broadcastId: "live",
    peerId: "browser-a",
    sendSignal: () => assert.fail("must not signal"),
    segmentProvider: () => undefined,
    iceServers: [],
    peerConnectionFactory,
  });
  try {
    await assert.rejects(
      peer.requestSegment(
        "browser-b",
        "../secret.ts",
        new AbortController().signal,
      ),
      /Invalid WebRTC segment ID/,
    );
  } finally {
    peer.stop();
  }
});
