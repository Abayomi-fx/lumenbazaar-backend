# Receipt status event streams

Authorized clients can follow settlement progress with a server-sent event stream instead of
polling the receipt endpoint. Streams are strictly opt-in per receipt or per seller and never
expose another client's events.

## Granting access

A stream requires a short-lived signed grant presented as `Authorization: Bearer <token>` on the
stream request, or as an `access_token` query parameter for clients such as `EventSource` that
cannot set headers.

- `POST /v1/receipts/{receiptId}/stream-access` mints a receipt-scoped grant. Anyone who can
  address the receipt id may mint it, matching the public receipt read model. The optional
  `ttlSeconds` body defaults to 300 and caps at 900.
- `POST /v1/sellers/{sellerId}/stream-access` mints a seller-scoped grant. The request carries
  `walletAddress`, `expiresAt`, and `signature`, where the signature is the SEP-53
  `signMessage` signature over:

  ```
  lumenbazaar:event-stream-access:v1
  seller:<sellerId>
  exp:<expiresAt>
  ```

  `expiresAt` must be a future timestamp no more than 900 seconds ahead. The signature must come
  from the seller's registered wallet, so one seller's grant can never authorize another.

Grants are HMAC-SHA-256 tokens bound to one scope (`receipt:<id>` or `seller:<id>`), so a receipt
grant cannot open a seller stream and vice versa. When `EVENT_STREAM_SIGNING_SECRET` is unset the
mint and stream endpoints fail closed with `503`.

## Opening a stream

- `GET /v1/receipts/{receiptId}/stream` follows one receipt until it reaches `finalized` or
  `failed`.
- `GET /v1/sellers/{sellerId}/receipts/stream` follows every receipt for the signed seller while
  the grant is valid.

Both responses are `text/event-stream` with the usual CORS and request-id headers. Frames:

- `stream.ready` — connection established; the data carries the scope, resume `cursor`,
  `heartbeatIntervalMs`, and the final status list.
- `receipt.status` — a status change with `receiptId`, `status`, `network`, `sellerId`,
  `resourceId`, `failureCode`, `settledAt`, `occurredAt`, and a signed `cursor`.
- `stream.reset` — the presented cursor was authentic but no longer replayable; adopt the new
  `cursor` from the frame and continue.
- `stream.end` — terminal; `reason` is `final`, `authorization_expired`, `shutdown`, or
  `backpressure`.
- `: hb <timestamp>` comment heartbeats keep intermediaries from closing idle connections.

Event data contains status metadata only. Signed payment payloads, transaction signatures,
transaction hashes, and receipt evidence never appear on the stream.

## Resuming

Every `receipt.status` and `stream.reset` frame carries an `id` that is the signed cursor, so a
standard `EventSource` reconnect resumes automatically through `Last-Event-ID`. The `cursor` query
parameter is equivalent; if both are supplied they must match. Cursors are validated for
signature, scope, and replay window:

- A cursor outside the retained window (or from another stream) is rejected or reset rather than
  trusted.
- A valid resume skips frames already acknowledged and emits only newer statuses.
- Reconnecting with no cursor delivers a snapshot of the current status, so a late subscriber
  always converges without the full history.

## Lifecycle

Status changes are published from settlement persistence and from the durable receipt update
path; a lightweight per-scope poller covers receipts updated outside the process. Journals are
bounded per scope, so a stalled client cannot grow memory without limit: once the pending queue
overflows, the server ends the stream with `backpressure` and the client should reconnect with
its last cursor. Grants are re-checked on every heartbeat, and an expired grant ends the stream
with `authorization_expired`. Server shutdown flushes open streams with `shutdown`.

## Configuration

`EVENT_STREAM_SIGNING_SECRET` signs grants and cursors. It must be a stable high-entropy secret
shared by every replica; rotation invalidates outstanding grants and cursors, which clients
recover from by minting a new grant and reconnecting. Leaving it unset disables the feature
entirely.
