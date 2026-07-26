#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  metricSummary,
  readAggregateFile,
} from "./benchmark-data.mjs";

const scriptPath = fileURLToPath(import.meta.url);

const HELP = `OpenStreamGrid Bencher adapter

Usage:
  node scripts/benchmark-bencher.mjs <aggregate.json>

Writes Bencher-compatible JSON to stdout. No Bencher account or SDK is needed.
`;

const metricMappings = [
  ["p2p_efficiency", "p2pEfficiencyRatioPercent", "percent"],
  ["cdn_traffic_reduction", "cdnTrafficReductionPercent", "percent"],
  ["p2p_success_rate", "p2pSuccessRatePercent", "percent"],
  ["fallback_rate", "originFallbackRatePercent", "percent"],
  ["deadline_miss_rate", "deadlineMissRatePercent", "percent"],
  ["fetch_latency_p50", "fetchLatencyMs.p50", "milliseconds"],
  ["fetch_latency_p95", "fetchLatencyMs.p95", "milliseconds"],
  ["fetch_latency_p99", "fetchLatencyMs.p99", "milliseconds"],
  ["stall_proxy_duration", "stallProxyDurationMs", "milliseconds"],
  ["peer_upload_fairness", "jainFairnessIndex", "ratio"],
];

export const toBencher = (aggregate) => ({
  version: "0.1.0",
  results: metricMappings.flatMap(([name, metric, units]) => {
    const summary = metricSummary(aggregate, metric);
    return summary
      ? [
          {
            name,
            value: summary.mean,
            units,
            lower_bound: summary.ci95[0],
            upper_bound: summary.ci95[1],
          },
        ]
      : [];
  }),
});

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
  const output = toBencher(aggregate);
  if (output.results.length === 0) {
    throw new Error("Aggregate contains no supported Bencher metrics");
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
};

if (resolve(process.argv[1] ?? "") === scriptPath) {
  try {
    main();
  } catch (error) {
    console.error(`[BenchmarkBencher] ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}
