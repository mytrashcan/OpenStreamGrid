#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const rootDirectory = resolve(dirname(scriptPath), "..");
const benchmarkScript = resolve(rootDirectory, "scripts/benchmark.sh");
const defaultResultsDirectory = resolve(rootDirectory, "benchmarks/results");

const HELP = `OpenStreamGrid repeated benchmark suite

Usage:
  node scripts/benchmark-suite.mjs <scenario.json>

Runs the scenario's repetitionCount (default: 1), writes each raw result, and
creates aggregate JSON, Markdown, and CSV summaries in benchmarks/results/.
`;

const studentTCritical95 = [
  undefined,
  12.706,
  4.303,
  3.182,
  2.776,
  2.571,
  2.447,
  2.365,
  2.306,
  2.262,
  2.228,
  2.201,
  2.179,
  2.16,
  2.145,
  2.131,
  2.12,
  2.11,
  2.101,
  2.093,
  2.086,
  2.08,
  2.074,
  2.069,
  2.064,
  2.06,
  2.056,
  2.052,
  2.048,
  2.045,
];

const round = (value) => Number(value.toFixed(6));

export const summarizeValues = (values) => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const count = sorted.length;
  const mean = sorted.reduce((sum, value) => sum + value, 0) / count;
  const middle = Math.floor(count / 2);
  const median =
    count % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle];
  const variance =
    count < 2
      ? 0
      : sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
        (count - 1);
  const stdDev = Math.sqrt(variance);
  const critical =
    count < 2
      ? 0
      : count <= 30
        ? studentTCritical95[count - 1]
        : 1.96;
  const margin = critical * (stdDev / Math.sqrt(count));
  return {
    count,
    mean: round(mean),
    median: round(median),
    min: round(sorted[0]),
    max: round(sorted.at(-1)),
    stdDev: round(stdDev),
    ci95: [round(mean - margin), round(mean + margin)],
  };
};

const collectNumericMetrics = (value, prefix = "", output = new Map()) => {
  for (const [key, child] of Object.entries(value ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof child === "number" && Number.isFinite(child)) {
      const values = output.get(path) ?? [];
      values.push(child);
      output.set(path, values);
    } else if (child !== null && typeof child === "object") {
      collectNumericMetrics(child, path, output);
    }
  }
  return output;
};

export const aggregateResults = (scenario, results, failedRuns, attemptedRuns) => {
  const metricValues = new Map();
  for (const result of results) {
    collectNumericMetrics(result.metrics, "", metricValues);
  }
  const metrics = Object.fromEntries(
    [...metricValues.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, values]) => [name, summarizeValues(values)]),
  );
  const first = results[0];
  return {
    schemaVersion: 2,
    aggregateVersion: 1,
    scenario,
    provenance: first?.provenance ?? null,
    runs: attemptedRuns,
    failedRuns,
    metrics,
    perRun: first
      ? {
          generatedAt: { value: first.generatedAt, note: "per-run" },
          executedAt: {
            value: first.provenance?.executedAt ?? null,
            note: "per-run",
          },
          randomSeed: {
            value: first.provenance?.randomSeed ?? first.scenario?.randomSeed,
            note: "per-run",
          },
        }
      : {},
  };
};

const markdownSummary = (aggregate) => {
  const lines = [
    `# Benchmark summary: ${aggregate.scenario.name}`,
    "",
    `- Attempted runs: ${aggregate.runs}`,
    `- Successful runs: ${aggregate.runs - aggregate.failedRuns.length}`,
    `- Failed runs: ${aggregate.failedRuns.length}`,
    "",
    "| Metric | Count | Mean | Median | Min | Max | Std dev | 95% CI |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const [name, summary] of Object.entries(aggregate.metrics)) {
    lines.push(
      `| ${name} | ${summary.count} | ${summary.mean} | ${summary.median} | ` +
        `${summary.min} | ${summary.max} | ${summary.stdDev} | ` +
        `[${summary.ci95[0]}, ${summary.ci95[1]}] |`,
    );
  }
  if (aggregate.failedRuns.length > 0) {
    lines.push("", "## Failed runs", "");
    for (const failed of aggregate.failedRuns) {
      lines.push(`- Run ${failed.run}: ${failed.error.replaceAll("\n", " ")}`);
    }
  }
  return `${lines.join("\n")}\n`;
};

const csvCell = (value) => {
  const text = String(value);
  return /[",\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

const csvSummary = (aggregate) => {
  const rows = [
    [
      "metric",
      "count",
      "mean",
      "median",
      "min",
      "max",
      "stdDev",
      "ci95Low",
      "ci95High",
    ],
  ];
  for (const [name, summary] of Object.entries(aggregate.metrics)) {
    rows.push([
      name,
      summary.count,
      summary.mean,
      summary.median,
      summary.min,
      summary.max,
      summary.stdDev,
      summary.ci95[0],
      summary.ci95[1],
    ]);
  }
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
};

const timestampForFilename = (date = new Date()) =>
  date.toISOString().replace(/\.\d{3}Z$/u, "Z").replaceAll(":", "-");

const readScenario = (scenarioArgument) => {
  const scenarioPath = resolve(scenarioArgument);
  let scenario;
  try {
    scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read scenario '${scenarioArgument}': ${error.message}`);
  }
  if (scenario === null || typeof scenario !== "object" || Array.isArray(scenario)) {
    throw new Error("Scenario must contain a JSON object");
  }
  if (typeof scenario.name !== "string" || !/^[a-z0-9][a-z0-9-]*$/u.test(scenario.name)) {
    throw new Error("Scenario name must be a non-empty kebab-case string");
  }
  const repetitionCount = scenario.repetitionCount ?? 1;
  if (!Number.isSafeInteger(repetitionCount) || repetitionCount < 1) {
    throw new Error("Scenario repetitionCount must be a positive integer");
  }
  return { scenario, scenarioPath, repetitionCount };
};

const runBenchmark = (scenarioPath, outputPath, runNumber) =>
  new Promise((resolveRun) => {
    const child = spawn(
      "bash",
      [
        benchmarkScript,
        "--scenario",
        scenarioPath,
        "--output",
        outputPath,
      ],
      {
        cwd: rootDirectory,
        env: {
          ...process.env,
          BENCHMARK_PROJECT_NAME:
            process.env.BENCHMARK_PROJECT_NAME ??
            `openstreamgrid-benchmark-suite-${process.pid}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let errorOutput = "";
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      errorOutput = `${errorOutput}${chunk}`.slice(-20_000);
    });
    child.on("error", (error) => {
      resolveRun({ error: error.message, exitCode: null, run: runNumber });
    });
    child.on("close", (exitCode, signal) => {
      if (exitCode === 0) {
        resolveRun({ exitCode, run: runNumber });
        return;
      }
      const detail = errorOutput.trim();
      const reason =
        exitCode === null
          ? `terminated by ${signal ?? "an unknown signal"}`
          : `exited with code ${exitCode}`;
      resolveRun({
        error: detail ? `${reason}: ${detail}` : reason,
        exitCode,
        run: runNumber,
      });
    });
  });

const main = async () => {
  const arguments_ = process.argv.slice(2);
  if (arguments_.includes("--help")) {
    console.log(HELP);
    return;
  }
  if (arguments_.length !== 1 || arguments_[0].startsWith("--")) {
    throw new Error(HELP.trim());
  }

  const { scenario, scenarioPath, repetitionCount } = readScenario(arguments_[0]);
  const timestamp = timestampForFilename();
  const prefix = `${scenario.name}-${timestamp}`;
  const aggregatePath = resolve(
    defaultResultsDirectory,
    `${prefix}-aggregate.json`,
  );
  const markdownPath = resolve(
    defaultResultsDirectory,
    `${prefix}-summary.md`,
  );
  const csvPath = resolve(defaultResultsDirectory, `${prefix}-summary.csv`);
  const runPaths = Array.from({ length: repetitionCount }, (_, index) =>
    resolve(
      defaultResultsDirectory,
      `${prefix}-run-${String(index + 1).padStart(3, "0")}.json`,
    ),
  );
  for (const path of [...runPaths, aggregatePath, markdownPath, csvPath]) {
    if (existsSync(path)) {
      throw new Error(`Refusing to overwrite existing benchmark output '${path}'`);
    }
  }
  mkdirSync(defaultResultsDirectory, { recursive: true });

  const results = [];
  const failedRuns = [];
  for (let index = 0; index < repetitionCount; index += 1) {
    const runNumber = index + 1;
    console.log(`[BenchmarkSuite] Starting run ${runNumber}/${repetitionCount}`);
    const outcome = await runBenchmark(
      scenarioPath,
      runPaths[index],
      runNumber,
    );
    if (outcome.error) {
      failedRuns.push({
        run: runNumber,
        outputFile: runPaths[index],
        error: outcome.error,
      });
      continue;
    }
    try {
      const result = JSON.parse(readFileSync(runPaths[index], "utf8"));
      if (result.schemaVersion !== 2) {
        throw new Error(`unsupported schemaVersion ${result.schemaVersion}`);
      }
      results.push(result);
    } catch (error) {
      failedRuns.push({
        run: runNumber,
        outputFile: runPaths[index],
        error: `Unable to collect result: ${error.message}`,
      });
    }
  }

  const aggregate = aggregateResults(
    scenario,
    results,
    failedRuns,
    repetitionCount,
  );
  writeFileSync(aggregatePath, `${JSON.stringify(aggregate, null, 2)}\n`);
  writeFileSync(markdownPath, markdownSummary(aggregate));
  writeFileSync(csvPath, csvSummary(aggregate));
  console.log(`[BenchmarkSuite] Aggregate: ${aggregatePath}`);
  console.log(`[BenchmarkSuite] Markdown: ${markdownPath}`);
  console.log(`[BenchmarkSuite] CSV: ${csvPath}`);
  if (failedRuns.length > 0) process.exitCode = 1;
};

if (resolve(process.argv[1] ?? "") === scriptPath) {
  main().catch((error) => {
    console.error(`[BenchmarkSuite] ERROR: ${error.message}`);
    process.exitCode = 1;
  });
}
