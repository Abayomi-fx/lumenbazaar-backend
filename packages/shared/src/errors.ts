export const errorCodes = [
  "PAYMENT_REQUIRED",
  "UNSUPPORTED_NETWORK",
  "UNSUPPORTED_ASSET",
  "INVALID_PAYMENT_PAYLOAD",
  "INVALID_SIGNATURE",
  "AUTH_EXPIRED",
  "REPLAY_DETECTED",
  "AMOUNT_MISMATCH",
  "ASSET_MISMATCH",
  "RECIPIENT_MISMATCH",
  "SETTLEMENT_FAILED",
  "TRUSTLINE_REQUIRED",
  "RESOURCE_NOT_FOUND",
  "SELLER_NOT_FOUND",
  "SELLER_DOMAIN_UNVERIFIED",
  "CATALOG_VALIDATION_FAILED",
  "ROUTE_TEMPLATE_INVALID",
  "VALIDATION_FAILED",
  "RATE_LIMITED",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "INTERNAL_ERROR"
] as const;

export type ErrorCode = (typeof errorCodes)[number];

export const defaultErrorStatus: Record<ErrorCode, number> = {
  PAYMENT_REQUIRED: 402,
  UNSUPPORTED_NETWORK: 400,
  UNSUPPORTED_ASSET: 400,
  INVALID_PAYMENT_PAYLOAD: 400,
  INVALID_SIGNATURE: 401,
  AUTH_EXPIRED: 400,
  REPLAY_DETECTED: 409,
  AMOUNT_MISMATCH: 400,
  ASSET_MISMATCH: 400,
  RECIPIENT_MISMATCH: 400,
  SETTLEMENT_FAILED: 502,
  TRUSTLINE_REQUIRED: 424,
  RESOURCE_NOT_FOUND: 404,
  SELLER_NOT_FOUND: 404,
  SELLER_DOMAIN_UNVERIFIED: 403,
  CATALOG_VALIDATION_FAILED: 400,
  ROUTE_TEMPLATE_INVALID: 400,
  VALIDATION_FAILED: 400,
  RATE_LIMITED: 429,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  INTERNAL_ERROR: 500
};

export class LumenError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, options: LumenErrorOptions = {}) {
    super(message);
    this.name = "LumenError";
    this.code = code;
    this.statusCode = options.statusCode ?? defaultErrorStatus[code];
    this.details = options.details;
  }
}

export type LumenErrorOptions = {
  statusCode?: number;
  details?: Record<string, unknown>;
};

export function isErrorCode(value: string): value is ErrorCode {
  return errorCodes.includes(value as ErrorCode);
}
