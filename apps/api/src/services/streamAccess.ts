import { createHmac, timingSafeEqual } from "node:crypto";

import { Keypair } from "@stellar/stellar-sdk";

import {
  LumenError,
  type Receipt,
  type ReceiptStreamGrant,
  type ReceiptStreamScope
} from "@lumenbazaar/shared";

const grantTokenPrefix = "lbss1";
const cursorTokenPrefix = "lbsc1";
const tokenVersion = 1;

export type StreamGrant = {
  scope: ReceiptStreamScope;
  expiresAt: number;
};

export type SellerStreamAccessRequest = {
  walletAddress: string;
  expiresAt: string;
  signature: string;
};

export type StreamAccessServiceOptions = {
  signingSecret?: string | undefined;
  defaultGrantTtlSeconds?: number | undefined;
  maxGrantTtlSeconds?: number | undefined;
  now?: (() => number) | undefined;
};

type GrantPayload = {
  v: number;
  k: ReceiptStreamScope["kind"];
  s: string;
  exp: number;
};

type CursorPayload = {
  v: number;
  s: string;
  n: number;
};

export function streamScopeKey(scope: ReceiptStreamScope) {
  return `${scope.kind}:${scope.id}`;
}

export function receiptStreamPath(receiptId: string) {
  return `/v1/receipts/${receiptId}/stream`;
}

export function sellerStreamPath(sellerId: string) {
  return `/v1/sellers/${sellerId}/receipts/stream`;
}

export function sellerStreamAccessMessage(sellerId: string, expiresAt: string) {
  return `lumenbazaar:event-stream-access:v1\nseller:${sellerId}\nexp:${expiresAt}`;
}

export class StreamAccessService {
  private readonly signingSecret: string | undefined;
  private readonly defaultGrantTtlSeconds: number;
  private readonly maxGrantTtlSeconds: number;
  private readonly now: () => number;

  constructor(options: StreamAccessServiceOptions = {}) {
    this.signingSecret = options.signingSecret;
    this.defaultGrantTtlSeconds = options.defaultGrantTtlSeconds ?? 300;
    this.maxGrantTtlSeconds = options.maxGrantTtlSeconds ?? 900;
    this.now = options.now ?? Date.now;
  }

  get enabled() {
    return this.signingSecret !== undefined && this.signingSecret.length > 0;
  }

  mintReceiptGrant(receiptId: string, ttlSeconds?: number): ReceiptStreamGrant {
    const ttl = ttlSeconds ?? this.defaultGrantTtlSeconds;

    if (!Number.isInteger(ttl) || ttl < 1) {
      throw new LumenError("VALIDATION_FAILED", "ttlSeconds must be a positive whole number.");
    }
    if (ttl > this.maxGrantTtlSeconds) {
      throw new LumenError(
        "VALIDATION_FAILED",
        `ttlSeconds must not exceed ${this.maxGrantTtlSeconds}.`
      );
    }

    const expiresAt = this.now() + ttl * 1000;
    const token = this.signGrant({ v: tokenVersion, k: "receipt", s: receiptId, exp: expiresAt });

    return {
      token,
      scope: "receipt",
      subjectId: receiptId,
      expiresAt: new Date(expiresAt).toISOString(),
      streamPath: receiptStreamPath(receiptId)
    };
  }

  mintSellerGrant(
    seller: { id: string; walletAddress: string },
    request: SellerStreamAccessRequest
  ): ReceiptStreamGrant {
    this.requireEnabled();

    if (request.walletAddress !== seller.walletAddress) {
      throw new LumenError(
        "FORBIDDEN",
        "Stream access must be signed by the seller wallet address."
      );
    }

    const expiresAtMs = this.parseGrantExpiry(request.expiresAt);
    const message = sellerStreamAccessMessage(seller.id, request.expiresAt);
    const signature = decodeSignature(request.signature);

    let valid = false;
    try {
      valid = Keypair.fromPublicKey(seller.walletAddress).verifyMessage(message, signature);
    } catch {
      valid = false;
    }

    if (!valid) {
      throw new LumenError("INVALID_SIGNATURE", "Seller stream access signature is invalid.");
    }

    const token = this.signGrant({
      v: tokenVersion,
      k: "seller",
      s: seller.id,
      exp: expiresAtMs
    });

    return {
      token,
      scope: "seller",
      subjectId: seller.id,
      expiresAt: new Date(expiresAtMs).toISOString(),
      streamPath: sellerStreamPath(seller.id)
    };
  }

  authenticate(token: string | undefined): StreamGrant {
    this.requireEnabled();

    if (token === undefined || token.length === 0) {
      throw new LumenError("UNAUTHORIZED", "A stream access grant is required.");
    }

    const payload = this.readSignedToken<GrantPayload>(token, grantTokenPrefix);

    if (
      payload.v !== tokenVersion ||
      (payload.k !== "receipt" && payload.k !== "seller") ||
      typeof payload.s !== "string" ||
      payload.s.length === 0 ||
      typeof payload.exp !== "number" ||
      !Number.isFinite(payload.exp)
    ) {
      throw new LumenError("UNAUTHORIZED", "The stream access grant is malformed.");
    }

    if (payload.exp <= this.now()) {
      throw new LumenError("UNAUTHORIZED", "The stream access grant has expired.");
    }

    return {
      scope: { kind: payload.k, id: payload.s },
      expiresAt: payload.exp
    };
  }

  verifyReceiptAccess(grant: StreamGrant, receipt: Pick<Receipt, "id" | "sellerId">) {
    if (grant.scope.kind === "receipt" && grant.scope.id === receipt.id) {
      return;
    }

    if (
      grant.scope.kind === "seller" &&
      receipt.sellerId !== null &&
      grant.scope.id === receipt.sellerId
    ) {
      return;
    }

    throw new LumenError(
      "FORBIDDEN",
      "The stream access grant is not authorized for this receipt."
    );
  }

  verifySellerAccess(grant: StreamGrant, sellerId: string) {
    if (grant.scope.kind !== "seller" || grant.scope.id !== sellerId) {
      throw new LumenError(
        "FORBIDDEN",
        "The stream access grant is not authorized for this seller."
      );
    }
  }

  issueCursor(scope: ReceiptStreamScope, seq: number) {
    return this.signToken<CursorPayload>(cursorTokenPrefix, {
      v: tokenVersion,
      s: streamScopeKey(scope),
      n: seq
    });
  }

  parseCursor(token: string | undefined, scope: ReceiptStreamScope) {
    if (token === undefined || token.length === 0) {
      return undefined;
    }

    let payload: CursorPayload;
    try {
      payload = this.readSignedToken<CursorPayload>(token, cursorTokenPrefix);
    } catch (error) {
      if (error instanceof LumenError && error.statusCode >= 500) {
        throw error;
      }
      throw new LumenError("VALIDATION_FAILED", "The stream cursor is not valid.");
    }

    if (
      payload.v !== tokenVersion ||
      typeof payload.s !== "string" ||
      typeof payload.n !== "number" ||
      !Number.isSafeInteger(payload.n) ||
      payload.n < 0
    ) {
      throw new LumenError("VALIDATION_FAILED", "The stream cursor is not valid.");
    }

    if (payload.s !== streamScopeKey(scope)) {
      throw new LumenError("VALIDATION_FAILED", "The stream cursor does not match this stream.");
    }

    return payload.n;
  }

  private parseGrantExpiry(expiresAt: string): number {
    const expiresAtMs = Date.parse(expiresAt);

    if (!Number.isFinite(expiresAtMs)) {
      throw new LumenError("VALIDATION_FAILED", "expiresAt must be an ISO-8601 timestamp.");
    }

    const now = this.now();
    const maxExpiry = now + this.maxGrantTtlSeconds * 1000;

    if (expiresAtMs <= now) {
      throw new LumenError("VALIDATION_FAILED", "expiresAt must be in the future.");
    }
    if (expiresAtMs > maxExpiry) {
      throw new LumenError(
        "VALIDATION_FAILED",
        `expiresAt must not be more than ${this.maxGrantTtlSeconds} seconds ahead.`
      );
    }

    return expiresAtMs;
  }

  private requireEnabled() {
    if (!this.enabled) {
      throw new LumenError("INTERNAL_ERROR", "Authenticated event streams are not configured.", {
        statusCode: 503
      });
    }
  }

  private signGrant(payload: GrantPayload) {
    return this.signToken<GrantPayload>(grantTokenPrefix, payload);
  }

  private signToken<TPayload>(prefix: string, payload: TPayload) {
    this.requireEnabled();
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    return `${prefix}.${encoded}.${this.mac(encoded)}`;
  }

  private readSignedToken<TPayload>(token: string, prefix: string): TPayload {
    const segments = token.split(".");

    if (segments.length !== 3 || segments[0] !== prefix) {
      throw new LumenError("UNAUTHORIZED", "The stream access credential is not valid.");
    }

    const [, encoded, providedSignature] = segments as [string, string, string];
    const expectedSignature = this.mac(encoded);
    const provided = Buffer.from(providedSignature, "base64url");
    const expected = Buffer.from(expectedSignature, "base64url");

    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new LumenError("INVALID_SIGNATURE", "The stream access credential is not valid.");
    }

    try {
      return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as TPayload;
    } catch {
      throw new LumenError("UNAUTHORIZED", "The stream access credential is not valid.");
    }
  }

  private mac(encodedPayload: string) {
    this.requireEnabled();
    return createHmac("sha256", this.signingSecret!).update(encodedPayload).digest("base64url");
  }
}

function decodeSignature(signature: string) {
  const decoded = Buffer.from(signature, "base64");

  if (decoded.length === 0) {
    throw new LumenError("INVALID_SIGNATURE", "Seller stream access signature is invalid.");
  }

  return decoded;
}
