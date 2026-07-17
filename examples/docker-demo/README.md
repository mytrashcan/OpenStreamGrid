# Docker five-peer demo

This demo starts one tracker, one FFmpeg-backed HLS origin, and five Node peers on an isolated Docker bridge network. Peer 1 polls first; the other peers use staggered intervals so they can reuse its cached segments. Urgent or unavailable segments still come from the origin.

## Requirements

- Docker with Compose v2
- `curl`
- Optional: `jq` for formatted terminal statistics

## Run the demo

From the repository root:

```bash
bash examples/docker-demo/scripts/run-demo.sh
```

The script builds the images, waits for every health check, lets the stream warm up for 20 seconds, and prints the tracker counters and active peer IDs. Override the warm-up when needed:

```bash
WARMUP_SECONDS=40 bash examples/docker-demo/scripts/run-demo.sh
```

Open the live dashboard at `http://localhost:7070/dashboard`. The master HLS playlist is available at `http://localhost:8080/hls/stream.m3u8`, and peer health endpoints are mapped to ports `9091` through `9095`.

## What to verify

1. The dashboard reports five active peers.
2. Both P2P and Origin bars accumulate bytes. Origin traffic proves fallback remains available; P2P traffic proves segments are shared.
3. The mesh view shows peers linked when their caches overlap.
4. Stop one peer with `docker compose -f examples/docker-demo/docker-compose.demo.yml stop peer-3`. The other peers continue consuming segments through P2P and origin fallback.

Inspect peer delivery logs with:

```bash
docker compose -f examples/docker-demo/docker-compose.demo.yml logs -f peer-1 peer-2 peer-3 peer-4 peer-5
```

Stop and remove the demo containers and network:

```bash
docker compose -f examples/docker-demo/docker-compose.demo.yml down
```

The tracker uses its in-memory store in this demo, so no persistent volume is created.
