export interface TransportOptions {
  /** WebSocket URL for signaling (used by WebRTC transport). */
  signalUrl?: string;
  /** Own peer ID, used for signaling identity. */
  peerId?: string;
  /** Broadcast ID the peer is subscribed to. */
  broadcastId?: string;
  /** Abort signal for graceful shutdown. */
  signal?: AbortSignal;
}

export interface TransportStats {
  /** Number of segments successfully fetched. */
  segmentsFetched: number;
  /** Number of segment fetch failures. */
  segmentsFailed: number;
  /** Total bytes transferred. */
  bytesTransferred: number;
  /** Latency stats in milliseconds. */
  latencyMs: {
    min: number;
    max: number;
    average: number;
  };
}

export interface TransportAdapter {
  readonly name: string;

  /** Initialize the transport (open connections, listen for peers). */
  start(options: TransportOptions): Promise<void>;

  /** Shut down the transport gracefully. */
  stop(): Promise<void>;

  /**
   * Request a segment from a specific peer.
   * The peerAddress format is transport-dependent:
   *   - HTTP: full URL (e.g. "http://peer-a:9090")
   *   - WebRTC: peer ID string
   */
  requestSegment(
    peerAddress: string,
    segmentName: string,
    signal?: AbortSignal,
  ): Promise<Buffer>;

  /** List of currently connected/discovered peer identifiers. */
  readonly peers: string[];

  /** Snapshot of transport-level statistics. */
  getStats(): TransportStats;

  /** Reset collected statistics. */
  resetStats(): void;
}
