import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isFiniteNumber = (value) =>
  typeof value === "number" && Number.isFinite(value);

const scenarioFields = {
  $schema: "string",
  scenarioVersion: "integer",
  name: "string",
  description: "string",
  peerCount: "integer",
  durationSeconds: "number",
  rampUpSeconds: "number",
  churnProbability: "number",
  p2pEnabled: "boolean",
  quality: "string",
  segmentDurationSeconds: "number",
  uploadBandwidthLimit: "number",
  concurrentUploadLimit: "integer",
  p2pTimeoutMs: "integer",
  randomSeed: "integer",
  repetitionCount: "integer",
  tags: "array",
};

const matchesType = (value, type) => {
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return Number.isSafeInteger(value);
  if (type === "number") return isFiniteNumber(value);
  return typeof value === type;
};

export const validateScenarioDocument = (scenario) => {
  const errors = [];
  if (!isObject(scenario)) return ["scenario must be a JSON object"];

  for (const [field, type] of Object.entries(scenarioFields)) {
    if (!Object.hasOwn(scenario, field)) {
      errors.push(`${field} is required`);
    } else if (!matchesType(scenario[field], type)) {
      errors.push(`${field} must be of type ${type}`);
    }
  }
  for (const field of Object.keys(scenario)) {
    if (!Object.hasOwn(scenarioFields, field)) {
      errors.push(`${field} is not allowed`);
    }
  }
  if (errors.length > 0) return errors;

  if (scenario.scenarioVersion !== 1) {
    errors.push("scenarioVersion must equal 1");
  }
  if (
    scenario.name.length > 80 ||
    !/^[a-z0-9][a-z0-9-]*$/u.test(scenario.name)
  ) {
    errors.push("name must be a kebab-case identifier");
  }
  if (scenario.description.length === 0 || scenario.description.length > 500) {
    errors.push("description must contain between 1 and 500 characters");
  }
  if (!/benchmark-scenario\.schema\.json$/u.test(scenario.$schema)) {
    errors.push("$schema must reference benchmark-scenario.schema.json");
  }
  if (scenario.peerCount < 1 || scenario.peerCount > 10_000) {
    errors.push("peerCount must be between 1 and 10000");
  }
  if (scenario.durationSeconds <= 0 || scenario.durationSeconds > 86_400) {
    errors.push("durationSeconds must be greater than 0 and at most 86400");
  }
  if (scenario.rampUpSeconds < 0 || scenario.rampUpSeconds > 86_400) {
    errors.push("rampUpSeconds must be between 0 and 86400");
  }
  if (scenario.churnProbability < 0 || scenario.churnProbability > 1) {
    errors.push("churnProbability must be between 0 and 1");
  }
  if (!["low", "med", "high"].includes(scenario.quality)) {
    errors.push("quality must be low, med, or high");
  }
  if (
    scenario.segmentDurationSeconds <= 0 ||
    scenario.segmentDurationSeconds > 60
  ) {
    errors.push("segmentDurationSeconds must be greater than 0 and at most 60");
  }
  if (
    scenario.uploadBandwidthLimit <= 0 ||
    scenario.uploadBandwidthLimit > 100_000
  ) {
    errors.push(
      "uploadBandwidthLimit must be greater than 0 and at most 100000",
    );
  }
  if (
    scenario.concurrentUploadLimit < 1 ||
    scenario.concurrentUploadLimit > 10_000
  ) {
    errors.push("concurrentUploadLimit must be between 1 and 10000");
  }
  if (scenario.p2pTimeoutMs < 1 || scenario.p2pTimeoutMs > 600_000) {
    errors.push("p2pTimeoutMs must be between 1 and 600000");
  }
  if (scenario.randomSeed < 0 || scenario.randomSeed > 0xFFFFFFFF) {
    errors.push("randomSeed must be an unsigned 32-bit integer");
  }
  if (scenario.repetitionCount < 1 || scenario.repetitionCount > 1_000) {
    errors.push("repetitionCount must be between 1 and 1000");
  }
  if (
    scenario.tags.length === 0 ||
    scenario.tags.length > 20 ||
    scenario.tags.some(
      (tag) =>
        typeof tag !== "string" ||
        tag.length > 40 ||
        !/^[a-z0-9][a-z0-9-]*$/u.test(tag),
    )
  ) {
    errors.push(
      "tags must contain between 1 and 20 unique kebab-case strings",
    );
  }
  if (new Set(scenario.tags).size !== scenario.tags.length) {
    errors.push("tags must not contain duplicates");
  }
  return errors;
};

export const parseScenarioJson = (text, label = "scenario") => {
  let scenario;
  try {
    scenario = JSON.parse(text);
  } catch (error) {
    throw new Error(`Unable to parse ${label}: ${error.message}`);
  }
  const errors = validateScenarioDocument(scenario);
  if (errors.length > 0) {
    throw new Error(`Invalid ${label}: ${errors.join("; ")}`);
  }
  return scenario;
};

export function createSeededRandom(seed) {
  let state = seed;
  return function nextRandom() {
    state |= 0;
    state = (state + 0x6D2B79F5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value =
      (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export const shuffleWithRandom = (values, random) => {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
};

export const percentile = (values, quantile) => {
  if (values.length === 0) return 0;
  if (!isFiniteNumber(quantile) || quantile < 0 || quantile > 1) {
    throw new Error("quantile must be between 0 and 1");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(sorted.length * quantile) - 1,
  );
  return sorted[Math.max(0, index)];
};

export const jainFairnessIndex = (values) => {
  if (values.length === 0) return 1;
  const sum = values.reduce((total, value) => total + value, 0);
  const sumOfSquares = values.reduce(
    (total, value) => total + value * value,
    0,
  );
  if (sumOfSquares === 0) return 1;
  return (sum * sum) / (values.length * sumOfSquares);
};

export const validateBenchmarkResult = (result) => {
  const errors = [];
  if (!isObject(result)) return ["result must be a JSON object"];
  if (result.schemaVersion !== 2) errors.push("schemaVersion must equal 2");
  if (typeof result.generatedAt !== "string") {
    errors.push("generatedAt must be a string");
  }
  for (const field of ["provenance", "scenario", "metrics", "traffic", "churn"]) {
    if (!isObject(result[field])) errors.push(`${field} must be an object`);
  }
  const requiredMetrics = [
    "p2pEfficiencyRatioPercent",
    "cdnTrafficReductionPercent",
    "p2pSuccessRatePercent",
    "originFallbackRatePercent",
    "bytesDownloadedP2P",
    "bytesDownloadedOrigin",
    "jainFairnessIndex",
  ];
  if (isObject(result.metrics)) {
    for (const metric of requiredMetrics) {
      if (!isFiniteNumber(result.metrics[metric])) {
        errors.push(`metrics.${metric} must be a finite number`);
      }
    }
    for (const percentileName of ["p50", "p95", "p99"]) {
      if (!isFiniteNumber(result.metrics.fetchLatencyMs?.[percentileName])) {
        errors.push(
          `metrics.fetchLatencyMs.${percentileName} must be a finite number`,
        );
      }
    }
  }
  return errors;
};

export const validateAggregate = (aggregate) => {
  if (!isObject(aggregate)) throw new Error("Aggregate must be a JSON object");
  if (aggregate.schemaVersion !== 2 || aggregate.aggregateVersion !== 1) {
    throw new Error(
      "Expected schemaVersion 2 and aggregateVersion 1",
    );
  }
  if (!isObject(aggregate.scenario) || typeof aggregate.scenario.name !== "string") {
    throw new Error("Aggregate scenario.name must be a string");
  }
  if (!isObject(aggregate.metrics)) {
    throw new Error("Aggregate metrics must be an object");
  }
  return aggregate;
};

export const readAggregateFile = (argument) => {
  const path = resolve(argument);
  let aggregate;
  try {
    aggregate = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read aggregate '${argument}': ${error.message}`);
  }
  return { aggregate: validateAggregate(aggregate), path };
};

export const metricSummary = (aggregate, name, group = "metrics") => {
  const summary = aggregate[group]?.[name];
  if (
    !isObject(summary) ||
    !isFiniteNumber(summary.mean) ||
    !Array.isArray(summary.ci95) ||
    summary.ci95.length !== 2 ||
    !summary.ci95.every(isFiniteNumber)
  ) {
    return undefined;
  }
  return summary;
};
