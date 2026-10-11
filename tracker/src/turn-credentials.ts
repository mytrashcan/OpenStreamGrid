import { createHmac } from "node:crypto";

/** Shared-secret TURN configuration (coturn `use-auth-secret`). */
export interface TurnCredentialOptions {
  urls: string[];
  sharedSecret: string;
}

/** RTCIceServer entry carrying short-lived TURN credentials. */
export interface TurnIceServer {
  urls: string[];
  username: string;
  credential: string;
}

/**
 * Issues time-limited TURN credentials using the TURN REST API convention
 * implemented by coturn's `use-auth-secret`: the username is
 * `<expiry unix seconds>:<peer id>` and the credential is the base64
 * HMAC-SHA1 of that username keyed by the shared secret.
 */
export const issueTurnCredentials = (
  options: TurnCredentialOptions,
  peerId: string,
  expiresAtMs: number,
): TurnIceServer => {
  const username = `${Math.floor(expiresAtMs / 1_000)}:${peerId}`;
  return {
    urls: [...options.urls],
    username,
    credential: createHmac("sha1", options.sharedSecret)
      .update(username)
      .digest("base64"),
  };
};
