import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(here, "..", "..", "..");
const trackerUrl = process.env.TRACKER_URL ?? "http://127.0.0.1:7070";
// A single rendition keeps both viewers on the same segments.
const originBaseUrl = "http://127.0.0.1:8080/hls/low";
const playlistUrl = `${originBaseUrl}/stream.m3u8`;
// The origin's HLS_SEGMENT_TYPE; the test checks that this format is played and shared.
const segmentType = process.env.EXPECTED_SEGMENT_TYPE ?? "mpegts";
const segmentExtension = { mpegts: ".ts", fmp4: ".m4s" }[segmentType];
if (!segmentExtension) throw new Error(`Unknown EXPECTED_SEGMENT_TYPE '${segmentType}'`);
// Player integration under test: the Hls.js plugin, the Shaka Player adapter,
// or Video.js 10's <hlsjs-video> configured through hlsJsConfig().
const player = process.env.E2E_PLAYER ?? "hlsjs";
if (!["hlsjs", "shaka", "videojs"].includes(player)) throw new Error(`Unknown E2E_PLAYER '${player}'`);

const routes = {
  "/": [join(here, "..", "page", "index.html"), "text/html; charset=utf-8"],
  "/sdk/sdk.js": [join(repositoryRoot, "sdk", "dist", "sdk.js"), "text/javascript"],
  "/vendor/hls.mjs": [join(here, "..", "node_modules", "hls.js", "dist", "hls.mjs"), "text/javascript"],
  "/vendor/shaka-player.compiled.js": [
    join(here, "..", "node_modules", "shaka-player", "dist", "shaka-player.compiled.js"),
    "text/javascript",
  ],
  // Built by `npm run build:videojs`; only the Video.js variant needs it.
  ...(player === "videojs"
    ? { "/vendor/videojs.mjs": [join(here, "..", "page", "dist", "videojs.mjs"), "text/javascript"] }
    : {}),
};

let server;
let pageOrigin;

test.beforeAll(async () => {
  for (const [path] of Object.values(routes)) {
    if (!existsSync(path)) throw new Error(`Missing ${path}; build the SDK and run npm ci first`);
  }
  server = createServer((request, response) => {
    const route = routes[new URL(request.url ?? "/", "http://localhost").pathname];
    if (!route) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": route[1], "cache-control": "no-store" });
    createReadStream(route[0]).pipe(response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  pageOrigin = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const viewerUrl = (peerId) => {
  const params = new URLSearchParams({
    tracker: trackerUrl,
    playlist: playlistUrl,
    originBase: originBaseUrl,
    peer: peerId,
    player,
  });
  return `${pageOrigin}/?${params}`;
};

// Seconds actually played. currentTime is a presentation timestamp that, for
// Shaka live playback, is already large on the first frame.
const playbackState = (page) =>
  page.evaluate(() => {
    // Video.js renders its own <video>; the page exposes the one hls.js plays.
    const video = window.osgMediaElement?.() ?? document.getElementById("video");
    if (!video) return { ...window.osg, currentTime: 0, playedSeconds: 0 };
    let playedSeconds = 0;
    for (let index = 0; index < video.played.length; index += 1) {
      playedSeconds += video.played.end(index) - video.played.start(index);
    }
    return { ...window.osg, currentTime: video.currentTime, playedSeconds };
  });

test("two zero-install browser viewers share segments over WebRTC", async ({ browser }) => {
  const viewers = [];
  const openViewer = async (name) => {
    const page = await (await browser.newContext()).newPage();
    viewers.push({ name, page });
    await page.goto(viewerUrl(`e2e-${name}-${Date.now()}`));
    return page;
  };
  try {
    const playlist = await (await fetch(playlistUrl)).text();
    const mediaLines = playlist.split("\n").filter((line) => line && !line.startsWith("#"));
    expect(mediaLines.length).toBeGreaterThan(0);
    expect(mediaLines.every((line) => line.endsWith(segmentExtension))).toBe(true);
    if (segmentType === "fmp4") expect(playlist).toContain("#EXT-X-MAP:URI=");

    const first = await openViewer("a");
    // Let the first viewer cache a few live segments before the second joins.
    await expect.poll(async () => (await playbackState(first)).playedSeconds, { timeout: 60_000 })
      .toBeGreaterThan(4);

    const second = await openViewer("b");
    await expect
      .poll(
        async () => {
          const [a, b] = await Promise.all([playbackState(first), playbackState(second)]);
          return a.peerFetched + b.peerFetched;
        },
        { timeout: 90_000, intervals: [2_000] },
      )
      .toBeGreaterThan(0);
    // peer_fetched can fire before Hls.js appends the bytes, so wait for
    // viewer B to actually play rather than checking once.
    await expect.poll(async () => (await playbackState(second)).playedSeconds, { timeout: 60_000 })
      .toBeGreaterThan(0);

    const [a, b] = await Promise.all([playbackState(first), playbackState(second)]);
    expect(a.fatalErrors).toEqual([]);
    expect(b.fatalErrors).toEqual([]);
    const shared = [...a.peerFetchedSegments, ...b.peerFetchedSegments];
    expect(shared.length).toBeGreaterThan(0);
    expect(shared.every((segment) => segment.endsWith(segmentExtension))).toBe(true);
  } finally {
    // Attach whatever state is available, including on timeouts.
    for (const { name, page } of viewers) {
      const state = await playbackState(page).catch((error) => ({ unavailable: String(error) }));
      test.info().annotations.push({ type: `viewer-${name}`, description: JSON.stringify(state) });
    }
  }
});
