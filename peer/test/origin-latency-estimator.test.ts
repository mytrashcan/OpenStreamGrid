import assert from "node:assert/strict";
import test from "node:test";
import { OriginLatencyEstimator } from "../src/origin-latency-estimator.js";

test("starts with the default Origin latency estimate", () => {
  assert.equal(new OriginLatencyEstimator().estimateMs, 500);
});

test("updates the estimate with an exponentially weighted moving average", () => {
  const estimator = new OriginLatencyEstimator();

  estimator.observe(1_000);

  assert.equal(estimator.estimateMs, 650);
});

test("bounds observations and the initial estimate", () => {
  const estimator = new OriginLatencyEstimator({
    initialEstimateMs: 20_000,
    alpha: 1,
  });

  assert.equal(estimator.estimateMs, 10_000);
  estimator.observe(0);
  assert.equal(estimator.estimateMs, 50);
  estimator.observe(20_000);
  assert.equal(estimator.estimateMs, 10_000);
});

test("reset restores the bounded initial estimate", () => {
  const estimator = new OriginLatencyEstimator({
    initialEstimateMs: 750,
  });
  estimator.observe(2_000);

  estimator.reset();

  assert.equal(estimator.estimateMs, 750);
});
