# OpenStreamGrid

OpenStreamGrid is a prototype hybrid P2P-CDN delivery middleware for live HLS
streams. The MVP runs a test-pattern origin, an in-memory tracker, and Node.js
peers that share verified HLS segments over HTTP while falling back to the
origin when a peer is unavailable.

## Run the MVP test

Requirements: Docker with Compose, `curl`, and Node.js 22 or newer.

```bash
./test/docker-test.sh
```

The test builds all images, waits for service health, confirms a peer-to-peer
segment transfer, forces a stale peer failure, and confirms the origin fallback
in tracker statistics. Set `KEEP_RUNNING=1` to leave the stack running after the
test.

Service endpoints:

- Tracker: `http://localhost:7070`
- Origin HLS: `http://localhost:8080/hls/stream.m3u8`
- Peer A health/upload server: `http://localhost:9091`
- Peer B health/upload server: `http://localhost:9092`

## Peer CLI

```bash
node peer/dist/client.js \
  --tracker-url http://localhost:7070 \
  --broadcast-id live \
  --origin-url http://localhost:8080/hls \
  --peer-address http://localhost:9090 \
  --cache-size 200MB \
  --max-upload-speed 1Mbps \
  --max-connections 3
```

`--peer-id` is optional; it defaults to `PEER_ID` or the local hostname. The
upload-speed value is in bits per second and controls a shared token bucket
across all active uploads.

## Local verification

```bash
npm install
npm run build
npm test
npm run typecheck
```
