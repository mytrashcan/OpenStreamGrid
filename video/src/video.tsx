import {
  AbsoluteFill,
  Audio,
  Easing,
  interpolate,
  Sequence,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { captions, frameAt } from "./timeline";

const COLORS = {
  bg: "#07111f",
  panel: "#0d1d30",
  ink: "#f3f8ff",
  muted: "#94a8c0",
  cyan: "#42d9ff",
  green: "#58e29b",
  amber: "#ffbd5c",
  red: "#ff6b78",
};

const appear = (frame: number, start = 0, duration = 18): number =>
  interpolate(frame, [start, start + duration], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

const Brand = (): React.JSX.Element => (
  <div className="brand">
    <div className="brand-mark"><span /><span /><span /></div>
    <span>OpenStreamGrid</span>
  </div>
);

const CaptionLayer = (): React.JSX.Element | null => {
  const frame = useCurrentFrame();
  const current = captions.find(
    ({ start, end }) => frame >= frameAt(start) && frame < frameAt(end),
  );
  if (!current) return null;
  return <div className="caption">{current.text}</div>;
};

const DotGrid = (): React.JSX.Element => <div className="dot-grid" />;

const SceneShell = ({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}): React.JSX.Element => {
  const frame = useCurrentFrame();
  const opacity = appear(frame);
  return (
    <AbsoluteFill className="scene">
      <DotGrid />
      <Brand />
      <div className="scene-heading" style={{ opacity, transform: `translateY(${(1 - opacity) * 28}px)` }}>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
      </div>
      {children}
    </AbsoluteFill>
  );
};

const ProblemScene = (): React.JSX.Element => {
  const frame = useCurrentFrame();
  const viewers = Array.from({ length: 8 }, (_, index) => index);
  return (
    <SceneShell eyebrow="THE DELIVERY PROBLEM" title="One live stream. Repeated delivery.">
      <div className="problem-layout">
        <Node icon="▦" label="Origin / CDN" tone="amber" />
        <div className="fan-lines">
          {viewers.map((index) => {
            const progress = interpolate(frame - index * 3, [22, 70], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            });
            return <div key={index} className="fan-line" style={{ opacity: 0.2 + progress * 0.8 }} />;
          })}
        </div>
        <div className="viewer-grid">
          {viewers.map((index) => <Node key={index} icon="▶" label={`Viewer ${index + 1}`} compact />)}
        </div>
      </div>
      <div className="callout bottom-left">The same segments cross the origin boundary again and again.</div>
    </SceneShell>
  );
};

const IntroScene = (): React.JSX.Element => {
  const frame = useCurrentFrame();
  const scale = interpolate(frame, [0, 35], [0.9, 1], { extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  return (
    <AbsoluteFill className="intro-scene">
      <DotGrid />
      <div className="hero-mark" style={{ transform: `scale(${scale})` }}><span /><span /><span /></div>
      <div className="hero-kicker">HYBRID P2P + CDN</div>
      <div className="hero-title">OpenStreamGrid</div>
      <div className="hero-subtitle">A platform-independent HLS delivery middleware prototype</div>
      <div className="pill-row"><span>Open source</span><span>Standards based</span><span>Origin fallback</span></div>
    </AbsoluteFill>
  );
};

const Node = ({ icon, label, tone = "cyan", compact = false }: { icon: string; label: string; tone?: "cyan" | "green" | "amber"; compact?: boolean }): React.JSX.Element => (
  <div className={`node ${compact ? "compact" : ""} ${tone}`}>
    <div className="node-icon">{icon}</div>
    <div>{label}</div>
  </div>
);

const ArchitectureScene = (): React.JSX.Element => {
  const frame = useCurrentFrame();
  const packet = (offset: number): number => ((frame + offset) % 90) / 90;
  return (
    <SceneShell eyebrow="VERIFIED ARCHITECTURE" title="Coordinate centrally. Deliver collaboratively.">
      <div className="architecture">
        <Node icon="◉" label="FFmpeg Origin" tone="amber" />
        <div className="arch-link horizontal"><i style={{ left: `${packet(0) * 100}%` }} /></div>
        <Node icon="⌘" label="Tracker + SQLite" />
        <div className="arch-link horizontal"><i style={{ left: `${packet(35) * 100}%` }} /></div>
        <div className="peer-cluster">
          <Node icon="A" label="Peer A" tone="green" />
          <div className="peer-link"><i style={{ left: `${packet(60) * 100}%` }} /></div>
          <Node icon="B" label="Peer B" tone="green" />
        </div>
      </div>
      <div className="feature-strip">
        <span>HLS: 360p · 480p · 720p</span>
        <span>WebSocket signaling</span>
        <span>HTTP + experimental WebRTC</span>
      </div>
    </SceneShell>
  );
};

const FlowScene = (): React.JSX.Element => {
  const frame = useCurrentFrame();
  const phase = Math.floor(frame / 55) % 3;
  const steps = [
    ["1", "Discover", "Tracker returns peers with the segment"],
    ["2", "Verify", "SHA-256 validates received bytes"],
    ["3", "Fallback", "Origin serves on peer failure or timeout"],
  ];
  return (
    <SceneShell eyebrow="HYBRID REQUEST FLOW" title="Peer first when useful. Origin when needed.">
      <div className="flow-steps">
        {steps.map(([number, title, body], index) => (
          <div key={title} className={`flow-card ${phase === index ? "active" : ""}`}>
            <div className="step-number">{number}</div><h2>{title}</h2><p>{body}</p>
          </div>
        ))}
      </div>
      <div className="routing-legend"><span className="green-dot" /> Peer delivery <span className="amber-dot" /> Origin fallback</div>
    </SceneShell>
  );
};

const terminalLines = [
  "[E2E] Tracker reports 2 connected peers",
  "[E2E] peer-a advertises 6 cached segments",
  "[E2E] p2pSuccesses reached 1",
  "[E2E] fallbacks reached 4",
  "[E2E] A peer completed a P2P transfer through HTTP",
  "[E2E] Broadcast and traffic data survived the tracker restart",
  "[E2E] All Phase 4 E2E checks passed",
];

const DemoScene = (): React.JSX.Element => {
  const frame = useCurrentFrame();
  const visible = Math.min(terminalLines.length, Math.floor(frame / 24) + 1);
  return (
    <SceneShell eyebrow="ACTUAL DOCKER DEMO" title="Real services. Real segment exchange.">
      <div className="demo-layout">
        <div className="terminal">
          <div className="terminal-bar"><span /><span /><span /><b>scripts/e2e-test.sh</b></div>
          <div className="terminal-body">
            {terminalLines.slice(0, visible).map((line, index) => <div key={line} className={index === terminalLines.length - 1 ? "terminal-success" : ""}>{line}</div>)}
            <div className="cursor">▋</div>
          </div>
        </div>
        <div className="demo-badges">
          <Metric value="2" label="Connected peers" tone="cyan" />
          <Metric value="SHA-256" label="Integrity verified" tone="green" />
          <Metric value="PASS" label="Docker E2E" tone="green" />
        </div>
      </div>
    </SceneShell>
  );
};

const Metric = ({ value, label, tone }: { value: string; label: string; tone: string }): React.JSX.Element => (
  <div className={`metric ${tone}`}><strong>{value}</strong><span>{label}</span></div>
);

const EvidenceScene = (): React.JSX.Element => (
  <SceneShell eyebrow="ONE VERIFIED LOCAL RUN" title="Measured evidence, scoped honestly.">
    <div className="metrics-grid">
      <Metric value="1.64 MB" label="Downloaded via P2P" tone="green" />
      <Metric value="36.08 MB" label="Downloaded via Origin" tone="amber" />
      <Metric value="4.35%" label="P2P traffic ratio" tone="cyan" />
      <Metric value="4" label="Forced origin fallbacks" tone="red" />
    </div>
    <div className="evidence-note">Prototype evidence from the captured Docker run · not a production benchmark</div>
  </SceneShell>
);

const ScopeScene = (): React.JSX.Element => (
  <SceneShell eyebrow="WHAT THE PROTOTYPE PROVES" title="Useful middleware, without inflated claims.">
    <div className="scope-columns">
      <div className="scope-panel verified"><h2>Demonstrated</h2><ul><li>HLS generation and SHA-256 hashes</li><li>Tracker-based peer discovery</li><li>Peer transfer with origin fallback</li><li>Traffic statistics and SQLite persistence</li></ul></div>
      <div className="scope-panel boundary"><h2>Current boundary</h2><ul><li>Local or Docker network testbed</li><li>WebRTC transport remains experimental</li><li>No production-scale savings claim</li><li>No commercial platform dependency</li></ul></div>
    </div>
  </SceneShell>
);

const ClosingScene = (): React.JSX.Element => {
  const frame = useCurrentFrame();
  const glow = 0.75 + Math.sin(frame / 16) * 0.12;
  return (
    <AbsoluteFill className="closing">
      <DotGrid />
      <div className="hero-mark" style={{ filter: `drop-shadow(0 0 60px rgba(66,217,255,${glow}))` }}><span /><span /><span /></div>
      <div className="hero-title">OpenStreamGrid</div>
      <div className="closing-tagline">Distributed when possible. Reliable by design.</div>
      <div className="repo">github.com/mytrashcan/OpenStreamGrid</div>
      <div className="devpost">Explore the prototype on Devpost</div>
    </AbsoluteFill>
  );
};

const Scene = ({ from, duration, children }: { from: number; duration: number; children: React.ReactNode }): React.JSX.Element => (
  <Sequence from={frameAt(from)} durationInFrames={frameAt(duration)}>{children}</Sequence>
);

export const OpenStreamGridVideo = (): React.JSX.Element => (
  <AbsoluteFill style={{ backgroundColor: COLORS.bg, color: COLORS.ink }}>
    <Audio src={staticFile("audio/ambient.wav")} volume={0.065} />
    {captions.map((caption) => (
      <Sequence key={caption.id} from={frameAt(caption.start)} durationInFrames={frameAt(caption.end - caption.start)}>
        <Audio src={staticFile(`audio/${caption.id}.wav`)} volume={1} />
      </Sequence>
    ))}
    <Scene from={0} duration={8.2}><ProblemScene /></Scene>
    <Scene from={8.2} duration={8.0}><IntroScene /></Scene>
    <Scene from={16.2} duration={9.0}><ArchitectureScene /></Scene>
    <Scene from={25.2} duration={16.0}><FlowScene /></Scene>
    <Scene from={41.2} duration={8.5}><DemoScene /></Scene>
    <Scene from={49.7} duration={9.0}><EvidenceScene /></Scene>
    <Scene from={58.7} duration={10.1}><ScopeScene /></Scene>
    <Scene from={68.8} duration={9.2}><ClosingScene /></Scene>
    <CaptionLayer />
  </AbsoluteFill>
);
