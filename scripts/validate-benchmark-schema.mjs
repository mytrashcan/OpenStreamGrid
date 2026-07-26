#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(
  scriptDirectory,
  "../benchmarks/schema/benchmark-scenario.schema.json",
);

const typeMatches = (value, type) => {
  switch (type) {
    case "array":
      return Array.isArray(value);
    case "integer":
      return Number.isSafeInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    default:
      return typeof value === type;
  }
};

const validateValue = (value, schema, path, errors) => {
  if (schema.type && !typeMatches(value, schema.type)) {
    errors.push(`${path} must be of type ${schema.type}`);
    return;
  }

  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path} must equal ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path} must be one of ${schema.enum.map(JSON.stringify).join(", ")}`);
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path} must be at least ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path} must be at most ${schema.maximum}`);
    }
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
      errors.push(`${path} must be greater than ${schema.exclusiveMinimum}`);
    }
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
      errors.push(`${path} must be less than ${schema.exclusiveMaximum}`);
    }
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path} must contain at least ${schema.minLength} character(s)`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path} must contain at most ${schema.maxLength} character(s)`);
    }
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) {
      errors.push(`${path} must match ${schema.pattern}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path} must contain at least ${schema.minItems} item(s)`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${path} must contain at most ${schema.maxItems} item(s)`);
    }
    if (schema.uniqueItems) {
      const serialized = value.map((item) => JSON.stringify(item));
      if (new Set(serialized).size !== serialized.length) {
        errors.push(`${path} must not contain duplicate items`);
      }
    }
    if (schema.items) {
      value.forEach((item, index) => {
        validateValue(item, schema.items, `${path}[${index}]`, errors);
      });
    }
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(`${path}.${key} is required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties ?? {}, key)) {
          errors.push(`${path}.${key} is not allowed`);
        }
      }
    }
    for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) {
        validateValue(value[key], propertySchema, `${path}.${key}`, errors);
      }
    }
  }
};

const main = () => {
  const scenarioArgument = process.argv[2];
  if (!scenarioArgument || process.argv.length !== 3) {
    console.error(
      "Usage: node scripts/validate-benchmark-schema.mjs <scenario.json>",
    );
    process.exitCode = 1;
    return;
  }

  try {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    const scenarioPath = resolve(scenarioArgument);
    const scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));
    const errors = [];
    validateValue(scenario, schema, "$", errors);
    if (errors.length > 0) {
      console.error(`Invalid benchmark scenario: ${scenarioArgument}`);
      for (const error of errors) console.error(`- ${error}`);
      process.exitCode = 1;
      return;
    }
    console.log(`Valid benchmark scenario: ${scenarioArgument}`);
  } catch (error) {
    console.error(
      `Unable to validate benchmark scenario '${scenarioArgument}': ${error.message}`,
    );
    process.exitCode = 1;
  }
};

main();
