import assert from "node:assert/strict";
import test from "node:test";

import {
  createSeededRandom,
  jainFairnessIndex,
  parseScenarioJson,
  percentile,
  shuffleWithRandom,
  validateBenchmarkResult,
} from "../scripts/benchmark-data.mjs";

const validScenario = {
  $schema: "../schema/benchmark-scenario.schema.json",
  scenarioVersion: 1,
  name: "inline-smoke",
  description: "Inline scenario fixture for benchmark validation tests.",
  peerCount: 3,
  durationSeconds: 30,
  rampUpSeconds: 5,
  churnProbability: 0.1,
  p2pEnabled: true,
  quality: "low",
  segmentDurationSeconds: 2,
  uploadBandwidthLimit: 4,
  concurrentUploadLimit: 3,
  p2pTimeoutMs: 2_000,
  randomSeed: 42,
  repetitionCount: 3,
  tags: ["inline", "smoke"],
};

const validResult = {
  schemaVersion: 2,
  generatedAt: "2026-07-26T08:00:00.000Z",
  provenance: {
    command: "node test/load-test.mjs --seed 42",
    randomSeed: 42,
    productionComparable: false,
  },
  scenario: {
    name: "inline-smoke",
    peerCount: 3,
    randomSeed: 42,
  },
  metrics: {
    p2pEfficiencyRatioPercent: 45.2,
    cdnTrafficReductionPercent: 46.1,
    p2pSuccessRatePercent: 80,
    originFallbackRatePercent: 20,
    bytesDownloadedP2P: 1_000,
    bytesDownloadedOrigin: 1_200,
    jainFairnessIndex: 0.92,
    fetchLatencyMs: {
      p50: 12,
      p95: 30,
      p99: 48,
    },
  },
  traffic: {
    p2pRequests: 10,
    p2pSuccesses: 8,
    originRequests: 2,
  },
  churn: {
    events: 0,
    sessions: 3,
  },
};

test("scenario JSON parsing accepts valid inline data and rejects invalid data", () => {
  assert.deepEqual(
    parseScenarioJson(JSON.stringify(validScenario), "valid fixture"),
    validScenario,
  );

  const invalidScenario = {
    ...validScenario,
    name: "Invalid Scenario",
    tags: ["duplicate", "duplicate"],
  };
  assert.throws(
    () =>
      parseScenarioJson(JSON.stringify(invalidScenario), "invalid fixture"),
    /Invalid invalid fixture:.*name must be a kebab-case identifier.*tags must not contain duplicates/u,
  );
  assert.throws(
    () => parseScenarioJson("{", "malformed fixture"),
    /Unable to parse malformed fixture/u,
  );
});

test("the same random seed produces the same shuffle order", () => {
  const values = Array.from({ length: 12 }, (_, index) => index + 1);
  const first = shuffleWithRandom(values, createSeededRandom(42));
  const second = shuffleWithRandom(values, createSeededRandom(42));
  const different = shuffleWithRandom(values, createSeededRandom(43));

  assert.deepEqual(first, second);
  assert.notDeepEqual(first, different);
  assert.deepEqual(values, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});

test("metric helpers calculate nearest-rank percentiles and Jain fairness", () => {
  assert.equal(percentile([40, 10, 30, 20], 0.5), 20);
  assert.equal(percentile([40, 10, 30, 20], 0.95), 40);
  assert.equal(percentile([], 0.99), 0);
  assert.equal(jainFairnessIndex([10, 10, 10]), 1);
  assert.equal(jainFairnessIndex([10, 0]), 0.5);
  assert.equal(jainFairnessIndex([0, 0]), 1);
});

test("benchmark result validation accepts v2 and reports schema errors", () => {
  assert.deepEqual(validateBenchmarkResult(validResult), []);

  const invalidResult = {
    ...validResult,
    schemaVersion: 1,
    metrics: {
      ...validResult.metrics,
      fetchLatencyMs: { p50: 12, p95: "slow" },
    },
    traffic: [],
  };
  assert.deepEqual(validateBenchmarkResult(invalidResult), [
    "schemaVersion must equal 2",
    "traffic must be an object",
    "metrics.fetchLatencyMs.p95 must be a finite number",
    "metrics.fetchLatencyMs.p99 must be a finite number",
  ]);
});
