/**
 * SHA-256 segment verification using the Web Crypto API (SubtleCrypto).
 * No Node.js builtins — works in all modern browsers.
 */

import type { SegmentVerificationResult } from "./types.js";

/**
 * Compute the SHA-256 hex digest of a Uint8Array using SubtleCrypto.
 */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(data).buffer,
  );
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Parse a SHA-256 hash from a .sha256 file content.
 * Standard format: "<hex>  <filename>" or just "<hex>".
 */
export function parseSha256(content: string): string {
  const match = content.trim().match(/^([a-fA-F0-9]{64})(?:\s+.+)?$/);
  if (!match?.[1]) {
    throw new Error("Invalid SHA-256 response format");
  }
  return match[1].toLowerCase();
}

/**
 * Constant-time comparison of two hex strings.
 * Prevents timing attacks (though less critical in browser context).
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Verify segment data against an expected SHA-256 hex hash.
 */
export async function verifySegmentHash(
  data: Uint8Array,
  expectedHash: string,
): Promise<SegmentVerificationResult> {
  const actualHash = await sha256Hex(data);
  const valid = constantTimeEqual(actualHash, expectedHash);
  return { valid, actualHash, expectedHash };
}

/**
 * Fetches the .sha256 file for a segment from the origin and verifies.
 */
export class OriginHashVerifier {
  private readonly originBaseUrl: URL;
  private readonly pendingHashes = new Map<string, Promise<string>>();

  constructor(originBaseUrl: string) {
    this.originBaseUrl = new URL(
      originBaseUrl.endsWith("/") ? originBaseUrl : `${originBaseUrl}/`,
    );
  }

  async verify(segmentName: string, data: Uint8Array): Promise<SegmentVerificationResult> {
    const expectedHash = await this.expectedHash(segmentName);
    return verifySegmentHash(data, expectedHash);
  }

  private async expectedHash(segmentName: string): Promise<string> {
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
    const response = await fetch(hashUrl);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch hash for '${segmentName}': HTTP ${response.status}`,
      );
    }
    return parseSha256(await response.text());
  }
}
