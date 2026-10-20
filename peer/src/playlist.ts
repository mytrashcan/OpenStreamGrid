import { isMediaSegmentFileName } from "@openstreamgrid/common";

/** Media segment file names listed in an HLS media playlist. */
export const playlistSegments = (playlist: string, playlistUrl: URL): string[] =>
  playlist
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => pathName(new URL(line, playlistUrl)))
    .filter((name): name is string => name !== undefined);

const pathName = (url: URL): string | undefined => {
  const name = url.pathname.split("/").at(-1);
  // Media segments only; init segments stay on the origin.
  return name && isMediaSegmentFileName(name) ? name : undefined;
};

/** A variant listed in an HLS multivariant playlist. */
export interface PlaylistVariant {
  url: URL;
  bandwidth: number;
}

/** Variants (`EXT-X-STREAM-INF`) listed in a multivariant playlist; empty for a media playlist. */
export const playlistVariants = (playlist: string, playlistUrl: URL): PlaylistVariant[] => {
  const variants: PlaylistVariant[] = [];
  let bandwidth: number | undefined;
  for (const rawLine of playlist.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const match = /(?:^|[:,])BANDWIDTH=(\d+)/.exec(line);
      bandwidth = match?.[1] ? Number(match[1]) : Number.POSITIVE_INFINITY;
    } else if (bandwidth !== undefined && line !== "" && !line.startsWith("#")) {
      variants.push({ url: new URL(line, playlistUrl), bandwidth });
      bandwidth = undefined;
    }
  }
  return variants;
};

const variantNames = (url: URL): string[] => {
  const segments = url.pathname.split("/");
  const fileName = segments.at(-1) ?? "";
  return [segments.at(-2) ?? "", fileName.replace(/\.m3u8$/, "")].filter((name) => name !== "");
};

/**
 * The variant whose directory or file stem is `rendition`, or without one the
 * lowest-bandwidth variant, so peers that follow the same playlist pick the
 * same rendition and can share its segments.
 */
export const selectVariant = (
  variants: readonly PlaylistVariant[],
  rendition?: string,
): PlaylistVariant => {
  if (rendition !== undefined) {
    const named = variants.find((variant) => variantNames(variant.url).includes(rendition));
    if (!named) {
      const available = variants.flatMap((variant) => variantNames(variant.url).slice(0, 1));
      throw new Error(
        `Rendition '${rendition}' is not in the playlist (available: ${available.join(", ")})`,
      );
    }
    return named;
  }
  const [first, ...rest] = variants;
  if (!first) throw new Error("Multivariant playlist lists no variants");
  return rest.reduce(
    (lowest, variant) => (variant.bandwidth < lowest.bandwidth ? variant : lowest),
    first,
  );
};
