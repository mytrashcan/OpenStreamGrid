/**
 * Limits on segment inventory reports. The tracker relays every report to the
 * reporter's neighbors (or to every subscriber, for legacy clients), so both
 * the size of one report and the volume a peer reports over time are bounded,
 * whichever interface (REST or WebSocket) the report arrives on.
 */

export const MAX_SEGMENTS_PER_REPORT = 512;
export const MAX_SEGMENT_ID_LENGTH = 512;
/**
 * Sustained segment-ID characters a peer may report per second, with bursts
 * large enough to re-report a full inventory after reconnecting. Clients
 * report a few IDs per segment, far below this.
 */
export const INVENTORY_CHARACTERS_PER_SECOND = 16 * 1024;
export const INVENTORY_BURST_CHARACTERS = 256 * 1024;
/** Buckets idle this long are full again and can be forgotten. */
const IDLE_BUCKET_MS = Math.ceil(
  (INVENTORY_BURST_CHARACTERS / INVENTORY_CHARACTERS_PER_SECOND) * 1_000,
);
const SWEEP_EVERY_CONSUMES = 1_024;

/** The segment IDs in `value`, or undefined unless it is a valid report list. */
export const segmentIdList = (value: unknown): string[] | undefined => {
  if (
    !Array.isArray(value) ||
    value.length > MAX_SEGMENTS_PER_REPORT ||
    value.some(
      (segment) =>
        typeof segment !== "string" ||
        segment.length === 0 ||
        segment.length > MAX_SEGMENT_ID_LENGTH,
    )
  ) {
    return undefined;
  }
  return value as string[];
};

interface InventoryBucket {
  characters: number;
  updatedAt: number;
}

/** Token bucket of reported segment-ID characters per broadcast peer. */
export class InventoryRateLimiter {
  private readonly buckets = new Map<string, InventoryBucket>();
  private consumesSinceSweep = 0;

  constructor(
    private readonly charactersPerSecond = INVENTORY_CHARACTERS_PER_SECOND,
    private readonly burstCharacters = INVENTORY_BURST_CHARACTERS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Charges the IDs in `segmentLists`; false (charging nothing) when over the limit. */
  consume(broadcastId: string, peerId: string, segmentLists: readonly (readonly string[])[]): boolean {
    let characters = 0;
    for (const segments of segmentLists) {
      for (const segment of segments) characters += segment.length;
    }
    const now = this.now();
    this.sweep(now);
    const key = `${broadcastId}\n${peerId}`;
    const bucket = this.buckets.get(key) ?? { characters: this.burstCharacters, updatedAt: now };
    bucket.characters = Math.min(
      this.burstCharacters,
      bucket.characters + ((now - bucket.updatedAt) / 1_000) * this.charactersPerSecond,
    );
    bucket.updatedAt = now;
    this.buckets.set(key, bucket);
    if (characters > bucket.characters) return false;
    bucket.characters -= characters;
    return true;
  }

  private sweep(now: number): void {
    this.consumesSinceSweep += 1;
    if (this.consumesSinceSweep < SWEEP_EVERY_CONSUMES) return;
    this.consumesSinceSweep = 0;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updatedAt >= IDLE_BUCKET_MS) this.buckets.delete(key);
    }
  }
}
