#!/usr/bin/env node

import {
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const START_MARKER = "<!-- BENCHMARK_SCHEDULER:START -->";
const END_MARKER = "<!-- BENCHMARK_SCHEDULER:END -->";
const POLICY_ORDER = [
  "Node-legacy",
  "Node-deadline-aware",
  "Browser-legacy",
  "Browser-deadline-aware",
];

const HELP = `OpenStreamGrid scheduler benchmark README updater

Usage:
  node scripts/benchmark-update-readme-scheduler.mjs <aggregate.json...> <README.md...>

The newest scheduler-lab aggregate is selected by generatedAt. Content between
the BENCHMARK_SCHEDULER markers is replaced in every supplied README.
`;

const readAggregate = (path) => {
  let aggregate;
  try {
    aggregate = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read aggregate '${path}': ${error.message}`);
  }
  if (
    aggregate?.kind !== "scheduler-lab-aggregate" ||
    !aggregate.policies ||
    typeof aggregate.generatedAt !== "string" ||
    !Number.isFinite(Date.parse(aggregate.generatedAt))
  ) {
    throw new Error(`'${path}' is not a scheduler-lab aggregate`);
  }
  for (const policyName of POLICY_ORDER) {
    if (!aggregate.policies[policyName]) {
      throw new Error(`'${path}' is missing policy '${policyName}'`);
    }
  }
  return { aggregate, path };
};

const newestAggregate = (paths) =>
  paths
    .map(readAggregate)
    .sort(
      (left, right) =>
        Date.parse(right.aggregate.generatedAt) -
          Date.parse(left.aggregate.generatedAt) ||
        right.path.localeCompare(left.path),
    )[0].aggregate;

const format = (value, digits = 2) =>
  new Intl.NumberFormat("en-US", {
    maximumFractionDigits: digits,
  }).format(value);

const tableRows = (aggregate) =>
  POLICY_ORDER.map((policyName) => {
    const policy = aggregate.policies[policyName];
    return (
      `| ${policyName} | ${format(policy.deadlineMetRatePercent)}% | ` +
      `${format(policy.peerWinRatePercent)}% | ` +
      `${format(policy.originWinRatePercent)}% | ` +
      `${format(policy.hedgeStartedRatePercent)}% | ` +
      `${format(policy.completionMs.p50)} ms | ` +
      `${format(policy.completionMs.p95)} ms |`
    );
  });

const englishContent = (aggregate) =>
  [
    `### Phase 3 scheduler policy lab: \`${aggregate.scenario.name}\``,
    "",
    "| Policy | Deadline met | Peer wins | Origin wins | Hedges started | Completion p50 | Completion p95 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...tableRows(aggregate),
    "",
    `_Fixed seed \`${aggregate.scenario.seed}\`; ${aggregate.scenario.requestCount} deterministic requests per policy. Controlled simulation using production schedulers—not a production capacity claim. See the [scheduler lab](benchmarks/scheduler-lab/README.md)._`,
  ].join("\n");

const koreanContent = (aggregate) =>
  [
    `### Phase 3 스케줄러 정책 실험: \`${aggregate.scenario.name}\``,
    "",
    "| 정책 | 데드라인 충족 | Peer 승리 | Origin 승리 | 헤지 시작 | 완료 p50 | 완료 p95 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...tableRows(aggregate),
    "",
    `_고정 시드 \`${aggregate.scenario.seed}\`, 정책별 결정론적 요청 ${aggregate.scenario.requestCount}건. 프로덕션 스케줄러를 사용하는 통제된 시뮬레이션이며 프로덕션 수용량 주장이 아닙니다. [스케줄러 실험실](benchmarks/scheduler-lab/README.md)을 참고하세요._`,
  ].join("\n");

const updateReadme = (readmePath, aggregate) => {
  const original = readFileSync(readmePath, "utf8");
  const startIndex = original.indexOf(START_MARKER);
  const endIndex = original.indexOf(END_MARKER);
  if (
    startIndex < 0 ||
    endIndex < 0 ||
    endIndex < startIndex ||
    original.indexOf(START_MARKER, startIndex + START_MARKER.length) >= 0 ||
    original.indexOf(END_MARKER, endIndex + END_MARKER.length) >= 0
  ) {
    throw new Error(
      `'${readmePath}' must contain exactly one ordered scheduler benchmark marker pair`,
    );
  }
  const content =
    basename(readmePath) === "README.ko.md"
      ? koreanContent(aggregate)
      : englishContent(aggregate);
  const replacement = `${START_MARKER}\n${content}\n${END_MARKER}`;
  const updated =
    original.slice(0, startIndex) +
    replacement +
    original.slice(endIndex + END_MARKER.length);
  writeFileSync(readmePath, updated);
  return updated !== original;
};

const main = () => {
  const arguments_ = process.argv.slice(2);
  if (arguments_.includes("--help")) {
    console.log(HELP);
    return;
  }
  const aggregatePaths = arguments_.filter((argument) =>
    argument.endsWith(".json"),
  );
  const readmePaths = arguments_.filter((argument) =>
    argument.endsWith(".md"),
  );
  if (aggregatePaths.length === 0 || readmePaths.length === 0) {
    throw new Error(HELP.trim());
  }

  const aggregate = newestAggregate(aggregatePaths);
  for (const readmePath of readmePaths) {
    const changed = updateReadme(readmePath, aggregate);
    console.log(
      `[SchedulerReadme] ${changed ? "Updated" : "Unchanged"}: ${resolve(readmePath)}`,
    );
  }
};

if (resolve(process.argv[1] ?? "") === scriptPath) {
  try {
    main();
  } catch (error) {
    console.error(`[SchedulerReadme] ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}
