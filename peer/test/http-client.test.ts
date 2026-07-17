import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { keepAliveFetch } from "../src/http-client.js";

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
