import {
  createEmptyPeerTrafficStats,
  peerTrafficStatKeys,
  type Peer,
  type PeerFailureReport,
  type PeerTrafficStats,
} from "@openstreamgrid/common";

const CONNECTION_FAILURE_PENALTY = 0.1;
const INTEGRITY_FAILURE_PENALTY = 0.35;
const SUCCESS_RATE_PENALTY_FACTOR = 0.5;
const DEFAULT_FAILURE_QUORUM = 2;
const DEFAULT_FAILURE_WINDOW_MS = 60_000;

/** Requires independent, recent observations before changing global peer trust. */
export class PeerFailureConsensus {
  private readonly observations = new Map<string, Map<string, number>>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly quorum = DEFAULT_FAILURE_QUORUM,
    private readonly windowMs = DEFAULT_FAILURE_WINDOW_MS,
  ) {}

  observe(
    broadcastId: string,
    reportedPeerId: string,
    report: PeerFailureReport,
  ): boolean {
    if (reportedPeerId === report.reporterId) return false;
    const observedAt = this.now();
    const key = `${broadcastId}\u0000${reportedPeerId}\u0000${report.reason}`;
    const reporters = this.observations.get(key) ?? new Map<string, number>();
    for (const [reporterId, timestamp] of reporters) {
      if (observedAt - timestamp >= this.windowMs) reporters.delete(reporterId);
    }
    if (reporters.has(report.reporterId)) return false;
    reporters.set(report.reporterId, observedAt);
    if (reporters.size < this.quorum) {
      this.observations.set(key, reporters);
      return false;
    }
    this.observations.delete(key);
    return true;
  }
}

/** Constrains a quality metric to the inclusive range from zero to one. */
export const clampUnitInterval = (value: number): number =>
  Math.min(1, Math.max(0, value));

/** Normalizes traffic counters before persistence. */
export const sanitizePeerTrafficStats = (
  stats: PeerTrafficStats,
): PeerTrafficStats => {
  const sanitized = createEmptyPeerTrafficStats();
  for (const key of peerTrafficStatKeys) {
    const value = stats[key];
    sanitized[key] = Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  }
  return sanitized;
};

/** Applies the configured trust and success penalties for a peer failure. */
export const penalizePeerQuality = (
  peer: Pick<Peer, "trustScore" | "successRate">,
  reason: PeerFailureReport["reason"],
): Pick<Peer, "trustScore" | "successRate"> => {
  const penalty =
    reason === "integrity"
      ? INTEGRITY_FAILURE_PENALTY
      : CONNECTION_FAILURE_PENALTY;
  return {
    trustScore: clampUnitInterval(peer.trustScore - penalty),
    successRate: clampUnitInterval(
      peer.successRate - penalty * SUCCESS_RATE_PENALTY_FACTOR,
    ),
  };
};
