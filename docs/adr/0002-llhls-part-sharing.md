# ADR 0002: Sharing LL-HLS partial segments

- **Status:** Proposed. Option B is implemented as the opt-in SDK setting
  `assembleLowLatencySegments` (off by default); A remains the default
- **Date:** 2026-10-19
- **Scope:** browser SDK (Hls.js plugin), Node peer, tracker inventory protocol,
  origin sidecar writer

## Context

LL-HLS splits each media segment into partial segments (`EXT-X-PART`, usually
0.3 to 1 s) that a player can load before the whole segment exists. Players
near the live edge load parts; players further behind load complete segments.

Since #97 the Hls.js plugin sends part loads (`context.part`) straight to the
origin, and only complete segments go through the grid. That is correct and
safe, but a low-latency audience at the live edge loads almost nothing but
parts, so it gets little P2P offload.

What makes parts different from segments here:

| Concern | Complete segments today | Parts |
| --- | --- | --- |
| Integrity | `<segment>.sha256` sidecar from the origin or the sidecar writer | No sidecar. Parts may be separate files or byte ranges of the segment file |
| Deadline | Seconds; peers get a share of the budget before the origin | Roughly one part duration, often under a second |
| Inventory | One update per segment per peer, batched every 250 ms | Three to five times as many updates, and the 250 ms batch is close to a part's whole lifetime |
| Cache key | Segment file name | Part URI, or segment plus byte range |

## Decision drivers

1. Never weaken integrity: every byte a peer serves must be verified against
   something the origin published.
2. Never risk playback: the origin stays authoritative, and P2P must give up
   in time to meet the part's deadline.
3. Keep tracker load linear in the audience (#92, #96).
4. Prefer changes that work with unmodified packagers.

## Options

### A. Keep parts on the origin (status quo)

Parts always load from the origin; complete segments are shared.

- **Pros:** no new code or risk. Viewers behind the live edge, and players with
  low-latency mode off, still share complete segments.
- **Cons:** little offload for a low-latency audience at the edge, which is
  the audience LL-HLS exists for.

### B. Assemble complete segments from parts and share those

When a viewer has loaded every part of segment N, the SDK caches the
concatenated bytes as segment N, verifies them against segment N's existing
`.sha256` sidecar, and advertises segment N as usual. Peers that load complete
segments (viewers behind the edge, rejoining viewers, Node peers) can then get
N from these viewers instead of the origin.

- **Pros:** reuses the existing sidecars, inventory, and deadlines; no
  tracker or protocol change. Integrity holds because the assembled segment is
  verified against the origin's hash before it is shared.
- **Cons:** helps only viewers that load complete segments, so it does not
  offload the parts themselves. It depends on the packager producing parts
  whose concatenation equals the segment, which is true for CMAF chunked
  packaging but must be checked per packager; when the hash does not match,
  the SDK simply does not share the segment.
- **Effort:** small to medium, mostly in the Hls.js loader (track parts per
  segment, assemble on the last part, verify, cache).

### C. Share parts directly

Peers advertise and serve individual parts.

- **Pros:** offloads the live edge itself.
- **Cons:**
  - Integrity needs a sidecar per part, so the sidecar writer must learn
    `EXT-X-PART` and byte ranges, and the bundled origin must emit parts.
  - The deadlines are short enough that only already-connected neighbors with
    low round-trip times can help.
  - Part inventory either skips batching, which brings back the
    message volume that #92 removed, or arrives too late to be useful. An
    alternative is to announce progress ("has parts up to N.k") instead of
    each part.
- **Effort:** large, touching the SDK, Node peer, tracker protocol, sidecar
  writer, and origin. It needs an LL-HLS origin in the E2E, which the FFmpeg
  test origin cannot produce today.

## Recommendation

1. **Now:** keep **A**, which is already in place and safe.
2. **Next:** implement **B** behind an SDK option, off by default at first.
   Measure how much of a mixed audience (at the edge and behind it) it
   offloads, and which packagers satisfy the concatenation property.
3. **Only if B's offload is not enough for real low-latency audiences:** design
   **C**, starting with progress-based part inventory and per-part sidecars in
   the sidecar writer, and an LL-HLS-capable test origin for the E2E.

## Consequences

- With A and B, LL-HLS viewers at the live edge keep loading parts from the
  origin or CDN, which must be provisioned for that load.
- B adds no tracker or protocol cost, and a packager that breaks the
  concatenation property degrades to A rather than to a failure.
- C would be a protocol change (a new subscribe feature, as #92 and #96 used)
  and would need the capacity benchmark to model part inventory.
