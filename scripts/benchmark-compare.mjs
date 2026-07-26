#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);

const HELP = `OpenStreamGrid benchmark aggregate comparison

Usage:
  node scripts/benchmark-compare.mjs <left-aggregate.json> <right-aggregate.json>
  node scripts/benchmark-compare.mjs --markdown <left-aggregate.json> <right-aggregate.json>

Outputs JSON by default, or a Markdown table when --markdown is supplied.
`;

const environmentFields = new Map([
  ["nodeVersion", "Node version"],
  ["platform", "Platform"],
  ["arch", "Architecture"],
  ["cpus", "CPU count"],
  ["totalMemoryMb", "Total memory"],
]);

const round = (value) => Number(value.toFixed(6));

const readAggregate = (argument) => {
  const path = resolve(argument);
  let aggregate;
  try {
    aggregate = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read aggregate '${argument}': ${error.message}`);
  }
  if (aggregate.schemaVersion !== 2 || aggregate.aggregateVersion !== 1) {
    throw new Error(
      `Schema mismatch in '${argument}': expected schemaVersion 2 and aggregateVersion 1`,
    );
  }
  if (
    aggregate.metrics === null ||
    typeof aggregate.metrics !== "object" ||
    Array.isArray(aggregate.metrics)
  ) {
    throw new Error(`Schema mismatch in '${argument}': metrics must be an object`);
  }
  return { aggregate, path };
};

const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const metricPreference = (metric) => {
  const lowerIsBetter =
    /latency|fallback|timeout|stall|deadlineMiss|failure|error/iu.test(metric);
  const higherIsBetter =
    /p2pEfficiency|cdnTrafficReduction|p2pSuccess|jainFairness|upload/iu.test(
      metric,
    );
  return {
    lowerIsBetter,
    higherIsBetter: !lowerIsBetter && higherIsBetter,
  };
};

const comparisonDirection = (difference, preference) => {
  if (difference === 0) return "unchanged";
  if (preference.lowerIsBetter) {
    return difference < 0 ? "improvement" : "regression";
  }
  if (preference.higherIsBetter) {
    return difference > 0 ? "improvement" : "regression";
  }
  return difference > 0 ? "increase" : "decrease";
};

const comparableSummary = (summary) =>
  summary &&
  typeof summary.mean === "number" &&
  Number.isFinite(summary.mean) &&
  Array.isArray(summary.ci95) &&
  summary.ci95.length === 2;

export const compareAggregates = (
  left,
  right,
  leftLabel = "left",
  rightLabel = "right",
) => {
  const environmentWarnings = [];
  for (const [field, label] of environmentFields) {
    const leftValue = left.provenance?.[field];
    const rightValue = right.provenance?.[field];
    if (leftValue !== rightValue) {
      environmentWarnings.push(
        `${label} differs: ${String(leftValue)} vs ${String(rightValue)}`,
      );
    }
  }

  const comparison = [];
  const sharedMetrics = Object.keys(left.metrics)
    .filter(
      (metric) =>
        Object.hasOwn(right.metrics, metric) &&
        comparableSummary(left.metrics[metric]) &&
        comparableSummary(right.metrics[metric]),
    )
    .sort();
  for (const metric of sharedMetrics) {
    const leftSummary = left.metrics[metric];
    const rightSummary = right.metrics[metric];
    const absoluteDiff = rightSummary.mean - leftSummary.mean;
    const preference = metricPreference(metric);
    comparison.push({
      metric,
      left: { mean: leftSummary.mean, ci95: leftSummary.ci95 },
      right: { mean: rightSummary.mean, ci95: rightSummary.ci95 },
      absoluteDiff: round(absoluteDiff),
      percentDiff:
        leftSummary.mean === 0
          ? null
          : round((absoluteDiff / Math.abs(leftSummary.mean)) * 100),
      direction: comparisonDirection(absoluteDiff, preference),
      ...preference,
    });
  }

  return {
    left: leftLabel,
    right: rightLabel,
    environmentMatch: environmentWarnings.length === 0,
    environmentWarnings,
    scenarioMatch: canonicalJson(left.scenario) === canonicalJson(right.scenario),
    comparison,
  };
};

const markdownCell = (value) => String(value).replaceAll("|", "\\|");
const formatCi = (summary) =>
  `${summary.mean} [${summary.ci95[0]}, ${summary.ci95[1]}]`;

const markdownComparison = (result) => {
  const lines = [
    "# Benchmark comparison",
    "",
    `- Left: \`${result.left}\``,
    `- Right: \`${result.right}\``,
    `- Environment match: ${result.environmentMatch ? "yes" : "no"}`,
    `- Scenario match: ${result.scenarioMatch ? "yes" : "no"}`,
  ];
  if (result.environmentWarnings.length > 0) {
    lines.push("", "## Environment warnings", "");
    for (const warning of result.environmentWarnings) {
      lines.push(`- ${warning}`);
    }
  }
  lines.push(
    "",
    "| Metric | Left mean [95% CI] | Right mean [95% CI] | Absolute diff | Percent diff | Direction |",
    "| --- | ---: | ---: | ---: | ---: | --- |",
  );
  for (const entry of result.comparison) {
    lines.push(
      `| ${markdownCell(entry.metric)} | ${formatCi(entry.left)} | ` +
        `${formatCi(entry.right)} | ${entry.absoluteDiff} | ` +
        `${entry.percentDiff === null ? "n/a" : `${entry.percentDiff}%`} | ` +
        `${entry.direction} |`,
    );
  }
  return `${lines.join("\n")}\n`;
};

const main = () => {
  const arguments_ = process.argv.slice(2);
  if (arguments_.includes("--help")) {
    console.log(HELP);
    return;
  }
  const markdown = arguments_.includes("--markdown");
  const files = arguments_.filter((argument) => argument !== "--markdown");
  if (files.length !== 2 || files.some((file) => file.startsWith("--"))) {
    throw new Error(HELP.trim());
  }
  const left = readAggregate(files[0]);
  const right = readAggregate(files[1]);
  const result = compareAggregates(
    left.aggregate,
    right.aggregate,
    files[0],
    files[1],
  );
  process.stdout.write(
    markdown ? markdownComparison(result) : `${JSON.stringify(result, null, 2)}\n`,
  );
};

if (resolve(process.argv[1] ?? "") === scriptPath) {
  try {
    main();
  } catch (error) {
    console.error(`[BenchmarkCompare] ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}
