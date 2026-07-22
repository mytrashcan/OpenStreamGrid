/**
 * esbuild build script for @openstreamgrid/sdk.
 * Produces:
 *   - dist/sdk.js       (ESM, browser-targeted)
 *   - dist/sdk.cjs      (CJS, for Node consumers)
 */

import * as esbuild from "esbuild";

const commonOptions = {
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "browser",
  target: "es2020",
  external: ["hls.js"],
  sourcemap: false,
  minify: true,
};

async function main() {
  // ESM build
  await esbuild.build({
    ...commonOptions,
    format: "esm",
    outfile: "dist/sdk.js",
  });

  // CJS build
  await esbuild.build({
    ...commonOptions,
    format: "cjs",
    outfile: "dist/sdk.cjs",
  });

  console.log("✓ dist/sdk.js (ESM)  built");
  console.log("✓ dist/sdk.cjs (CJS) built");
}

main().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
