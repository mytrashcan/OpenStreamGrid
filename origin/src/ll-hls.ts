/**
 * Test-only LL-HLS: FFmpeg's HLS muxer does not write partial segments, so
 * with HLS_PARTS_PER_SEGMENT the origin lists each recent MPEG-TS segment as
 * that many parts (`<segment>.part<k>.ts`) and serves each part as a slice of
 * the finished segment, cut at 188-byte TS packet boundaries. Parts are only
 * listed for completed segments, so players see LL-HLS without the latency
 * benefit, which is enough to exercise part loading in players and the SDK.
 */

const TS_PACKET_BYTES = 188;
/** Segments at the end of the playlist that get parts, as in real LL-HLS. */
const SEGMENTS_WITH_PARTS = 3;
const PART_NAME_PATTERN = /^(.+)\.part(\d+)\.ts$/;

/** The segment and index a part file name refers to, if it names a part. */
export const parsePartName = (
  fileName: string,
): { segmentName: string; index: number } | undefined => {
  const match = PART_NAME_PATTERN.exec(fileName);
  if (!match?.[1] || match[2] === undefined) return undefined;
  return { segmentName: `${match[1]}.ts`, index: Number(match[2]) };
};

/**
 * Byte range `[start, end)` of part `index` of `count` in a segment of `size`
 * bytes, aligned to TS packets; the last part takes the remainder.
 */
export const partRange = (
  size: number,
  index: number,
  count: number,
): { start: number; end: number } => {
  const packets = Math.floor(size / TS_PACKET_BYTES);
  const boundary = (part: number): number =>
    part >= count ? size : Math.floor((packets * part) / count) * TS_PACKET_BYTES;
  return { start: boundary(index), end: boundary(index + 1) };
};

const formatDuration = (seconds: number): string => seconds.toFixed(5);

/**
 * Adds LL-HLS part tags to an MPEG-TS media playlist: a part target, a server
 * control hold-back, and `EXT-X-PART` lines (the first independent) before
 * each of the last few segments. Other playlists are returned unchanged.
 */
export const addPartsToPlaylist = (playlist: string, partsPerSegment: number): string => {
  const lines = playlist.split("\n");
  if (partsPerSegment <= 0 || !lines.some((line) => line.startsWith("#EXTINF:"))) {
    return playlist;
  }
  const targetLine = lines.find((line) => line.startsWith("#EXT-X-TARGETDURATION:"));
  const targetDuration = Number(targetLine?.slice("#EXT-X-TARGETDURATION:".length));
  if (!Number.isFinite(targetDuration) || targetDuration <= 0) return playlist;
  const partTarget = targetDuration / partsPerSegment;

  const segmentIndexes = lines.flatMap((line, index) =>
    line.startsWith("#EXTINF:") ? [index] : [],
  );
  const withParts = new Set(segmentIndexes.slice(-SEGMENTS_WITH_PARTS));
  const output: string[] = [];
  lines.forEach((line, index) => {
    if (withParts.has(index)) {
      const duration = Number(line.slice("#EXTINF:".length).split(",")[0]);
      const uri = lines[index + 1]?.trim() ?? "";
      if (Number.isFinite(duration) && uri.endsWith(".ts")) {
        const base = uri.slice(0, -".ts".length);
        for (let part = 0; part < partsPerSegment; part += 1) {
          output.push(
            `#EXT-X-PART:DURATION=${formatDuration(duration / partsPerSegment)},` +
              `URI="${base}.part${part}.ts"${part === 0 ? ",INDEPENDENT=YES" : ""}`,
          );
        }
      }
    }
    output.push(line);
    if (line === targetLine) {
      output.push(
        `#EXT-X-PART-INF:PART-TARGET=${formatDuration(partTarget)}`,
        `#EXT-X-SERVER-CONTROL:PART-HOLD-BACK=${formatDuration(partTarget * 3)}`,
      );
    }
  });
  return output.join("\n");
};
