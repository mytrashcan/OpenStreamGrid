#!/usr/bin/env node

// Sets every first-party version (workspace manifests, lockfile entries, and
// the Helm chart) to one release version so they cannot drift apart.

import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? "")) {
  console.error("Usage: node scripts/bump-version.mjs <major.minor.patch[-prerelease]>");
  process.exit(1);
}

const repositoryRoot = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, repositoryRoot), "utf8");
const write = (path, contents) => writeFileSync(new URL(path, repositoryRoot), contents);

function updateJson(path, mutate) {
  const data = JSON.parse(read(path));
  mutate(data);
  write(path, `${JSON.stringify(data, null, 2)}\n`);
}

function setCommonDependency(dependencies) {
  if (dependencies?.["@openstreamgrid/common"]) {
    dependencies["@openstreamgrid/common"] = version;
  }
}

for (const path of [
  "package.json",
  "common/package.json",
  "tracker/package.json",
  "origin/package.json",
  "peer/package.json",
  "sdk/package.json",
]) {
  updateJson(path, (manifest) => {
    manifest.version = version;
    setCommonDependency(manifest.dependencies);
  });
}

updateJson("package-lock.json", (lock) => {
  lock.version = version;
  for (const key of ["", "common", "tracker", "origin", "peer"]) {
    lock.packages[key].version = version;
    setCommonDependency(lock.packages[key].dependencies);
  }
});

updateJson("sdk/package-lock.json", (lock) => {
  lock.version = version;
  lock.packages[""].version = version;
  lock.packages["../common"].version = version;
});

updateJson("examples/react-integration/package-lock.json", (lock) => {
  lock.packages["../../sdk"].version = version;
});

const chartPath = "helm/openstreamgrid/Chart.yaml";
write(
  chartPath,
  read(chartPath)
    .replace(/^version:.*$/m, `version: ${version}`)
    .replace(/^appVersion:.*$/m, `appVersion: "${version}"`),
);

console.log(`Set first-party versions to ${version}. Update CHANGELOG.md and release docs next.`);
