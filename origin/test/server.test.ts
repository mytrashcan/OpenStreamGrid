import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import {
  createOriginHandler,
  OriginServer,
  parseOriginConfiguration,
  registerBroadcast,
  registerBroadcasts,
} from "../src/server.js";
import {
  HlsStreamer,
  MultiHlsStreamer,
  type MultiStreamController,
  type StreamController,
} from "../src/streamer.js";

class FakeStreamer implements StreamController {
  readonly playlistPath: string;
  readonly qualities: string[] = ['low', 'med', 'high'];
  private running = false;
  starts = 0;
  stops = 0;

  constructor(private readonly directory: string) {
    this.playlistPath = path.join(directory, "stream.m3u8");
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    this.starts += 1;
    this.running = true;
  }

  async stop(): Promise<void> {
    this.stops += 1;
    this.running = false;
  }

  async ensureHash(segmentName: string): Promise<string> {
    const data = await readFile(path.join(this.directory, segmentName));
    const digest = createHash("sha256").update(data).digest("hex");
    const hashPath = path.join(this.directory, `${segmentName}.sha256`);
    await writeFile(hashPath, `${digest}  ${segmentName}\n`);
    return hashPath;
  }
}

test("validates origin environment configuration", () => {
  assert.deepEqual(parseOriginConfiguration({}), {
    port: 8080,
    host: "0.0.0.0",
    hlsDirectory: "/tmp/openstreamgrid-hls",
    trackerUrl: "http://tracker:7070/",
    broadcastId: "live",
    multiStreamCount: 1,
    streamIds: ["live"],
    publicOriginUrl: "http://origin:8080/",
    segmentDurationSeconds: 2,
    playlistSize: 8,
    hashIntervalMs: 250,
  });
  assert.throws(
    () => parseOriginConfiguration({ PORT: "8080x" }),
    /PORT must be an integer between 1 and 65535/,
  );
  assert.throws(
    () => parseOriginConfiguration({ TRACKER_URL: "tracker:7070" }),
    /TRACKER_URL must use HTTP or HTTPS/,
  );
  assert.throws(
    () => parseOriginConfiguration({ PUBLIC_ORIGIN_URL: "not a URL" }),
    /PUBLIC_ORIGIN_URL must be a valid absolute URL/,
  );
  assert.throws(
    () => parseOriginConfiguration({ BROADCAST_ID: " " }),
    /BROADCAST_ID must not be empty/,
  );
  assert.throws(
    () => parseOriginConfiguration({ BROADCAST_ID: "live/channel" }),
    /BROADCAST_ID must be a safe stream ID/,
  );
  assert.throws(
    () => parseOriginConfiguration({ HLS_DIRECTORY: "" }),
    /HLS_DIRECTORY must not be empty/,
  );
  assert.throws(
    () => parseOriginConfiguration({ SEGMENT_DURATION_SECONDS: "0" }),
    /SEGMENT_DURATION_SECONDS must be a positive number/,
  );
  assert.throws(
    () => parseOriginConfiguration({ PLAYLIST_SIZE: "2.5" }),
    /PLAYLIST_SIZE must be a positive integer/,
  );
  assert.equal(
    parseOriginConfiguration({ TRACKER_API_KEY: "test-secret" }).trackerApiKey,
    "test-secret",
  );
  assert.throws(
    () => parseOriginConfiguration({ TRACKER_API_KEY: " " }),
    /TRACKER_API_KEY must not be empty/,
  );
  assert.deepEqual(
    parseOriginConfiguration({ MULTI_STREAM_COUNT: "3", BROADCAST_ID: "ignored" })
      .streamIds,
    ["stream-1", "stream-2", "stream-3"],
  );
  assert.throws(
    () => parseOriginConfiguration({ MULTI_STREAM_COUNT: "6" }),
    /MULTI_STREAM_COUNT must not exceed 5/,
  );
});

test("validates HLS streamer configuration before startup", () => {
  assert.throws(
    () => new HlsStreamer({ outputDirectory: "" }),
    /Output directory must not be empty/,
  );
  assert.throws(
    () =>
      new HlsStreamer({
        outputDirectory: "/tmp/hls",
        masterPlaylistName: "../stream.m3u8",
      }),
    /Master playlist name must be a safe .m3u8 file name/,
  );
  assert.throws(
    () => new HlsStreamer({ outputDirectory: "/tmp/hls", playlistSize: 0 }),
    /Playlist size must be a positive integer/,
  );
  const multiStreamer = new MultiHlsStreamer({
    outputDirectory: "/tmp/hls",
    streamIds: ["stream-1", "stream-2"],
  });
  assert.deepEqual(multiStreamer.streamIds, ["stream-1", "stream-2"]);
  assert.equal(
    multiStreamer.getStream("stream-2")?.playlistPath,
    "/tmp/hls/stream-2/stream.m3u8",
  );
  assert.throws(
    () => new MultiHlsStreamer({ outputDirectory: "/tmp/hls", streamIds: [] }),
    /At least one stream ID is required/,
  );
});

class FakeMultiStreamer implements MultiStreamController {
  readonly streamIds: readonly string[];
  readonly playlistPath: string;
  readonly qualities: string[] = ["low", "med", "high"];
  private readonly streamers = new Map<string, FakeStreamer>();

  constructor(directory: string, streamIds: readonly string[]) {
    this.streamIds = streamIds;
    for (const streamId of streamIds) {
      this.streamers.set(streamId, new FakeStreamer(path.join(directory, streamId)));
    }
    this.playlistPath = this.streamers.get(streamIds[0]!)!.playlistPath;
  }

  getStream(streamId: string): StreamController | undefined {
    return this.streamers.get(streamId);
  }

  isRunning(): boolean {
    return [...this.streamers.values()].every((streamer) => streamer.isRunning());
  }

  async start(): Promise<void> {
    await Promise.all([...this.streamers.values()].map((streamer) => streamer.start()));
  }

  async stop(): Promise<void> {
    await Promise.all([...this.streamers.values()].map((streamer) => streamer.stop()));
  }

  async ensureHash(segmentName: string): Promise<string> {
    const [streamId, ...parts] = segmentName.split("/");
    const streamer = this.streamers.get(streamId ?? "");
    if (!streamer) throw new Error("Unknown stream");
    return streamer.ensureHash(parts.join("/"));
  }
}

class TestResponse extends Writable {
  statusCode = 0;
  body = Buffer.alloc(0);
  headers: Record<string, string | number | readonly string[]> = {};
  private sent = false;

  get headersSent(): boolean {
    return this.sent;
  }

  writeHead(
    statusCode: number,
    headers: Record<string, string | number | readonly string[]> = {},
  ): this {
    this.statusCode = statusCode;
    this.headers = headers;
    this.sent = true;
    return this;
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.body = Buffer.concat([this.body, Buffer.from(chunk)]);
    callback();
  }
}

const invoke = async (
  handler: ReturnType<typeof createOriginHandler>,
  url: string,
): Promise<TestResponse> => {
  const request = Object.assign(Readable.from([]), {
    method: "GET",
    url,
  }) as unknown as IncomingMessage;
  const response = new TestResponse();
  await handler(request, response as unknown as ServerResponse);
  return response;
};

test("serves HLS assets, creates hashes, and exposes readiness", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "openstreamgrid-origin-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const streamer = new FakeStreamer(directory);
  const handler = createOriginHandler(directory, streamer);

  await streamer.start();
  let response = await invoke(handler, "/health");
  assert.equal(response.statusCode, 503);
  assert.deepEqual(JSON.parse(response.body.toString()), {
    status: "starting",
    service: "origin",
    details: { ffmpegRunning: true, playlistAvailable: false },
  });

  await writeFile(streamer.playlistPath, "#EXTM3U\nsegment_000001.ts\n");
  await writeFile(path.join(directory, "segment_000001.ts"), "segment-data");

  response = await invoke(handler, "/health");
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body.toString()), {
    status: "ok",
    service: "origin",
    details: { ffmpegRunning: true, playlistAvailable: true },
  });
  response = await invoke(handler, "/hls/segment_000001.ts");
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["access-control-allow-origin"], "*");
  assert.equal(response.body.toString(), "segment-data");
  response = await invoke(handler, "/hls/segment_000001.ts.sha256");
  assert.match(
    response.body.toString(),
    /^[a-f0-9]{64}  segment_000001\.ts\n$/,
  );
  await streamer.stop();
});

test("serves isolated multi-stream routes and disables ambiguous flat aliases", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "openstreamgrid-multi-origin-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const streamer = new FakeMultiStreamer(directory, ["stream-1", "stream-2"]);
  for (const streamId of streamer.streamIds) {
    await mkdir(path.join(directory, streamId), { recursive: true });
    await writeFile(path.join(directory, streamId, "stream.m3u8"), `# ${streamId}`);
  }
  await streamer.start();
  const handler = createOriginHandler(directory, streamer);

  const first = await invoke(handler, "/hls/stream-1/stream.m3u8");
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.toString(), "# stream-1");
  const second = await invoke(handler, "/hls/stream-2/stream.m3u8");
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.toString(), "# stream-2");
  const ambiguous = await invoke(handler, "/hls/stream.m3u8");
  assert.equal(ambiguous.statusCode, 404);
  await streamer.stop();
});

test("rejects encoded traversal outside the HLS directory", async (context) => {
  const parent = await mkdtemp(path.join(tmpdir(), "openstreamgrid-origin-parent-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const directory = path.join(parent, "hls");
  await mkdir(directory);
  await writeFile(path.join(parent, "outside.ts"), "outside-data");
  const handler = createOriginHandler(directory, new FakeStreamer(directory));

  const response = await invoke(handler, "/hls/..%2Foutside.ts");

  assert.equal(response.statusCode, 400);
  assert.deepEqual(JSON.parse(response.body.toString()), {
    error: "Invalid file path",
  });
});

test("registers a broadcast with the tracker", async () => {
  let received: unknown;

  await registerBroadcast({
    trackerUrl: "http://tracker:7070",
    apiKey: "test-secret",
    registration: {
      id: "live",
      playlistUrl: "http://origin:8080/hls/stream.m3u8",
    },
    fetchImpl: async (input, init) => {
      assert.equal(String(input), "http://tracker:7070/api/v1/broadcasts");
      assert.equal(init?.method, "POST");
      assert.equal(
        new Headers(init?.headers).get("X-API-Key"),
        "test-secret",
      );
      received = JSON.parse(String(init?.body)) as unknown;
      return new Response(null, { status: 201 });
    },
  });
  assert.deepEqual(received, {
    id: "live",
    playlistUrl: "http://origin:8080/hls/stream.m3u8",
  });
});

test("registers every configured stream as a broadcast", async () => {
  const registrations: unknown[] = [];
  await registerBroadcasts({
    trackerUrl: "http://tracker:7070",
    registrations: [
      { id: "stream-1", playlistUrl: "http://origin:8080/hls/stream-1/stream.m3u8" },
      { id: "stream-2", playlistUrl: "http://origin:8080/hls/stream-2/stream.m3u8" },
    ],
    fetchImpl: async (_input, init) => {
      registrations.push(JSON.parse(String(init?.body)) as unknown);
      return new Response(null, { status: 201 });
    },
  });
  assert.deepEqual(
    registrations.sort((left, right) =>
      String((left as { id: string }).id).localeCompare((right as { id: string }).id),
    ),
    [
      { id: "stream-1", playlistUrl: "http://origin:8080/hls/stream-1/stream.m3u8" },
      { id: "stream-2", playlistUrl: "http://origin:8080/hls/stream-2/stream.m3u8" },
    ],
  );
});

test("coalesces concurrent origin server starts and stops", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "openstreamgrid-origin-"));
  const streamer = new FakeStreamer(directory);
  const server = new OriginServer({ hlsDirectory: directory, streamer });
  try {
    const [firstPort, secondPort] = await Promise.all([
      server.start(0, "127.0.0.1"),
      server.start(0, "127.0.0.1"),
    ]);
    assert.equal(firstPort, secondPort);
    assert.equal(streamer.starts, 1);
    await Promise.all([server.stop(), server.stop()]);
    assert.equal(streamer.stops, 1);
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("creates hashes for nested variant segments without allowing traversal", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "openstreamgrid-streamer-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const segmentDirectory = path.join(directory, "low");
  const segmentName = "low/segment_000001.ts";
  await mkdir(segmentDirectory, { recursive: true });
  await writeFile(path.join(directory, segmentName), "variant-segment-data");

  const streamer = new HlsStreamer({ outputDirectory: directory });
  const hashPath = await streamer.ensureHash(segmentName);
  const expectedDigest = createHash("sha256")
    .update("variant-segment-data")
    .digest("hex");

  assert.equal(
    await readFile(hashPath, "utf8"),
    `${expectedDigest}  ${segmentName}\n`,
  );
  await assert.rejects(
    streamer.ensureHash("../outside.ts"),
    /Invalid segment name/,
  );
});
