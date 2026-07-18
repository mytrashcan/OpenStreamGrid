import { OpenStreamGridHlsPlugin, type SdkEvent } from "@openstreamgrid/sdk";
import Hls from "hls.js";
import { useEffect, useRef } from "react";

export interface DeliverySnapshot {
  connected: boolean;
  peerCount: number;
  p2pBytes: number;
  originBytes: number;
  lastSource: "idle" | "p2p" | "origin";
}

interface VideoPlayerProps {
  streamUrl: string;
  trackerUrl: string;
  broadcastId: string;
  originBaseUrl: string;
  onSnapshot: (snapshot: DeliverySnapshot) => void;
  onEvent: (event: SdkEvent) => void;
}

const EMPTY_SNAPSHOT: DeliverySnapshot = {
  connected: false,
  peerCount: 0,
  p2pBytes: 0,
  originBytes: 0,
  lastSource: "idle",
};

/** Owns the imperative Hls.js and OpenStreamGrid lifecycle for a React tree. */
export function VideoPlayer({
  streamUrl,
  trackerUrl,
  broadcastId,
  originBaseUrl,
  onSnapshot,
  onEvent,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const onSnapshotRef = useRef(onSnapshot);
  const onEventRef = useRef(onEvent);

  useEffect(() => {
    onSnapshotRef.current = onSnapshot;
    onEventRef.current = onEvent;
  }, [onEvent, onSnapshot]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (!Hls.isSupported()) {
      onEventRef.current({
        type: "ws_error",
        message: "This browser does not support Media Source Extensions.",
      });
      return;
    }

    let connected = false;
    let lastSource: DeliverySnapshot["lastSource"] = "idle";
    const publishSnapshot = (plugin: OpenStreamGridHlsPlugin) => {
      onSnapshotRef.current({
        connected,
        peerCount: plugin.wsClient.getAllPeers().length,
        p2pBytes: plugin.stats.bytesDownloadedP2P,
        originBytes: plugin.stats.bytesDownloadedOrigin,
        lastSource,
      });
    };

    const plugin = new OpenStreamGridHlsPlugin({
      trackerUrl,
      broadcastId,
      originBaseUrl,
      // Keep local negotiation inside the loopback network.
      iceServers: [],
      onReady: () => {
        connected = true;
        publishSnapshot(plugin);
      },
      onEvent: (event: SdkEvent) => {
        if (event.type === "peer_fetched") lastSource = "p2p";
        if (event.type === "origin_fallback") lastSource = "origin";
        if (event.type === "ws_disconnected") connected = false;
        onEventRef.current(event);
        publishSnapshot(plugin);
      },
    });
    const hls = new Hls({ enableWorker: true, lowLatencyMode: true });

    plugin.attach(hls);
    hls.loadSource(streamUrl);
    hls.attachMedia(video);
    const interval = window.setInterval(() => publishSnapshot(plugin), 1000);

    return () => {
      window.clearInterval(interval);
      plugin.detach();
      hls.destroy();
      onSnapshotRef.current(EMPTY_SNAPSHOT);
    };
  }, [broadcastId, originBaseUrl, streamUrl, trackerUrl]);

  return <video ref={videoRef} controls muted autoPlay playsInline />;
}
