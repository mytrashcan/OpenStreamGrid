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

const chartYaml = readText("helm/openstreamgrid/Chart.yaml");
const chartField = (field) =>
  chartYaml.match(new RegExp(`^${field}:\\s*["']?([^"'\\s]+)["']?\\s*$`, "m"))?.[1];
const chartAppVersion = chartField("appVersion");

const manifestPaths = [
  "package.json",
  "common/package.json",
  "tracker/package.json",
  "origin/package.json",
  "peer/package.json",
  "sdk/package.json",
];

test("Helm chart declares an appVersion that matches its chart version", () => {
  assert.match(chartAppVersion ?? "", /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.equal(chartField("version"), chartAppVersion, "Chart.yaml version");
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
    assert.equal(rootLock.packages[key]?.version, chartAppVersion, `package-lock.json packages["${key}"]`);
  }
  const sdkLock = readJson("sdk/package-lock.json");
  for (const key of ["", "../common"]) {
    assert.equal(sdkLock.packages[key]?.version, chartAppVersion, `sdk/package-lock.json packages["${key}"]`);
  }
  const exampleLock = readJson("examples/react-integration/package-lock.json");
  assert.equal(
    exampleLock.packages["../../sdk"]?.version,
    chartAppVersion,
    'examples/react-integration/package-lock.json packages["../../sdk"]',
  );
});

test("Helm image tags default to the release tag derived from appVersion", () => {
  const values = readText("helm/openstreamgrid/values.yaml");
  const pinnedTags = [...values.matchAll(/^\s+tag:[ \t]*(.*)$/gm)]
    .map((match) => match[1].replace(/\s+#.*$/, "").trim())
    .filter((tag) => tag !== '""' && tag !== "''" && tag !== "");
  assert.deepEqual(pinnedTags, [], "values.yaml should leave image tags empty to follow appVersion");
});
