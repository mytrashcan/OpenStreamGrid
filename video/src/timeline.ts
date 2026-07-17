export const FPS = 30;

export interface Caption {
  id: string;
  start: number;
  end: number;
  text: string;
}

export const captions: Caption[] = [
  {
    id: "01-problem",
    start: 0.8,
    end: 8.0,
    text: "In centralized live streaming, every viewer pulls the same HLS segments from delivery infrastructure.",
  },
  {
    id: "02-intro",
    start: 8.3,
    end: 16.0,
    text: "OpenStreamGrid is an open, platform-independent hybrid P2P-CDN testbed for HLS live streaming.",
  },
  {
    id: "03-architecture",
    start: 16.3,
    end: 25.0,
    text: "The origin publishes three renditions. A tracker coordinates broadcasts, peers, segments, and live statistics.",
  },
  {
    id: "04-peer-flow",
    start: 25.3,
    end: 33.5,
    text: "Peers cache and verify segments, announce availability, and serve them over WebRTC or HTTP.",
  },
  {
    id: "05-fallback",
    start: 33.8,
    end: 41.0,
    text: "If a peer is missing, late, or untrusted, the client immediately falls back to the origin.",
  },
  {
    id: "06-demo",
    start: 41.3,
    end: 49.5,
    text: "In the real Docker demo, two peers joined, advertised cached segments, and completed peer-to-peer transfers.",
  },
  {
    id: "07-evidence",
    start: 49.8,
    end: 58.5,
    text: "After disconnecting peers, the same run recorded four origin fallbacks and preserved traffic data through a tracker restart.",
  },
  {
    id: "08-scope",
    start: 58.8,
    end: 68.5,
    text: "This local prototype is reproducible, but not a production benchmark. It demonstrates hybrid routing, integrity, and resilience.",
  },
  {
    id: "09-close",
    start: 69.0,
    end: 77.2,
    text: "OpenStreamGrid explores a more distributed and resilient approach to live-stream delivery.",
  },
];

export const frameAt = (seconds: number): number => Math.round(seconds * FPS);
