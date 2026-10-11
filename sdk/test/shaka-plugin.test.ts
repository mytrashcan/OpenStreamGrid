import assert from "node:assert/strict";
import test from "node:test";
import {
  OpenStreamGridShakaPlugin,
  type ShakaNamespace,
  type ShakaSchemePlugin,
} from "../src/shaka-plugin.js";

const SEGMENT = 1;
const MANIFEST = 0;

const fakeShaka = () => {
  const registrations: Array<{ scheme: string; plugin: ShakaSchemePlugin; priority?: number }> = [];
  const fallbackCalls: string[] = [];
  const fallback: ShakaSchemePlugin = (uri) => {
    fallbackCalls.push(uri);
    return { promise: Promise.resolve({ uri, originalUri: uri, data: new Uint8Array(), headers: {}, originalRequest: {} }), abort: () => undefined };
  };
  const shaka: ShakaNamespace = {
    net: {
      NetworkingEngine: {
        registerScheme: (scheme, plugin, priority) => {
          registrations.push({ scheme, plugin, ...(priority === undefined ? {} : { priority }) });
        },
        RequestType: { SEGMENT },
        PluginPriority: { APPLICATION: 3, PREFERRED: 2 },
      },
      HttpFetchPlugin: { parse: fallback },
    },
    util: {
      AbortableOperation: class<T> {
        constructor(readonly promise: Promise<T>, readonly onAbort: () => Promise<void>) {}
        abort(): Promise<void> {
          return this.onAbort();
        }
      },
    },
  };
  return { shaka, registrations, fallback, fallbackCalls };
};

const pluginFor = (): OpenStreamGridShakaPlugin =>
  new OpenStreamGridShakaPlugin({
    trackerUrl: "ws://tracker.example/ws",
    broadcastId: "live",
    verifySegments: false,
    peerParticipation: false,
  });

test("registers for http and https and restores Shaka's fetch plugin on detach", () => {
  const { shaka, registrations, fallback } = fakeShaka();
  const plugin = pluginFor();

  plugin.attach(shaka);
  assert.deepEqual(registrations.map(({ scheme, priority }) => [scheme, priority]), [["http", 3], ["https", 3]]);
  plugin.detach();
  assert.deepEqual(registrations.slice(2).map(({ scheme, plugin: p, priority }) => [scheme, p === fallback, priority]), [
    ["http", true, 2],
    ["https", true, 2],
  ]);
});

test("loads media segments through the grid and leaves other requests to Shaka", async (context) => {
  const { shaka, registrations, fallbackCalls } = fakeShaka();
  const plugin = pluginFor();
  const loads: Array<[string, string]> = [];
  context.mock.method(plugin.core, "loadSegment", async (name: string, url: string) => {
    loads.push([name, url]);
    return { data: new Uint8Array([1, 2, 3]) };
  });
  plugin.attach(shaka);
  const scheme = registrations[1]?.plugin;
  assert.ok(scheme);
  const noop = (): void => undefined;
  try {
    const segment = await scheme("https://cdn.example/hls/low/seg_000001.m4s", {}, SEGMENT, noop, noop, {}).promise;
    assert.deepEqual(new Uint8Array(segment.data as Uint8Array), new Uint8Array([1, 2, 3]));
    assert.equal(segment.uri, "https://cdn.example/hls/low/seg_000001.m4s");
    assert.deepEqual(loads, [["seg_000001.m4s", "https://cdn.example/hls/low/seg_000001.m4s"]]);

    await scheme("https://cdn.example/hls/low/stream.m3u8", {}, MANIFEST, noop, noop, {}).promise;
    await scheme("https://cdn.example/hls/low/init_low.mp4", {}, SEGMENT, noop, noop, {}).promise;
    await scheme("https://cdn.example/hls/low/seg_000002.m4s", { headers: { Range: "bytes=0-99" } }, SEGMENT, noop, noop, {}).promise;
    assert.deepEqual(fallbackCalls, [
      "https://cdn.example/hls/low/stream.m3u8",
      "https://cdn.example/hls/low/init_low.mp4",
      "https://cdn.example/hls/low/seg_000002.m4s",
    ]);
    assert.equal(loads.length, 1);
  } finally {
    plugin.detach();
  }
});

test("aborting a Shaka request aborts the grid request", async (context) => {
  const { shaka, registrations } = fakeShaka();
  const plugin = pluginFor();
  let observedSignal: AbortSignal | undefined;
  context.mock.method(plugin.core, "loadSegment", (_name: string, _url: string, signal: AbortSignal) => {
    observedSignal = signal;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  });
  plugin.attach(shaka);
  const scheme = registrations[0]?.plugin;
  assert.ok(scheme);
  const noop = (): void => undefined;
  try {
    const operation = scheme("http://cdn.example/hls/low/seg_000001.ts", {}, SEGMENT, noop, noop, {});
    await operation.abort();
    await assert.rejects(operation.promise, { name: "AbortError" });
    assert.equal(observedSignal?.aborted, true);
  } finally {
    plugin.detach();
  }
});

test("derives a synthetic deadline from Shaka's request timeouts", async (context) => {
  const { shaka, registrations } = fakeShaka();
  const plugin = pluginFor();
  const deadlines: unknown[] = [];
  context.mock.method(
    plugin.core,
    "loadSegment",
    async (_name: string, _url: string, _signal: AbortSignal, deadline?: unknown) => {
      deadlines.push(deadline);
      return { data: new Uint8Array([1]) };
    },
  );
  plugin.attach(shaka);
  const scheme = registrations[1]?.plugin;
  assert.ok(scheme);
  const noop = (): void => undefined;
  try {
    const uri = "https://cdn.example/hls/low/seg_000001.m4s";
    await scheme(uri, { retryParameters: { timeout: 30_000, stallTimeout: 5_000 } }, SEGMENT, noop, noop, {}).promise;
    await scheme(uri, { retryParameters: { timeout: 0, stallTimeout: 0 } }, SEGMENT, noop, noop, {}).promise;
    await scheme(uri, {}, SEGMENT, noop, noop, {}).promise;
  } finally {
    plugin.detach();
  }
  assert.deepEqual(deadlines, [{ kind: "synthetic", slackMs: 4_500 }, undefined, undefined]);
});
