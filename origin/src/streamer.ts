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

export interface StreamerOptions {
  outputDirectory: string;
  ffmpegPath?: string;
  playlistName?: string;
  segmentDurationSeconds?: number;
  playlistSize?: number;
  hashIntervalMs?: number;
}

export interface StreamController {
  readonly playlistPath: string;
  isRunning(): boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  ensureHash(segmentName: string): Promise<string>;
}

const isMissing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

export class HlsStreamer implements StreamController {
  readonly playlistPath: string;
  private readonly ffmpegPath: string;
  private readonly segmentDurationSeconds: number;
  private readonly playlistSize: number;
  private readonly hashIntervalMs: number;
  private child: ChildProcess | undefined;
  private hashTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: StreamerOptions) {
    const playlistName = options.playlistName ?? "stream.m3u8";
    this.playlistPath = path.join(options.outputDirectory, playlistName);
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
    await this.removeOldStreamFiles();

    const child = spawn(this.ffmpegPath, this.ffmpegArguments(), {
      stdio: ["ignore", "ignore", "pipe"],
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
    if (!/^[-A-Za-z0-9_.]+\.ts$/.test(segmentName)) {
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
    const segmentPattern = path.join(
      this.options.outputDirectory,
      "segment_%06d.ts",
    );
    const keyframeInterval = Math.max(
      1,
      Math.round(this.segmentDurationSeconds * 30),
    );
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
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-tune",
      "zerolatency",
      "-pix_fmt",
      "yuv420p",
      "-b:v",
      "800k",
      "-maxrate",
      "800k",
      "-bufsize",
      "1600k",
      "-g",
      String(keyframeInterval),
      "-keyint_min",
      String(keyframeInterval),
      "-sc_threshold",
      "0",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-ac",
      "2",
      "-f",
      "hls",
      "-hls_time",
      String(this.segmentDurationSeconds),
      "-hls_list_size",
      String(this.playlistSize),
      "-hls_flags",
      "delete_segments+independent_segments+omit_endlist+program_date_time",
      "-hls_segment_filename",
      segmentPattern,
      this.playlistPath,
    ];
  }

  private async generatePublishedHashes(): Promise<void> {
    let playlist: string;
    try {
      playlist = await readFile(this.playlistPath, "utf8");
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    const segmentNames = playlist
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#") && line.endsWith(".ts"));
    await Promise.all(
      segmentNames.map(async (segmentName) => {
        try {
          await this.ensureHash(segmentName);
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
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
          rm(path.join(this.options.outputDirectory, entry), { force: true }),
        ),
    );
  }
}
