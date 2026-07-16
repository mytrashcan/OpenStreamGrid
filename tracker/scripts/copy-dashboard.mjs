import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const trackerDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(
  trackerDirectory,
  process.argv[2] ?? "dist",
);

await mkdir(outputDirectory, { recursive: true });
await copyFile(
  resolve(trackerDirectory, "src/dashboard.html"),
  resolve(outputDirectory, "dashboard.html"),
);
