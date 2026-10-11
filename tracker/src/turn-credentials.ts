import { createHmac } from "node:crypto";

/** Shared-secret TURN configuration (coturn `use-auth-secret`). */
export interface TurnCredentialOptions {
  urls: string[];
  sharedSecret: string;
}

/**
 * TURN credentials outlive the peer session by this margin so a peer whose
 * session refresh is being retried can still open relayed connections.
 */
export const TURN_CREDENTIAL_GRACE_MS = 10 * 60 * 1_000;

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
    // HMAC-SHA1 is fixed by the TURN REST API / coturn use-auth-secret format;
    // TURN servers cannot verify any other algorithm. SHA-1 collision attacks
    // do not weaken HMAC, and the credential expires with the session.
    credential: createHmac("sha1", options.sharedSecret)
      .update(username)
      .digest("base64"),
  };
};
