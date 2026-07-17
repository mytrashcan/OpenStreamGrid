import { useCallback, useState } from "react";
import type { SdkEvent } from "@openstreamgrid/sdk";
import { VideoPlayer, type DeliverySnapshot } from "./video-player";

const TRACKER_URL = "http://localhost:7070";
const STREAM_URL = "http://localhost:8080/hls/stream.m3u8";
const ORIGIN_BASE_URL = "http://localhost:8080/hls";

const INITIAL_SNAPSHOT: DeliverySnapshot = {
  connected: false,
  peerCount: 0,
  p2pBytes: 0,
  originBytes: 0,
  lastSource: "idle",
};

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
};

export default function App() {
  const [snapshot, setSnapshot] = useState(INITIAL_SNAPSHOT);
  const [latestEvent, setLatestEvent] = useState("Waiting for segment delivery");

  const handleEvent = useCallback((event: SdkEvent) => {
    const segment = event.segment ? ` · ${event.segment}` : "";
    setLatestEvent(`${event.type.replaceAll("_", " ")}${segment}`);
  }, []);

  const totalBytes = snapshot.p2pBytes + snapshot.originBytes;
  const p2pShare = totalBytes === 0 ? 0 : (snapshot.p2pBytes / totalBytes) * 100;

  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">React integration</p>
          <h1>OpenStreamGrid + Hls.js</h1>
          <p className="subtitle">
            A small wrapper component owns the player lifecycle while React renders live delivery state.
          </p>
        </div>
        <span className={`connection ${snapshot.connected ? "online" : ""}`}>
          <i /> {snapshot.connected ? "Tracker connected" : "Connecting"}
        </span>
      </header>

      <section className="player">
        <VideoPlayer
          trackerUrl={TRACKER_URL}
          broadcastId="live"
          streamUrl={STREAM_URL}
          originBaseUrl={ORIGIN_BASE_URL}
          onSnapshot={setSnapshot}
          onEvent={handleEvent}
        />
        <div className={`source ${snapshot.lastSource}`}>
          Current source: {snapshot.lastSource === "p2p" ? "Peer mesh" : snapshot.lastSource === "origin" ? "Origin / CDN" : "Waiting"}
        </div>
      </section>

      <section className="metrics">
        <article><span>Peers</span><strong>{snapshot.peerCount}</strong></article>
        <article><span>P2P traffic</span><strong>{formatBytes(snapshot.p2pBytes)}</strong></article>
        <article><span>Origin traffic</span><strong>{formatBytes(snapshot.originBytes)}</strong></article>
        <article><span>P2P share</span><strong>{p2pShare.toFixed(1)}%</strong></article>
      </section>

      <p className="event">Latest event: <strong>{latestEvent}</strong></p>
    </main>
  );
}
