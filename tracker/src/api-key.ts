import { timingSafeEqual } from "node:crypto";

/** Compares API keys without leaking matching-prefix timing information. */
export const apiKeysMatch = (expected: string, provided: string): boolean => {
  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  return (
    expectedBytes.length === providedBytes.length &&
    timingSafeEqual(expectedBytes, providedBytes)
  );
};
