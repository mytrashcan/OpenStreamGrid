import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { playlistSegmentFiles, writeSidecars } from "../src/sidecars.js";

const sha256 = (data: string): string => createHash("sha256").update(data).digest("hex");

const temporaryDirectory = async (context: TestContext): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), "openstreamgrid-sidecars-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
};

test("lists only local media segments inside the root", () => {
  const root = "/srv/hls";
  const playlist = [
    "#EXTM3U",
    "#EXT-X-MAP:URI=\"init.mp4\"",
    "#EXTINF:2.0,",
    "segment_1.m4s?token=abc",
    "#EXTINF:2.0,",
    "segment%202.ts",
    "https://cdn.example/segment_3.ts",
    "/absolute/segment_4.ts",
    "../../outside/segment_5.ts",
    "variant/stream.m3u8",
    "",
  ].join("\n");
  assert.deepEqual(playlistSegmentFiles(playlist, "/srv/hls/low/stream.m3u8", root), [
    "/srv/hls/low/segment_1.m4s",
    "/srv/hls/low/segment 2.ts",
  ]);
});

test("hashes listed segments, skips unlisted ones, and prunes orphans", async (context) => {
  const root = await temporaryDirectory(context);
  await mkdir(path.join(root, "low"));
  await writeFile(path.join(root, "master.m3u8"), "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlow/stream.m3u8\n");
  await writeFile(
    path.join(root, "low", "stream.m3u8"),
    "#EXTM3U\n#EXTINF:2,\nseg_1.ts\n#EXTINF:2,\nseg_2.ts\n#EXTINF:2,\nmissing.ts\n",
  );
  await writeFile(path.join(root, "low", "seg_1.ts"), "first");
  await writeFile(path.join(root, "low", "seg_2.ts"), "second");
  // Written but not yet listed: the packager may still be writing it.
  await writeFile(path.join(root, "low", "seg_3.ts"), "partial");
  // A sidecar whose segment the packager already deleted.
  await writeFile(path.join(root, "low", "seg_0.ts.sha256"), `${sha256("old")}  seg_0.ts\n`);

  const first = await writeSidecars(root);
  assert.deepEqual(first.written.sort(), [path.join("low", "seg_1.ts"), path.join("low", "seg_2.ts")]);
  assert.deepEqual(first.removed, [path.join("low", "seg_0.ts.sha256")]);
  assert.equal(
    await readFile(path.join(root, "low", "seg_1.ts.sha256"), "utf8"),
    `${sha256("first")}  seg_1.ts\n`,
  );
  assert.ok(!existsSync(path.join(root, "low", "seg_3.ts.sha256")));
  assert.ok(!existsSync(path.join(root, "low", "seg_0.ts.sha256")));

  // Existing sidecars are kept; nothing changes on the next pass.
  assert.deepEqual(await writeSidecars(root), { written: [], removed: [] });
});

test("the command line runs one pass with --once", async (context) => {
  const root = await temporaryDirectory(context);
  await writeFile(path.join(root, "stream.m3u8"), "#EXTM3U\n#EXTINF:2,\nseg_1.m4s\n");
  await writeFile(path.join(root, "seg_1.m4s"), "fmp4");
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "sidecars.js");
  await promisify(execFile)(process.execPath, [script, root, "--once"]);
  assert.equal(
    await readFile(path.join(root, "seg_1.m4s.sha256"), "utf8"),
    `${sha256("fmp4")}  seg_1.m4s\n`,
  );
  await assert.rejects(promisify(execFile)(process.execPath, [script]), /Usage: sidecars\.js/);
  await assert.rejects(
    promisify(execFile)(process.execPath, [script, root, "--interval", "3600000"]),
    /--interval must be between 100 and 60000 milliseconds/,
  );
});
