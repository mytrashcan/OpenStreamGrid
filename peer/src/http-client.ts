import {
  Agent as HttpAgent,
  request as httpRequest,
  type IncomingMessage,
  type RequestOptions,
} from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

const httpAgent = new HttpAgent({
  keepAlive: true,
  keepAliveMsecs: 1_000,
  maxFreeSockets: 16,
  maxSockets: 64,
});
const httpsAgent = new HttpsAgent({
  keepAlive: true,
  keepAliveMsecs: 1_000,
  maxFreeSockets: 16,
  maxSockets: 64,
});

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

/** Fetch-compatible Node HTTP client backed by shared keep-alive agents. */
export const keepAliveFetch = async (
  input: string | URL,
  init: RequestInit = {},
): Promise<Response> => {
  const url = input instanceof URL ? input : new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("Keep-alive client supports only HTTP and HTTPS URLs");
  }
  const body = await requestBody(init.body);
  const options: RequestOptions = {
    method: init.method ?? (body ? "POST" : "GET"),
    headers: Object.fromEntries(new Headers(init.headers).entries()),
    agent: url.protocol === "https:" ? httpsAgent : httpAgent,
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
