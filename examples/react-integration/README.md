# React integration example

This Vite app demonstrates the recommended React boundary: React owns configuration and display state, while `VideoPlayer` owns the imperative Hls.js and OpenStreamGrid lifecycle.

## Run it

Start the local OpenStreamGrid stack from the repository root:

```bash
docker compose up --build
```

In another terminal, build the local SDK and start the example:

```bash
npm --prefix sdk run build
cd examples/react-integration
npm install
npm run dev
```

Open `http://localhost:5173`. The app connects to the tracker at `http://localhost:7070`, joins broadcast `live`, and plays `http://localhost:8080/hls/stream.m3u8`.

Open the page in two browser windows to create two zero-install viewer peers.
After both windows cache overlapping segments, the delivery counters show
browser-to-browser WebRTC traffic without an extension or native executable.
The local example uses host ICE candidates for fast loopback negotiation;
replace `iceServers: []` with production STUN/TURN configuration before
deploying across networks.

## Production integration notes

- Instantiate one `OpenStreamGridHlsPlugin` per Hls.js player and call `detach()` during React effect cleanup.
- Attach the plugin before `loadSource()` so it can install the hybrid segment loader.
- Serve the page, tracker, origin, and peer endpoints over HTTPS in production. Browsers block mixed-content requests from HTTPS pages.
- The tracker enables REST CORS for browser registration. Configure CORS on any separate origin or peer HTTP endpoints as needed.
- Configure a production TURN service; public STUN alone does not cover restrictive NATs and firewalls.
- Use short-lived TURN credentials rather than embedding permanent secrets in the page.
- Pass deployment URLs through your app's environment configuration instead of hard-coding the local defaults used here.
