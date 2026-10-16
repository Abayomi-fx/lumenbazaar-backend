import { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";

import { LumenError, type Receipt, type ReceiptStreamScope } from "@lumenbazaar/shared";
import { ReceiptService } from "@lumenbazaar/stellar-payments";

import { parseBody, parseParams, parseQuery } from "../http/validation.js";
import {
  ReceiptStatusStreamService,
  type EventStreamTuning
} from "../services/receiptStatusStreams.js";
import { StreamAccessService, type StreamGrant } from "../services/streamAccess.js";
import { type StreamSink } from "../services/streamSession.js";
import { SellerService } from "../services/sellers.js";

export type StreamRouteOptions = {
  receiptService?: ReceiptService | undefined;
  sellerService?: SellerService | undefined;
  streamAccess?: StreamAccessService | undefined;
  streams?: ReceiptStatusStreamService | undefined;
  eventStreamTuning?: EventStreamTuning | undefined;
};

const receiptParamsSchema = z.object({ receiptId: z.string().min(1) });
const sellerParamsSchema = z.object({ sellerId: z.string().min(1) });
const streamQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  access_token: z.string().min(1).optional()
});
const streamAccessTtlSchema = z.preprocess(
  (value) => value ?? {},
  z.object({ ttlSeconds: z.number().int().min(1).optional() })
);
const sellerStreamAccessSchema = z.object({
  walletAddress: z.string().trim().min(1),
  expiresAt: z.string().min(1),
  signature: z.string().min(1).max(512)
});

export function registerStreamRoutes(app: FastifyInstance, options: StreamRouteOptions = {}) {
  const receiptService =
    options.receiptService ?? options.streams?.receiptService ?? new ReceiptService();
  const sellerService = options.sellerService ?? new SellerService();
  const streamAccess =
    options.streamAccess ?? options.streams?.streamAccess ?? new StreamAccessService();
  const streams =
    options.streams ??
    new ReceiptStatusStreamService({ receiptService, streamAccess, ...options.eventStreamTuning });

  app.post("/v1/receipts/:receiptId/stream-access", async (request) => {
    const params = parseParams(request, receiptParamsSchema);
    const body = parseBody(request, streamAccessTtlSchema);
    const receipt = await receiptService.getReceipt(params.receiptId);

    return streamAccess.mintReceiptGrant(receipt.id, body.ttlSeconds);
  });

  app.post("/v1/sellers/:sellerId/stream-access", async (request) => {
    const params = parseParams(request, sellerParamsSchema);
    const body = parseBody(request, sellerStreamAccessSchema);
    const seller = await sellerService.getSeller(params.sellerId);

    return streamAccess.mintSellerGrant(
      { id: seller.id, walletAddress: seller.walletAddress },
      body
    );
  });

  app.get("/v1/receipts/:receiptId/stream", async (request, reply) => {
    const params = parseParams(request, receiptParamsSchema);
    const grant = streamAccess.authenticate(readGrantToken(request));
    const receipt = await receiptService.getReceipt(params.receiptId);
    streamAccess.verifyReceiptAccess(grant, receipt);
    const scope: ReceiptStreamScope = { kind: "receipt", id: receipt.id };
    const cursorSeq = streamAccess.parseCursor(readCursor(request), scope);

    return openEventStream(request, reply, streams, {
      scope,
      grant,
      cursorSeq,
      knownReceipt: receipt
    });
  });

  app.get("/v1/sellers/:sellerId/receipts/stream", async (request, reply) => {
    const params = parseParams(request, sellerParamsSchema);
    const grant = streamAccess.authenticate(readGrantToken(request));
    const seller = await sellerService.getSeller(params.sellerId);
    streamAccess.verifySellerAccess(grant, seller.id);
    const scope: ReceiptStreamScope = { kind: "seller", id: seller.id };
    const cursorSeq = streamAccess.parseCursor(readCursor(request), scope);

    return openEventStream(request, reply, streams, { scope, grant, cursorSeq });
  });
}

type StreamAttachRequest = {
  scope: ReceiptStreamScope;
  grant: StreamGrant;
  cursorSeq: number | undefined;
  knownReceipt?: Receipt | undefined;
};

async function openEventStream(
  request: FastifyRequest,
  reply: FastifyReply,
  streams: ReceiptStatusStreamService,
  attach: StreamAttachRequest
) {
  reply.hijack();
  const sink = createReplyStreamSink(reply.raw, collectStreamHeaders(reply));

  try {
    await streams.attach({
      scope: attach.scope,
      grant: attach.grant,
      cursorSeq: attach.cursorSeq,
      sink,
      ...(attach.knownReceipt === undefined ? {} : { knownReceipt: attach.knownReceipt })
    });
  } catch (error) {
    request.log.error({ err: error, scope: attach.scope }, "receipt status stream attach failed");
    sink.end();
  }
}

function createReplyStreamSink(
  reply: FastifyReply["raw"],
  headers: Record<string, string>
): StreamSink {
  reply.writeHead(200, headers);

  return {
    write: (chunk) => reply.write(chunk),
    end: () => reply.end(),
    onDrain: (listener) => {
      reply.once("drain", listener);
      return () => {
        reply.off("drain", listener);
      };
    },
    onClose: (listener) => {
      reply.once("close", listener);
      return () => {
        reply.off("close", listener);
      };
    }
  };
}

function collectStreamHeaders(reply: FastifyReply) {
  const headers: Record<string, string> = {};

  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (value === undefined) {
      continue;
    }
    headers[name] = Array.isArray(value) ? value.join(", ") : String(value);
  }

  headers["content-type"] = "text/event-stream; charset=utf-8";
  headers["cache-control"] = "no-cache, no-store, no-transform";
  headers["connection"] = "keep-alive";
  headers["x-accel-buffering"] = "no";

  return headers;
}

function readGrantToken(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;

  if (authorization !== undefined) {
    const match = /^Bearer[ ]+(\S+)$/i.exec(authorization.trim());

    if (match?.[1] === undefined) {
      throw new LumenError(
        "UNAUTHORIZED",
        "Stream access grants must use the Authorization Bearer scheme."
      );
    }

    return match[1];
  }

  return parseQuery(request, streamQuerySchema).access_token;
}

function readCursor(request: FastifyRequest): string | undefined {
  const query = parseQuery(request, streamQuerySchema);
  const header = request.headers["last-event-id"];
  const headerValue = Array.isArray(header) ? header[0] : header;

  if (query.cursor !== undefined && headerValue !== undefined && query.cursor !== headerValue) {
    throw new LumenError(
      "VALIDATION_FAILED",
      "cursor and Last-Event-ID must match when both are provided."
    );
  }

  return query.cursor ?? headerValue;
}
