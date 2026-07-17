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
