import type {
  Broadcast,
  BroadcastRegistration,
  BroadcastStats,
  GlobalStats,
  Peer,
  PeerFailureReport,
  PeerHeartbeat,
  PeerJoinRequest,
  PeerTrafficStats,
  TrafficTotals,
} from "@openstreamgrid/common";

export class StoreError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

export interface TrackerStoreBackend {
  registerBroadcast(registration: BroadcastRegistration): {
    broadcast: Broadcast;
    created: boolean;
  };
  listBroadcasts(): Broadcast[];
  getBroadcast(id: string): Broadcast;
  unregisterBroadcast(id: string): void;
  joinPeer(broadcastId: string, request: PeerJoinRequest): Peer;
  leavePeer(broadcastId: string, peerId: string): void;
  listPeers(broadcastId: string, segment?: string): Peer[];
  reportSegments(
    broadcastId: string,
    peerId: string,
    segments: string[],
    replace?: boolean,
  ): Peer;
  heartbeat(
    broadcastId: string,
    peerId: string,
    heartbeat: PeerHeartbeat,
  ): Peer;
  reportStats(
    broadcastId: string,
    peerId: string,
    stats: PeerTrafficStats,
  ): void;
  reportPeerFailure(
    broadcastId: string,
    peerId: string,
    report: PeerFailureReport,
  ): Peer;
  removeStalePeers(maxAgeMs: number): number;
  getBroadcastStats(broadcastId: string): BroadcastStats;
  getGlobalStats(): GlobalStats;
  close(): void;
}

interface PeerState {
  peer: Peer;
  stats: PeerTrafficStats;
}

interface BroadcastState {
  broadcast: Broadcast;
  peers: Map<string, PeerState>;
  retiredStats: PeerTrafficStats;
}

const emptyTrafficStats = (): PeerTrafficStats => ({
  bytesDownloadedP2P: 0,
  bytesDownloadedOrigin: 0,
  bytesUploadedP2P: 0,
  p2pRequests: 0,
  p2pSuccesses: 0,
  p2pFailures: 0,
  originRequests: 0,
  integrityFailures: 0,
  fallbacks: 0,
  segmentsCached: 0,
});

const trafficKeys: ReadonlyArray<keyof PeerTrafficStats> = [
  "bytesDownloadedP2P",
  "bytesDownloadedOrigin",
  "bytesUploadedP2P",
  "p2pRequests",
  "p2pSuccesses",
  "p2pFailures",
  "originRequests",
  "integrityFailures",
  "fallbacks",
  "segmentsCached",
];

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const addStats = (target: PeerTrafficStats, source: PeerTrafficStats): void => {
  for (const key of trafficKeys) {
    target[key] += source[key];
  }
};

const sanitizeStats = (stats: PeerTrafficStats): PeerTrafficStats => {
  const sanitized = emptyTrafficStats();
  for (const key of trafficKeys) {
    const value = stats[key];
    sanitized[key] = Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  }
  return sanitized;
};

export class TrackerStore implements TrackerStoreBackend {
  private readonly broadcasts = new Map<string, BroadcastState>();

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly maxSegmentsPerPeer = 2_000,
  ) {}

  registerBroadcast(registration: BroadcastRegistration): {
    broadcast: Broadcast;
    created: boolean;
  } {
    const existing = this.broadcasts.get(registration.id);
    const timestamp = this.timestamp();
    if (existing) {
      existing.broadcast = {
        ...existing.broadcast,
        playlistUrl: registration.playlistUrl,
        ...(registration.metadata ? { metadata: registration.metadata } : {}),
        updatedAt: timestamp,
      };
      return { broadcast: this.copyBroadcast(existing.broadcast), created: false };
    }

    const broadcast: Broadcast = {
      id: registration.id,
      playlistUrl: registration.playlistUrl,
      ...(registration.metadata ? { metadata: registration.metadata } : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.broadcasts.set(registration.id, {
      broadcast,
      peers: new Map(),
      retiredStats: emptyTrafficStats(),
    });
    return { broadcast: this.copyBroadcast(broadcast), created: true };
  }

  listBroadcasts(): Broadcast[] {
    return [...this.broadcasts.values()].map(({ broadcast }) =>
      this.copyBroadcast(broadcast),
    );
  }

  getBroadcast(id: string): Broadcast {
    return this.copyBroadcast(this.requireBroadcast(id).broadcast);
  }

  unregisterBroadcast(id: string): void {
    if (!this.broadcasts.delete(id)) {
      throw new StoreError(`Broadcast '${id}' was not found`, 404);
    }
  }

  joinPeer(broadcastId: string, request: PeerJoinRequest): Peer {
    const state = this.requireBroadcast(broadcastId);
    const timestamp = this.timestamp();
    const existing = state.peers.get(request.id);
    const peer: Peer = {
      id: request.id,
      address: request.address,
      ...(request.uploadBandwidthBps !== undefined
        ? { uploadBandwidthBps: request.uploadBandwidthBps }
        : {}),
      ...(request.metadata ? { metadata: request.metadata } : {}),
      segments: existing?.peer.segments ?? [],
      joinedAt: existing?.peer.joinedAt ?? timestamp,
      lastSeenAt: timestamp,
      latencyMs: existing?.peer.latencyMs ?? 0,
      successRate: existing?.peer.successRate ?? 1,
      trustScore: existing?.peer.trustScore ?? 1,
    };
    state.peers.set(request.id, {
      peer,
      stats: existing?.stats ?? emptyTrafficStats(),
    });
    return this.copyPeer(peer);
  }

  leavePeer(broadcastId: string, peerId: string): void {
    const state = this.requireBroadcast(broadcastId);
    const peerState = state.peers.get(peerId);
    if (!peerState) {
      throw new StoreError(`Peer '${peerId}' was not found`, 404);
    }
    addStats(state.retiredStats, peerState.stats);
    state.peers.delete(peerId);
  }

  listPeers(broadcastId: string, segment?: string): Peer[] {
    const peers = [...this.requireBroadcast(broadcastId).peers.values()];
    return peers
      .filter(({ peer }) => segment === undefined || peer.segments.includes(segment))
      .map(({ peer }) => this.copyPeer(peer));
  }

  reportSegments(
    broadcastId: string,
    peerId: string,
    segments: string[],
    replace = false,
  ): Peer {
    const peerState = this.requirePeer(broadcastId, peerId);
    const nextSegments = replace
      ? segments
      : [...peerState.peer.segments, ...segments];
    peerState.peer.segments = [...new Set(nextSegments)].slice(
      -this.maxSegmentsPerPeer,
    );
    peerState.peer.lastSeenAt = this.timestamp();
    return this.copyPeer(peerState.peer);
  }

  heartbeat(
    broadcastId: string,
    peerId: string,
    heartbeat: PeerHeartbeat,
  ): Peer {
    const peerState = this.requirePeer(broadcastId, peerId);
    if (heartbeat.latencyMs !== undefined) {
      peerState.peer.latencyMs = Math.max(0, heartbeat.latencyMs);
    }
    if (heartbeat.uploadBandwidthBps !== undefined) {
      peerState.peer.uploadBandwidthBps = Math.max(
        0,
        heartbeat.uploadBandwidthBps,
      );
    }
    if (heartbeat.successRate !== undefined) {
      peerState.peer.successRate = clamp(heartbeat.successRate, 0, 1);
    }
    peerState.peer.lastSeenAt = this.timestamp();
    return this.copyPeer(peerState.peer);
  }

  reportStats(
    broadcastId: string,
    peerId: string,
    stats: PeerTrafficStats,
  ): void {
    const peerState = this.requirePeer(broadcastId, peerId);
    peerState.stats = sanitizeStats(stats);
    peerState.peer.lastSeenAt = this.timestamp();
  }

  reportPeerFailure(
    broadcastId: string,
    peerId: string,
    report: PeerFailureReport,
  ): Peer {
    const reported = this.requirePeer(broadcastId, peerId);
    this.requirePeer(broadcastId, report.reporterId);
    const penalty = report.reason === "integrity" ? 0.35 : 0.1;
    reported.peer.trustScore = clamp(reported.peer.trustScore - penalty, 0, 1);
    reported.peer.successRate = clamp(reported.peer.successRate - penalty / 2, 0, 1);
    return this.copyPeer(reported.peer);
  }

  removeStalePeers(maxAgeMs: number): number {
    const cutoff = this.now().getTime() - maxAgeMs;
    let removed = 0;
    for (const state of this.broadcasts.values()) {
      for (const [peerId, peerState] of state.peers) {
        if (new Date(peerState.peer.lastSeenAt).getTime() < cutoff) {
          addStats(state.retiredStats, peerState.stats);
          state.peers.delete(peerId);
          removed += 1;
        }
      }
    }
    return removed;
  }

  getBroadcastStats(broadcastId: string): BroadcastStats {
    const state = this.requireBroadcast(broadcastId);
    return {
      broadcastId,
      ...this.totalsFor(state),
    };
  }

  getGlobalStats(): GlobalStats {
    const totals: TrafficTotals = {
      ...emptyTrafficStats(),
      peers: 0,
    };
    for (const state of this.broadcasts.values()) {
      const broadcastTotals = this.totalsFor(state);
      totals.peers += broadcastTotals.peers;
      addStats(totals, broadcastTotals);
    }
    return {
      broadcasts: this.broadcasts.size,
      ...totals,
    };
  }

  close(): void {}

  private totalsFor(state: BroadcastState): TrafficTotals {
    const totals: TrafficTotals = {
      ...emptyTrafficStats(),
      peers: state.peers.size,
    };
    addStats(totals, state.retiredStats);
    for (const peerState of state.peers.values()) {
      addStats(totals, peerState.stats);
    }
    return totals;
  }

  private requireBroadcast(id: string): BroadcastState {
    const state = this.broadcasts.get(id);
    if (!state) {
      throw new StoreError(`Broadcast '${id}' was not found`, 404);
    }
    return state;
  }

  private requirePeer(broadcastId: string, peerId: string): PeerState {
    const peer = this.requireBroadcast(broadcastId).peers.get(peerId);
    if (!peer) {
      throw new StoreError(`Peer '${peerId}' was not found`, 404);
    }
    return peer;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private copyBroadcast(broadcast: Broadcast): Broadcast {
    return {
      ...broadcast,
      ...(broadcast.metadata ? { metadata: { ...broadcast.metadata } } : {}),
    };
  }

  private copyPeer(peer: Peer): Peer {
    return {
      ...peer,
      segments: [...peer.segments],
      ...(peer.metadata ? { metadata: { ...peer.metadata } } : {}),
    };
  }
}
