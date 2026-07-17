import {
  addPeerTrafficStats,
  createEmptyPeerTrafficStats,
  type Broadcast,
  type BroadcastRegistration,
  type BroadcastStats,
  type GlobalStats,
  type Peer,
  type PeerFailureReport,
  type PeerHeartbeat,
  type PeerJoinRequest,
  type PeerTrafficStats,
  type TrafficTotals,
} from "@openstreamgrid/common";
import {
  clampUnitInterval,
  penalizePeerQuality,
  sanitizePeerTrafficStats,
} from "./store-utils.js";

const NOT_FOUND_STATUS_CODE = 404;

/** Store operation failure with its corresponding HTTP status. */
export class StoreError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

/** Persistence contract used by tracker HTTP and WebSocket services. */
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

/** In-memory tracker store used for development and tests. */
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
        ...(registration.metadata
          ? { metadata: { ...registration.metadata } }
          : {}),
        updatedAt: timestamp,
      };
      return { broadcast: this.copyBroadcast(existing.broadcast), created: false };
    }

    const broadcast: Broadcast = {
      id: registration.id,
      playlistUrl: registration.playlistUrl,
      ...(registration.metadata
        ? { metadata: { ...registration.metadata } }
        : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.broadcasts.set(registration.id, {
      broadcast,
      peers: new Map(),
      retiredStats: createEmptyPeerTrafficStats(),
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
      throw new StoreError(`Broadcast '${id}' was not found`, NOT_FOUND_STATUS_CODE);
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
      ...(request.metadata ? { metadata: { ...request.metadata } } : {}),
      segments: existing?.peer.segments ?? [],
      joinedAt: existing?.peer.joinedAt ?? timestamp,
      lastSeenAt: timestamp,
      latencyMs: existing?.peer.latencyMs ?? 0,
      successRate: existing?.peer.successRate ?? 1,
      trustScore: existing?.peer.trustScore ?? 1,
    };
    state.peers.set(request.id, {
      peer,
      stats: existing?.stats ?? createEmptyPeerTrafficStats(),
    });
    return this.copyPeer(peer);
  }

  leavePeer(broadcastId: string, peerId: string): void {
    const state = this.requireBroadcast(broadcastId);
    const peerState = state.peers.get(peerId);
    if (!peerState) {
      throw new StoreError(`Peer '${peerId}' was not found`, NOT_FOUND_STATUS_CODE);
    }
    addPeerTrafficStats(state.retiredStats, peerState.stats);
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
      peerState.peer.successRate = clampUnitInterval(heartbeat.successRate);
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
    peerState.stats = sanitizePeerTrafficStats(stats);
    peerState.peer.lastSeenAt = this.timestamp();
  }

  reportPeerFailure(
    broadcastId: string,
    peerId: string,
    report: PeerFailureReport,
  ): Peer {
    const reported = this.requirePeer(broadcastId, peerId);
    this.requirePeer(broadcastId, report.reporterId);
    const quality = penalizePeerQuality(reported.peer, report.reason);
    reported.peer.trustScore = quality.trustScore;
    reported.peer.successRate = quality.successRate;
    return this.copyPeer(reported.peer);
  }

  removeStalePeers(maxAgeMs: number): number {
    const cutoff = this.now().getTime() - maxAgeMs;
    let removed = 0;
    for (const state of this.broadcasts.values()) {
      for (const [peerId, peerState] of state.peers) {
        if (new Date(peerState.peer.lastSeenAt).getTime() < cutoff) {
          addPeerTrafficStats(state.retiredStats, peerState.stats);
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
      ...createEmptyPeerTrafficStats(),
      peers: 0,
    };
    for (const state of this.broadcasts.values()) {
      const broadcastTotals = this.totalsFor(state);
      totals.peers += broadcastTotals.peers;
      addPeerTrafficStats(totals, broadcastTotals);
    }
    return {
      broadcasts: this.broadcasts.size,
      ...totals,
    };
  }

  close(): void {}

  private totalsFor(state: BroadcastState): TrafficTotals {
    const totals: TrafficTotals = {
      ...createEmptyPeerTrafficStats(),
      peers: state.peers.size,
    };
    addPeerTrafficStats(totals, state.retiredStats);
    for (const peerState of state.peers.values()) {
      addPeerTrafficStats(totals, peerState.stats);
    }
    return totals;
  }

  private requireBroadcast(id: string): BroadcastState {
    const state = this.broadcasts.get(id);
    if (!state) {
      throw new StoreError(`Broadcast '${id}' was not found`, NOT_FOUND_STATUS_CODE);
    }
    return state;
  }

  private requirePeer(broadcastId: string, peerId: string): PeerState {
    const peer = this.requireBroadcast(broadcastId).peers.get(peerId);
    if (!peer) {
      throw new StoreError(`Peer '${peerId}' was not found`, NOT_FOUND_STATUS_CODE);
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
