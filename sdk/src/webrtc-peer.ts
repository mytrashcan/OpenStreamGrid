import { createLogger } from "@openstreamgrid/common";
import type { WebRtcSignalMessage } from "./types.js";

const DATA_CHANNEL_LABEL = "segment-request";
const MAX_CHUNK_BYTES = 16 * 1024;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_UPLOAD_CONNECTIONS = 3;
const DEFAULT_MAX_UPLOAD_BITRATE = 1_000_000;
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
];
const logger = createLogger("sdk");

type SegmentProvider = (
  segmentId: string,
) => Uint8Array | undefined | Promise<Uint8Array | undefined>;

export interface BrowserWebRtcPeerOptions {
  broadcastId: string;
  peerId: string;
  sendSignal: (message: WebRtcSignalMessage) => void;
  segmentProvider: SegmentProvider;
  onUpload?: (bytes: number) => void;
  timeoutMs?: number;
  iceServers?: RTCIceServer[];
  maxUploadConnections?: number;
  maxUploadBitrate?: number;
  peerConnectionFactory?: (configuration: RTCConfiguration) => RTCPeerConnection;
}

interface PendingAnswer {
  expectedPeerId: string;
  resolve: (sdp: string) => void;
  reject: (error: Error) => void;
}

type JsonObject = Record<string, unknown>;

const parseObject = (value: string): JsonObject => {
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("DataChannel control message must be an object");
  }
  return parsed as JsonObject;
};

const errorFrom = (value: unknown, fallback: string): Error =>
  value instanceof Error ? value : new Error(fallback);

const abortError = (signal: AbortSignal): Error =>
  errorFrom(signal.reason, "WebRTC request aborted");

const binaryBytes = (value: unknown): Uint8Array | undefined => {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return undefined;
};

const isSegmentId = (value: string): boolean =>
  value.length <= 1024 &&
  /^(?!.*(?:^|\/)\.\.(?:\/|$))[-A-Za-z0-9_./]+\.ts$/.test(value);

const requestId = (): string => {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

/** Browser-native WebRTC requester and cache uploader. */
export class BrowserWebRtcPeer {
  private readonly timeoutMs: number;
  private readonly iceServers: RTCIceServer[];
  private readonly maxUploadConnections: number;
  private readonly maxUploadBitrate: number;
  private readonly peerConnectionFactory: (
    configuration: RTCConfiguration,
  ) => RTCPeerConnection;
  private readonly pendingAnswers = new Map<string, PendingAnswer>();
  private readonly connections = new Set<RTCPeerConnection>();
  private activeUploadConnections = 0;
  private stopped = false;

  constructor(private readonly options: BrowserWebRtcPeerOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxUploadConnections =
      options.maxUploadConnections ?? DEFAULT_MAX_UPLOAD_CONNECTIONS;
    this.maxUploadBitrate =
      options.maxUploadBitrate ?? DEFAULT_MAX_UPLOAD_BITRATE;
    for (const [label, value] of [
      ["WebRTC timeout", this.timeoutMs],
      ["Maximum upload connections", this.maxUploadConnections],
      ["Maximum upload bitrate", this.maxUploadBitrate],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${label} must be a positive integer`);
      }
    }
    this.iceServers = (options.iceServers ?? DEFAULT_ICE_SERVERS).map(
      (server) => ({
        ...server,
        urls: Array.isArray(server.urls) ? [...server.urls] : server.urls,
      }),
    );
    this.peerConnectionFactory =
      options.peerConnectionFactory ??
      ((configuration) => new RTCPeerConnection(configuration));
  }

  async requestSegment(
    targetPeerId: string,
    segmentId: string,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    if (this.stopped) throw new Error("Browser WebRTC peer has stopped");
    if (!isSegmentId(segmentId)) throw new Error("Invalid WebRTC segment ID");
    if (signal.aborted) throw abortError(signal);

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("WebRTC segment request timed out")),
      this.timeoutMs,
    );
    const onAbort = (): void => controller.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    let connection: RTCPeerConnection | undefined;
    try {
      connection = this.createConnection();
      const channel = connection.createDataChannel(DATA_CHANNEL_LABEL, {
        ordered: true,
      });
      channel.binaryType = "arraybuffer";
      const id = requestId();
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      await this.waitForIce(connection, controller.signal);
      const sdp = connection.localDescription?.sdp;
      if (!sdp) throw new Error("WebRTC offer did not contain SDP");
      const answer = this.waitForAnswer(id, targetPeerId, controller.signal);
      try {
        this.options.sendSignal({
          type: "webrtc_offer",
          broadcastId: this.options.broadcastId,
          peerId: this.options.peerId,
          targetPeerId,
          requestId: id,
          sdp,
        });
      } catch (error) {
        controller.abort(error);
        await answer.catch(() => undefined);
        throw error;
      }
      await connection.setRemoteDescription({
        type: "answer",
        sdp: await answer,
      });
      await this.waitForChannelOpen(channel, controller.signal);
      const response = this.receiveSegment(channel, segmentId, controller.signal);
      channel.send(JSON.stringify({ type: "segment_request", segmentName: segmentId }));
      return await response;
    } catch (error) {
      if (controller.signal.aborted) throw abortError(controller.signal);
      throw errorFrom(error, "WebRTC segment request failed");
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      if (connection) this.closeConnection(connection);
    }
  }

  handleSignal(message: WebRtcSignalMessage): void {
    if (
      this.stopped ||
      message.broadcastId !== this.options.broadcastId ||
      message.targetPeerId !== this.options.peerId
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
    void this.acceptOffer(message).catch((error: unknown) => {
      if (!this.stopped) logger.warn("browser_webrtc_offer_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const pending of this.pendingAnswers.values()) {
      pending.reject(new Error("Browser WebRTC peer stopped"));
    }
    this.pendingAnswers.clear();
    for (const connection of this.connections) connection.close();
    this.connections.clear();
  }

  private createConnection(): RTCPeerConnection {
    const connection = this.peerConnectionFactory({
      iceServers: this.iceServers,
    });
    this.connections.add(connection);
    return connection;
  }

  private closeConnection(connection: RTCPeerConnection): void {
    this.connections.delete(connection);
    if (connection.connectionState !== "closed") connection.close();
  }

  private waitForAnswer(
    id: string,
    expectedPeerId: string,
    signal: AbortSignal,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        this.pendingAnswers.delete(id);
        reject(abortError(signal));
      };
      this.pendingAnswers.set(id, {
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
    if (this.activeUploadConnections >= this.maxUploadConnections) return;
    this.activeUploadConnections += 1;
    let connection: RTCPeerConnection;
    try {
      connection = this.createConnection();
    } catch (error) {
      this.activeUploadConnections -= 1;
      throw error;
    }
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("Incoming WebRTC request timed out")),
      this.timeoutMs,
    );
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      this.activeUploadConnections -= 1;
      this.closeConnection(connection);
    };
    controller.signal.addEventListener("abort", finish, { once: true });
    connection.addEventListener("connectionstatechange", () => {
      if (["failed", "closed"].includes(connection.connectionState)) finish();
    });
    connection.ondatachannel = (event): void => {
      if (event.channel.label !== DATA_CHANNEL_LABEL) {
        event.channel.close();
        finish();
        return;
      }
      void this.serveSegment(event.channel, controller.signal)
        .catch((error: unknown) => {
          if (!controller.signal.aborted) {
            logger.warn("browser_webrtc_upload_failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        })
        .finally(finish);
    };
    try {
      await connection.setRemoteDescription({ type: "offer", sdp: message.sdp });
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      await this.waitForIce(connection, controller.signal);
      const sdp = connection.localDescription?.sdp;
      if (!sdp) throw new Error("WebRTC answer did not contain SDP");
      this.options.sendSignal({
        type: "webrtc_answer",
        broadcastId: this.options.broadcastId,
        peerId: this.options.peerId,
        targetPeerId: message.peerId,
        requestId: message.requestId,
        sdp,
      });
    } catch (error) {
      finish();
      throw error;
    }
  }

  private async serveSegment(
    channel: RTCDataChannel,
    signal: AbortSignal,
  ): Promise<void> {
    channel.binaryType = "arraybuffer";
    const segmentId = await this.waitForRequest(channel, signal);
    const data = await this.options.segmentProvider(segmentId);
    const receipt = this.waitForReceipt(channel, segmentId, signal);
    void receipt.catch(() => undefined);
    if (!data) {
      this.sendControl(channel, {
        type: "segment_error",
        segmentName: segmentId,
        message: "Segment not found",
      });
      await receipt;
      return;
    }
    const chunkCount = Math.ceil(data.byteLength / MAX_CHUNK_BYTES);
    this.sendControl(channel, {
      type: "segment_response",
      segmentName: segmentId,
      byteLength: data.byteLength,
      chunkCount,
    });
    const startedAt = performance.now();
    let sentBytes = 0;
    for (let offset = 0; offset < data.byteLength; offset += MAX_CHUNK_BYTES) {
      await this.waitForSendCapacity(channel, signal);
      const chunk = data.subarray(offset, Math.min(offset + MAX_CHUNK_BYTES, data.byteLength));
      const frame = new Uint8Array(chunk.byteLength);
      frame.set(chunk);
      channel.send(frame.buffer);
      sentBytes += chunk.byteLength;
      this.options.onUpload?.(chunk.byteLength);
      await this.limitUpload(startedAt, sentBytes, signal);
    }
    await this.waitForBufferedData(channel, signal);
    await receipt;
    channel.close();
  }

  private waitForRequest(
    channel: RTCDataChannel,
    signal: AbortSignal,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        channel.removeEventListener("message", onMessage);
        channel.removeEventListener("error", onError);
        channel.removeEventListener("close", onClose);
        signal.removeEventListener("abort", onAbort);
      };
      const fail = (error: Error): void => { cleanup(); reject(error); };
      const onMessage = (event: MessageEvent): void => {
        try {
          if (typeof event.data !== "string") throw new Error("Expected segment request");
          const message = parseObject(event.data);
          if (
            message.type !== "segment_request" ||
            typeof message.segmentName !== "string" ||
            !isSegmentId(message.segmentName)
          ) {
            throw new Error("Invalid segment request");
          }
          cleanup();
          resolve(message.segmentName);
        } catch (error) {
          fail(errorFrom(error, "Invalid segment request"));
        }
      };
      const onError = (): void => fail(new Error("DataChannel request failed"));
      const onClose = (): void => fail(new Error("DataChannel closed before request"));
      const onAbort = (): void => fail(abortError(signal));
      channel.addEventListener("message", onMessage);
      channel.addEventListener("error", onError);
      channel.addEventListener("close", onClose);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  private waitForReceipt(
    channel: RTCDataChannel,
    segmentId: string,
    signal: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        channel.removeEventListener("message", onMessage);
        channel.removeEventListener("error", onError);
        channel.removeEventListener("close", onClose);
        signal.removeEventListener("abort", onAbort);
      };
      const fail = (error: Error): void => { cleanup(); reject(error); };
      const onMessage = (event: MessageEvent): void => {
        if (typeof event.data !== "string") return;
        try {
          const message = parseObject(event.data);
          if (message.type !== "segment_received" || message.segmentName !== segmentId) return;
          cleanup();
          resolve();
        } catch (error) {
          fail(errorFrom(error, "Invalid segment receipt"));
        }
      };
      const onError = (): void => fail(new Error("DataChannel receipt failed"));
      const onClose = (): void => fail(new Error("DataChannel closed before receipt"));
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
    segmentId: string,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const chunks: Uint8Array[] = [];
      let expectedBytes: number | undefined;
      let expectedChunks: number | undefined;
      let receivedBytes = 0;
      const cleanup = (): void => {
        channel.removeEventListener("message", onMessage);
        channel.removeEventListener("error", onError);
        channel.removeEventListener("close", onClose);
        signal.removeEventListener("abort", onAbort);
      };
      const fail = (error: Error): void => { cleanup(); reject(error); };
      const complete = (): void => {
        if (expectedBytes === undefined || expectedChunks === undefined || chunks.length !== expectedChunks) return;
        if (receivedBytes !== expectedBytes) {
          fail(new Error("WebRTC response length mismatch"));
          return;
        }
        const result = new Uint8Array(receivedBytes);
        let offset = 0;
        for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
        channel.send(JSON.stringify({ type: "segment_received", segmentName: segmentId }));
        cleanup();
        resolve(result);
      };
      const onMessage = (event: MessageEvent): void => {
        try {
          if (typeof event.data === "string") {
            const message = parseObject(event.data);
            if (message.type === "segment_error") {
              channel.send(JSON.stringify({ type: "segment_received", segmentName: segmentId }));
              throw new Error(typeof message.message === "string" ? message.message : "Segment unavailable");
            }
            if (
              message.type !== "segment_response" ||
              message.segmentName !== segmentId ||
              typeof message.byteLength !== "number" ||
              typeof message.chunkCount !== "number" ||
              !Number.isSafeInteger(message.byteLength) ||
              !Number.isSafeInteger(message.chunkCount) ||
              message.byteLength < 0 ||
              message.chunkCount < 0
            ) {
              throw new Error("Invalid WebRTC response metadata");
            }
            expectedBytes = message.byteLength;
            expectedChunks = message.chunkCount;
            complete();
            return;
          }
          const chunk = binaryBytes(event.data);
          if (expectedBytes === undefined || expectedChunks === undefined || !chunk) {
            throw new Error("Invalid WebRTC response chunk");
          }
          if (chunk.byteLength > MAX_CHUNK_BYTES) throw new Error("WebRTC chunk too large");
          chunks.push(chunk);
          receivedBytes += chunk.byteLength;
          if (chunks.length > expectedChunks || receivedBytes > expectedBytes) {
            throw new Error("WebRTC response exceeded declared size");
          }
          complete();
        } catch (error) {
          fail(errorFrom(error, "Invalid WebRTC response"));
        }
      };
      const onError = (): void => fail(new Error("DataChannel receive failed"));
      const onClose = (): void => fail(new Error("DataChannel closed before response"));
      const onAbort = (): void => fail(abortError(signal));
      channel.addEventListener("message", onMessage);
      channel.addEventListener("error", onError);
      channel.addEventListener("close", onClose);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  private sendControl(channel: RTCDataChannel, message: JsonObject): void {
    if (channel.readyState !== "open") throw new Error("DataChannel is not open");
    channel.send(JSON.stringify(message));
  }

  private waitForChannelOpen(channel: RTCDataChannel, signal: AbortSignal): Promise<void> {
    if (channel.readyState === "open") return Promise.resolve();
    return this.waitForEvent(channel, "open", signal, "DataChannel failed to open");
  }

  private waitForIce(connection: RTCPeerConnection, signal: AbortSignal): Promise<void> {
    if (connection.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        connection.removeEventListener("icecandidate", onCandidate);
        signal.removeEventListener("abort", onAbort);
      };
      const onCandidate = (event: RTCPeerConnectionIceEvent): void => {
        if (event.candidate !== null) return;
        cleanup();
        resolve();
      };
      const onAbort = (): void => { cleanup(); reject(abortError(signal)); };
      connection.addEventListener("icecandidate", onCandidate);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  private async waitForSendCapacity(channel: RTCDataChannel, signal: AbortSignal): Promise<void> {
    if (channel.bufferedAmount <= MAX_BUFFERED_BYTES) return;
    channel.bufferedAmountLowThreshold = MAX_BUFFERED_BYTES / 2;
    if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) return;
    await this.waitForEvent(channel, "bufferedamountlow", signal, "DataChannel buffering failed");
  }

  private async waitForBufferedData(channel: RTCDataChannel, signal: AbortSignal): Promise<void> {
    if (channel.bufferedAmount === 0) return;
    channel.bufferedAmountLowThreshold = 0;
    if (channel.bufferedAmount === 0) return;
    await this.waitForEvent(channel, "bufferedamountlow", signal, "DataChannel flush failed");
  }

  private waitForEvent(
    target: EventTarget,
    eventName: string,
    signal: AbortSignal,
    message: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        target.removeEventListener(eventName, onSuccess);
        target.removeEventListener("error", onError);
        target.removeEventListener("close", onClose);
        signal.removeEventListener("abort", onAbort);
      };
      const onSuccess = (): void => { cleanup(); resolve(); };
      const onError = (): void => { cleanup(); reject(new Error(message)); };
      const onClose = (): void => { cleanup(); reject(new Error(message)); };
      const onAbort = (): void => { cleanup(); reject(abortError(signal)); };
      target.addEventListener(eventName, onSuccess, { once: true });
      target.addEventListener("error", onError, { once: true });
      target.addEventListener("close", onClose, { once: true });
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  private async limitUpload(
    startedAt: number,
    sentBytes: number,
    signal: AbortSignal,
  ): Promise<void> {
    const expectedMs = (sentBytes * 8 * 1000) / this.maxUploadBitrate;
    const delayMs = expectedMs - (performance.now() - startedAt);
    if (delayMs <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); resolve(); }, delayMs);
      const onAbort = (): void => { cleanup(); reject(abortError(signal)); };
      const cleanup = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }
}
