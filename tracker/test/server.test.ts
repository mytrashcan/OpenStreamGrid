import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import { createTrackerHandler } from "../src/server.js";
import { TrackerStore } from "../src/store.js";

interface TestResponse {
  status: number;
  json: unknown;
}

const invoke = async (
  handler: ReturnType<typeof createTrackerHandler>,
  method: string,
  url: string,
  body?: unknown,
): Promise<TestResponse> => {
  const payload = body === undefined ? [] : [JSON.stringify(body)];
  const request = Object.assign(Readable.from(payload), {
    method,
    url,
  }) as unknown as IncomingMessage;
  let status = 0;
  let responseBody = "";
  let headersSent = false;
  const response = {
    get headersSent() {
      return headersSent;
    },
    writeHead(statusCode: number) {
      status = statusCode;
      headersSent = true;
      return response;
    },
    end(chunk?: string) {
      if (chunk) responseBody += chunk;
      return response;
    },
    destroy() {
      return response;
    },
  } as unknown as ServerResponse;
  await handler(request, response);
  return {
    status,
    json: responseBody ? (JSON.parse(responseBody) as unknown) : undefined,
  };
};

test("exposes the broadcast and peer lifecycle over REST", async () => {
  const handler = createTrackerHandler(new TrackerStore());

  const registration = await invoke(handler, "POST", "/api/v1/broadcasts", {
    id: "live",
    playlistUrl: "http://origin/live.m3u8",
  });
  assert.equal(registration.status, 201);

  const join = await invoke(handler, "POST", "/api/v1/broadcasts/live/peers", {
    id: "peer-a",
    address: "http://peer-a:9090",
  });
  assert.equal(join.status, 201);

  await invoke(
    handler,
    "POST",
    "/api/v1/broadcasts/live/peers/peer-a/segments",
    { segments: ["segment_1.ts"] },
  );
  const peers = await invoke(
    handler,
    "GET",
    "/api/v1/broadcasts/live/peers?segment=segment_1.ts",
  );
  const peerBody = peers.json as { peers: Array<{ id: string }> };
  assert.deepEqual(peerBody.peers.map((peer) => peer.id), ["peer-a"]);

  const health = await invoke(handler, "GET", "/health");
  assert.equal(health.status, 200);
});
