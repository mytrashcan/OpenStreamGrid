#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  metricSummary,
  readAggregateFile,
} from "./benchmark-data.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const rootDirectory = resolve(dirname(scriptPath), "..");

const HELP = `OpenStreamGrid benchmark SVG report generator

Usage:
  node scripts/benchmark-report.mjs <aggregate.json>
  node scripts/benchmark-report.mjs --output-dir <directory> <aggregate.json>

Generates four self-contained SVG charts. By default, reports are written to:
  benchmarks/reports/<scenario-name>-<timestamp>/
`;

const WIDTH = 960;
const HEIGHT = 600;
const DISCLAIMER = "Not a production capacity claim";
const palette = {
  background: "#F8FAFC",
  card: "#FFFFFF",
  grid: "#CBD5E1",
  text: "#0F172A",
  muted: "#475569",
  p2p: "#0F766E",
  origin: "#2563EB",
  failure: "#DC2626",
  latency: "#7C3AED",
  fairness: "#D97706",
};

const escapeXml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const formatNumber = (value, maximumFractionDigits = 2) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(value);

const formatBytes = (value) => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value;
  let unit = units[0];
  for (let index = 1; index < units.length && amount >= 1_000; index += 1) {
    amount /= 1_000;
    unit = units[index];
  }
  return `${formatNumber(amount)} ${unit}`;
};

const svgFrame = (scenarioName, chartTitle, content, description = "") => `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-labelledby="title description">
  <title id="title">${escapeXml(scenarioName)} — ${escapeXml(chartTitle)}</title>
  <desc id="description">${escapeXml(description || chartTitle)}</desc>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${palette.background}"/>
  <rect x="32" y="28" width="896" height="536" rx="18" fill="${palette.card}" stroke="${palette.grid}"/>
  <text x="64" y="76" fill="${palette.text}" font-family="Arial, sans-serif" font-size="18" font-weight="700">${escapeXml(scenarioName)}</text>
  <text x="64" y="111" fill="${palette.text}" font-family="Arial, sans-serif" font-size="28" font-weight="700">${escapeXml(chartTitle)}</text>
${content}
  <line x1="64" y1="526" x2="896" y2="526" stroke="${palette.grid}"/>
  <text x="64" y="550" fill="${palette.muted}" font-family="Arial, sans-serif" font-size="14">${DISCLAIMER}</text>
</svg>
`;

const unavailableChart = (scenarioName, chartTitle, detail) =>
  svgFrame(
    scenarioName,
    chartTitle,
    `  <text x="480" y="315" text-anchor="middle" fill="${palette.muted}" font-family="Arial, sans-serif" font-size="18">Data unavailable in this aggregate</text>
  <text x="480" y="345" text-anchor="middle" fill="${palette.muted}" font-family="Arial, sans-serif" font-size="14">${escapeXml(detail)}</text>`,
    detail,
  );

const verticalBarChart = ({
  scenarioName,
  title,
  values,
  formatter,
  description,
}) => {
  if (values.some((entry) => entry.value === undefined)) {
    return unavailableChart(
      scenarioName,
      title,
      "Run the current benchmark suite to populate all required metrics.",
    );
  }

  const plot = { left: 120, top: 160, width: 720, height: 280 };
  const maximum = Math.max(...values.map((entry) => entry.value), 1);
  const tickCount = 4;
  const grid = Array.from({ length: tickCount + 1 }, (_, index) => {
    const ratio = index / tickCount;
    const y = plot.top + plot.height - ratio * plot.height;
    const value = maximum * ratio;
    return `  <line x1="${plot.left}" y1="${y}" x2="${plot.left + plot.width}" y2="${y}" stroke="${palette.grid}" stroke-dasharray="${index === 0 ? "0" : "4 6"}"/>
  <text x="${plot.left - 14}" y="${y + 5}" text-anchor="end" fill="${palette.muted}" font-family="Arial, sans-serif" font-size="13">${escapeXml(formatter(value))}</text>`;
  }).join("\n");
  const slotWidth = plot.width / values.length;
  const barWidth = Math.min(150, slotWidth * 0.55);
  const bars = values
    .map((entry, index) => {
      const height = (entry.value / maximum) * plot.height;
      const x = plot.left + slotWidth * index + (slotWidth - barWidth) / 2;
      const y = plot.top + plot.height - height;
      return `  <rect x="${x}" y="${y}" width="${barWidth}" height="${height}" rx="8" fill="${entry.color}"/>
  <text x="${x + barWidth / 2}" y="${Math.max(plot.top - 10, y - 12)}" text-anchor="middle" fill="${palette.text}" font-family="Arial, sans-serif" font-size="15" font-weight="700">${escapeXml(formatter(entry.value))}</text>
  <text x="${x + barWidth / 2}" y="${plot.top + plot.height + 30}" text-anchor="middle" fill="${palette.text}" font-family="Arial, sans-serif" font-size="14">${escapeXml(entry.label)}</text>`;
    })
    .join("\n");
  return svgFrame(
    scenarioName,
    title,
    `${grid}\n${bars}`,
    description,
  );
};

const requestOutcomesChart = (aggregate) => {
  const scenarioName = aggregate.scenario.name;
  const values = [
    {
      label: "P2P successes",
      value: metricSummary(aggregate, "p2pSuccesses", "traffic")?.mean,
      color: palette.p2p,
    },
    {
      label: "Origin requests",
      value: metricSummary(aggregate, "originRequests", "traffic")?.mean,
      color: palette.origin,
    },
    {
      label: "P2P failures",
      value: metricSummary(aggregate, "p2pFailures", "traffic")?.mean,
      color: palette.failure,
    },
  ];
  if (values.some((entry) => entry.value === undefined)) {
    return unavailableChart(
      scenarioName,
      "Request outcomes",
      "Traffic counters require an aggregate generated by the current suite.",
    );
  }
  const total = values.reduce((sum, entry) => sum + entry.value, 0);
  const left = 100;
  const top = 220;
  const width = 760;
  let offset = 0;
  const segments =
    total === 0
      ? `  <rect x="${left}" y="${top}" width="${width}" height="76" rx="12" fill="${palette.grid}"/>
  <text x="480" y="267" text-anchor="middle" fill="${palette.muted}" font-family="Arial, sans-serif" font-size="16">No requests recorded</text>`
      : values
          .map((entry) => {
            const segmentWidth = (entry.value / total) * width;
            const x = left + offset;
            offset += segmentWidth;
            return `  <rect x="${x}" y="${top}" width="${segmentWidth}" height="76" fill="${entry.color}"/>`;
          })
          .join("\n");
  const legend = values
    .map(
      (entry, index) => `  <rect x="${left + index * 250}" y="342" width="16" height="16" rx="3" fill="${entry.color}"/>
  <text x="${left + 24 + index * 250}" y="355" fill="${palette.text}" font-family="Arial, sans-serif" font-size="14">${escapeXml(entry.label)}: ${formatNumber(entry.value)}</text>`,
    )
    .join("\n");
  return svgFrame(
    scenarioName,
    "Request outcomes",
    `${segments}\n${legend}
  <text x="100" y="406" fill="${palette.muted}" font-family="Arial, sans-serif" font-size="13">Counters are not mutually exclusive: a failed P2P attempt may lead to an Origin request.</text>`,
    "Mean P2P successes, Origin requests, and P2P failures across completed runs.",
  );
};

const fairnessChart = (aggregate) => {
  const scenarioName = aggregate.scenario.name;
  const fairness = metricSummary(aggregate, "jainFairnessIndex")?.mean;
  if (fairness === undefined) {
    return unavailableChart(
      scenarioName,
      "Peer upload fairness",
      "Jain's fairness index is missing from this aggregate.",
    );
  }
  const bounded = Math.min(1, Math.max(0, fairness));
  const left = 140;
  const width = 680;
  return svgFrame(
    scenarioName,
    "Peer upload fairness",
    `  <text x="480" y="218" text-anchor="middle" fill="${palette.text}" font-family="Arial, sans-serif" font-size="64" font-weight="700">${formatNumber(fairness, 4)}</text>
  <text x="480" y="252" text-anchor="middle" fill="${palette.muted}" font-family="Arial, sans-serif" font-size="15">Jain&apos;s fairness index (0 to 1; higher is fairer)</text>
  <rect x="${left}" y="304" width="${width}" height="42" rx="21" fill="${palette.grid}"/>
  <rect x="${left}" y="304" width="${width * bounded}" height="42" rx="21" fill="${palette.fairness}"/>
  <text x="${left}" y="376" fill="${palette.muted}" font-family="Arial, sans-serif" font-size="13">0</text>
  <text x="${left + width}" y="376" text-anchor="end" fill="${palette.muted}" font-family="Arial, sans-serif" font-size="13">1</text>`,
    "Mean Jain's fairness index for peer upload bytes.",
  );
};

const timestampForDirectory = (date = new Date()) =>
  date.toISOString().replaceAll(":", "-").replaceAll(".", "-");

const parseArguments = (arguments_) => {
  if (arguments_.includes("--help")) return { help: true };
  let outputDirectory;
  const files = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    if (arguments_[index] === "--output-dir") {
      outputDirectory = arguments_[index + 1];
      if (!outputDirectory || outputDirectory.startsWith("--")) {
        throw new Error("Option '--output-dir' requires a value");
      }
      index += 1;
    } else if (arguments_[index].startsWith("--")) {
      throw new Error(`Unknown option '${arguments_[index]}'`);
    } else {
      files.push(arguments_[index]);
    }
  }
  if (files.length !== 1) throw new Error(HELP.trim());
  return { aggregateFile: files[0], outputDirectory };
};

const main = () => {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }
  const { aggregate } = readAggregateFile(options.aggregateFile);
  const scenarioName = aggregate.scenario.name;
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(scenarioName)) {
    throw new Error("Scenario name must be a kebab-case identifier");
  }
  const outputDirectory = options.outputDirectory
    ? resolve(options.outputDirectory)
    : resolve(
        rootDirectory,
        "benchmarks/reports",
        `${scenarioName}-${timestampForDirectory()}`,
      );
  mkdirSync(outputDirectory, { recursive: true });

  const charts = new Map([
    [
      "cdn-vs-p2p-traffic.svg",
      verticalBarChart({
        scenarioName,
        title: "CDN vs P2P traffic",
        values: [
          {
            label: "P2P download",
            value: metricSummary(aggregate, "bytesDownloadedP2P")?.mean,
            color: palette.p2p,
          },
          {
            label: "Origin download",
            value: metricSummary(aggregate, "bytesDownloadedOrigin")?.mean,
            color: palette.origin,
          },
        ],
        formatter: formatBytes,
        description: "Mean bytes downloaded from peers and the Origin.",
      }),
    ],
    [
      "latency-percentiles.svg",
      verticalBarChart({
        scenarioName,
        title: "Fetch latency percentiles",
        values: ["p50", "p95", "p99"].map((percentileName) => ({
          label: percentileName,
          value: metricSummary(
            aggregate,
            `fetchLatencyMs.${percentileName}`,
          )?.mean,
          color: palette.latency,
        })),
        formatter: (value) => `${formatNumber(value)} ms`,
        description: "Mean fetch-latency percentiles across completed runs.",
      }),
    ],
    ["request-outcomes.svg", requestOutcomesChart(aggregate)],
    ["peer-upload-fairness.svg", fairnessChart(aggregate)],
  ]);
  for (const [filename, content] of charts) {
    writeFileSync(resolve(outputDirectory, filename), content);
  }
  console.log(`[BenchmarkReport] Report directory: ${outputDirectory}`);
  for (const filename of charts.keys()) {
    console.log(`[BenchmarkReport] Created: ${resolve(outputDirectory, filename)}`);
  }
};

if (resolve(process.argv[1] ?? "") === scriptPath) {
  try {
    main();
  } catch (error) {
    console.error(`[BenchmarkReport] ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}
