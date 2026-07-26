#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  metricSummary,
  readAggregateFile,
} from "./benchmark-data.mjs";

const scriptPath = fileURLToPath(import.meta.url);

const HELP = `OpenStreamGrid README benchmark block generator

Usage:
  node scripts/benchmark-update-readme.mjs <aggregate.json>

Prints a replacement block for the BENCHMARK markers in README.md and
README.ko.md. This command never writes either README.
`;

const format = (value, unit = "", digits = 2) =>
  `${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: digits,
  }).format(value)}${unit}`;

const formatMetric = (aggregate, metric, unit = "", digits = 2) => {
  const summary = metricSummary(aggregate, metric);
  if (!summary) return "n/a";
  return `${format(summary.mean, unit, digits)} (95% CI ${format(summary.ci95[0], unit, digits)}–${format(summary.ci95[1], unit, digits)})`;
};

export const markdownBenchmarkBlock = (aggregate) => {
  const successfulRuns =
    typeof aggregate.runs === "number" && Array.isArray(aggregate.failedRuns)
      ? aggregate.runs - aggregate.failedRuns.length
      : "n/a";
  return `<!-- BENCHMARK:START -->
### Reproducible benchmark: \`${aggregate.scenario.name}\`

| Metric | Mean and 95% CI |
| --- | ---: |
| Successful runs | ${successfulRuns} |
| P2P efficiency | ${formatMetric(aggregate, "p2pEfficiencyRatioPercent", "%")} |
| CDN traffic reduction | ${formatMetric(aggregate, "cdnTrafficReductionPercent", "%")} |
| P2P success rate | ${formatMetric(aggregate, "p2pSuccessRatePercent", "%")} |
| Origin fallback rate | ${formatMetric(aggregate, "originFallbackRatePercent", "%")} |
| Fetch latency p50 | ${formatMetric(aggregate, "fetchLatencyMs.p50", " ms")} |
| Fetch latency p95 | ${formatMetric(aggregate, "fetchLatencyMs.p95", " ms")} |
| Fetch latency p99 | ${formatMetric(aggregate, "fetchLatencyMs.p99", " ms")} |
| Jain's fairness index | ${formatMetric(aggregate, "jainFairnessIndex", "", 4)} |

_Single-host Docker benchmark with synthetic virtual peers. Not a production capacity claim. See [benchmark methodology](docs/benchmark-methodology.md)._
<!-- BENCHMARK:END -->`;
};

const main = () => {
  const arguments_ = process.argv.slice(2);
  if (arguments_.includes("--help")) {
    console.log(HELP);
    return;
  }
  if (arguments_.length !== 1 || arguments_[0].startsWith("--")) {
    throw new Error(HELP.trim());
  }
  const { aggregate } = readAggregateFile(arguments_[0]);
  process.stdout.write(`${markdownBenchmarkBlock(aggregate)}\n`);
};

if (resolve(process.argv[1] ?? "") === scriptPath) {
  try {
    main();
  } catch (error) {
    console.error(`[BenchmarkReadme] ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}
