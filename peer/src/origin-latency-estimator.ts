const DEFAULT_INITIAL_ESTIMATE_MS = 500;
const DEFAULT_ALPHA = 0.3;
const DEFAULT_MIN_MS = 50;
const DEFAULT_MAX_MS = 10_000;

export interface OriginLatencyEstimatorOptions {
  initialEstimateMs?: number;
  alpha?: number;
  minMs?: number;
  maxMs?: number;
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const requireFinite = (value: number, name: string): void => {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be finite`);
  }
};

/** Maintains a bounded exponentially weighted estimate of Origin latency. */
export class OriginLatencyEstimator {
  private readonly initialEstimateMs: number;
  private readonly alpha: number;
  private readonly minMs: number;
  private readonly maxMs: number;
  private currentEstimateMs: number;

  constructor(options: OriginLatencyEstimatorOptions = {}) {
    const initialEstimateMs =
      options.initialEstimateMs ?? DEFAULT_INITIAL_ESTIMATE_MS;
    const alpha = options.alpha ?? DEFAULT_ALPHA;
    const minMs = options.minMs ?? DEFAULT_MIN_MS;
    const maxMs = options.maxMs ?? DEFAULT_MAX_MS;

    requireFinite(initialEstimateMs, "initialEstimateMs");
    requireFinite(alpha, "alpha");
    requireFinite(minMs, "minMs");
    requireFinite(maxMs, "maxMs");
    if (alpha <= 0 || alpha > 1) {
      throw new RangeError("alpha must be greater than zero and at most one");
    }
    if (minMs < 0) {
      throw new RangeError("minMs must be non-negative");
    }
    if (maxMs < minMs) {
      throw new RangeError("maxMs must be greater than or equal to minMs");
    }

    this.alpha = alpha;
    this.minMs = minMs;
    this.maxMs = maxMs;
    this.initialEstimateMs = clamp(initialEstimateMs, minMs, maxMs);
    this.currentEstimateMs = this.initialEstimateMs;
  }

  get estimateMs(): number {
    return this.currentEstimateMs;
  }

  observe(latencyMs: number): void {
    if (!Number.isFinite(latencyMs)) return;
    const boundedLatencyMs = clamp(latencyMs, this.minMs, this.maxMs);
    this.currentEstimateMs = clamp(
      this.alpha * boundedLatencyMs +
        (1 - this.alpha) * this.currentEstimateMs,
      this.minMs,
      this.maxMs,
    );
  }

  reset(): void {
    this.currentEstimateMs = this.initialEstimateMs;
  }
}
