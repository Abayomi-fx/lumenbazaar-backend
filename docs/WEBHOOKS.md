# Settlement Status Webhooks

This document describes the webhook system for receiving server-to-server notifications when payment settlements change status.

## Overview

Webhooks allow sellers to receive automatic notifications when settlement payments transition between states:
- `settlement.pending` - Settlement awaiting blockchain confirmation
- `settlement.finalized` - Settlement confirmed on blockchain
- `settlement.failed` - Settlement failed permanently
- `settlement.reconciled` - Settlement finality confirmed on Horizon

## Security

### SSRF Protection

Webhook URLs are validated to prevent Server-Side Request Forgery (SSRF) attacks:
- **HTTPS only**: HTTP URLs are rejected
- **No credentials**: URLs cannot contain username/password
- **No private IPs**: Loopback, link-local, and private IP ranges are rejected (127.x, 10.x, 192.168.x, 172.16-31.x, 169.254.x)
- **No redirects**: Delivery does not follow HTTP redirects

### Secret Rotation

Webhook secrets are rotated with an overlap window:
1. Create endpoint → receive secret (shown only once)
2. Call `/rotate-secret` endpoint → receive new secret (shown only once)
3. Old secret remains valid for 1 hour (overlap window)
4. After overlap window expires, old secret is rejected

Deliveries during overlap period are signed with both secrets in headers:
- `x-lumenbazaar-signature`: Current signature
- `x-lumenbazaar-signature-previous`: Previous signatures (comma-separated if multiple)

### Signature Verification

All deliveries are signed with HMAC-SHA256. Verify signatures using:

```
signature = HMAC-SHA256(secret, "{timestamp}.{rawBody}")
```

Where:
- `secret`: Your webhook secret (base64-encoded)
- `timestamp`: Value from `x-lumenbazaar-timestamp` header (ISO 8601)
- `rawBody`: Raw JSON body as received (do not parse/re-encode)

Use **constant-time comparison** to prevent timing attacks.

### Replay Protection

Signatures include a timestamp that must be verified:
- Reject deliveries older than **5 minutes** (300 seconds)
- Timestamp is in `x-lumenbazaar-timestamp` header

## Webhook Payload

All webhook payloads have this structure:

```json
{
  "schemaVersion": "1.0.0",
  "eventId": "corr_123.settlement.finalized",
  "eventType": "settlement.finalized",
  "timestamp": "2026-10-17T12:34:56Z",
  "paymentId": "pay_456",
  "settlementId": "settle_789",
  "status": "confirmed",
  "network": "testnet",
  "amount": "100000000",
  "assetCode": "USDC",
  "assetIssuer": "GAAAA...",
  "transactionHash": "abc123...",
  "failureCode": null,
  "failureReason": null
}
```

### Schema Version

The `schemaVersion` field is explicit and must be checked:
- `1.0.0`: Current version
- Future versions may add fields or change behavior

### Event ID (Idempotency)

The `eventId` is stable and unique per settlement transition:
- Format: `{correlationId}.{eventType}`
- Same `eventId` indicates a retry of the same event
- Use `eventId` for deduplication on your side

### Optional Fields

Some fields are only present for specific status values:
- `transactionHash`: Present when settled on blockchain, absent until confirmed
- `failureCode`: Present for failed settlements only
- `failureReason`: Present for failed settlements only

Never assume these fields exist; always check before accessing.

### Sensitive Data Not Included

These fields are **never** included in webhook payloads:
- Payment signatures
- Authorization entries
- Seller secrets or keys
- Raw Prisma records (only explicit allowlisted fields)

## API Endpoints

### Create Webhook Endpoint

```
POST /v1/sellers/{sellerId}/webhooks
```

**Request:**
```json
{
  "url": "https://api.example.com/webhook",
  "isActive": true
}
```

**Response (202):**
```json
{
  "id": "webhook_1234...",
  "sellerId": "seller_456",
  "url": "https://api.example.com/webhook",
  "isActive": true,
  "secret": "base64-encoded-secret",
  "lastDeliveryAt": null,
  "lastDeliveryStatus": null,
  "createdAt": "2026-10-17T12:00:00Z",
  "updatedAt": "2026-10-17T12:00:00Z"
}
```

**Important:** The `secret` is shown only once at creation. Store it securely. If lost, rotate the secret.

### List Webhook Endpoints

```
GET /v1/sellers/{sellerId}/webhooks?limit=20&offset=0
```

**Response:**
```json
{
  "endpoints": [
    {
      "id": "webhook_1234...",
      "url": "https://api.example.com/webhook",
      "isActive": true,
      "lastDeliveryAt": "2026-10-17T12:10:00Z",
      "lastDeliveryStatus": 200,
      "createdAt": "2026-10-17T12:00:00Z",
      "updatedAt": "2026-10-17T12:00:00Z"
    }
  ],
  "total": 1
}
```

Note: Endpoints do not include secrets (never exposed after creation).

### Get Webhook Endpoint

```
GET /v1/sellers/{sellerId}/webhooks/{endpointId}
```

Returns same structure as list endpoint (without secret).

### Update Webhook Endpoint

```
PATCH /v1/sellers/{sellerId}/webhooks/{endpointId}
```

**Request (optional fields):**
```json
{
  "url": "https://new-api.example.com/webhook",
  "isActive": false
}
```

### Delete Webhook Endpoint

```
DELETE /v1/sellers/{sellerId}/webhooks/{endpointId}
```

Deletes endpoint and all delivery history. This cannot be undone.

### Rotate Secret

```
POST /v1/sellers/{sellerId}/webhooks/{endpointId}/rotate-secret
```

**Response:**
```json
{
  "id": "webhook_secret_789...",
  "endpointId": "webhook_1234...",
  "secret": "new-base64-encoded-secret",
  "isCurrent": true,
  "createdAt": "2026-10-17T12:05:00Z",
  "rotatedOutAt": null
}
```

New secret is shown only once. Previous secret remains valid for 1 hour.

### List Webhook Events

```
GET /v1/sellers/{sellerId}/webhooks/events?limit=20&offset=0
```

Lists all webhook events for a seller (for debugging/audit).

### List Delivery Attempts

```
GET /v1/sellers/{sellerId}/webhooks/{endpointId}/deliveries?limit=20&offset=0
```

Lists all delivery attempts for an endpoint (for debugging/troubleshooting).

## Delivery Behavior

### Retry Strategy

Webhook delivery uses exponential backoff with jitter:

| Attempt | Base Delay | Delay Range |
|---------|-----------|-------------|
| 1       | 5s        | 5.0s - 5.5s  |
| 2       | 10s       | 10.0s - 11s  |
| 3       | 20s       | 20.0s - 22s  |
| 4       | 40s       | 40.0s - 44s  |
| 5       | 80s       | 80.0s - 88s  |

Maximum **5 attempts** (initial + 4 retries).

### Retriable vs Non-Retriable Errors

**Retriable (will retry):**
- 408 Request Timeout
- 429 Rate Limited
- 5xx Server Errors
- Connection timeouts
- DNS failures
- Connection refused

**Non-Retriable (terminal failure):**
- 4xx Client Errors (except 408, 429)
- Invalid URL
- Malformed request

### Request Timeout

Each delivery attempt has a **10 second timeout**. If your endpoint doesn't respond within 10s, the delivery is retried.

### No Response Body Storage

Response bodies are truncated to 500 characters and stored only for audit/debugging purposes. Original response is never logged or persisted.

## Implementation Examples

### Node.js / TypeScript

```typescript
import crypto from 'crypto';

export function verifyWebhookSignature(
  secret: string,
  timestamp: string,
  rawBody: string,
  signature: string
): boolean {
  // Verify timestamp is recent (within 5 minutes)
  const receivedTime = new Date(timestamp);
  const nowTime = new Date();
  const ageSeconds = (nowTime.getTime() - receivedTime.getTime()) / 1000;
  
  if (ageSeconds < 0 || ageSeconds > 300) {
    return false;
  }
  
  // Decode secret from base64
  const secretBuffer = Buffer.from(secret, 'base64');
  
  // Compute expected signature
  const signedContent = `${timestamp}.${rawBody}`;
  const expectedSignature = crypto
    .createHmac('sha256', secretBuffer)
    .update(signedContent)
    .digest('hex');
  
  // Constant-time comparison
  return crypto.timingSafeEqual(
    Buffer.from(signature, 'hex'),
    Buffer.from(expectedSignature, 'hex')
  );
}

// In your webhook handler:
app.post('/webhook', (req, res) => {
  const signature = req.headers['x-lumenbazaar-signature'];
  const eventId = req.headers['x-lumenbazaar-event-id'];
  const timestamp = req.headers['x-lumenbazaar-timestamp'];
  
  const rawBody = req.rawBody; // Get unparsed body
  
  if (!verifyWebhookSignature(process.env.WEBHOOK_SECRET, timestamp, rawBody, signature)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const payload = JSON.parse(rawBody);
  
  // Deduplicate by eventId
  const isNew = await markEventDelivered(eventId);
  if (!isNew) {
    return res.status(200).json({ ok: true }); // Already processed
  }
  
  // Process payment status change
  switch (payload.eventType) {
    case 'settlement.finalized':
      await handleFinalized(payload);
      break;
    case 'settlement.failed':
      await handleFailed(payload);
      break;
    // ... etc
  }
  
  res.json({ ok: true });
});
```

### Python

```python
import hmac
import hashlib
from datetime import datetime, timedelta

def verify_webhook_signature(secret: str, timestamp: str, raw_body: str, signature: str) -> bool:
    # Verify timestamp is recent
    received_time = datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
    now = datetime.utcnow().replace(tzinfo=received_time.tzinfo)
    age_seconds = (now - received_time).total_seconds()
    
    if age_seconds < 0 or age_seconds > 300:
        return False
    
    # Decode secret
    secret_bytes = secret.encode('utf-8')  # Or base64.b64decode(secret) if base64
    
    # Compute signature
    signed_content = f"{timestamp}.{raw_body}"
    expected_signature = hmac.new(
        secret_bytes,
        signed_content.encode('utf-8'),
        hashlib.sha256
    ).hexdigest()
    
    # Constant-time comparison
    return hmac.compare_digest(signature, expected_signature)
```

## Monitoring

### Delivery History

Check delivery attempts at:
```
GET /v1/sellers/{sellerId}/webhooks/{endpointId}/deliveries
```

Each delivery attempt includes:
- `statusCode`: HTTP response code (or null if connection failed)
- `latencyMs`: Milliseconds to get response
- `errorClass`: Error type if failed (e.g., "TimeoutError")
- `createdAt`: Timestamp of attempt

### Event Tracking

View all webhook events at:
```
GET /v1/sellers/{sellerId}/webhooks/events
```

Shows event type, status, and creation time for each event.

### Last Delivery Status

Each endpoint shows:
- `lastDeliveryAt`: Time of most recent delivery attempt
- `lastDeliveryStatus`: HTTP status code of last attempt

## Troubleshooting

### Webhook Not Delivered

1. Check endpoint is active: `isActive: true`
2. Verify URL in endpoint is correct
3. Check delivery history for error details
4. Ensure your server returns 2xx status
5. Verify your server accepts POST requests
6. Check that your server is accessible from public internet

### Verification Failures

1. Use correct secret (base64-encoded from response)
2. Verify timestamp is recent (within 5 minutes)
3. Use raw JSON body (do not parse/re-encode)
4. Use constant-time comparison for signatures
5. Check for secret rotation overlap window

### High Latency

If deliveries are slow:
1. Optimize your webhook handler (< 1 second preferred)
2. Use async/background job processing
3. Return 2xx status immediately, process async
4. Check server logs for issues

### Lost Secret

If you lose your secret:
1. Call `/rotate-secret` endpoint
2. Use new secret for signature verification
3. Old secret is invalid after overlap window (1 hour)

## Limits

- Maximum 100 webhook endpoints per seller
- Maximum 10,000 delivery attempts retained per endpoint
- Response body truncated to 500 characters
- Payload size limited to 1MB
- Request timeout: 10 seconds
- Maximum 5 delivery attempts
- Overlap window on secret rotation: 1 hour
