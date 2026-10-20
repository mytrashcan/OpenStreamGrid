# @openstreamgrid/sdk

Browser SDK for [OpenStreamGrid](https://github.com/mytrashcan/OpenStreamGrid),
a hybrid P2P-CDN middleware for HLS live streaming. The Hls.js plugin turns each
viewer into a zero-install WebRTC peer: it fetches verified segments from other
viewers when they can meet the playback deadline and falls back to your origin
or CDN otherwise.

## Install

```bash
npm install @openstreamgrid/sdk hls.js
```

`hls.js` 1.5 or later is an optional peer dependency: install it for the Hls.js
plugin. Shaka Player apps can leave it out (`npm install @openstreamgrid/sdk`);
only TypeScript projects with `skipLibCheck: false` then need hls.js for its
types.

## Usage

```ts
import Hls from "hls.js";
import { OpenStreamGridHlsPlugin } from "@openstreamgrid/sdk";

const hls = new Hls();
const plugin = new OpenStreamGridHlsPlugin({
  trackerUrl: "https://stream.example.com",
  broadcastId: "live",
  // Covers every rendition so segment verification accepts all qualities.
  originBaseUrl: "https://stream.example.com/hls",
});
plugin.attach(hls);
hls.loadSource("https://stream.example.com/hls/stream.m3u8");
hls.attachMedia(document.querySelector("video")!);
```

For Shaka Player, use `OpenStreamGridShakaPlugin` with the same options and call
`plugin.attach(shaka)` before loading the stream.

For players that create hls.js themselves, such as Video.js 10's
`<hlsjs-video>`, pass `plugin.hlsJsConfig(Hls.DefaultConfig.loader)` where the
player accepts hls.js options (`source.engine.hlsJs` in Video.js 10, with
`preferPlayback: "mse"`), then `plugin.attach()` the instance it creates.

Each viewer registers with the tracker and receives a short-lived peer session.
When the tracker is configured for TURN, it also issues short-lived TURN
credentials. Never put the tracker administrator API key in viewer code.

See the [project README](https://github.com/mytrashcan/OpenStreamGrid#zero-install-browser-peers)
for configuration options and the
[API reference](https://github.com/mytrashcan/OpenStreamGrid/blob/main/API_REFERENCE.md)
for events and signaling.

## License

MIT
