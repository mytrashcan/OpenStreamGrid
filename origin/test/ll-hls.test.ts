import assert from "node:assert/strict";
import test from "node:test";
import { addPartsToPlaylist, parsePartName, partRange } from "../src/ll-hls.js";

test("names parts after their segment", () => {
  assert.deepEqual(parsePartName("e_segment_000010.part2.ts"), {
    segmentName: "e_segment_000010.ts",
    index: 2,
  });
  assert.deepEqual(parsePartName("low/e_segment_000010.part0.ts"), {
    segmentName: "low/e_segment_000010.ts",
    index: 0,
  });
  assert.equal(parsePartName("e_segment_000010.ts"), undefined);
  assert.equal(parsePartName("e_segment_000010.part1.m4s"), undefined);
});

test("splits a segment into packet-aligned parts that cover it exactly", () => {
  const size = 188 * 100 + 17;
  const ranges = [0, 1, 2].map((index) => partRange(size, index, 3));
  assert.deepEqual(ranges, [
    { start: 0, end: 188 * 33 },
    { start: 188 * 33, end: 188 * 66 },
    { start: 188 * 66, end: size },
  ]);
  for (const { start } of ranges) assert.equal(start % 188, 0);
});

test("adds LL-HLS part tags to the last segments of a media playlist", () => {
  const playlist = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-TARGETDURATION:2",
    "#EXT-X-MEDIA-SEQUENCE:7",
    ...[7, 8, 9, 10].flatMap((sn) => ["#EXTINF:2.000000,", `e_segment_00000${sn}.ts`]),
    "",
  ].join("\n");
  const rewritten = addPartsToPlaylist(playlist, 2).split("\n");

  assert.ok(rewritten.includes("#EXT-X-PART-INF:PART-TARGET=1.00000"));
  assert.ok(rewritten.includes("#EXT-X-SERVER-CONTROL:PART-HOLD-BACK=3.00000"));
  // The oldest segment gets no parts; the last three do, before their EXTINF.
  assert.ok(!rewritten.some((line) => line.includes("e_segment_000007.part")));
  const tenth = rewritten.indexOf("e_segment_0000010.ts");
  assert.deepEqual(rewritten.slice(tenth - 3, tenth), [
    '#EXT-X-PART:DURATION=1.00000,URI="e_segment_0000010.part0.ts",INDEPENDENT=YES',
    '#EXT-X-PART:DURATION=1.00000,URI="e_segment_0000010.part1.ts"',
    "#EXTINF:2.000000,",
  ]);

  // Master playlists and disabled parts are left alone.
  const master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlow/stream.m3u8\n";
  assert.equal(addPartsToPlaylist(master, 2), master);
  assert.equal(addPartsToPlaylist(playlist, 0), playlist);
});
