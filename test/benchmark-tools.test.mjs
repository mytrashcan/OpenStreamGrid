import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateResults,
  summarizeValues,
} from "../scripts/benchmark-suite.mjs";
import { compareAggregates } from "../scripts/benchmark-compare.mjs";

const provenance = (overrides = {}) => ({
  executedAt: "2026-07-26T08:00:00.000Z",
  nodeVersion: "v22.1.0",
  platform: "linux",
  arch: "x64",
  cpus: 8,
  totalMemoryMb: 16_384,
  randomSeed: 42,
  ...overrides,
});

test("summarizeValues calculates sample deviation and Student's t interval", () => {
  assert.deepEqual(summarizeValues([44.1, 45.2, 46.3]), {
    count: 3,
    mean: 45.2,
    median: 45.2,
    min: 44.1,
    max: 46.3,
    stdDev: 1.1,
    ci95: [42.467228, 47.932772],
  });
  assert.deepEqual(summarizeValues([7]), {
    count: 1,
    mean: 7,
    median: 7,
    min: 7,
    max: 7,
    stdDev: 0,
    ci95: [7, 7],
  });
});

test("aggregateResults flattens every numeric metric and skips null metrics", () => {
  const scenario = { name: "baseline", repetitionCount: 2 };
  const results = [
    {
      schemaVersion: 2,
      generatedAt: "2026-07-26T08:00:10.000Z",
      provenance: provenance(),
      scenario: { randomSeed: 42 },
      metrics: {
        p2pEfficiencyRatioPercent: 40,
        cacheHitRatePercent: null,
        latencyMs: { p50: 10, p95: 20 },
      },
      traffic: { p2pSuccesses: 4, originRequests: 6 },
    },
    {
      schemaVersion: 2,
      generatedAt: "2026-07-26T08:01:10.000Z",
      provenance: provenance(),
      scenario: { randomSeed: 42 },
      metrics: {
        p2pEfficiencyRatioPercent: 50,
        cacheHitRatePercent: null,
        latencyMs: { p50: 12, p95: 24 },
      },
      traffic: { p2pSuccesses: 6, originRequests: 4 },
    },
  ];

  const aggregate = aggregateResults(scenario, results, [], 2);
  assert.equal(aggregate.schemaVersion, 2);
  assert.equal(aggregate.aggregateVersion, 1);
  assert.equal(aggregate.runs, 2);
  assert.deepEqual(Object.keys(aggregate.metrics), [
    "latencyMs.p50",
    "latencyMs.p95",
    "p2pEfficiencyRatioPercent",
  ]);
  assert.equal(aggregate.metrics["latencyMs.p50"].mean, 11);
  assert.equal(aggregate.metrics.p2pEfficiencyRatioPercent.mean, 45);
  assert.equal(aggregate.traffic.p2pSuccesses.mean, 5);
  assert.equal(aggregate.traffic.originRequests.mean, 5);
  assert.deepEqual(aggregate.perRun.randomSeed, {
    value: 42,
    note: "per-run",
  });
});

test("compareAggregates reports environment drift and metric direction", () => {
  const left = {
    schemaVersion: 2,
    aggregateVersion: 1,
    scenario: { name: "baseline" },
    provenance: provenance(),
    metrics: {
      p2pEfficiencyRatioPercent: {
        mean: 45,
        ci95: [44, 46],
      },
      "latencyMs.p95": {
        mean: 100,
        ci95: [90, 110],
      },
      requestTimeoutCount: {
        mean: 0,
        ci95: [0, 0],
      },
    },
  };
  const right = {
    ...left,
    provenance: provenance({ nodeVersion: "v22.2.0" }),
    metrics: {
      p2pEfficiencyRatioPercent: {
        mean: 47,
        ci95: [46, 48],
      },
      "latencyMs.p95": {
        mean: 80,
        ci95: [75, 85],
      },
      requestTimeoutCount: {
        mean: 1,
        ci95: [0, 2],
      },
    },
  };

  const result = compareAggregates(left, right, "left.json", "right.json");
  assert.equal(result.environmentMatch, false);
  assert.deepEqual(result.environmentWarnings, [
    "Node version differs: v22.1.0 vs v22.2.0",
  ]);
  assert.equal(result.scenarioMatch, true);
  assert.deepEqual(
    result.comparison.map((entry) => [
      entry.metric,
      entry.direction,
      entry.lowerIsBetter,
      entry.higherIsBetter,
      entry.percentDiff,
    ]),
    [
      ["latencyMs.p95", "improvement", true, false, -20],
      [
        "p2pEfficiencyRatioPercent",
        "improvement",
        false,
        true,
        4.444444,
      ],
      ["requestTimeoutCount", "regression", true, false, null],
    ],
  );
});
