import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const videoDirectory = path.resolve(scriptDirectory, "..");
const audioDirectory = path.join(videoDirectory, "public", "audio");
mkdirSync(audioDirectory, { recursive: true });

const captions = [
  ["01-problem", "In centralized live streaming, every viewer pulls the same H L S segments from delivery infrastructure."],
  ["02-intro", "Open Stream Grid is an open, platform independent hybrid P to P C D N testbed for H L S live streaming."],
  ["03-architecture", "The origin publishes three renditions. A tracker coordinates broadcasts, peers, segments, and live statistics."],
  ["04-peer-flow", "Peers cache and verify segments, announce availability, and serve them over Web R T C or H T T P."],
  ["05-fallback", "If a peer is missing, late, or untrusted, the client immediately falls back to the origin."],
  ["06-demo", "In the real Docker demo, two peers joined, advertised cached segments, and completed peer to peer transfers."],
  ["07-evidence", "After disconnecting peers, the same run recorded four origin fallbacks and preserved traffic data through a tracker restart."],
  ["08-scope", "This local prototype is reproducible, but not a production benchmark. It demonstrates hybrid routing, integrity, and resilience."],
  ["09-close", "Open Stream Grid explores a more distributed and resilient approach to live stream delivery."],
];

for (const [id, text] of captions) {
  const aiff = path.join(audioDirectory, `${id}.aiff`);
  const wav = path.join(audioDirectory, `${id}.wav`);
  execFileSync("/usr/bin/say", ["-r", "190", "-o", aiff, text], { stdio: "inherit" });
  execFileSync("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@48000", "-c", "1", aiff, wav], { stdio: "inherit" });
  rmSync(aiff, { force: true });
}

const sampleRate = 48_000;
const durationSeconds = 78;
const channels = 2;
const samples = sampleRate * durationSeconds;
const dataBytes = samples * channels * 2;
const buffer = Buffer.alloc(44 + dataBytes);
buffer.write("RIFF", 0);
buffer.writeUInt32LE(36 + dataBytes, 4);
buffer.write("WAVEfmt ", 8);
buffer.writeUInt32LE(16, 16);
buffer.writeUInt16LE(1, 20);
buffer.writeUInt16LE(channels, 22);
buffer.writeUInt32LE(sampleRate, 24);
buffer.writeUInt32LE(sampleRate * channels * 2, 28);
buffer.writeUInt16LE(channels * 2, 32);
buffer.writeUInt16LE(16, 34);
buffer.write("data", 36);
buffer.writeUInt32LE(dataBytes, 40);

const notes = [110, 138.59, 164.81, 220];
for (let index = 0; index < samples; index += 1) {
  const time = index / sampleRate;
  const section = Math.floor(time / 9.75) % 4;
  const fade = Math.min(1, time / 2, (durationSeconds - time) / 2);
  const pulse = 0.72 + 0.28 * Math.sin(time * Math.PI / 4);
  const value = notes.reduce(
    (sum, frequency, noteIndex) =>
      sum + Math.sin(2 * Math.PI * frequency * (1 + section * 0.002) * time + noteIndex) / (noteIndex + 2),
    0,
  );
  const sample = Math.round(value * 1900 * fade * pulse);
  const offset = 44 + index * channels * 2;
  buffer.writeInt16LE(sample, offset);
  buffer.writeInt16LE(Math.round(sample * 0.92), offset + 2);
}
writeFileSync(path.join(audioDirectory, "ambient.wav"), buffer);
console.log(`Generated narration and original ambient audio in ${audioDirectory}`);
