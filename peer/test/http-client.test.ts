import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { isReservedPeerAddress, keepAliveFetch, peerFetch } from "../src/http-client.js";

test("reuses an HTTP connection across sequential requests", async (context) => {
  let connections = 0;
  const server = createServer((_request, response) => response.end("ok"));
  server.on("connection", () => {
    connections += 1;
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  if (!address || typeof address === "string") throw new Error("Missing server address");
  const url = `http://127.0.0.1:${address.port}/segment`;

  assert.equal(await (await keepAliveFetch(url)).text(), "ok");
  assert.equal(await (await keepAliveFetch(url)).text(), "ok");
  assert.equal(connections, 1);
});

test("refuses peer hosts that resolve to loopback but not origin requests", async (context) => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.end("ok");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  // A host name, unlike an IP literal, goes through DNS lookup.
  const url = `http://localhost:${address.port}/segments/a.ts`;

  await assert.rejects(peerFetch(url), (error: NodeJS.ErrnoException) => {
    assert.equal(error.code, "ERR_RESERVED_PEER_ADDRESS");
    return true;
  });
  assert.equal(requests, 0);
  assert.equal(await (await keepAliveFetch(url)).text(), "ok");
});

test("classifies reserved peer addresses", () => {
  for (const [address, family] of [
    ["127.0.0.1", 4],
    ["127.255.0.9", 4],
    ["169.254.169.254", 4],
    ["0.0.0.0", 4],
    ["::1", 6],
    ["::", 6],
    ["fe80::1", 6],
    ["febf::1", 6],
    ["::ffff:127.0.0.1", 6],
    ["::ffff:169.254.169.254", 6],
  ] as const) {
    assert.equal(isReservedPeerAddress(address, family), true, address);
  }
  for (const [address, family] of [
    ["10.0.0.5", 4],
    ["172.18.0.3", 4],
    ["192.168.1.20", 4],
    ["2001:db8::1", 6],
    ["fd00::1", 6],
    ["::ffff:10.0.0.5", 6],
  ] as const) {
    assert.equal(isReservedPeerAddress(address, family), false, address);
  }
});
