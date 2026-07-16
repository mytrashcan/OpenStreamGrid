import { createHash } from "node:crypto";
import { type ChildProcess, spawn } from "node:child_process";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const DEFAULT_HASH_INTERVAL_MS = 250;
const STOP_TIMEOUT_MS = 5_000;

/** Quality level definitions for Adaptive Bitrate streaming. */
export interface QualityLevel {
  /** Name used as subdirectory and variant key (low, med, high). */
  name: string;
  /** Output video width in pixels. */
  width: number;
  /** Output video height in pixels. */
  height: number;
  /** Target video bitrate (e.g. "500k"). */
  videoBitrate: string;
  /** Max video bitrate (same as target for CBR-like behavior). */
  maxrate: string;
  /** Buffer size (typically 2× videoBitrate). */
  bufsize: string;
  /** Audio bitrate (e.g. "64k" or "128k"). */
  audioBitrate: string;
}

export const QUALITY_LEVELS: QualityLevel[] = [
  {
    name: "low",
    width: 640,
    height: 360,
    videoBitrate: "500k",
    maxrate: "500k",
    bufsize: "1000k",
    audioBitrate: "64k",
  },
  {
    name: "med",
    width: 854,
    height: 480,
    videoBitrate: "1500k",
    maxrate: "1500k",
    bufsize: "3000k",
    audioBitrate: "128k",
  },
  {
    name: "high",
    width: 1280,
    height: 720,
    videoBitrate: "3000k",
    maxrate: "3000k",
    bufsize: "6000k",
    audioBitrate: "128k",
  },
] as const;

export interface StreamerOptions {
  outputDirectory: string;
  ffmpegPath?: string;
  masterPlaylistName?: string;
  segmentDurationSeconds?: number;
  playlistSize?: number;
  hashIntervalMs?: number;
}

export interface StreamController {
  readonly playlistPath: string;
  readonly qualities: string[];
  isRunning(): boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  ensureHash(segmentName: string): Promise<string>;
}

const isMissing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

export class HlsStreamer implements StreamController {
  readonly playlistPath: string;
  readonly qualities: string[];
  private readonly ffmpegPath: string;
  private readonly segmentDurationSeconds: number;
  private readonly playlistSize: number;
  private readonly hashIntervalMs: number;
  private child: ChildProcess | undefined;
  private hashTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: StreamerOptions) {
    const masterPlaylistName = options.masterPlaylistName ?? "stream.m3u8";
    this.playlistPath = path.join(options.outputDirectory, masterPlaylistName);
    this.qualities = QUALITY_LEVELS.map((q) => q.name);
    this.ffmpegPath = options.ffmpegPath ?? "ffmpeg";
    this.segmentDurationSeconds = options.segmentDurationSeconds ?? 2;
    this.playlistSize = options.playlistSize ?? 8;
    this.hashIntervalMs = options.hashIntervalMs ?? DEFAULT_HASH_INTERVAL_MS;
  }

  isRunning(): boolean {
    return this.child !== undefined && this.child.exitCode === null;
  }

  async start(): Promise<void> {
    if (this.isRunning()) return;
    await mkdir(this.options.outputDirectory, { recursive: true });
    await this.createVariantDirectories();
    await this.removeOldStreamFiles();

    const child = spawn(this.ffmpegPath, this.ffmpegArguments(), {
      stdio: ["ignore", "ignore", "pipe"],
      cwd: this.options.outputDirectory,
    });
    this.child = child;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.trimEnd().split("\n")) {
        if (line) console.error(`[ffmpeg] ${line}`);
      }
    });
    child.once("exit", (code, signal) => {
      if (this.child === child) this.child = undefined;
      if (code !== 0 && signal !== "SIGTERM") {
        console.error(
          JSON.stringify({ event: "ffmpeg_exited", code, signal }),
        );
      }
    });

    await new Promise<void>((resolve, reject) => {
      const onSpawn = (): void => {
        child.off("error", onError);
        resolve();
      };
      const onError = (error: Error): void => {
        child.off("spawn", onSpawn);
        if (this.child === child) this.child = undefined;
        reject(error);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });

    this.hashTimer = setInterval(
      () => void this.generatePublishedHashes().catch((error: unknown) => {
        console.error("failed to generate segment hashes", error);
      }),
      this.hashIntervalMs,
    );
    this.hashTimer.unref();
  }

  async stop(): Promise<void> {
    if (this.hashTimer) {
      clearInterval(this.hashTimer);
      this.hashTimer = undefined;
    }
    const child = this.child;
    if (!child || child.exitCode !== null) return;

    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    const timeout = new Promise<"timeout">((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), STOP_TIMEOUT_MS);
      timer.unref();
    });
    if ((await Promise.race([exited, timeout])) === "timeout") {
      child.kill("SIGKILL");
      await exited;
    }
  }

  async ensureHash(segmentName: string): Promise<string> {
    if (!/^[-A-Za-z0-9_./]+\\.ts$/.test(segmentName)) {
      throw new Error("Invalid segment name");
    }
    const segmentPath = path.join(this.options.outputDirectory, segmentName);
    const hashPath = `${segmentPath}.sha256`;
    try {
      await access(hashPath);
      return hashPath;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }

    const segment = await readFile(segmentPath);
    const digest = createHash("sha256").update(segment).digest("hex");
    const temporaryPath = `${hashPath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${digest}  ${segmentName}\n`, "utf8");
    await rename(temporaryPath, hashPath);
    return hashPath;
  }

  private ffmpegArguments(): string[] {
    const keyframeInterval = Math.max(
      1,
      Math.round(this.segmentDurationSeconds * 30),
    );

    // Build filter_complex: split video into 3 streams with scaling, split audio into 3 streams
    const videoScales = QUALITY_LEVELS.map(
      (q, i) => `[v${i}]scale=${q.width}:${q.height}[v${i}out]`,
    );
    const filterChains = [
      `[0:v]split=${QUALITY_LEVELS.length}${QUALITY_LEVELS.map((_, i) => `[v${i}]`).join("")}`,
      ...videoScales,
      `[1:a]asplit=${QUALITY_LEVELS.length}${QUALITY_LEVELS.map((_, i) => `[a${i}]`).join("")}`,
    ];
    const filterComplex = filterChains.join(";");

    // Build map arguments: interleave video+audio pairs
    const mapArgs: string[] = [];
    const perStreamArgs: string[] = [];
    for (const q of QUALITY_LEVELS) {
      mapArgs.push("-map", `[v${QUALITY_LEVELS.indexOf(q)}out]`);
      mapArgs.push("-map", `[a${QUALITY_LEVELS.indexOf(q)}]`);
      perStreamArgs.push(...["-b:v", q.videoBitrate, "-maxrate", q.maxrate, "-bufsize", q.bufsize]);
      perStreamArgs.push(...["-b:a", q.audioBitrate]);
    }

    // Build var_stream_map string
    const varStreamMap = QUALITY_LEVELS.map(
      (q, i) => `v:${i},a:${i},name:${q.name}`,
    ).join(" ");

    return [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-re",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=1280x720:rate=30",
      "-re",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=1000:sample_rate=48000",
      "-filter_complex",
      filterComplex,
      ...mapArgs,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-tune",
      "zerolatency",
      "-pix_fmt",
      "yuv420p",
      ...perStreamArgs,
      "-c:a",
      "aac",
      "-ac",
      "2",
      "-g",
      String(keyframeInterval),
      "-keyint_min",
      String(keyframeInterval),
      "-sc_threshold",
      "0",
      "-f",
      "hls",
      "-hls_time",
      String(this.segmentDurationSeconds),
      "-hls_list_size",
      String(this.playlistSize),
      "-hls_flags",
      "delete_segments+independent_segments+omit_endlist+program_date_time",
      "-var_stream_map",
      varStreamMap,
      "-master_pl_name",
      path.basename(this.playlistPath),
      "-hls_segment_filename",
      "hls/%v/segment_%06d.ts",
      "hls/%v/stream.m3u8",
    ];
  }

  private async createVariantDirectories(): Promise<void> {
    await Promise.all(
      QUALITY_LEVELS.map((q) =>
        mkdir(path.join(this.options.outputDirectory, "hls", q.name), {
          recursive: true,
        }),
      ),
    );
  }

  private async generatePublishedHashes(): Promise<void> {
    // Hash segments from all quality variant playlists
    await Promise.all(
      QUALITY_LEVELS.map(async (q) => {
        const variantPlaylist = path.join(
          this.options.outputDirectory,
          "hls",
          q.name,
          "stream.m3u8",
        );
        let playlist: string;
        try {
          playlist = await readFile(variantPlaylist, "utf8");
        } catch (error) {
          if (isMissing(error)) return;
          throw error;
        }
        const segmentNames = playlist
          .split("\n")
          .map((line) => line.trim())
          .filter(
            (line) => line !== "" && !line.startsWith("#") && line.endsWith(".ts"),
          );
        await Promise.all(
          segmentNames.map(async (segmentName) => {
            try {
              await this.ensureHash(path.join("hls", q.name, segmentName));
            } catch (error) {
              if (!isMissing(error)) throw error;
            }
          }),
        );
      }),
    );
  }

  private async removeOldStreamFiles(): Promise<void> {
    const entries = await readdir(this.options.outputDirectory);
    await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.endsWith(".m3u8") ||
            entry.endsWith(".ts") ||
            entry.endsWith(".ts.sha256") ||
            entry.endsWith(".tmp"),
        )
        .map((entry) =>
          rm(path.join(this.options.outputDirectory, entry), { force: true, recursive: true }),
        ),
    );
    // Clean variant subdirectories
    for (const q of QUALITY_LEVELS) {
      const variantDir = path.join(this.options.outputDirectory, "hls", q.name);
      try {
        const variantEntries = await readdir(variantDir);
        await Promise.all(
          variantEntries.map((entry) =>
            rm(path.join(variantDir, entry), { force: true, recursive: true }),
          ),
        );
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
  }
}
