import type { IncomingMessage } from "node:http";

/**
 * Returns the address used for per-client limits.
 *
 * Behind `trustedProxyHops` reverse proxies (a TLS terminator, a Kubernetes
 * ingress, a CDN), every request arrives from the last proxy, so the socket
 * address would put all viewers into one rate-limit bucket. Each trusted proxy
 * appends the address it received the request from to `X-Forwarded-For`; the
 * entry `trustedProxyHops` positions from the end is the client as seen by the
 * outermost trusted proxy. Entries further left are client-controlled and are
 * ignored.
 *
 * Only enable this when the tracker is reachable exclusively through that proxy
 * chain; otherwise a client could choose its own address.
 */
export const clientAddress = (
  request: Pick<IncomingMessage, "headers" | "socket">,
  trustedProxyHops: number,
): string => {
  const socketAddress = request.socket?.remoteAddress ?? "unknown";
  if (trustedProxyHops <= 0) return socketAddress;
  const header = request.headers["x-forwarded-for"];
  const hops = (Array.isArray(header) ? header.join(",") : header ?? "")
    .split(",")
    .map((hop) => withoutPort(hop.trim()))
    .filter((hop) => hop !== "");
  return hops[hops.length - trustedProxyHops] ?? hops[0] ?? socketAddress;
};

/**
 * Some proxies record `ip:port`; keying limits on the port would give every
 * connection its own bucket. Strips the port from `a.b.c.d:port` and
 * `[ipv6]:port` and leaves bare IPv6 addresses alone.
 */
const withoutPort = (hop: string): string => {
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(hop);
  if (bracketed?.[1]) return bracketed[1];
  const ipv4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(hop);
  return ipv4WithPort?.[1] ?? hop;
};
