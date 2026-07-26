#!/usr/bin/env node

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DeadlineAwareScheduler as NodeDeadlineAwareScheduler } from "../peer/dist/deadline-aware-scheduler.js";
import { OriginLatencyEstimator } from "../peer/dist/origin-latency-estimator.js";
import { WeightedScoreScheduler } from "../peer/dist/weighted-score-scheduler.js";
import {
  DeadlineAwareScheduler as BrowserDeadlineAwareScheduler,
  TrustLatencyProbeScheduler,
} from "../sdk/dist/sdk.js";

const scriptPath = fileURLToPath(import.meta.url);
const rootDirectory = resolve(dirname(scriptPath), "..");
const defaultResultsDirectory = resolve(
  rootDirectory,
  "benchmarks/scheduler-lab/results",
);

const DEADLINE_KINDS = new Set([
  "player-derived",
  "playlist-derived",
  "synthetic",
  "unknown",
]);
const POLICY_ORDER = [
  "Node-legacy",
  "Node-deadline-aware",
  "Browser-legacy",
  "Browser-deadline-aware",
];

const HELP = `OpenStreamGrid Phase 3 scheduler lab

Usage:
  node scripts/benchmark-scheduler.mjs <scenario.json>

Build the project first. The scenario's fixed seed controls every simulated
request. Results are written below benchmarks/scheduler-lab/results/.
`;

const clamp = (value, minimum, maximum) =>
  Math.min(maximum, Math.max(minimum, value));

const round = (value, digits = 3) =>
  Number(Number(value).toFixed(digits));

const requireNumber = (
  value,
  name,
  { minimum = 0, integer = false, maximum = Number.POSITIVE_INFINITY } = {},
) => {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum ||
    (integer && !Number.isSafeInteger(value))
  ) {
    throw new Error(
      `${name} must be ${integer ? "an integer" : "a number"} between ${minimum} and ${maximum}`,
    );
  }
  return value;
};

const normalizedDeadlineMix = (scenario) => {
  const mix =
    scenario.deadlineMix ??
    [
      {
        kind: scenario.deadlineKind ?? "synthetic",
        slackMs: scenario.slackMs,
        weight: 1,
      },
    ];
  if (!Array.isArray(mix) || mix.length === 0) {
    throw new Error("deadlineMix must be a non-empty array");
  }
  return mix.map((deadline, index) => {
    if (
      deadline === null ||
      typeof deadline !== "object" ||
      Array.isArray(deadline)
    ) {
      throw new Error(`deadlineMix[${index}] must be an object`);
    }
    if (!DEADLINE_KINDS.has(deadline.kind)) {
      throw new Error(`deadlineMix[${index}].kind is not supported`);
    }
    return {
      kind: deadline.kind,
      slackMs: requireNumber(
        deadline.slackMs,
        `deadlineMix[${index}].slackMs`,
      ),
      weight: requireNumber(
        deadline.weight ?? 1,
        `deadlineMix[${index}].weight`,
        { minimum: Number.EPSILON },
      ),
    };
  });
};

const readScenario = (scenarioArgument) => {
  const scenarioPath = resolve(scenarioArgument);
  let scenario;
  try {
    scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Unable to read scenario '${scenarioArgument}': ${error.message}`,
    );
  }
  if (
    scenario === null ||
    typeof scenario !== "object" ||
    Array.isArray(scenario)
  ) {
    throw new Error("Scenario must contain a JSON object");
  }
  if (
    typeof scenario.name !== "string" ||
    !/^[a-z0-9][a-z0-9-]*$/u.test(scenario.name)
  ) {
    throw new Error("Scenario name must be non-empty kebab-case");
  }
  if (
    typeof scenario.seed !== "string" &&
    typeof scenario.seed !== "number"
  ) {
    throw new Error("Scenario seed must be a string or number");
  }

  const validated = {
    ...scenario,
    requestCount: requireNumber(
      scenario.requestCount ?? 240,
      "requestCount",
      { minimum: 1, integer: true },
    ),
    originLatencyMs: requireNumber(
      scenario.originLatencyMs ?? 700,
      "originLatencyMs",
    ),
    originJitterMs: requireNumber(
      scenario.originJitterMs ?? 0,
      "originJitterMs",
    ),
    peerLatencyMs: requireNumber(
      scenario.peerLatencyMs ?? 900,
      "peerLatencyMs",
    ),
    peerLatencyJitterMs: requireNumber(
      scenario.peerLatencyJitterMs ?? 0,
      "peerLatencyJitterMs",
    ),
    peerSuccessRate: requireNumber(
      scenario.peerSuccessRate ?? 0.9,
      "peerSuccessRate",
      { maximum: 1 },
    ),
    peerCount: requireNumber(scenario.peerCount ?? 5, "peerCount", {
      minimum: 1,
      integer: true,
    }),
    maximumParallelism: requireNumber(
      scenario.maximumParallelism ?? 3,
      "maximumParallelism",
      { minimum: 1, integer: true },
    ),
    peerTimeoutMs: requireNumber(
      scenario.peerTimeoutMs ?? 3000,
      "peerTimeoutMs",
      { minimum: 1 },
    ),
    segmentBytes: requireNumber(
      scenario.segmentBytes ?? 1_000_000,
      "segmentBytes",
      { minimum: 1, integer: true },
    ),
  };
  validated.deadlineMix = normalizedDeadlineMix(validated);
  return { scenario: validated, scenarioPath };
};

// Dependency-free seedrandom-style generator. A SHA-256 seed expansion and
// sfc32 state transition keep results stable without adding an npm package.
const seedrandom = (seed) => {
  const digest = createHash("sha256").update(String(seed)).digest();
  let a = digest.readUInt32LE(0);
  let b = digest.readUInt32LE(4);
  let c = digest.readUInt32LE(8);
  let d = digest.readUInt32LE(12);
  return () => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    const result = (a + b + d) >>> 0;
    d = (d + 1) >>> 0;
    a = (b ^ (b >>> 9)) >>> 0;
    b = (c + (c << 3)) >>> 0;
    c = ((c << 21) | (c >>> 11)) >>> 0;
    c = (c + result) >>> 0;
    return result / 4_294_967_296;
  };
};

const varied = (random, center, jitter, minimum = 1) =>
  Math.max(
    minimum,
    center + (random() + random() - 1) * jitter,
  );

const selectDeadline = (random, mix) => {
  const totalWeight = mix.reduce(
    (sum, deadline) => sum + deadline.weight,
    0,
  );
  let selection = random() * totalWeight;
  for (const deadline of mix) {
    selection -= deadline.weight;
    if (selection <= 0) return deadline;
  }
  return mix.at(-1);
};

const generateRequests = (scenario) => {
  const random = seedrandom(scenario.seed);
  const requests = [];
  for (let requestIndex = 0; requestIndex < scenario.requestCount; requestIndex += 1) {
    const segmentId = `segment-${String(requestIndex).padStart(4, "0")}.ts`;
    const deadline = selectDeadline(random, scenario.deadlineMix);
    const peers = [];
    for (let peerIndex = 0; peerIndex < scenario.peerCount; peerIndex += 1) {
      const qualityFactor = 0.72 + peerIndex * 0.11;
      const advertisedLatencyMs = varied(
        random,
        scenario.peerLatencyMs * qualityFactor,
        scenario.peerLatencyJitterMs * 0.25,
      );
      const advertisedSuccessRate = clamp(
        scenario.peerSuccessRate + (random() - 0.5) * 0.16,
        0,
        1,
      );
      const trustScore = clamp(
        0.45 + advertisedSuccessRate * 0.5 + (random() - 0.5) * 0.08,
        0,
        1,
      );
      const actualCompletionMs = varied(
        random,
        advertisedLatencyMs,
        scenario.peerLatencyJitterMs,
      );
      peers.push({
        id: `peer-${peerIndex + 1}`,
        latencyMs: round(advertisedLatencyMs),
        successRate: round(advertisedSuccessRate),
        uploadBandwidthBps: round(
          (scenario.segmentBytes * 8 * 1000) /
            Math.max(advertisedLatencyMs, 1),
        ),
        trustScore: round(trustScore),
        segments: [segmentId],
        originalIndex: peerIndex,
        actualCompletionMs: round(actualCompletionMs),
        succeeded: random() < scenario.peerSuccessRate,
      });
    }
    requests.push({
      requestIndex,
      segmentId,
      deadline: {
        kind: deadline.kind,
        slackMs: deadline.slackMs,
        segmentDurationMs: 2_000,
        bufferAheadMs: Math.max(0, deadline.slackMs - 250),
      },
      originLatencyMs: round(
        varied(
          random,
          scenario.originLatencyMs,
          scenario.originJitterMs,
        ),
      ),
      peers,
    });
  }
  return requests;
};

const policyFactories = {
  "Node-legacy": () => ({
    runtime: "node",
    scheduler: new WeightedScoreScheduler(),
  }),
  "Node-deadline-aware": () => {
    const originLatencyEstimator = new OriginLatencyEstimator();
    return {
      runtime: "node",
      originLatencyEstimator,
      scheduler: new NodeDeadlineAwareScheduler({
        baseScheduler: new WeightedScoreScheduler(),
        originLatencyEstimator,
      }),
    };
  },
  "Browser-legacy": () => ({
    runtime: "browser",
    scheduler: new TrustLatencyProbeScheduler(),
  }),
  "Browser-deadline-aware": () => {
    const originLatencyEstimator = new OriginLatencyEstimator();
    return {
      runtime: "browser",
      originLatencyEstimator,
      scheduler: new BrowserDeadlineAwareScheduler({
        baseScheduler: new TrustLatencyProbeScheduler(),
        originLatencyEstimator,
      }),
    };
  },
};

const selectedAttempts = (plan, request) => {
  const peersById = new Map(request.peers.map((peer) => [peer.id, peer]));
  return plan.peerIds
    .map((peerId) => peersById.get(peerId))
    .filter((peer) => peer !== undefined);
};

const minimumSuccessfulCompletion = (attempts) => {
  const successful = attempts
    .filter((attempt) => attempt.succeeded)
    .map((attempt) => attempt.actualCompletionMs);
  return successful.length === 0 ? null : Math.min(...successful);
};

const allAttemptsResolvedAt = (attempts, timeoutMs) => {
  if (attempts.length === 0) return 0;
  return Math.min(
    timeoutMs,
    Math.max(...attempts.map((attempt) => attempt.actualCompletionMs)),
  );
};

const simulateExecution = (
  plan,
  attempts,
  request,
  scenario,
  runtime,
) => {
  const strategy =
    plan.execution?.strategy ??
    (plan.mode === "origin" ? "origin-only" : "legacy-p2p-first");
  const hedgeDelay =
    strategy === "hedged-origin"
      ? (plan.execution?.originHedgeDelayMs ?? 0)
      : null;
  const sampledPeerCompletionMs = minimumSuccessfulCompletion(attempts);

  if (plan.mode === "origin" || strategy === "origin-only") {
    return {
      strategy,
      peerCompletionMs: null,
      originCompletionMs: request.originLatencyMs,
      hedgeDelay,
      hedgeStarted: false,
      winningSource: "origin",
      completionMs: request.originLatencyMs,
    };
  }

  if (strategy === "legacy-p2p-first") {
    if (
      sampledPeerCompletionMs !== null &&
      sampledPeerCompletionMs <= scenario.peerTimeoutMs
    ) {
      return {
        strategy,
        peerCompletionMs: sampledPeerCompletionMs,
        originCompletionMs: null,
        hedgeDelay,
        hedgeStarted: false,
        winningSource: "peer",
        completionMs: sampledPeerCompletionMs,
      };
    }
    const originStartMs = allAttemptsResolvedAt(
      attempts,
      scenario.peerTimeoutMs,
    );
    return {
      strategy,
      peerCompletionMs: sampledPeerCompletionMs,
      originCompletionMs: originStartMs + request.originLatencyMs,
      hedgeDelay,
      hedgeStarted: false,
      winningSource: "origin",
      completionMs: originStartMs + request.originLatencyMs,
    };
  }

  const peerAttemptBudgetMs = plan.execution?.peerAttemptBudgetMs;
  const effectivePeerCompletionMs =
    runtime === "node" &&
    peerAttemptBudgetMs !== undefined &&
    (sampledPeerCompletionMs === null ||
      sampledPeerCompletionMs > peerAttemptBudgetMs)
      ? null
      : sampledPeerCompletionMs;
  const allPeerAttemptsFailed =
    attempts.length > 0 && attempts.every((attempt) => !attempt.succeeded);
  const originStartMs =
    runtime === "node" && allPeerAttemptsFailed
      ? Math.min(
          hedgeDelay,
          allAttemptsResolvedAt(attempts, hedgeDelay),
        )
      : hedgeDelay;

  if (
    effectivePeerCompletionMs !== null &&
    effectivePeerCompletionMs < originStartMs
  ) {
    return {
      strategy,
      peerCompletionMs: effectivePeerCompletionMs,
      originCompletionMs: null,
      hedgeDelay,
      hedgeStarted: false,
      winningSource: "peer",
      completionMs: effectivePeerCompletionMs,
    };
  }

  const originCompletionMs = originStartMs + request.originLatencyMs;
  if (
    effectivePeerCompletionMs !== null &&
    effectivePeerCompletionMs <= originCompletionMs
  ) {
    return {
      strategy,
      peerCompletionMs: effectivePeerCompletionMs,
      originCompletionMs,
      hedgeDelay,
      hedgeStarted: true,
      winningSource: "peer",
      completionMs: effectivePeerCompletionMs,
    };
  }
  return {
    strategy,
    peerCompletionMs: effectivePeerCompletionMs,
    originCompletionMs,
    hedgeDelay,
    hedgeStarted: true,
    winningSource: "origin",
    completionMs: originCompletionMs,
  };
};

const observePolicy = (
  policy,
  attempts,
  execution,
  scenario,
  request,
) => {
  for (const attempt of attempts) {
    const attemptLimitMs =
      execution.strategy === "hedged-origin" &&
      policy.runtime === "node" &&
      execution.hedgeDelay !== null
        ? execution.hedgeDelay
        : scenario.peerTimeoutMs;
    const succeeded =
      attempt.succeeded && attempt.actualCompletionMs <= attemptLimitMs;
    policy.scheduler.observePeer?.({
      peerId: attempt.id,
      succeeded,
      latencyMs: Math.min(attempt.actualCompletionMs, attemptLimitMs),
      bytes: succeeded ? scenario.segmentBytes : 0,
      ...(succeeded ? {} : { failureReason: "transport" }),
    });
  }
  if (execution.winningSource === "origin") {
    policy.originLatencyEstimator?.observe(request.originLatencyMs);
  }
};

const runPolicies = (scenario, requests) => {
  const records = [];
  for (const policyName of POLICY_ORDER) {
    const policy = policyFactories[policyName]();
    for (const request of requests) {
      const candidates = request.peers.map(
        ({ actualCompletionMs: _actualCompletionMs, succeeded: _succeeded, ...peer }) =>
          peer,
      );
      const context = {
        segmentId: request.segmentId,
        segmentsAhead: 3,
        deadline: request.deadline,
        candidates,
        selfPeerId: "benchmark-self",
        maximumParallelism: scenario.maximumParallelism,
      };
      policy.scheduler.reconcilePeers?.(candidates);
      const plan = policy.scheduler.planSegment(context);
      const attempts = selectedAttempts(plan, request);
      const execution = simulateExecution(
        plan,
        attempts,
        request,
        scenario,
        policy.runtime,
      );
      const record = {
        requestIndex: request.requestIndex,
        segmentId: request.segmentId,
        deadlineKind: request.deadline.kind,
        deadlineSlackMs: request.deadline.slackMs,
        policy: policyName,
        mode: plan.mode,
        strategy: execution.strategy,
        reason: plan.reason,
        peerCompletionMs:
          execution.peerCompletionMs === null
            ? null
            : round(execution.peerCompletionMs),
        originCompletionMs:
          execution.originCompletionMs === null
            ? null
            : round(execution.originCompletionMs),
        hedgeDelay:
          execution.hedgeDelay === null
            ? null
            : round(execution.hedgeDelay),
        hedgeStarted: execution.hedgeStarted,
        winningSource: execution.winningSource,
        completionMs: round(execution.completionMs),
        deadlineMet:
          execution.completionMs <= request.deadline.slackMs,
      };
      records.push(record);
      observePolicy(policy, attempts, execution, scenario, request);
    }
  }
  return records;
};

const percentile = (values, percentileValue) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil((percentileValue / 100) * sorted.length) - 1;
  return sorted[clamp(index, 0, sorted.length - 1)];
};

const average = (values) =>
  values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length;

const summarizeRecords = (records) => {
  const completionValues = records.map((record) => record.completionMs);
  const peerCompletionValues = records
    .map((record) => record.peerCompletionMs)
    .filter((value) => value !== null);
  const originCompletionValues = records
    .map((record) => record.originCompletionMs)
    .filter((value) => value !== null);
  const hedgeDelayValues = records
    .map((record) => record.hedgeDelay)
    .filter((value) => value !== null);
  const count = records.length;
  const countWhere = (predicate) => records.filter(predicate).length;
  const deadlineMetCount = countWhere((record) => record.deadlineMet);
  const peerWinCount = countWhere(
    (record) => record.winningSource === "peer",
  );
  const originWinCount = count - peerWinCount;
  const hedgeStartedCount = countWhere((record) => record.hedgeStarted);
  return {
    requests: count,
    deadlineMetCount,
    deadlineMetRatePercent: round((deadlineMetCount / count) * 100),
    peerWinCount,
    peerWinRatePercent: round((peerWinCount / count) * 100),
    originWinCount,
    originWinRatePercent: round((originWinCount / count) * 100),
    hedgeStartedCount,
    hedgeStartedRatePercent: round((hedgeStartedCount / count) * 100),
    completionMs: {
      mean: round(average(completionValues)),
      p50: round(percentile(completionValues, 50)),
      p95: round(percentile(completionValues, 95)),
      p99: round(percentile(completionValues, 99)),
    },
    peerCompletionMsMean:
      peerCompletionValues.length === 0
        ? null
        : round(average(peerCompletionValues)),
    originCompletionMsMean:
      originCompletionValues.length === 0
        ? null
        : round(average(originCompletionValues)),
    hedgeDelayMsMean:
      hedgeDelayValues.length === 0
        ? null
        : round(average(hedgeDelayValues)),
  };
};

const aggregateRecords = (scenario, records, generatedAt) => {
  const policies = {};
  for (const policyName of POLICY_ORDER) {
    const policyRecords = records.filter(
      (record) => record.policy === policyName,
    );
    const deadlineKinds = {};
    for (const deadlineKind of DEADLINE_KINDS) {
      const deadlineRecords = policyRecords.filter(
        (record) => record.deadlineKind === deadlineKind,
      );
      if (deadlineRecords.length > 0) {
        deadlineKinds[deadlineKind] = summarizeRecords(deadlineRecords);
      }
    }
    policies[policyName] = {
      ...summarizeRecords(policyRecords),
      deadlineKinds,
    };
  }
  return {
    schemaVersion: 1,
    kind: "scheduler-lab-aggregate",
    generatedAt,
    scenario: {
      name: scenario.name,
      description: scenario.description ?? "",
      seed: scenario.seed,
      requestCount: scenario.requestCount,
      originLatencyMs: scenario.originLatencyMs,
      peerSuccessRate: scenario.peerSuccessRate,
      deadlineMix: scenario.deadlineMix,
    },
    policyOrder: POLICY_ORDER,
    policies,
    disclaimer:
      "Controlled deterministic scheduler simulation; not a production capacity claim.",
  };
};

const csvCell = (value) => {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/u.test(text)
    ? `"${text.replaceAll('"', '""')}"`
    : text;
};

const csvFor = (records) => {
  const columns = [
    "requestIndex",
    "segmentId",
    "deadlineKind",
    "deadlineSlackMs",
    "policy",
    "mode",
    "strategy",
    "reason",
    "peerCompletionMs",
    "originCompletionMs",
    "hedgeDelay",
    "hedgeStarted",
    "winningSource",
    "completionMs",
    "deadlineMet",
  ];
  return `${[
    columns,
    ...records.map((record) => columns.map((column) => record[column])),
  ]
    .map((row) => row.map(csvCell).join(","))
    .join("\n")}\n`;
};

const markdownFor = (aggregate) => {
  const lines = [
    `# Scheduler lab: ${aggregate.scenario.name}`,
    "",
    `- Seed: \`${aggregate.scenario.seed}\``,
    `- Requests per policy: ${aggregate.scenario.requestCount}`,
    `- Generated: ${aggregate.generatedAt}`,
    "",
    "| Policy | Deadline met | Peer wins | Origin wins | Hedges started | Completion p50 | Completion p95 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const policyName of aggregate.policyOrder) {
    const policy = aggregate.policies[policyName];
    lines.push(
      `| ${policyName} | ${policy.deadlineMetRatePercent}% | ` +
        `${policy.peerWinRatePercent}% | ${policy.originWinRatePercent}% | ` +
        `${policy.hedgeStartedRatePercent}% | ${policy.completionMs.p50} ms | ` +
        `${policy.completionMs.p95} ms |`,
    );
  }
  lines.push(
    "",
    "_Controlled deterministic scheduler simulation using production schedulers. Not a production capacity claim._",
  );
  return `${lines.join("\n")}\n`;
};

const xmlEscape = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const svgBarChart = (aggregate, metric, title, color) => {
  const width = 900;
  const height = 330;
  const chartLeft = 220;
  const chartWidth = 620;
  const rowHeight = 58;
  const bars = aggregate.policyOrder
    .map((policyName, index) => {
      const value = aggregate.policies[policyName][metric];
      const y = 70 + index * rowHeight;
      const barWidth = (value / 100) * chartWidth;
      return [
        `<text x="12" y="${y + 22}" font-size="16">${xmlEscape(policyName)}</text>`,
        `<rect x="${chartLeft}" y="${y}" width="${chartWidth}" height="28" fill="#e5e7eb" rx="4"/>`,
        `<rect x="${chartLeft}" y="${y}" width="${round(barWidth)}" height="28" fill="${color}" rx="4"/>`,
        `<text x="${chartLeft + Math.min(barWidth + 8, chartWidth - 45)}" y="${y + 20}" font-size="14">${value}%</text>`,
      ].join("\n  ");
    })
    .join("\n  ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
  <title id="title">${xmlEscape(title)}</title>
  <desc id="desc">Horizontal bars compare four scheduler policies from zero to one hundred percent.</desc>
  <rect width="${width}" height="${height}" fill="white"/>
  <text x="12" y="34" font-size="22" font-weight="600">${xmlEscape(title)}</text>
  ${bars}
  <text x="${chartLeft}" y="${height - 14}" font-size="12">0%</text>
  <text x="${chartLeft + chartWidth - 30}" y="${height - 14}" font-size="12">100%</text>
</svg>
`;
};

const timestampForFilename = (date) =>
  date.toISOString().replace(/\.\d{3}Z$/u, "Z").replaceAll(":", "-");

const safeFilenamePart = (value) =>
  String(value)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "") || "seed";

const writeResults = (
  scenario,
  scenarioPath,
  records,
  aggregate,
) => {
  const timestamp = timestampForFilename(new Date(aggregate.generatedAt));
  const runName = `${scenario.name}_${safeFilenamePart(scenario.seed)}_${timestamp}`;
  const outputDirectory = resolve(defaultResultsDirectory, runName);
  mkdirSync(outputDirectory, { recursive: true });
  const raw = {
    schemaVersion: 1,
    kind: "scheduler-lab-raw",
    generatedAt: aggregate.generatedAt,
    scenarioPath,
    scenario,
    policies: POLICY_ORDER,
    records,
    disclaimer: aggregate.disclaimer,
  };
  writeFileSync(
    resolve(outputDirectory, "raw.json"),
    `${JSON.stringify(raw, null, 2)}\n`,
  );
  writeFileSync(
    resolve(outputDirectory, "aggregate.json"),
    `${JSON.stringify(aggregate, null, 2)}\n`,
  );
  writeFileSync(resolve(outputDirectory, "results.csv"), csvFor(records));
  writeFileSync(
    resolve(outputDirectory, "report.md"),
    markdownFor(aggregate),
  );
  writeFileSync(
    resolve(outputDirectory, "deadline-met-rate.svg"),
    svgBarChart(
      aggregate,
      "deadlineMetRatePercent",
      "Deadline met rate",
      "#2563eb",
    ),
  );
  writeFileSync(
    resolve(outputDirectory, "winning-source-rate.svg"),
    svgBarChart(
      aggregate,
      "peerWinRatePercent",
      "Peer winning-source rate",
      "#059669",
    ),
  );

  const aggregateConveniencePath = resolve(
    defaultResultsDirectory,
    `${runName}_aggregate.json`,
  );
  writeFileSync(
    aggregateConveniencePath,
    `${JSON.stringify(aggregate, null, 2)}\n`,
  );
  return { aggregateConveniencePath, outputDirectory };
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

  const { scenario, scenarioPath } = readScenario(arguments_[0]);
  const requests = generateRequests(scenario);
  const records = runPolicies(scenario, requests);
  const generatedAt = new Date().toISOString();
  const aggregate = aggregateRecords(scenario, records, generatedAt);
  const { aggregateConveniencePath, outputDirectory } = writeResults(
    scenario,
    scenarioPath,
    records,
    aggregate,
  );
  console.log(`[SchedulerLab] Scenario: ${scenario.name}`);
  console.log(`[SchedulerLab] Seed: ${scenario.seed}`);
  console.log(`[SchedulerLab] Results: ${outputDirectory}`);
  console.log(`[SchedulerLab] Aggregate: ${aggregateConveniencePath}`);
};

if (resolve(process.argv[1] ?? "") === scriptPath) {
  try {
    main();
  } catch (error) {
    console.error(`[SchedulerLab] ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}
