/**
 * Writes the SHA-256 sidecars that peers verify segments against, for HLS
 * output from any packager. Run it next to your packager when you do not use
 * the OpenStreamGrid origin:
 *
 *   node origin/dist/sidecars.js /var/www/hls            # keep watching
 *   node origin/dist/sidecars.js /var/www/hls --once     # one pass
 *
 * Only segments listed in a media playlist are hashed: packagers add a
 * segment to the playlist after writing it, so a listed segment is complete.
 * Sidecars are written atomically as `<sha256>  <segment name>`, and sidecars
 * whose segment was deleted are removed.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createLogger, MEDIA_SEGMENT_EXTENSION_PATTERN } from "@openstreamgrid/common";

const SIDECAR_SUFFIX = ".sha256";
const DEFAULT_INTERVAL_MS = 1_000;
const MIN_INTERVAL_MS = 100;
const MAX_INTERVAL_MS = 60_000;
const URI_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;
const logger = createLogger("sidecars");

export interface SidecarPassResult {
  /** Segments that got a new sidecar, relative to the root. */
  written: string[];
  /** Sidecars removed because their segment no longer exists. */
  removed: string[];
}

/**
 * Media segment files a playlist lists, as absolute paths inside `root`.
 * Remote URLs, root-relative paths, and paths that leave `root` are skipped:
 * they do not name a file this process can hash.
 */
export const playlistSegmentFiles = (
  playlist: string,
  playlistPath: string,
  root: string,
): string[] => {
  const resolvedRoot = path.resolve(root);
  const directory = path.dirname(path.resolve(playlistPath));
  return playlist
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((uri) => uri.replace(/[?#].*$/, ""))
    .filter((uri) => !URI_SCHEME_PATTERN.test(uri) && !uri.startsWith("/"))
    .map((uri) => {
      try {
        return path.resolve(directory, decodeURIComponent(uri));
      } catch {
        return "";
      }
    })
    .filter(
      (file) =>
        file.startsWith(`${resolvedRoot}${path.sep}`) &&
        MEDIA_SEGMENT_EXTENSION_PATTERN.test(file),
    );
};

const sha256File = async (file: string): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
};

/** One pass over `root`: writes missing sidecars and prunes orphaned ones. */
export const writeSidecars = async (root: string): Promise<SidecarPassResult> => {
  const resolvedRoot = path.resolve(root);
  const files = new Set(
    (await readdir(resolvedRoot, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(entry.parentPath, entry.name)),
  );
  const listed = new Set<string>();
  for (const file of files) {
    if (!file.endsWith(".m3u8")) continue;
    let playlist: string;
    try {
      playlist = await readFile(file, "utf8");
    } catch {
      continue; // Replaced or removed by the packager mid-pass.
    }
    for (const segment of playlistSegmentFiles(playlist, file, resolvedRoot)) {
      listed.add(segment);
    }
  }

  const written: string[] = [];
  for (const segment of listed) {
    if (!files.has(segment) || files.has(`${segment}${SIDECAR_SUFFIX}`)) continue;
    const sidecar = `${segment}${SIDECAR_SUFFIX}`;
    const temporary = `${sidecar}.${process.pid}.tmp`;
    try {
      const digest = await sha256File(segment);
      await writeFile(temporary, `${digest}  ${path.basename(segment)}\n`, "utf8");
      await rename(temporary, sidecar);
      written.push(path.relative(resolvedRoot, segment));
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      // The packager deleted the segment while it was being hashed.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  const removed: string[] = [];
  for (const file of files) {
    if (!file.endsWith(SIDECAR_SUFFIX)) continue;
    const segment = file.slice(0, -SIDECAR_SUFFIX.length);
    if (!MEDIA_SEGMENT_EXTENSION_PATTERN.test(segment) || files.has(segment)) continue;
    await unlink(file).catch(() => undefined);
    removed.push(path.relative(resolvedRoot, file));
  }
  return { written, removed };
};

const USAGE = [
  "Usage: sidecars.js <hls-directory> [--once] [--interval <ms>]",
  "",
  "Writes <segment>.sha256 next to every segment an HLS media playlist under",
  "<hls-directory> lists, and removes sidecars whose segment is gone.",
  "",
  "  --once            Run a single pass and exit",
  `  --interval <ms>   Time between passes, ${MIN_INTERVAL_MS} to ${MAX_INTERVAL_MS} (default ${DEFAULT_INTERVAL_MS})`,
].join("\n");

const parseArguments = (
  argv: string[],
): { root: string; once: boolean; intervalMs: number } => {
  let root: string | undefined;
  let once = false;
  let intervalMs = DEFAULT_INTERVAL_MS;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--once") once = true;
    else if (argument === "--interval") {
      intervalMs = Number(argv[(index += 1)]);
      if (
        !Number.isSafeInteger(intervalMs) ||
        intervalMs < MIN_INTERVAL_MS ||
        intervalMs > MAX_INTERVAL_MS
      ) {
        throw new Error(
          `--interval must be between ${MIN_INTERVAL_MS} and ${MAX_INTERVAL_MS} milliseconds`,
        );
      }
    } else if (argument?.startsWith("--")) {
      throw new Error(`Unknown option '${argument}'`);
    } else if (root === undefined) root = argument;
    else throw new Error(`Unexpected argument '${argument}'`);
  }
  if (!root) {
    throw new Error("Missing <hls-directory>; run with --help for usage");
  }
  return { root, once, intervalMs };
};

const run = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return;
  }
  const { root, once, intervalMs } = parseArguments(argv);
  let stopped = false;
  let wake: (() => void) | undefined;
  const stop = (): void => {
    stopped = true;
    wake?.();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  do {
    const { written, removed } = await writeSidecars(root);
    if (written.length > 0 || removed.length > 0) {
      logger.info("sidecars_updated", { written: written.length, removed: removed.length });
    }
    if (once || stopped) break;
    await new Promise<void>((resolve) => {
      wake = resolve;
      // parseArguments already rejects values outside this range.
      const delayMs =
        intervalMs > MAX_INTERVAL_MS
          ? MAX_INTERVAL_MS
          : intervalMs < MIN_INTERVAL_MS
            ? MIN_INTERVAL_MS
            : intervalMs;
      setTimeout(resolve, delayMs);
    });
  } while (!stopped);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error: unknown) => {
    logger.error("sidecars_failed", error);
    process.exitCode = 1;
  });
}
