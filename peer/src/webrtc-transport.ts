import { randomUUID } from "node:crypto";
import type { WebRtcSignalMessage, WsClientMessage } from "@openstreamgrid/common";
import wrtc, {
  type RTCDataChannel,
  type RTCPeerConnection,
} from "@roamhq/wrtc";
import WebSocket, { type RawData } from "ws";
import type {
  TransportAdapter,
  TransportOptions,
  TransportStats,
} from "./transport.js";
import type { SegmentIntegrityVerifier } from "./verifier.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DATA_CHANNEL_LABEL = "segment-request";
const MAX_DATA_CHANNEL_CHUNK_BYTES = 16 * 1024;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
];

type SegmentProvider = (
  segmentName: string,
) => Buffer | undefined | Promise<Buffer | undefined>;

export interface WebRtcTransportOptions {
  timeoutMs?: number;
  iceServers?: RTCIceServer[];
  segmentProvider?: SegmentProvider;
  verifier?: SegmentIntegrityVerifier;
  onUpload?: (bytes: number) => void;
  peerConnectionFactory?: (configuration: RTCConfiguration) => RTCPeerConnection;
  webSocketFactory?: (url: URL) => WebSocket;
}

interface PendingAnswer {
  expectedPeerId: string;
  resolve: (sdp: string) => void;
  reject: (error: Error) => void;
}

interface SegmentResponse {
  type: "segment_response";
  segmentName: string;
  byteLength: number;
  chunkCount: number;
}

interface SegmentError {
  type: "segment_error";
  segmentName: string;
  message: string;
}

const errorFrom = (value: unknown, fallback: string): Error =>
  value instanceof Error ? value : new Error(fallback);

const abortError = (signal: AbortSignal): Error =>
  errorFrom(signal.reason, "WebRTC segment request aborted");

const parseJsonObject = (value: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("DataChannel control message must be a JSON object");
  }
  return parsed as Record<string, unknown>;
};

const binaryBuffer = (value: unknown): Buffer | undefined => {
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return Buffer.isBuffer(value) ? value : undefined;
};

export class WebRtcTransport implements TransportAdapter {
  readonly name = "webrtc";
  private readonly timeoutMs: number;
  private readonly iceServers: RTCIceServer[];
  private readonly segmentProvider: SegmentProvider | undefined;
  private readonly verifier: SegmentIntegrityVerifier | undefined;
  private readonly onUpload: ((bytes: number) => void) | undefined;
  private readonly peerConnectionFactory: (
    configuration: RTCConfiguration,
  ) => RTCPeerConnection;
  private readonly webSocketFactory: (url: URL) => WebSocket;
  private readonly activePeerIds = new Set<string>();
  private readonly activeConnections = new Set<RTCPeerConnection>();
  private readonly pendingAnswers = new Map<string, PendingAnswer>();
  private readonly latencies: number[] = [];
  private readonly stats: TransportStats = {
    segmentsFetched: 0,
    segmentsFailed: 0,
    bytesTransferred: 0,
    latencyMs: { min: Infinity, max: 0, average: 0 },
  };
  private transportOptions: TransportOptions | undefined;
  private signalSocket: WebSocket | undefined;
  private signalConnection: Promise<WebSocket> | undefined;
  private stopped = true;

  constructor(options: WebRtcTransportOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("WebRTC request timeout must be a positive integer");
    }
    this.iceServers = [...(options.iceServers ?? DEFAULT_ICE_SERVERS)];
    this.segmentProvider = options.segmentProvider;
    this.verifier = options.verifier;
    this.onUpload = options.onUpload;
    this.peerConnectionFactory =
      options.peerConnectionFactory ??
      ((configuration) => new wrtc.RTCPeerConnection(configuration));
    this.webSocketFactory =
      options.webSocketFactory ?? ((url) => new WebSocket(url));
  }

  /**
   * Starts only the signaling listener. Peer connections remain lazy and are
   * created when an offer arrives or a segment is requested.
   */
  async start(options: TransportOptions): Promise<void> {
    this.transportOptions = options;
    this.stopped = false;
    if (!options.signalUrl || !options.peerId || !options.broadcastId) return;
    await this.ensureSignalSocket(options.signal);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const socket = this.signalSocket;
    this.signalSocket = undefined;
    this.signalConnection = undefined;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
      else socket.close(1000, "WebRTC transport stopping");
    }
    for (const pending of this.pendingAnswers.values()) {
      pending.reject(new Error("WebRTC transport stopped"));
    }
    this.pendingAnswers.clear();
    for (const connection of this.activeConnections) connection.close();
    this.activeConnections.clear();
    this.activePeerIds.clear();
  }

  get peers(): string[] {
    return [...this.activePeerIds];
  }

  async requestSegment(
    peerAddress: string,
    segmentName: string,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const startedAt = performance.now();
    const requestController = new AbortController();
    const timeout = setTimeout(
      () => requestController.abort(new Error("WebRTC segment request timed out")),
      this.timeoutMs,
    );
    timeout.unref();
    const onAbort = (): void => requestController.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });

    let connection: RTCPeerConnection | undefined;
    try {
      if (signal?.aborted) throw abortError(signal);
      if (this.stopped) throw new Error("WebRTC transport has not been started");
      this.requireConfiguration();
      await this.ensureSignalSocket(requestController.signal);

      connection = this.createPeerConnection();
      const channel = connection.createDataChannel(DATA_CHANNEL_LABEL, {
        ordered: true,
      });
      channel.binaryType = "arraybuffer";
      const requestId = randomUUID();

      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      await this.waitForIceGathering(connection, requestController.signal);
      const localSdp = connection.localDescription?.sdp;
      if (!localSdp) throw new Error("WebRTC offer did not contain SDP");
      const answer = this.waitForAnswer(
        requestId,
        peerAddress,
        requestController.signal,
      );
      try {
        this.sendSignal({
          type: "webrtc_offer",
          targetPeerId: peerAddress,
          requestId,
          sdp: localSdp,
        });
      } catch (error) {
        requestController.abort(error);
        await answer.catch(() => undefined);
        throw error;
      }

      const remoteSdp = await answer;
      await connection.setRemoteDescription({ type: "answer", sdp: remoteSdp });
      await this.waitForDataChannelOpen(channel, requestController.signal);
      const response = this.receiveSegment(
        channel,
        segmentName,
        requestController.signal,
      );
      try {
        channel.send(JSON.stringify({ type: "segment_request", segmentName }));
      } catch (error) {
        requestController.abort(error);
        await response.catch(() => undefined);
        throw error;
      }
      const data = await response;
      if (this.verifier && !(await this.verifier.verify(segmentName, data))) {
        throw new Error("WebRTC segment integrity verification failed");
      }
      this.activePeerIds.add(peerAddress);
      this.recordSuccess(data.byteLength, performance.now() - startedAt);
      return data;
    } catch (error) {
      this.recordFailure();
      if (requestController.signal.aborted) {
        throw abortError(requestController.signal);
      }
      throw errorFrom(error, "WebRTC segment request failed");
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if (connection) this.closePeerConnection(connection);
    }
  }

  getStats(): TransportStats {
    return {
      segmentsFetched: this.stats.segmentsFetched,
      segmentsFailed: this.stats.segmentsFailed,
      bytesTransferred: this.stats.bytesTransferred,
      latencyMs: { ...this.stats.latencyMs },
    };
  }

  resetStats(): void {
    this.stats.segmentsFetched = 0;
    this.stats.segmentsFailed = 0;
    this.stats.bytesTransferred = 0;
    this.stats.latencyMs = { min: Infinity, max: 0, average: 0 };
    this.latencies.length = 0;
  }

  private requireConfiguration(): Required<
    Pick<TransportOptions, "signalUrl" | "peerId" | "broadcastId">
  > {
    const { signalUrl, peerId, broadcastId } = this.transportOptions ?? {};
    if (!signalUrl || !peerId || !broadcastId) {
      throw new Error(
        "WebRTC transport requires signalUrl, peerId, and broadcastId",
      );
    }
    return { signalUrl, peerId, broadcastId };
  }

  private async ensureSignalSocket(signal?: AbortSignal): Promise<WebSocket> {
    const current = this.signalSocket;
    if (current?.readyState === WebSocket.OPEN) return current;
    if (this.signalConnection) return this.signalConnection;
    const configuration = this.requireConfiguration();
    const url = new URL(configuration.signalUrl);
    if (url.protocol === "http:") url.protocol = "ws:";
    if (url.protocol === "https:") url.protocol = "wss:";
    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      throw new Error("WebRTC signaling URL must use ws or wss");
    }

    const socket = this.webSocketFactory(url);
    this.signalSocket = socket;
    this.signalConnection = new Promise<WebSocket>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        socket.off("open", onOpen);
        socket.off("error", onError);
        socket.off("close", onCloseBeforeOpen);
        signal?.removeEventListener("abort", onAbort);
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onOpen = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.send(
          JSON.stringify({
            type: "subscribe",
            broadcastId: configuration.broadcastId,
            peerId: configuration.peerId,
          } satisfies WsClientMessage),
        );
        resolve(socket);
      };
      const onError = (error: Error): void => fail(error);
      const onCloseBeforeOpen = (): void =>
        fail(new Error("WebRTC signaling socket closed before opening"));
      const onAbort = (): void => {
        socket.terminate();
        fail(signal ? abortError(signal) : new Error("Signaling aborted"));
      };
      socket.once("open", onOpen);
      socket.once("error", onError);
      socket.once("close", onCloseBeforeOpen);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    }).finally(() => {
      this.signalConnection = undefined;
    });

    socket.on("message", (data, isBinary) => {
      if (!isBinary) this.handleSignalMessage(data);
    });
    socket.once("close", () => {
      if (this.signalSocket === socket) this.signalSocket = undefined;
    });
    return this.signalConnection;
  }

  private handleSignalMessage(data: RawData): void {
    if (this.stopped) return;
    try {
      const message = parseJsonObject(data.toString()) as Partial<WebRtcSignalMessage>;
      const configuration = this.requireConfiguration();
      if (
        message.broadcastId !== configuration.broadcastId ||
        message.targetPeerId !== configuration.peerId ||
        typeof message.peerId !== "string" ||
        typeof message.requestId !== "string" ||
        typeof message.sdp !== "string"
      ) {
        return;
      }
      if (message.type === "webrtc_answer") {
        const pending = this.pendingAnswers.get(message.requestId);
        if (pending?.expectedPeerId === message.peerId) {
          this.pendingAnswers.delete(message.requestId);
          pending.resolve(message.sdp);
        }
        return;
      }
      if (message.type === "webrtc_offer") {
        void this.acceptOffer(message as WebRtcSignalMessage).catch(() => {
          // The requester owns the timeout and HTTP fallback path.
        });
      }
    } catch {
      // Ignore tracker messages unrelated to WebRTC signaling.
    }
  }

  private sendSignal(
    message: Pick<WebRtcSignalMessage, "type" | "targetPeerId" | "requestId" | "sdp">,
  ): void {
    const configuration = this.requireConfiguration();
    const socket = this.signalSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("WebRTC signaling socket is not open");
    }
    socket.send(
      JSON.stringify({
        ...message,
        broadcastId: configuration.broadcastId,
        peerId: configuration.peerId,
      } satisfies WebRtcSignalMessage),
    );
  }

  private waitForAnswer(
    requestId: string,
    expectedPeerId: string,
    signal: AbortSignal,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const onAbort = (): void => {
        this.pendingAnswers.delete(requestId);
        reject(abortError(signal));
      };
      this.pendingAnswers.set(requestId, {
        expectedPeerId,
        resolve: (sdp) => {
          signal.removeEventListener("abort", onAbort);
          resolve(sdp);
        },
        reject: (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      });
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  private async acceptOffer(message: WebRtcSignalMessage): Promise<void> {
    const connection = this.createPeerConnection();
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("Incoming WebRTC request timed out")),
      this.timeoutMs,
    );
    timeout.unref();
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      this.closePeerConnection(connection);
    };
    controller.signal.addEventListener("abort", finish, { once: true });
    connection.addEventListener("connectionstatechange", () => {
      if (
        connection.connectionState === "failed" ||
        connection.connectionState === "closed"
      ) {
        finish();
      }
    });
    connection.ondatachannel = (event): void => {
      if (event.channel.label !== DATA_CHANNEL_LABEL) {
        event.channel.close();
        return;
      }
      void this.serveSegment(
        event.channel,
        message.peerId,
        controller.signal,
      ).finally(finish);
    };

    try {
      await connection.setRemoteDescription({ type: "offer", sdp: message.sdp });
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      await this.waitForIceGathering(connection, controller.signal);
      const localSdp = connection.localDescription?.sdp;
      if (!localSdp) throw new Error("WebRTC answer did not contain SDP");
      this.sendSignal({
        type: "webrtc_answer",
        targetPeerId: message.peerId,
        requestId: message.requestId,
        sdp: localSdp,
      });
    } catch (error) {
      finish();
      throw error;
    }
  }

  private async serveSegment(
    channel: RTCDataChannel,
    requesterPeerId: string,
    signal: AbortSignal,
  ): Promise<void> {
    channel.binaryType = "arraybuffer";
    const request = await this.waitForSegmentRequest(channel, signal);
    const data = await this.segmentProvider?.(request.segmentName);
    if (!data) {
      const receipt = this.waitForSegmentReceipt(
        channel,
        request.segmentName,
        signal,
      );
      void receipt.catch(() => undefined);
      this.sendControl(channel, {
        type: "segment_error",
        segmentName: request.segmentName,
        message: "Segment not found",
      } satisfies SegmentError);
      await receipt;
      return;
    }

    const receipt = this.waitForSegmentReceipt(
      channel,
      request.segmentName,
      signal,
    );
    void receipt.catch(() => undefined);
    const chunkCount = Math.ceil(data.byteLength / MAX_DATA_CHANNEL_CHUNK_BYTES);
    this.sendControl(channel, {
      type: "segment_response",
      segmentName: request.segmentName,
      byteLength: data.byteLength,
      chunkCount,
    } satisfies SegmentResponse);
    for (let offset = 0; offset < data.byteLength; offset += MAX_DATA_CHANNEL_CHUNK_BYTES) {
      await this.waitForSendCapacity(channel, signal);
      const chunk = data.subarray(
        offset,
        Math.min(offset + MAX_DATA_CHANNEL_CHUNK_BYTES, data.byteLength),
      );
      const frame = Uint8Array.from(chunk);
      channel.send(frame);
      this.onUpload?.(chunk.byteLength);
    }
    await this.waitForBufferedData(channel, signal);
    await receipt;
    this.activePeerIds.add(requesterPeerId);
    channel.close();
  }

  private waitForSegmentReceipt(
    channel: RTCDataChannel,
    segmentName: string,
    signal: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        channel.removeEventListener("message", onMessage);
        channel.removeEventListener("error", onError);
        channel.removeEventListener("close", onClose);
        signal.removeEventListener("abort", onAbort);
      };
      const fail = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onMessage = (event: MessageEvent): void => {
        if (typeof event.data !== "string") return;
        try {
          const message = parseJsonObject(event.data);
          if (
            message.type !== "segment_received" ||
            message.segmentName !== segmentName
          ) {
            return;
          }
          cleanup();
          resolve();
        } catch (error) {
          fail(errorFrom(error, "Invalid segment receipt"));
        }
      };
      const onError = (): void => fail(new Error("DataChannel receipt failed"));
      const onClose = (): void =>
        fail(new Error("DataChannel closed before acknowledging the segment"));
      const onAbort = (): void => fail(abortError(signal));
      channel.addEventListener("message", onMessage);
      channel.addEventListener("error", onError);
      channel.addEventListener("close", onClose);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  private waitForSegmentRequest(
    channel: RTCDataChannel,
    signal: AbortSignal,
  ): Promise<{ segmentName: string }> {
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        channel.removeEventListener("message", onMessage);
        channel.removeEventListener("error", onError);
        channel.removeEventListener("close", onClose);
        signal.removeEventListener("abort", onAbort);
      };
      const fail = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onMessage = (event: MessageEvent): void => {
        try {
          if (typeof event.data !== "string") {
            throw new Error("Expected a segment request control message");
          }
          const message = parseJsonObject(event.data);
          if (
            message.type !== "segment_request" ||
            typeof message.segmentName !== "string" ||
            !/^[-A-Za-z0-9_.]+\.ts$/.test(message.segmentName)
          ) {
            throw new Error("Invalid DataChannel segment request");
          }
          cleanup();
          resolve({ segmentName: message.segmentName });
        } catch (error) {
          fail(errorFrom(error, "Invalid segment request"));
        }
      };
      const onError = (): void => fail(new Error("DataChannel request failed"));
      const onClose = (): void =>
        fail(new Error("DataChannel closed before receiving a request"));
      const onAbort = (): void => fail(abortError(signal));
      channel.addEventListener("message", onMessage);
      channel.addEventListener("error", onError);
      channel.addEventListener("close", onClose);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  private receiveSegment(
    channel: RTCDataChannel,
    segmentName: string,
    signal: AbortSignal,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let expectedBytes: number | undefined;
      let expectedChunks: number | undefined;
      let receivedBytes = 0;
      const cleanup = (): void => {
        channel.removeEventListener("message", onMessage);
        channel.removeEventListener("error", onError);
        channel.removeEventListener("close", onClose);
        signal.removeEventListener("abort", onAbort);
      };
      const fail = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const complete = (): void => {
        if (
          expectedBytes === undefined ||
          expectedChunks === undefined ||
          chunks.length !== expectedChunks
        ) {
          return;
        }
        if (receivedBytes !== expectedBytes) {
          fail(new Error("WebRTC segment response length did not match metadata"));
          return;
        }
        channel.send(JSON.stringify({ type: "segment_received", segmentName }));
        cleanup();
        resolve(Buffer.concat(chunks, receivedBytes));
      };
      const onMessage = (event: MessageEvent): void => {
        try {
          if (typeof event.data === "string") {
            const message = parseJsonObject(event.data);
            if (message.type === "segment_error") {
              channel.send(
                JSON.stringify({ type: "segment_received", segmentName }),
              );
              throw new Error(
                typeof message.message === "string"
                  ? message.message
                  : "Peer could not serve segment",
              );
            }
            if (
              message.type !== "segment_response" ||
              message.segmentName !== segmentName ||
              !Number.isSafeInteger(message.byteLength) ||
              !Number.isSafeInteger(message.chunkCount) ||
              (message.byteLength as number) < 0 ||
              (message.chunkCount as number) < 0
            ) {
              throw new Error("Invalid WebRTC segment response metadata");
            }
            expectedBytes = message.byteLength as number;
            expectedChunks = message.chunkCount as number;
            complete();
            return;
          }
          if (expectedBytes === undefined || expectedChunks === undefined) {
            throw new Error("Received WebRTC segment data before metadata");
          }
          const chunk = binaryBuffer(event.data);
          if (!chunk || chunk.byteLength > MAX_DATA_CHANNEL_CHUNK_BYTES) {
            throw new Error("Invalid WebRTC segment chunk");
          }
          chunks.push(chunk);
          receivedBytes += chunk.byteLength;
          if (
            chunks.length > expectedChunks ||
            receivedBytes > expectedBytes
          ) {
            throw new Error("WebRTC segment response exceeded declared size");
          }
          complete();
        } catch (error) {
          fail(errorFrom(error, "Invalid WebRTC segment response"));
        }
      };
      const onError = (): void => fail(new Error("DataChannel receive failed"));
      const onClose = (): void =>
        fail(new Error("DataChannel closed before the segment was complete"));
      const onAbort = (): void => fail(abortError(signal));
      channel.addEventListener("message", onMessage);
      channel.addEventListener("error", onError);
      channel.addEventListener("close", onClose);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  private sendControl(channel: RTCDataChannel, message: SegmentResponse | SegmentError): void {
    if (channel.readyState !== "open") {
      throw new Error("DataChannel closed before the response could be sent");
    }
    channel.send(JSON.stringify(message));
  }

  private waitForDataChannelOpen(
    channel: RTCDataChannel,
    signal: AbortSignal,
  ): Promise<void> {
    if (channel.readyState === "open") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        channel.removeEventListener("open", onOpen);
        channel.removeEventListener("error", onError);
        channel.removeEventListener("close", onClose);
        signal.removeEventListener("abort", onAbort);
      };
      const onOpen = (): void => {
        cleanup();
        resolve();
      };
      const onError = (): void => {
        cleanup();
        reject(new Error("DataChannel failed to open"));
      };
      const onClose = (): void => {
        cleanup();
        reject(new Error("DataChannel closed before opening"));
      };
      const onAbort = (): void => {
        cleanup();
        reject(abortError(signal));
      };
      channel.addEventListener("open", onOpen, { once: true });
      channel.addEventListener("error", onError, { once: true });
      channel.addEventListener("close", onClose, { once: true });
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  private waitForIceGathering(
    connection: RTCPeerConnection,
    signal: AbortSignal,
  ): Promise<void> {
    if (connection.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        connection.removeEventListener("icecandidate", onIceCandidate);
        signal.removeEventListener("abort", onAbort);
      };
      const onIceCandidate = (event: RTCPeerConnectionIceEvent): void => {
        if (event.candidate !== null) return;
        cleanup();
        resolve();
      };
      const onAbort = (): void => {
        cleanup();
        reject(abortError(signal));
      };
      connection.addEventListener("icecandidate", onIceCandidate);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  private async waitForSendCapacity(
    channel: RTCDataChannel,
    signal: AbortSignal,
  ): Promise<void> {
    if (channel.bufferedAmount <= MAX_BUFFERED_BYTES) return;
    channel.bufferedAmountLowThreshold = MAX_BUFFERED_BYTES / 2;
    await this.waitForBufferedAmountLow(channel, signal);
  }

  private async waitForBufferedData(
    channel: RTCDataChannel,
    signal: AbortSignal,
  ): Promise<void> {
    if (channel.bufferedAmount === 0) return;
    channel.bufferedAmountLowThreshold = 0;
    await this.waitForBufferedAmountLow(channel, signal);
  }

  private waitForBufferedAmountLow(
    channel: RTCDataChannel,
    signal: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        channel.removeEventListener("bufferedamountlow", onLow);
        channel.removeEventListener("close", onClose);
        signal.removeEventListener("abort", onAbort);
      };
      const onLow = (): void => {
        cleanup();
        resolve();
      };
      const onClose = (): void => {
        cleanup();
        reject(new Error("DataChannel closed while sending segment data"));
      };
      const onAbort = (): void => {
        cleanup();
        reject(abortError(signal));
      };
      channel.addEventListener("bufferedamountlow", onLow, { once: true });
      channel.addEventListener("close", onClose, { once: true });
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  private createPeerConnection(): RTCPeerConnection {
    const connection = this.peerConnectionFactory({
      iceServers: this.iceServers,
    });
    this.activeConnections.add(connection);
    return connection;
  }

  private closePeerConnection(connection: RTCPeerConnection): void {
    this.activeConnections.delete(connection);
    if (connection.connectionState !== "closed") connection.close();
  }

  private recordSuccess(bytes: number, latencyMs: number): void {
    this.stats.segmentsFetched += 1;
    this.stats.bytesTransferred += bytes;
    this.latencies.push(latencyMs);
    const total = this.latencies.reduce((sum, value) => sum + value, 0);
    this.stats.latencyMs = {
      min: Math.min(...this.latencies),
      max: Math.max(...this.latencies),
      average: total / this.latencies.length,
    };
  }

  private recordFailure(): void {
    this.stats.segmentsFailed += 1;
  }
}
