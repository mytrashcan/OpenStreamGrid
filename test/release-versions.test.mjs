import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const repositoryRoot = new URL("../", import.meta.url);

function readText(path) {
  return readFileSync(new URL(path, repositoryRoot), "utf8");
}

function readJson(path) {
  return JSON.parse(readText(path));
}

const chartAppVersion = readText("helm/openstreamgrid/Chart.yaml").match(
  /^appVersion:\s*"?([^"\s]+)"?\s*$/m,
)?.[1];

const manifestPaths = [
  "package.json",
  "common/package.json",
  "tracker/package.json",
  "origin/package.json",
  "peer/package.json",
  "sdk/package.json",
];

test("Helm chart declares an appVersion", () => {
  assert.match(chartAppVersion ?? "", /^\d+\.\d+\.\d+$/);
});

test("package versions match the Helm chart appVersion", () => {
  for (const path of manifestPaths) {
    assert.equal(readJson(path).version, chartAppVersion, path);
  }
});

test("workspaces depend on the current common package version", () => {
  for (const path of ["tracker/package.json", "origin/package.json", "peer/package.json"]) {
    assert.equal(readJson(path).dependencies["@openstreamgrid/common"], chartAppVersion, path);
  }
});

test("lockfiles record the current first-party package versions", () => {
  const rootLock = readJson("package-lock.json");
  for (const key of ["", "common", "tracker", "origin", "peer"]) {
    assert.equal(rootLock.packages[key].version, chartAppVersion, `package-lock.json packages["${key}"]`);
  }
  const sdkLock = readJson("sdk/package-lock.json");
  assert.equal(sdkLock.packages[""].version, chartAppVersion, "sdk/package-lock.json");
});

test("Helm image tags default to the release tag derived from appVersion", () => {
  const values = readText("helm/openstreamgrid/values.yaml");
  const pinnedTags = [...values.matchAll(/^\s+tag:\s*"([^"]*)"/gm)]
    .map((match) => match[1])
    .filter((tag) => tag !== "");
  assert.deepEqual(pinnedTags, [], "values.yaml should leave image tags empty to follow appVersion");
});
