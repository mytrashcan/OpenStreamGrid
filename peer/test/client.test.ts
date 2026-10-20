import assert from "node:assert/strict";
import test from "node:test";
import { parseArguments, resolveMediaPlaylist, SegmentAttempts } from "../src/client.js";
import { playlistSegments, playlistVariants, selectVariant } from "../src/playlist.js";

const environment = {
  PEER_ADDRESS: "http://peer-a:9090",
  ORIGIN_URL: "http://origin:8080/hls",
};

test("parses the parallel download limit with a default of three", () => {
  assert.equal(parseArguments([], environment).maxParallelDownloads, 3);
  assert.equal(parseArguments([], environment).p2pTimeoutMs, 2_000);
  assert.equal(parseArguments([], environment).segmentDurationMs, undefined);
  assert.equal(parseArguments([], environment).deadlineSchedulingEnabled, true);
  assert.equal(parseArguments([], environment).uploadHost, "0.0.0.0");
  assert.equal(parseArguments([], environment).cacheSizeBytes, 512_000_000);
  assert.equal(parseArguments([], environment).cacheTtlMs, 300_000);
  assert.equal(
    parseArguments([], { ...environment, UPLOAD_HOST: "127.0.0.1" }).uploadHost,
    "127.0.0.1",
  );
  assert.equal(
    parseArguments(["--parallel-downloads", "5"], environment)
      .maxParallelDownloads,
    5,
  );
  assert.equal(
    parseArguments([], {
      ...environment,
      SEGMENT_DURATION_SECONDS: "1.5",
    }).segmentDurationMs,
    1_500,
  );
});

test("parses tracker API key configuration from environment and CLI", () => {
  assert.equal(
    parseArguments([], { ...environment, TRACKER_API_KEY: "env-secret" })
      .trackerApiKey,
    "env-secret",
  );
  assert.equal(
    parseArguments(
      ["--tracker-api-key", "cli-secret"],
      { ...environment, TRACKER_API_KEY: "env-secret" },
    ).trackerApiKey,
    "cli-secret",
  );
  assert.throws(
    () => parseArguments([], { ...environment, TRACKER_API_KEY: " " }),
    /Tracker API key must not be empty/,
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

test("supports disabling deadline-aware scheduling", () => {
  assert.equal(
    parseArguments([], {
      ...environment,
      DEADLINE_SCHEDULING_ENABLED: "false",
      SEGMENT_DURATION_SECONDS: "2",
    }).deadlineSchedulingEnabled,
    false,
  );
  assert.throws(
    () =>
      parseArguments([], {
        ...environment,
        SEGMENT_DURATION_SECONDS: "0",
      }),
    /Segment duration must be a positive number/,
  );
});

test("builds ICE server configuration from STUN and TURN environment values", () => {
  assert.deepEqual(parseArguments([], environment).iceServers, [
    { urls: "stun:stun.l.google.com:19302" },
  ]);
  assert.deepEqual(
    parseArguments([], {
      ...environment,
      STUN_SERVER: "stuns:stun.example.com:5349",
      TURN_SERVER: "turns:turn.example.com:5349?transport=tcp",
      TURN_USERNAME: "peer-user",
      TURN_CREDENTIAL: "peer-secret",
    }).iceServers,
    [
      { urls: "stuns:stun.example.com:5349" },
      {
        urls: "turns:turn.example.com:5349?transport=tcp",
        username: "peer-user",
        credential: "peer-secret",
      },
    ],
  );
});

test("validates STUN and TURN environment configuration", () => {
  assert.throws(
    () => parseArguments([], { ...environment, STUN_SERVER: "https://stun.example.com" }),
    /STUN server must use STUN or STUNS/,
  );
  assert.throws(
    () => parseArguments([], { ...environment, TURN_SERVER: "stun:turn.example.com" }),
    /TURN server must use TURN or TURNS/,
  );
  assert.throws(
    () => parseArguments([], { ...environment, TURN_SERVER: "turn:" }),
    /TURN server must include a host/,
  );
  assert.throws(
    () => parseArguments([], { ...environment, TURN_USERNAME: "orphaned" }),
    /TURN_SERVER is required when TURN credentials are configured/,
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
  assert.throws(
    () => parseArguments([], { ...environment, CACHE_TTL_MS: "0" }),
    /Cache TTL must be a positive integer/,
  );
});

test("lists MPEG-TS and fMP4 media segments but not init segments", () => {
  const playlist = [
    "#EXTM3U",
    '#EXT-X-MAP:URI="epoch_init_low.mp4"',
    "#EXTINF:2.0,",
    "epoch_segment_000001.m4s",
    "#EXTINF:2.0,",
    "https://origin.example/hls/low/epoch_segment_000002.m4s",
    "legacy_segment_000003.ts",
    "notes.txt",
  ].join("\n");
  assert.deepEqual(
    playlistSegments(playlist, new URL("https://origin.example/hls/low/stream.m3u8")),
    ["epoch_segment_000001.m4s", "epoch_segment_000002.m4s", "legacy_segment_000003.ts"],
  );
});

test("gives up on a segment after its attempts and forgets unlisted ones", () => {
  const attempts = new SegmentAttempts(3);
  assert.equal(attempts.fail("a.ts"), false);
  assert.equal(attempts.fail("a.ts"), false);
  assert.equal(attempts.fail("a.ts"), true);

  // A success resets the count, so a transient failure is not held against it.
  attempts.fail("b.ts");
  attempts.succeed("b.ts");
  assert.equal(attempts.fail("b.ts"), false);

  // Segments that leave the playlist are forgotten.
  attempts.fail("c.ts");
  attempts.fail("c.ts");
  attempts.retain(new Set(["b.ts"]));
  assert.equal(attempts.fail("c.ts"), false);
});

const MULTIVARIANT_PLAYLIST = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  '#EXT-X-STREAM-INF:BANDWIDTH=2628000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"',
  "high/stream.m3u8",
  "#EXT-X-STREAM-INF:BANDWIDTH=828000,RESOLUTION=640x360",
  "low/stream.m3u8",
  "#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=1000,BANDWIDTH=1528000",
  "med/stream.m3u8",
  "",
].join("\n");

test("lists the variants of a multivariant playlist and none for a media playlist", () => {
  const playlistUrl = new URL("http://origin:8080/hls/stream.m3u8");
  const variants = playlistVariants(MULTIVARIANT_PLAYLIST, playlistUrl);
  assert.deepEqual(
    variants.map(({ url, bandwidth }) => [url.href, bandwidth]),
    [
      ["http://origin:8080/hls/high/stream.m3u8", 2_628_000],
      ["http://origin:8080/hls/low/stream.m3u8", 828_000],
      ["http://origin:8080/hls/med/stream.m3u8", 1_528_000],
    ],
  );
  assert.deepEqual(
    playlistVariants("#EXTM3U\n#EXTINF:2.0,\nsegment_000001.ts\n", playlistUrl),
    [],
  );
});

test("selects the named rendition or the lowest-bandwidth variant", () => {
  const variants = playlistVariants(
    MULTIVARIANT_PLAYLIST,
    new URL("http://origin:8080/hls/stream.m3u8"),
  );
  assert.equal(selectVariant(variants).url.pathname, "/hls/low/stream.m3u8");
  assert.equal(selectVariant(variants, "med").url.pathname, "/hls/med/stream.m3u8");
  assert.throws(() => selectVariant(variants, "4k"), /Rendition '4k'.*available: high, low, med/);
});

test("resolves a multivariant playlist to a variant's playlist and directory", async () => {
  const configuration = parseArguments(["--rendition", "high"], environment);
  assert.equal(configuration.rendition, "high");
  const requested: string[] = [];
  let failures = 1;
  const resolved = await resolveMediaPlaylist(
    { ...configuration, playlistPollMs: 1 },
    new AbortController().signal,
    async (url) => {
      requested.push(url.href);
      if (failures-- > 0) throw new Error("origin not ready");
      return MULTIVARIANT_PLAYLIST;
    },
  );
  assert.deepEqual(requested, [
    "http://origin:8080/hls/stream.m3u8",
    "http://origin:8080/hls/stream.m3u8",
  ]);
  assert.equal(resolved.playlistUrl.href, "http://origin:8080/hls/high/stream.m3u8");
  assert.equal(resolved.originBaseUrl.href, "http://origin:8080/hls/high/");
});

test("keeps a media playlist and stops retrying once aborted", async () => {
  const configuration = parseArguments([], environment);
  const media = await resolveMediaPlaylist(configuration, new AbortController().signal, async () =>
    "#EXTM3U\n#EXTINF:2.0,\nsegment_000001.ts\n",
  );
  assert.equal(media, configuration);

  const controller = new AbortController();
  const aborted = await resolveMediaPlaylist(
    { ...configuration, playlistPollMs: 1 },
    controller.signal,
    async () => {
      controller.abort();
      throw new Error("aborted");
    },
  );
  assert.equal(aborted.playlistUrl.href, "http://origin:8080/hls/stream.m3u8");
});
