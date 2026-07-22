import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1_000;

export interface PeerSessionClaims {
  broadcastId: string;
  peerId: string;
  expiresAt: number;
}

interface PeerSessionPayload {
  v: 1;
  broadcastId: string;
  peerId: string;
  expiresAt: number;
}

const encode = (value: string): string => Buffer.from(value).toString("base64url");

const decodePayload = (encoded: string): PeerSessionPayload | undefined => {
  try {
    const value: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value)
    ) {
      return undefined;
    }
    const payload = value as Record<string, unknown>;
    if (
      payload.v !== 1 ||
      typeof payload.broadcastId !== "string" ||
      payload.broadcastId === "" ||
      typeof payload.peerId !== "string" ||
      payload.peerId === "" ||
      typeof payload.expiresAt !== "number" ||
      !Number.isSafeInteger(payload.expiresAt)
    ) {
      return undefined;
    }
    return {
      v: 1,
      broadcastId: payload.broadcastId,
      peerId: payload.peerId,
      expiresAt: payload.expiresAt,
    };
  } catch {
    return undefined;
  }
};

/** Issues and verifies short-lived tokens bound to one tracker peer identity. */
export class PeerSessionTokenService {
  private readonly secret: Buffer;

  constructor(
    secret: string | Buffer = randomBytes(32),
    private readonly ttlMs = DEFAULT_SESSION_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {
    this.secret = Buffer.isBuffer(secret) ? Buffer.from(secret) : Buffer.from(secret, "utf8");
    if (this.secret.byteLength < 32) {
      throw new Error("Peer session secret must contain at least 32 bytes");
    }
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new Error("Peer session TTL must be a positive integer");
    }
  }

  issue(broadcastId: string, peerId: string): {
    token: string;
    expiresAt: string;
  } {
    const expiresAt = this.now() + this.ttlMs;
    const payload = encode(JSON.stringify({
      v: 1,
      broadcastId,
      peerId,
      expiresAt,
    } satisfies PeerSessionPayload));
    return {
      token: `${payload}.${this.sign(payload)}`,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  verify(token: string | undefined): PeerSessionClaims | undefined {
    if (!token) return undefined;
    const [payload, suppliedSignature, extra] = token.split(".");
    if (!payload || !suppliedSignature || extra !== undefined) return undefined;
    const expectedSignature = this.sign(payload);
    const supplied = Buffer.from(suppliedSignature);
    const expected = Buffer.from(expectedSignature);
    if (
      supplied.byteLength !== expected.byteLength ||
      !timingSafeEqual(supplied, expected)
    ) {
      return undefined;
    }
    const claims = decodePayload(payload);
    if (!claims || claims.expiresAt <= this.now()) return undefined;
    return {
      broadcastId: claims.broadcastId,
      peerId: claims.peerId,
      expiresAt: claims.expiresAt,
    };
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.secret).update(payload).digest("base64url");
  }
}

export const bearerToken = (
  authorization: string | string[] | undefined,
): string | undefined => {
  if (typeof authorization !== "string") return undefined;
  const match = authorization.match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1];
};
