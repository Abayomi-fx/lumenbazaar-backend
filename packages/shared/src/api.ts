import { type ErrorCode } from "./errors.js";
import { type ReceiptStatus } from "./models.js";

export type RequestId = string;

export type ApiErrorBody = {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown> | undefined;
};

export type ApiSuccess<T> = {
  ok: true;
  data: T;
  requestId?: RequestId;
};

export type ApiFailure = {
  ok: false;
  error: ApiErrorBody;
  requestId?: RequestId;
};

export type ApiEnvelope<T> = ApiSuccess<T> | ApiFailure;

export function success<T>(data: T, requestId?: RequestId): ApiSuccess<T> {
  return requestId === undefined ? { ok: true, data } : { ok: true, data, requestId };
}

export function failure(error: ApiErrorBody, requestId?: RequestId): ApiFailure {
  return requestId === undefined ? { ok: false, error } : { ok: false, error, requestId };
}

export type ReceiptStreamScopeKind = "receipt" | "seller";

export type ReceiptStreamScope = {
  kind: ReceiptStreamScopeKind;
  id: string;
};

export type ReceiptStreamChange = {
  receiptId: string;
  status: ReceiptStatus;
  network: string;
  sellerId: string | null;
  resourceId: string | null;
  failureCode: string | null;
  settledAt: string | null;
  occurredAt: string;
};

export type ReceiptStatusStreamEvent = ReceiptStreamChange & {
  cursor: string;
};

export type ReceiptStreamReadyEvent = {
  scope: ReceiptStreamScope;
  cursor: string;
  heartbeatIntervalMs: number;
  finalStatuses: readonly ReceiptStatus[];
};

export type ReceiptStreamResetEvent = {
  reason: "cursor_unavailable";
  cursor: string;
};

export type ReceiptStreamEndReason =
  | "final"
  | "authorization_expired"
  | "shutdown"
  | "backpressure";

export type ReceiptStreamEndEvent = {
  reason: ReceiptStreamEndReason;
};

export type ReceiptStreamGrant = {
  token: string;
  scope: ReceiptStreamScopeKind;
  subjectId: string;
  expiresAt: string;
  streamPath: string;
};
