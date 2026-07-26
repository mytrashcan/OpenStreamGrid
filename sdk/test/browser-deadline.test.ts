import assert from "node:assert/strict";
import test from "node:test";
import type { SegmentSchedulingContext } from "@openstreamgrid/common";
import type Hls from "hls.js";
import type { LoaderContext } from "hls.js";
import {
  deriveBrowserDeadline,
  OpenStreamGridHlsPlugin,
} from "../src/hls-plugin.js";

class OriginalLoader {}

const createPlugin = (
  media?: Partial<HTMLMediaElement>,
): OpenStreamGridHlsPlugin => {
  const plugin = new OpenStreamGridHlsPlugin({
    trackerUrl: "ws://tracker.example/ws",
    broadcastId: "live",
    verifySegments: false,
    peerParticipation: false,
  });
  if (media) {
    plugin.attach({
      config: { loader: OriginalLoader },
      media: media as HTMLMediaElement,
    } as unknown as Hls);
  }
  return plugin;
};

const loaderContext = (
  fragment?: { start: number; duration: number; cc: number },
): LoaderContext =>
  ({
    url: "https://origin.example/hls/segment.ts",
    responseType: "arraybuffer",
    ...(fragment ? { frag: fragment } : {}),
  }) as unknown as LoaderContext;

test("derives a player deadline from fragment and media timing", () => {
  const plugin = createPlugin({
    currentTime: 8,
    playbackRate: 2,
    paused: false,
    seeking: false,
  });

  assert.deepEqual(
    deriveBrowserDeadline(
      loaderContext({ start: 10, duration: 4, cc: 0 }),
      plugin,
    ),
    {
      kind: "player-derived",
      slackMs: 3_000,
      segmentDurationMs: 4_000,
    },
  );
});

test("returns an unknown deadline when no media is attached", () => {
  const plugin = createPlugin();

  assert.equal(
    deriveBrowserDeadline(
      loaderContext({ start: 10, duration: 4, cc: 0 }),
      plugin,
    ),
    undefined,
  );
});

test("returns an unknown deadline when fragment timing is absent", () => {
  const plugin = createPlugin({
    currentTime: 8,
    playbackRate: 1,
    paused: false,
    seeking: false,
  });

  assert.equal(deriveBrowserDeadline(loaderContext(), plugin), undefined);
});

test("clamps an expired fragment deadline to critical slack", () => {
  const plugin = createPlugin({
    currentTime: 15,
    playbackRate: 1,
    paused: false,
    seeking: false,
  });

  assert.deepEqual(
    deriveBrowserDeadline(
      loaderContext({ start: 10, duration: 4, cc: 0 }),
      plugin,
    ),
    {
      kind: "player-derived",
      slackMs: 0,
      segmentDurationMs: 4_000,
    },
  );
});

test("uses normal playback speed when a paused media element reports zero", () => {
  const plugin = createPlugin({
    currentTime: 8,
    playbackRate: 0,
    paused: true,
    seeking: false,
  });

  assert.deepEqual(
    deriveBrowserDeadline(
      loaderContext({ start: 10, duration: 4, cc: 0 }),
      plugin,
    ),
    {
      kind: "player-derived",
      slackMs: 6_000,
      segmentDurationMs: 4_000,
    },
  );
});

test("treats fragment timing as stale while the media element is seeking", () => {
  const plugin = createPlugin({
    currentTime: 8,
    playbackRate: 1,
    paused: false,
    seeking: true,
  });

  assert.equal(
    deriveBrowserDeadline(
      loaderContext({ start: 10, duration: 4, cc: 0 }),
      plugin,
    ),
    undefined,
  );
});

test("rejects the first timing sample after a discontinuity", () => {
  const plugin = createPlugin({
    currentTime: 8,
    playbackRate: 1,
    paused: false,
    seeking: false,
  });
  assert.ok(
    deriveBrowserDeadline(
      loaderContext({ start: 10, duration: 4, cc: 0 }),
      plugin,
    ),
  );

  assert.equal(
    deriveBrowserDeadline(
      loaderContext({ start: 10, duration: 4, cc: 1 }),
      plugin,
    ),
    undefined,
  );
  assert.ok(
    deriveBrowserDeadline(
      loaderContext({ start: 10, duration: 4, cc: 1 }),
      plugin,
    ),
  );
});

test("forwards a derived deadline into the scheduler context", async (context) => {
  let schedulingContext: SegmentSchedulingContext | undefined;
  const plugin = new OpenStreamGridHlsPlugin({
    trackerUrl: "ws://tracker.example/ws",
    broadcastId: "live",
    verifySegments: false,
    peerParticipation: false,
    scheduler: {
      policyName: "deadline-capture",
      planSegment(currentContext) {
        schedulingContext = currentContext;
        return {
          policy: this.policyName,
          mode: "origin",
          peerIds: [],
          rankedPeers: [],
          reason: "deadline_origin",
        };
      },
    },
  });
  plugin.attach({
    config: { loader: OriginalLoader },
    media: {
      currentTime: 8,
      playbackRate: 1,
      paused: false,
      seeking: false,
    } as HTMLMediaElement,
  } as unknown as Hls);
  context.mock.method(plugin.wsClient, "getPeersWithSegment", () => [
    {
      id: "peer-a",
      address: "http://peer-a.example:9090",
      segments: ["segment.ts"],
      latencyMs: 10,
      successRate: 1,
      trustScore: 1,
    },
  ]);
  context.mock.method(
    globalThis,
    "fetch",
    async () => new Response(new Uint8Array([1, 2, 3])),
  );
  const deadline = deriveBrowserDeadline(
    loaderContext({ start: 10, duration: 4, cc: 0 }),
    plugin,
  );

  await plugin.loadSegment(
    "segment.ts",
    "https://origin.example/hls/segment.ts",
    new AbortController().signal,
    deadline,
  );

  assert.deepEqual(schedulingContext?.deadline, deadline);
});
