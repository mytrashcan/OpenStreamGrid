import { createHash, timingSafeEqual } from "node:crypto";

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

  constructor(
    private readonly originBaseUrl: URL,
    private readonly fetchImpl: FetchFunction = fetch,
  ) {}

  async verify(segmentName: string, data: Buffer): Promise<boolean> {
    let expectedHash = this.hashes.get(segmentName);
    if (!expectedHash) {
      const hashUrl = new URL(`${encodeURIComponent(segmentName)}.sha256`, this.originBaseUrl);
      const response = await this.fetchImpl(hashUrl);
      if (!response.ok) {
        throw new Error(
          `Failed to fetch hash for '${segmentName}': HTTP ${response.status}`,
        );
      }
      expectedHash = parseSha256(await response.text());
      this.hashes.set(segmentName, expectedHash);
    }
    return verifySegmentHash(data, expectedHash);
  }
}
