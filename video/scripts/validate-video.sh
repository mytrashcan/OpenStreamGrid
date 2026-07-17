#!/usr/bin/env bash
set -Eeuo pipefail

VIDEO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT="$VIDEO_DIR/output/openstreamgrid-devpost-1080p.mp4"
PREVIEWS="$VIDEO_DIR/output/previews"
FFPROBE="$(node -e "process.stdout.write(require('ffprobe-static').path)")"
FFMPEG="$(node -e "process.stdout.write(require('ffmpeg-static'))")"

mkdir -p "$PREVIEWS"
"$FFPROBE" -v error -show_entries format=format_name,duration:stream=index,codec_name,codec_type,width,height,r_frame_rate -of json "$OUTPUT" > "$VIDEO_DIR/output/ffprobe.json"

for timestamp in 4 12 20 29 37 45 54 63 73; do
  "$FFMPEG" -hide_banner -loglevel error -y -ss "$timestamp" -i "$OUTPUT" -frames:v 1 "$PREVIEWS/frame-${timestamp}s.png"
done

node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const report = JSON.parse(readFileSync(process.argv[1], "utf8"));
  const duration = Number(report.format.duration);
  const video = report.streams.find((stream) => stream.codec_type === "video");
  const audio = report.streams.find((stream) => stream.codec_type === "audio");
  if (!report.format.format_name.includes("mp4")) throw new Error("Output is not MP4");
  if (duration < 60 || duration > 90) throw new Error(`Duration ${duration} is outside 60–90 seconds`);
  if (video?.codec_name !== "h264" || video.width !== 1920 || video.height !== 1080) throw new Error("Video must be 1920x1080 H.264");
  if (audio?.codec_name !== "aac") throw new Error("Audio must use AAC");
  console.log(JSON.stringify({ duration, video, audio }, null, 2));
' "$VIDEO_DIR/output/ffprobe.json"
