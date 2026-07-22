import { createHash, timingSafeEqual } from "node:crypto";
import { keepAliveFetch } from "./http-client.js";

const DEFAULT_MAX_CACHED_HASHES = 2_000;
const HASH_REQUEST_TIMEOUT_MS = 5_000;

/** Contract for validating downloaded segment bytes. */
export interface SegmentIntegrityVerifier {
  verify(segmentName: string, data: Buffer): Promise<boolean>;
}

/** Fetch-compatible function signature used for dependency injection. */
export type FetchFunction = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

/** Returns the lowercase SHA-256 digest for segment bytes. */
export const sha256 = (data: Buffer): string =>
  createHash("sha256").update(data).digest("hex");

/** Parses a standard SHA-256 sidecar response. */
export const parseSha256 = (content: string): string => {
  const match = content.trim().match(/^([a-fA-F0-9]{64})(?:\s+.+)?$/);
  if (!match?.[1]) throw new Error("Invalid SHA-256 response");
  return match[1].toLowerCase();
};

/** Compares segment bytes with an expected SHA-256 digest. */
export const verifySegmentHash = (data: Buffer, expectedHash: string): boolean => {
  const actual = Buffer.from(sha256(data), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return expected.byteLength === actual.byteLength && timingSafeEqual(actual, expected);
};

/** Retrieves and caches origin sidecar hashes for segment verification. */
export class OriginHashVerifier implements SegmentIntegrityVerifier {
  private readonly hashes = new Map<string, string>();
  private readonly pendingHashes = new Map<string, Promise<string>>();

  constructor(
    private readonly originBaseUrl: URL,
    private readonly fetchImpl: FetchFunction = keepAliveFetch,
    private readonly maxCachedHashes = DEFAULT_MAX_CACHED_HASHES,
  ) {
    if (!Number.isSafeInteger(maxCachedHashes) || maxCachedHashes <= 0) {
      throw new Error("Maximum cached hashes must be a positive integer");
    }
  }

  async verify(segmentName: string, data: Buffer): Promise<boolean> {
    const expectedHash = await this.expectedHash(segmentName);
    return verifySegmentHash(data, expectedHash);
  }

  private async expectedHash(segmentName: string): Promise<string> {
    const cached = this.hashes.get(segmentName);
    if (cached) {
      this.hashes.delete(segmentName);
      this.hashes.set(segmentName, cached);
      return cached;
    }
    const pending = this.pendingHashes.get(segmentName);
    if (pending) return pending;
    const request = this.fetchHash(segmentName).finally(() => {
      if (this.pendingHashes.get(segmentName) === request) {
        this.pendingHashes.delete(segmentName);
      }
    });
    this.pendingHashes.set(segmentName, request);
    return request;
  }

  private async fetchHash(segmentName: string): Promise<string> {
    const hashUrl = new URL(
      `${encodeURIComponent(segmentName)}.sha256`,
      this.originBaseUrl,
    );
    const response = await this.fetchImpl(hashUrl, {
      signal: AbortSignal.timeout(HASH_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(
        `Failed to fetch hash for '${segmentName}': HTTP ${response.status}`,
      );
    }
    const expectedHash = parseSha256(await response.text());
    this.hashes.set(segmentName, expectedHash);
    while (this.hashes.size > this.maxCachedHashes) {
      const oldest = this.hashes.keys().next().value;
      if (oldest === undefined) break;
      this.hashes.delete(oldest);
    }
    return expectedHash;
  }
}
