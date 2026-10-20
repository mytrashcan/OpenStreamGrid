import {
  Agent as HttpAgent,
  request as httpRequest,
  type IncomingMessage,
  type RequestOptions,
} from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, type LookupFunction } from "node:net";

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

const AGENT_OPTIONS = {
  keepAlive: true,
  keepAliveMsecs: 1_000,
  maxFreeSockets: 16,
  maxSockets: 64,
};

/**
 * Addresses a peer must not make other peers connect to: loopback,
 * unspecified, and link-local (cloud metadata endpoints), including their
 * IPv4-mapped IPv6 forms. The tracker rejects these as literal peer
 * addresses; this catches host names that resolve to them.
 */
const RESERVED_PEER_ADDRESSES = new BlockList();
RESERVED_PEER_ADDRESSES.addSubnet("127.0.0.0", 8, "ipv4");
RESERVED_PEER_ADDRESSES.addSubnet("169.254.0.0", 16, "ipv4");
RESERVED_PEER_ADDRESSES.addAddress("0.0.0.0", "ipv4");
RESERVED_PEER_ADDRESSES.addAddress("::", "ipv6");
RESERVED_PEER_ADDRESSES.addAddress("::1", "ipv6");
RESERVED_PEER_ADDRESSES.addSubnet("fe80::", 10, "ipv6");
RESERVED_PEER_ADDRESSES.addSubnet("::ffff:127.0.0.0", 104, "ipv6");
RESERVED_PEER_ADDRESSES.addSubnet("::ffff:169.254.0.0", 112, "ipv6");
RESERVED_PEER_ADDRESSES.addAddress("::ffff:0.0.0.0", "ipv6");

/** True if `address` is one other peers must not be sent to. */
export const isReservedPeerAddress = (address: string, family: number | string): boolean =>
  RESERVED_PEER_ADDRESSES.check(address, family === 6 || family === "IPv6" ? "ipv6" : "ipv4");

/** DNS lookup that fails when a peer host name resolves to a reserved address. */
const reservedAddressGuard: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
    if (error) {
      callback(error, "", 0);
      return;
    }
    const reserved = addresses.find(({ address, family }) =>
      isReservedPeerAddress(address, family),
    );
    if (reserved) {
      const failure: NodeJS.ErrnoException = new Error(
        `Peer host ${hostname} resolves to reserved address ${reserved.address}`,
      );
      failure.code = "ERR_RESERVED_PEER_ADDRESS";
      callback(failure, "", 0);
      return;
    }
    if (options.all) {
      (callback as unknown as (error: null, addresses: LookupAddress[]) => void)(null, addresses);
      return;
    }
    const [first] = addresses;
    if (!first) {
      callback(Object.assign(new Error(`No address for ${hostname}`), { code: "ENOTFOUND" }), "", 0);
      return;
    }
    callback(null, first.address, first.family);
  });
};

const httpAgent = new HttpAgent(AGENT_OPTIONS);
const httpsAgent = new HttpsAgent(AGENT_OPTIONS);
const peerHttpAgent = new HttpAgent({ ...AGENT_OPTIONS, lookup: reservedAddressGuard });
const peerHttpsAgent = new HttpsAgent({ ...AGENT_OPTIONS, lookup: reservedAddressGuard });

const requestBody = async (
  body: BodyInit | null | undefined,
): Promise<Buffer | undefined> => {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  if (body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  throw new TypeError("Unsupported request body for the Node keep-alive client");
};

const responseHeaders = (response: IncomingMessage): Headers => {
  const headers = new Headers();
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    const name = response.rawHeaders[index];
    const value = response.rawHeaders[index + 1];
    if (name && value !== undefined) headers.append(name, value);
  }
  return headers;
};

type KeepAliveFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

const createKeepAliveFetch = (
  agents: { http: HttpAgent; https: HttpsAgent },
): KeepAliveFetch => async (input, init = {}) => {
  const url = input instanceof URL ? input : new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("Keep-alive client supports only HTTP and HTTPS URLs");
  }
  const body = await requestBody(init.body);
  const options: RequestOptions = {
    method: init.method ?? (body ? "POST" : "GET"),
    headers: Object.fromEntries(new Headers(init.headers).entries()),
    agent: url.protocol === "https:" ? agents.https : agents.http,
    signal: init.signal ?? undefined,
  };

  return new Promise<Response>((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      options,
      (response) => {
        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        const declaredLength = Number(response.headers["content-length"]);
        if (
          Number.isFinite(declaredLength) &&
          declaredLength > MAX_RESPONSE_BYTES
        ) {
          response.destroy(new Error("HTTP response exceeds the maximum size"));
          return;
        }
        response.on("data", (chunk: Buffer | string) => {
          const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
          receivedBytes += bytes.byteLength;
          if (receivedBytes > MAX_RESPONSE_BYTES) {
            response.destroy(new Error("HTTP response exceeds the maximum size"));
            return;
          }
          chunks.push(bytes);
        });
        response.once("error", reject);
        response.once("end", () => {
          const status = response.statusCode ?? 500;
          resolve(
            new Response(
              status === 204 || status === 205 || status === 304
                ? null
                : Buffer.concat(chunks),
              {
                status,
                ...(response.statusMessage
                  ? { statusText: response.statusMessage }
                  : {}),
                headers: responseHeaders(response),
              },
            ),
          );
        });
      },
    );
    request.once("error", reject);
    request.setTimeout(DEFAULT_REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error("HTTP request timed out"));
    });
    request.end(body);
  });
};

/** Fetch-compatible Node HTTP client backed by shared keep-alive agents. */
export const keepAliveFetch = createKeepAliveFetch({ http: httpAgent, https: httpsAgent });

/**
 * `keepAliveFetch` for requests to other peers: it refuses host names that
 * resolve to loopback, unspecified, or link-local addresses, so a peer cannot
 * point others at their own local services or a cloud metadata endpoint.
 */
export const peerFetch = createKeepAliveFetch({ http: peerHttpAgent, https: peerHttpsAgent });
