/**
 * esbuild build script for @openstreamgrid/sdk.
 * Produces:
 *   - dist/sdk.js       (ESM, browser-targeted)
 *   - dist/sdk.cjs      (CJS, for Node consumers)
 * and makes the declarations in dist/types self-contained.
 */

import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const TYPES_DIRECTORY = fileURLToPath(new URL("../dist/types/", import.meta.url));
const COMMON_PACKAGE = "@openstreamgrid/common";
/** Packages the published declarations may import; consumers install them. */
const ALLOWED_TYPE_IMPORTS = new Set(["hls.js"]);
const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm;

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

  await inlineCommonTypes();
  await checkTypeImports();
  console.log("✓ dist/types self-contained");
}

/**
 * The bundles inline @openstreamgrid/common, but tsc leaves its imports in
 * the declarations, and that private package is not published. Copy its
 * declarations next to the SDK's and point the imports at the copy.
 */
async function inlineCommonTypes() {
  const require = createRequire(import.meta.url);
  const commonTypes = path.dirname(require.resolve(COMMON_PACKAGE));
  const target = path.join(TYPES_DIRECTORY, "common");
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(commonTypes)) {
    if (entry.endsWith(".d.ts")) {
      await copyFile(path.join(commonTypes, entry), path.join(target, entry));
    }
  }
  for (const file of await declarationFiles(TYPES_DIRECTORY)) {
    if (file.startsWith(target + path.sep)) continue;
    const source = await readFile(file, "utf8");
    const relative = path.relative(path.dirname(file), path.join(target, "index.js"));
    const specifier = relative.startsWith(".") ? relative : `./${relative}`;
    const rewritten = source.replaceAll(`"${COMMON_PACKAGE}"`, `"${specifier.split(path.sep).join("/")}"`);
    if (rewritten !== source) await writeFile(file, rewritten);
  }
}

/** Fails the build if a declaration imports a package consumers will not have. */
async function checkTypeImports() {
  const problems = [];
  for (const file of await declarationFiles(TYPES_DIRECTORY)) {
    // Drop comments, whose examples may mention other packages.
    const source = (await readFile(file, "utf8"))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const [, specifier] of source.matchAll(IMPORT_SPECIFIER)) {
      if (specifier.startsWith(".") || ALLOWED_TYPE_IMPORTS.has(specifier)) continue;
      problems.push(`${path.relative(TYPES_DIRECTORY, file)} imports "${specifier}"`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`Published declarations import unpublished packages:\n${problems.join("\n")}`);
  }
}

async function declarationFiles(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".d.ts"))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

main().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
