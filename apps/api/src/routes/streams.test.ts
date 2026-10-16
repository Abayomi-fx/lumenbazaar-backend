import type { Readable } from "node:stream";

import { Keypair } from "@stellar/stellar-sdk";
import { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import {
  LumenError,
  loadConfig,
  localIssuerPublicKey,
  type Receipt,
  type ReceiptStatus
} from "@lumenbazaar/shared";
import { ReceiptService } from "@lumenbazaar/stellar-payments";

import { buildApiApp } from "../app.js";
import { type EventStreamTuning } from "../services/receiptStatusStreams.js";
import { StreamAccessService, sellerStreamAccessMessage } from "../services/streamAccess.js";

const signingSecret = "lumenbazaar-test-event-stream-signing-secret";

describe("receipt stream access grants", () => {
  it("mints a short-lived receipt grant without exposing it across receipts", async () => {
    const { app, receipts } = await streamFixture();
    const receipt = receipts.seed(receiptFixture());

    const granted = await app.inject({
      method: "POST",
      url: `/v1/receipts/${receipt.id}/stream-access`,
      payload: { ttlSeconds: 60 }
    });

    expect(granted.statusCode).toBe(200);
    expect(granted.json()).toMatchObject({
      scope: "receipt",
      subjectId: receipt.id,
      expiresAt: expect.any(String),
      streamPath: `/v1/receipts/${receipt.id}/stream`,
      token: expect.stringMatching(/^lbss1\./)
    });

    const foreign = await app.inject({
      method: "POST",
      url: "/v1/receipts/receipt_missing/stream-access",
      payload: {}
    });

    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().error.code).toBe("RESOURCE_NOT_FOUND");
    await app.close();
  });

  it("rejects missing, tampered, and out-of-scope stream credentials", async () => {
    const { app, receipts } = await streamFixture();
    const receipt = receipts.seed(receiptFixture());
    const other = receipts.seed(receiptFixture());
    const sellerId = "seller_stream_owner";
    const seller = await createSeller(app, Keypair.random(), sellerId);
    const grant = await mintReceiptGrant(app, receipt.id);

    const missing = await app.inject({
      method: "GET",
      url: `/v1/receipts/${receipt.id}/stream`
    });
    const tampered = await app.inject({
      method: "GET",
      url: `/v1/receipts/${receipt.id}/stream`,
      headers: { authorization: `Bearer ${grant.token}tampered` }
    });
    const wrongScheme = await app.inject({
      method: "GET",
      url: `/v1/receipts/${receipt.id}/stream`,
      headers: { authorization: grant.token }
    });
    const wrongReceipt = await app.inject({
      method: "GET",
      url: `/v1/receipts/${other.id}/stream`,
      headers: { authorization: `Bearer ${grant.token}` }
    });
    const receiptGrantOnSellerStream = await app.inject({
      method: "GET",
      url: `/v1/sellers/${seller.id}/receipts/stream`,
      headers: { authorization: `Bearer ${grant.token}` }
    });

    expect(missing.statusCode).toBe(401);
    expect(missing.json().error.code).toBe("UNAUTHORIZED");
    expect(tampered.statusCode).toBe(401);
    expect(tampered.json().error.code).toBe("INVALID_SIGNATURE");
    expect(wrongScheme.statusCode).toBe(401);
    expect(wrongReceipt.statusCode).toBe(403);
    expect(wrongReceipt.json().error.code).toBe("FORBIDDEN");
    expect(receiptGrantOnSellerStream.statusCode).toBe(403);
    await app.close();
  });

  it("only mints seller grants from the seller wallet signature", async () => {
    const { app } = await streamFixture();
    const keypair = Keypair.random();
    const otherKeypair = Keypair.random();
    const seller = await createSeller(app, keypair);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const message = sellerStreamAccessMessage(seller.id, expiresAt);

    const granted = await app.inject({
      method: "POST",
      url: `/v1/sellers/${seller.id}/stream-access`,
      payload: {
        walletAddress: keypair.publicKey(),
        expiresAt,
        signature: signMessage(keypair, message)
      }
    });

    expect(granted.statusCode).toBe(200);
    expect(granted.json()).toMatchObject({
      scope: "seller",
      subjectId: seller.id,
      token: expect.stringMatching(/^lbss1\./)
    });

    const foreignWallet = await app.inject({
      method: "POST",
      url: `/v1/sellers/${seller.id}/stream-access`,
      payload: {
        walletAddress: otherKeypair.publicKey(),
        expiresAt,
        signature: signMessage(otherKeypair, message)
      }
    });
    const foreignSignature = await app.inject({
      method: "POST",
      url: `/v1/sellers/${seller.id}/stream-access`,
      payload: {
        walletAddress: keypair.publicKey(),
        expiresAt,
        signature: signMessage(otherKeypair, message)
      }
    });
    const distantExpiry = await app.inject({
      method: "POST",
      url: `/v1/sellers/${seller.id}/stream-access`,
      payload: {
        walletAddress: keypair.publicKey(),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        signature: signMessage(keypair, sellerStreamAccessMessage(seller.id, expiresAt))
      }
    });

    expect(foreignWallet.statusCode).toBe(403);
    expect(foreignWallet.json().error.code).toBe("FORBIDDEN");
    expect(foreignSignature.statusCode).toBe(401);
    expect(foreignSignature.json().error.code).toBe("INVALID_SIGNATURE");
    expect(distantExpiry.statusCode).toBe(400);
    expect(distantExpiry.json().error.code).toBe("VALIDATION_FAILED");
    await app.close();
  });

  it("fails closed when no stream signing secret is configured", async () => {
    const receipts = new TestReceiptService();
    const receipt = receipts.seed(receiptFixture());
    const app = buildApiApp({
      logger: false,
      config: loadConfig({}),
      receiptService: receipts
    });

    const mint = await app.inject({
      method: "POST",
      url: `/v1/receipts/${receipt.id}/stream-access`,
      payload: {}
    });
    const stream = await app.inject({
      method: "GET",
      url: `/v1/receipts/${receipt.id}/stream`,
      headers: { authorization: "Bearer lbss1.eyJ2IjoxfQ.abc" }
    });

    expect(mint.statusCode).toBe(503);
    expect(mint.json().error.code).toBe("INTERNAL_ERROR");
    expect(stream.statusCode).toBe(503);
    await app.close();
  });

  it("publishes the event stream contract in the OpenAPI document", async () => {
    const { app } = await streamFixture();
    const response = await app.inject({ method: "GET", url: "/openapi.json" });
    const spec = response.json();

    expect(
      spec.paths["/v1/receipts/{receiptId}/stream"].get.responses["200"].content
    ).toHaveProperty("text/event-stream");
    expect(
      spec.paths["/v1/sellers/{sellerId}/receipts/stream"].get.responses["200"].content
    ).toHaveProperty("text/event-stream");
    expect(spec.paths["/v1/receipts/{receiptId}/stream-access"].post.requestBody.required).toBe(
      false
    );
    await app.close();
  });
});

describe("receipt status event streams", () => {
  it("streams receipt status updates with heartbeats and no signed payload material", async () => {
    const { app, receipts } = await streamFixture();
    const receipt = receipts.seed(receiptFixture());
    const grant = await mintReceiptGrant(app, receipt.id);

    const stream = await openStream(app, `/v1/receipts/${receipt.id}/stream`, grant.token);

    const frames = await stream.waitFor((events) =>
      events.some((frame) => frame.event === "receipt.status")
    );
    const statusFrame = frames.find((frame) => frame.event === "receipt.status")!;

    expect(stream.headers["content-type"]).toContain("text/event-stream");
    expect(stream.headers["cache-control"]).toContain("no-cache");

    const data = frameJson(statusFrame);
    expect(Object.keys(data).sort()).toEqual([
      "cursor",
      "failureCode",
      "network",
      "occurredAt",
      "receiptId",
      "resourceId",
      "sellerId",
      "settledAt",
      "status"
    ]);
    expect(data).toMatchObject({ receiptId: receipt.id, status: "pending" });

    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain(receipt.evidenceHash);
    expect(serialized).not.toContain(String(receipt.transactionHash));
    expect(serialized).not.toContain("paymentPayload");
    expect(serialized).not.toContain("signature");
    expect(data.cursor).toMatch(/^lbsc1\./);
    expect(statusFrame.id).toBe(data.cursor);

    await stream.waitFor((events) => events.some((frame) => frame.comment?.startsWith("hb ")));

    stream.disconnect();
    await app.close();
  });

  it("closes the stream when a pending receipt reaches a final state", async () => {
    const { app, receipts } = await streamFixture();
    const receipt = receipts.seed(receiptFixture({ status: "pending" }));
    const grant = await mintReceiptGrant(app, receipt.id);

    const stream = await openStream(app, `/v1/receipts/${receipt.id}/stream`, grant.token);
    await stream.waitFor((events) => events.some((frame) => frame.event === "receipt.status"));

    receipts.transition(receipt.id, "finalized");

    const frames = await stream.waitFor((events) =>
      events.some((frame) => frame.event === "stream.end")
    );
    const statusFrames = frames.filter((frame) => frame.event === "receipt.status");
    const finalFrame = statusFrames.at(-1)!;
    const endFrame = frames.find((frame) => frame.event === "stream.end")!;

    expect(statusFrames.map((frame) => frameJson(frame).status)).toEqual(["pending", "finalized"]);
    expect(finalFrame.id).toBe(frameJson(finalFrame).cursor);
    expect(frameJson(finalFrame)).toMatchObject({ status: "finalized" });
    expect(frameJson(endFrame)).toEqual({ reason: "final" });
    await stream.waitForEnded();

    await app.close();
  });

  it("closes immediately for receipts that are already final", async () => {
    const { app, receipts } = await streamFixture();
    const receipt = receipts.seed(
      receiptFixture({ status: "failed", failureCode: "SETTLEMENT_FAILED" })
    );
    const grant = await mintReceiptGrant(app, receipt.id);

    const stream = await openStream(app, `/v1/receipts/${receipt.id}/stream`, grant.token);
    const frames = await stream.waitFor((events) =>
      events.some((frame) => frame.event === "stream.end")
    );

    expect(frameJson(frames.find((frame) => frame.event === "receipt.status")!)).toMatchObject({
      status: "failed",
      failureCode: "SETTLEMENT_FAILED"
    });
    expect(frameJson(frames.find((frame) => frame.event === "stream.end")!)).toEqual({
      reason: "final"
    });
    await stream.waitForEnded();

    await app.close();
  });

  it("resumes from a validated cursor after a reconnect", async () => {
    const { app, receipts } = await streamFixture();
    const receipt = receipts.seed(receiptFixture({ status: "pending" }));
    const grant = await mintReceiptGrant(app, receipt.id);

    const first = await openStream(app, `/v1/receipts/${receipt.id}/stream`, grant.token);
    const firstFrames = await first.waitFor((events) =>
      events.some((frame) => frame.event === "receipt.status")
    );
    const resumeCursor = frameJson(firstFrames.find((frame) => frame.event === "receipt.status")!)
      .cursor as string;
    expect(resumeCursor).toMatch(/^lbsc1\./);
    first.disconnect();
    await delay(50);

    receipts.transition(receipt.id, "finalized");

    const second = await openStream(app, `/v1/receipts/${receipt.id}/stream`, grant.token, {
      "last-event-id": resumeCursor
    });
    const frames = await second.waitFor((events) =>
      events.some((frame) => frame.event === "stream.end")
    );
    const statusFrames = frames.filter((frame) => frame.event === "receipt.status");

    expect(statusFrames).toHaveLength(1);
    expect(frameJson(statusFrames[0]!)).toMatchObject({ status: "finalized" });
    expect(statusFrames[0]!.id).toBe(frameJson(statusFrames[0]!).cursor);
    expect(frameJson(frames.find((frame) => frame.event === "stream.end")!)).toEqual({
      reason: "final"
    });

    await app.close();
  });

  it("rejects invalid cursors and resets unusable but authentic cursors", async () => {
    const { app, receipts } = await streamFixture();
    const receipt = receipts.seed(receiptFixture());
    const other = receipts.seed(receiptFixture());
    const grant = await mintReceiptGrant(app, receipt.id);
    const scope = { kind: "receipt" as const, id: receipt.id };

    const openAccess = new StreamAccessService({ signingSecret });
    const tamperedCursor = tamperToken(openAccess.issueCursor(scope, 1));
    const foreignCursor = openAccess.issueCursor({ kind: "receipt", id: other.id }, 0);
    const futureCursor = openAccess.issueCursor(scope, 999);

    const garbage = await app.inject({
      method: "GET",
      url: `/v1/receipts/${receipt.id}/stream`,
      headers: { authorization: `Bearer ${grant.token}`, "last-event-id": "not-a-cursor" }
    });
    const tampered = await app.inject({
      method: "GET",
      url: `/v1/receipts/${receipt.id}/stream`,
      headers: { authorization: `Bearer ${grant.token}`, "last-event-id": tamperedCursor }
    });
    const foreign = await app.inject({
      method: "GET",
      url: `/v1/receipts/${receipt.id}/stream`,
      headers: { authorization: `Bearer ${grant.token}` },
      query: { cursor: foreignCursor }
    });
    const mismatched = await app.inject({
      method: "GET",
      url: `/v1/receipts/${receipt.id}/stream`,
      headers: {
        authorization: `Bearer ${grant.token}`,
        "last-event-id": openAccess.issueCursor(scope, 1)
      },
      query: { cursor: tamperToken(openAccess.issueCursor(scope, 1)) }
    });

    for (const response of [garbage, tampered, foreign, mismatched]) {
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("VALIDATION_FAILED");
    }

    const resetStream = await openStream(
      app,
      `/v1/receipts/${receipt.id}/stream`,
      grant.token,
      {},
      { cursor: futureCursor }
    );
    const resetFrames = await resetStream.waitFor((events) =>
      events.some((frame) => frame.event === "stream.reset")
    );
    expect(frameJson(resetFrames.find((frame) => frame.event === "stream.reset")!)).toMatchObject({
      reason: "cursor_unavailable"
    });

    await app.close();
  });

  it("ends the stream when the grant expires while connected", async () => {
    const { app, receipts } = await streamFixture();
    const receipt = receipts.seed(receiptFixture({ status: "pending" }));
    const grant = await mintReceiptGrant(app, receipt.id, 1);

    const stream = await openStream(app, `/v1/receipts/${receipt.id}/stream`, grant.token);
    await stream.waitFor((events) => events.some((frame) => frame.event === "receipt.status"));

    const frames = await stream.waitFor(
      (events) => events.some((frame) => frame.event === "stream.end"),
      4_000
    );
    expect(frameJson(frames.find((frame) => frame.event === "stream.end")!)).toEqual({
      reason: "authorization_expired"
    });
    await stream.waitForEnded();

    await app.close();
  });

  it("ends open streams with a shutdown reason when the server closes", async () => {
    const { app, receipts } = await streamFixture();
    const receipt = receipts.seed(receiptFixture({ status: "pending" }));
    const grant = await mintReceiptGrant(app, receipt.id);

    const stream = await openStream(app, `/v1/receipts/${receipt.id}/stream`, grant.token);
    await stream.waitFor((events) => events.some((frame) => frame.event === "receipt.status"));

    await app.close();

    const frames = await stream.waitFor((events) =>
      events.some((frame) => frame.event === "stream.end")
    );
    expect(frameJson(frames.find((frame) => frame.event === "stream.end")!)).toEqual({
      reason: "shutdown"
    });
    await stream.waitForEnded();
  });
});

describe("seller receipt streams", () => {
  it("scopes seller streams to the signed wallet and only its own receipts", async () => {
    const { app, receipts } = await streamFixture();
    const keypair = Keypair.random();
    const otherKeypair = Keypair.random();
    const seller = await createSeller(app, keypair, "seller_stream_a");
    const otherSeller = await createSeller(app, otherKeypair, "seller_stream_b");
    const grant = await mintSellerGrant(app, seller.id, keypair);

    const owned = receipts.seed(receiptFixture({ sellerId: seller.id }));
    receipts.seed(receiptFixture({ sellerId: otherSeller.id }));

    const stream = await openStream(app, `/v1/sellers/${seller.id}/receipts/stream`, grant.token);
    const frames = await stream.waitFor((events) =>
      events.some((frame) => frame.event === "receipt.status")
    );

    expect(frameJson(frames.find((frame) => frame.event === "receipt.status")!)).toMatchObject({
      receiptId: owned.id,
      sellerId: seller.id
    });

    const late = receipts.seed(receiptFixture({ sellerId: seller.id }));
    const laterFrames = await stream.waitFor(
      (events) => events.filter((frame) => frame.event === "receipt.status").length >= 2
    );
    expect(
      laterFrames
        .filter((frame) => frame.event === "receipt.status")
        .map((frame) => frameJson(frame).receiptId)
    ).toEqual([owned.id, late.id]);

    const foreignGrantOnSellerStream = await app.inject({
      method: "GET",
      url: `/v1/sellers/${otherSeller.id}/receipts/stream`,
      headers: { authorization: `Bearer ${grant.token}` }
    });
    expect(foreignGrantOnSellerStream.statusCode).toBe(403);

    const sellerGrantOnReceiptStream = await app.inject({
      method: "GET",
      url: `/v1/receipts/${late.id}/stream`,
      headers: { authorization: `Bearer ${grant.token}`, "last-event-id": "not-a-cursor" }
    });
    expect(sellerGrantOnReceiptStream.statusCode).toBe(400);

    const terminal = receipts.seed(receiptFixture({ sellerId: seller.id, status: "finalized" }));

    const sellerStreamAccess = await openStream(
      app,
      `/v1/receipts/${terminal.id}/stream`,
      grant.token
    );
    const receiptFrames = await sellerStreamAccess.waitFor((events) =>
      events.some((frame) => frame.event === "stream.end")
    );
    expect(frameJson(receiptFrames.find((frame) => frame.event === "stream.end")!)).toEqual({
      reason: "final"
    });

    await app.close();
  });
});

type SseFrame = {
  id?: string | undefined;
  event?: string | undefined;
  data?: string | undefined;
  comment?: string | undefined;
  retry?: string | undefined;
};

class SseTestClient {
  readonly frames: SseFrame[] = [];
  readonly headers: Record<string, unknown>;
  private buffer = "";
  private ended = false;
  private readonly stream: Readable;
  private readonly rawResponse: { destroy: () => void };
  private readonly waiters: Array<{
    predicate: (frames: SseFrame[]) => boolean;
    resolve: (frames: SseFrame[]) => void;
  }> = [];

  constructor(response: {
    headers: Record<string, unknown>;
    stream: () => Readable;
    raw: { res: { destroy: () => void } };
  }) {
    this.headers = response.headers;
    this.stream = response.stream();
    this.rawResponse = response.raw.res;
    this.stream.setEncoding("utf8");
    this.stream.on("data", (chunk: string | Buffer) => {
      this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      this.drain();
    });
    this.stream.on("end", () => {
      this.ended = true;
      this.resolveWaiters();
    });
    this.stream.on("error", () => {
      this.ended = true;
      this.resolveWaiters();
    });
  }

  async waitFor(predicate: (frames: SseFrame[]) => boolean, timeoutMs = 3_000) {
    if (predicate(this.frames)) {
      return this.frames;
    }

    return new Promise<SseFrame[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.resolve === settle);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        reject(
          new Error(
            `Timed out waiting for SSE frames. Received: ${JSON.stringify(
              this.frames.map((frame) => frame.event ?? frame.comment ?? frame.retry ?? "id")
            )}`
          )
        );
      }, timeoutMs);

      const settle = (frames: SseFrame[]) => {
        clearTimeout(timer);
        resolve(frames);
      };

      this.waiters.push({ predicate, resolve: settle });
    });
  }

  async waitForEnded(timeoutMs = 2_000) {
    await this.waitFor(() => this.ended, timeoutMs);
  }

  disconnect() {
    this.rawResponse.destroy();
  }

  private drain() {
    let boundary = this.buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const rawFrame = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      if (rawFrame.trim().length > 0) {
        this.frames.push(parseFrame(rawFrame));
      }
      boundary = this.buffer.indexOf("\n\n");
    }
    this.resolveWaiters();
  }

  private resolveWaiters() {
    for (const waiter of [...this.waiters]) {
      if (waiter.predicate(this.frames)) {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        waiter.resolve(this.frames);
      }
    }
  }
}

class TestReceiptService extends ReceiptService {
  private readonly receipts = new Map<string, Receipt>();

  seed(receipt: Receipt) {
    this.receipts.set(receipt.id, receipt);
    return receipt;
  }

  transition(receiptId: string, status: ReceiptStatus) {
    const current = this.receipts.get(receiptId);

    if (current === undefined) {
      throw new Error(`Receipt ${receiptId} was not seeded.`);
    }

    const next: Receipt = {
      ...current,
      status,
      settledAt: status === "finalized" ? new Date().toISOString() : null,
      updatedAt: new Date().toISOString()
    };
    this.receipts.set(receiptId, next);
    return next;
  }

  override async finalizeSettlementReceipt(
    ...args: Parameters<ReceiptService["finalizeSettlementReceipt"]>
  ) {
    const receipt = await super.finalizeSettlementReceipt(...args);
    this.receipts.set(receipt.id, receipt);
    return receipt;
  }

  override async getReceipt(receiptId: string) {
    const receipt = this.receipts.get(receiptId);

    if (receipt === undefined) {
      throw new LumenError("RESOURCE_NOT_FOUND", "Receipt was not found.");
    }

    return receipt;
  }

  override async listReceiptsBySeller(sellerId: string, limit?: number) {
    return [...this.receipts.values()]
      .filter((receipt) => receipt.sellerId === sellerId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit ?? 100);
  }
}

let receiptSequence = 0;

function receiptFixture(overrides: Partial<Receipt> = {}): Receipt {
  receiptSequence += 1;
  const id = overrides.id ?? `receipt_stream_${receiptSequence}`;
  const now = new Date().toISOString();

  return {
    id,
    correlationId: `correlation_${id}`,
    paymentAttemptId: `attempt_${id}`,
    resourceId: "resource_stream",
    sellerId: "seller_stream",
    transactionHash: `tx_stream_${id}`,
    ledger: 4242,
    network: "stellar:testnet",
    amount: "0.0500000",
    assetCode: "USDC",
    assetIssuer: localIssuerPublicKey,
    status: "pending",
    settledAt: null,
    failureCode: null,
    failureReason: null,
    evidenceHash: `evidence_${id}`,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

async function streamFixture(tuning: EventStreamTuning = {}) {
  const receipts = new TestReceiptService();
  const app = buildApiApp({
    logger: false,
    config: loadConfig({ EVENT_STREAM_SIGNING_SECRET: signingSecret }),
    receiptService: receipts,
    eventStreamTuning: { heartbeatIntervalMs: 100, pollIntervalMs: 25, ...tuning }
  });
  return { app, receipts };
}

async function openStream(
  app: FastifyInstance,
  url: string,
  token: string,
  headers: Record<string, string> = {},
  query: Record<string, string> = {}
) {
  const response = await app.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${token}`, ...headers },
    ...(Object.keys(query).length > 0 ? { query } : {}),
    payloadAsStream: true
  });

  expect(response.statusCode).toBe(200);

  return new SseTestClient(
    response as unknown as {
      headers: Record<string, unknown>;
      stream: () => Readable;
      raw: { res: { destroy: () => void } };
    }
  );
}

async function mintReceiptGrant(app: FastifyInstance, receiptId: string, ttlSeconds?: number) {
  const response = await app.inject({
    method: "POST",
    url: `/v1/receipts/${receiptId}/stream-access`,
    payload: ttlSeconds === undefined ? {} : { ttlSeconds }
  });

  expect(response.statusCode).toBe(200);
  return response.json() as { token: string };
}

let sellerSequence = 0;

async function createSeller(app: FastifyInstance, keypair: Keypair, sellerId?: string) {
  sellerSequence += 1;
  const response = await app.inject({
    method: "POST",
    url: "/v1/sellers",
    payload: {
      displayName: `Stream Seller ${sellerId ?? sellerSequence}`,
      walletAddress: keypair.publicKey(),
      domain: `stream-seller-${sellerSequence}.example`
    }
  });

  expect(response.statusCode).toBe(200);
  return response.json() as { id: string; walletAddress: string };
}

async function mintSellerGrant(app: FastifyInstance, sellerId: string, keypair: Keypair) {
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const response = await app.inject({
    method: "POST",
    url: `/v1/sellers/${sellerId}/stream-access`,
    payload: {
      walletAddress: keypair.publicKey(),
      expiresAt,
      signature: signMessage(keypair, sellerStreamAccessMessage(sellerId, expiresAt))
    }
  });

  expect(response.statusCode).toBe(200);
  return response.json() as { token: string };
}

function signMessage(keypair: Keypair, message: string) {
  return Buffer.from(keypair.signMessage(message)).toString("base64");
}

function tamperToken(token: string): string {
  const segments = token.split(".");
  const signature = segments[2]!;

  segments[2] = (signature.startsWith("A") ? "B" : "A") + signature.slice(1);
  return segments.join(".");
}

function frameJson(frame: SseFrame): Record<string, unknown> {
  return JSON.parse(String(frame.data)) as Record<string, unknown>;
}

function parseFrame(rawFrame: string): SseFrame {
  const frame: SseFrame = {};
  const dataLines: string[] = [];

  for (const line of rawFrame.split("\n")) {
    if (line.startsWith(":")) {
      frame.comment = line.slice(1).trim();
      continue;
    }

    const separator = line.indexOf(":");
    if (separator === -1) {
      continue;
    }

    const field = line.slice(0, separator);
    const value = line.slice(separator + 1).replace(/^ /, "");

    if (field === "id") {
      frame.id = value;
    } else if (field === "event") {
      frame.event = value;
    } else if (field === "data") {
      dataLines.push(value);
    } else if (field === "retry") {
      frame.retry = value;
    }
  }

  if (dataLines.length > 0) {
    frame.data = dataLines.join("\n");
  }

  return frame;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
