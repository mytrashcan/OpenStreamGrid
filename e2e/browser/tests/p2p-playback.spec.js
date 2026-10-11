import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(here, "..", "..", "..");
const trackerUrl = process.env.TRACKER_URL ?? "http://127.0.0.1:7070";
// A single rendition keeps both viewers on the same segments.
const originBaseUrl = process.env.ORIGIN_BASE_URL ?? "http://127.0.0.1:8080/hls/low";
const playlistUrl = `${originBaseUrl}/stream.m3u8`;
// The origin's HLS_SEGMENT_TYPE; the test checks that this format is played and shared.
const segmentType = process.env.EXPECTED_SEGMENT_TYPE ?? "mpegts";
const segmentExtension = { mpegts: ".ts", fmp4: ".m4s" }[segmentType];
if (!segmentExtension) throw new Error(`Unknown EXPECTED_SEGMENT_TYPE '${segmentType}'`);

const routes = {
  "/": [join(here, "..", "page", "index.html"), "text/html; charset=utf-8"],
  "/sdk/sdk.js": [join(repositoryRoot, "sdk", "dist", "sdk.js"), "text/javascript"],
  "/vendor/hls.mjs": [join(here, "..", "node_modules", "hls.js", "dist", "hls.mjs"), "text/javascript"],
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
  });
  return `${pageOrigin}/?${params}`;
};

const playbackState = (page) =>
  page.evaluate(() => ({
    ...window.osg,
    currentTime: document.getElementById("video").currentTime,
  }));

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
    await expect.poll(async () => (await playbackState(first)).currentTime, { timeout: 60_000 })
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
    await expect.poll(async () => (await playbackState(second)).currentTime, { timeout: 60_000 })
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
