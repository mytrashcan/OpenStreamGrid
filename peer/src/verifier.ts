import { createHash, timingSafeEqual } from "node:crypto";

const DEFAULT_MAX_CACHED_HASHES = 2_000;

export interface SegmentIntegrityVerifier {
  verify(segmentName: string, data: Buffer): Promise<boolean>;
}

export type FetchFunction = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export const sha256 = (data: Buffer): string =>
  createHash("sha256").update(data).digest("hex");

export const parseSha256 = (content: string): string => {
  const match = content.trim().match(/^([a-fA-F0-9]{64})(?:\s+.+)?$/);
  if (!match?.[1]) throw new Error("Invalid SHA-256 response");
  return match[1].toLowerCase();
};

export const verifySegmentHash = (data: Buffer, expectedHash: string): boolean => {
  const actual = Buffer.from(sha256(data), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return expected.byteLength === actual.byteLength && timingSafeEqual(actual, expected);
};

export class OriginHashVerifier implements SegmentIntegrityVerifier {
  private readonly hashes = new Map<string, string>();
  private readonly pendingHashes = new Map<string, Promise<string>>();

  constructor(
    private readonly originBaseUrl: URL,
    private readonly fetchImpl: FetchFunction = fetch,
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
    const response = await this.fetchImpl(hashUrl);
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
