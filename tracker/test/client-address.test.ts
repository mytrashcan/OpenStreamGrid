import assert from "node:assert/strict";
import test from "node:test";
import { clientAddress } from "../src/client-address.js";

const request = (remoteAddress: string, forwardedFor?: string | string[]) => ({
  socket: { remoteAddress },
  headers: forwardedFor === undefined ? {} : { "x-forwarded-for": forwardedFor },
}) as unknown as Parameters<typeof clientAddress>[0];

test("uses the socket address unless proxies are trusted", () => {
  assert.equal(clientAddress(request("10.0.0.5", "203.0.113.9"), 0), "10.0.0.5");
});

test("takes the client recorded by the outermost trusted proxy", () => {
  // One trusted ingress appended the client's address.
  assert.equal(clientAddress(request("10.0.0.5", "198.51.100.1, 203.0.113.9"), 1), "203.0.113.9");
  // CDN then ingress: the CDN recorded the client, the ingress recorded the CDN.
  assert.equal(clientAddress(request("10.0.0.5", "203.0.113.9, 192.0.2.44"), 2), "203.0.113.9");
  assert.equal(clientAddress(request("10.0.0.5", ["203.0.113.9", "192.0.2.44"]), 2), "203.0.113.9");
});

test("falls back when the header is missing or shorter than the proxy chain", () => {
  assert.equal(clientAddress(request("10.0.0.5"), 1), "10.0.0.5");
  assert.equal(clientAddress(request("10.0.0.5", "203.0.113.9"), 2), "203.0.113.9");
});

test("ignores ports recorded by proxies", () => {
  assert.equal(clientAddress(request("10.0.0.5", "203.0.113.9:51234"), 1), "203.0.113.9");
  assert.equal(clientAddress(request("10.0.0.5", "[2001:db8::1]:443"), 1), "2001:db8::1");
  assert.equal(clientAddress(request("10.0.0.5", "2001:db8::1"), 1), "2001:db8::1");
});
