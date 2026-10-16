# Payment Data Retention and Redaction Policy

## Overview

This document defines the data retention policy for payment records in LumenRoute's backend payment processing system. The policy balances compliance requirements, financial audit trails, operational efficiency, and security by establishing clear retention windows for different data types and mandatory redaction rules for sensitive information.

**Core Principle**: All payment records are retained indefinitely for financial compliance and audit purposes. Cleanup operations mark records as expired or archived rather than deleting them, ensuring immutable evidence trails.

---

## Retention Windows by Data Type

### 1. PaymentAttempt Records

**Retention Period**: Indefinite (effectively 1,000 years in practice)

**Business Justification**:
- Core evidence of payment authorization requests
- Used for replay protection via unique `paymentHash` and `idempotencyKey` constraints
- Necessary for audit trails and regulatory compliance
- Required for financial reconciliation and dispute resolution
- Links seller, resource, and payment network activity

**Data Structure**:
```typescript
{
  id: string;                    // Unique identifier
  correlationId: string;         // Links all payment events
  paymentHash: string;           // Canonical hash (redacted in logs)
  idempotencyKey: string;        // User-supplied dedup key (redacted in logs)
  network: NetworkId;            // Stellar network
  assetCode: string;             // e.g., "USDC"
  assetIssuer: string;           // Issuer public key
  amount: string;                // Payment amount
  payTo: string;                 // Recipient address
  status: PaymentStatus;         // State machine: received → verified → settling → settled
  failureCode?: string;          // Financial evidence if failed
  failureReason?: string;        // Financial evidence if failed
  createdAt: string;             // ISO timestamp
  updatedAt: string;             // ISO timestamp
}
```

**Sensitive Fields** (never logged or stored as-is):
- `paymentHash`: Linkable to user activity
- `idempotencyKey`: User-controlled identifier

**Cleanup Behavior**:
- No deletion ever occurs
- Records older than 7 days with status `"received"` are marked as `"expired"`
- Expiration is tracked via `status` update and logged in AuditLog

---

### 2. Settlement Records

**Retention Period**: Indefinite (effectively 1,000 years in practice)

**Business Justification**:
- Immutable blockchain evidence of transaction settlements
- Contains `transactionHash` and `ledger` number (cryptographic proof)
- Required for reconciliation of on-chain vs. off-chain state
- Critical for dispute resolution and financial audits
- One-to-one relationship with PaymentAttempt (cannot be deleted due to FK constraint `ON DELETE RESTRICT`)

**Data Structure**:
```typescript
{
  id: string;
  correlationId: string;
  paymentAttemptId: string;         // FK: cannot delete
  transactionHash: string | null;   // Blockchain evidence (redacted in logs)
  ledger: number | null;             // Block height
  network: NetworkId;
  amount: string;
  assetCode: string;
  assetIssuer: string;
  status: SettlementStatus;          // pending, submitted, confirmed, settled, failed
  reconciliationState: string;       // not_required, pending, reconciled, needs_review
  reconciliationReason?: string;     // Why manual review is needed
  reconciliationAttempts: number;    // Bounded retry count
  lastReconciledAt?: string;         // Last reconciliation attempt
  settledAt?: string;                // Settlement completion time
  createdAt: string;
}
```

**Sensitive Fields** (redacted in logs):
- `transactionHash`: Linkable to on-chain activity

**Cleanup Behavior**:
- Never deleted (FK constraint prevents it)
- `reconciliationState: "needs_review"` settlements are flagged for operator attention
- Reconciliation jobs retry with exponential backoff (max 8 attempts)
- Failed reconciliations remain for manual review

---

### 3. Receipt Records

**Retention Period**: Indefinite (effectively 1,000 years in practice)

**Business Justification**:
- Customer-facing proof of payment
- Contains deduplicated evidence hash (`evidenceHash`) for detection of duplicate payments
- Includes financial details (`amount`, `assetCode`, `assetIssuer`) for customer records
- Failure information documented for dispute handling
- One-to-one relationship with PaymentAttempt (cannot be deleted due to FK constraint)

**Data Structure**:
```typescript
{
  id: string;
  correlationId: string;
  paymentAttemptId: string;       // FK: cannot delete
  resourceId?: string;
  sellerId?: string;
  transactionHash?: string;       // Redacted in logs
  ledger?: number;
  network: NetworkId;
  amount: string;
  assetCode: string;
  assetIssuer: string;
  status: ReceiptStatus;          // pending, finalized, failed
  settledAt?: string;
  failureCode?: string;           // Financial evidence
  failureReason?: string;         // Financial evidence
  evidenceHash: string;           // SHA256(attempt + settlement) for deduplication
  createdAt: string;
  updatedAt: string;
}
```

**Sensitive Fields** (redacted in logs):
- `transactionHash`: Linkable activity
- `evidenceHash`: Payment linkability

**Cleanup Behavior**:
- Never deleted (FK constraint prevents it)
- Available indefinitely for customer lookup and dispute resolution
- Indexed by `(network, status)`, `(sellerId, status)`, `(resourceId, status)` for quick lookup

---

### 4. PaymentSession Records (Upto Scheme)

**Retention Period**: Indefinite (effectively 1,000 years in practice)

**Business Justification**:
- Streaming payment contracts for Upto scheme
- Tracks cumulative spending against a cap amount
- Required for usage-based billing audits
- One-to-many relationship with UptoSessionSettlement records
- Session history needed for buyer/seller disputes

**Data Structure**:
```typescript
{
  id: string;
  resourceId?: string;
  sellerId?: string;
  network: NetworkId;
  buyer: string;                  // Buyer public key
  payTo: string;                  // Recipient address
  assetCode: string;
  assetIssuer: string;
  assetContractId: string;        // Redacted in logs
  capAmount: string;              // Total budget
  spentAmount: string;            // Cumulative spending
  remainingAmount: string;        // capAmount - spentAmount
  contractId: string;             // Smart contract ID (redacted in logs)
  contractSessionId: string;      // Session ID (redacted in logs)
  resourceHash: string;           // Resource identifier hash
  expiresAtLedger: number;        // Expiration block height
  status: PaymentSessionStatus;   // open, settled, cancelled, expired
  transactionHash?: string;       // Redacted in logs
  ledger?: number;
  usageHash?: string;             // Redacted in logs
  createdAt: string;
  updatedAt: string;
}
```

**Sensitive Fields** (redacted in logs):
- `contractId`: Smart contract linkability
- `contractSessionId`: Session linkability
- `assetContractId`: Asset contract reference
- `usageHash`: Usage pattern linkability
- `transactionHash`: On-chain activity

**Cleanup Behavior**:
- Never deleted
- Sessions remain available for historical lookups
- Settled/expired sessions mark status; never removed

---

### 5. UptoSessionSettlement Records

**Retention Period**: Indefinite (effectively 1,000 years in practice)

**Business Justification**:
- Individual settlement events within a PaymentSession
- Each settlement represents a transaction on-chain with cryptographic proof
- One-to-many relationship with PaymentSession (multiple settlements per session)
- Required for reconciling session balance and usage history

**Data Structure**:
```typescript
{
  id: string;
  sessionId: string;
  network: NetworkId;
  amount: string;
  transactionHash: string;        // Blockchain proof (redacted in logs)
  ledger: number;                 // Block height
  usageHash: string;              // Usage metadata hash (redacted in logs)
  status: SettlementStatus;
  settledAt: string;
  createdAt: string;
}
```

**Sensitive Fields** (redacted in logs):
- `transactionHash`: On-chain linkability
- `usageHash`: Usage tracking

**Cleanup Behavior**:
- Never deleted
- Immutable settlement history
- Indexed for efficient session settlement lookups

---

### 6. AuditLog Records

**Retention Period**: Indefinite (effectively 1,000 years in practice)

**Business Justification**:
- Immutable compliance trail for all payment operations
- Records actor, action, target, and timestamp for non-repudiation
- Enables investigation of payment anomalies and disputes
- Required for regulatory compliance and forensic analysis
- Sanitized metadata (sensitive fields redacted at storage time)

**Data Structure**:
```typescript
{
  id: string;
  correlationId: string | null;
  action: string;                 // e.g., "payment.attempt.created"
  actorType: "buyer" | "facilitator" | "seller" | "system";
  actorId: string | null;         // Who performed the action
  targetType: string;             // e.g., "payment_attempt"
  targetId: string | null;        // What was affected
  metadata: JsonObject;           // Redacted at storage (no secrets)
  createdAt: string;
}
```

**Metadata Examples**:
- `payment.attempt.created`: `{ network, amount, assetCode, resourceId, sellerId }`
- `payment.retention.reviewed`: `{ retained: true, reason: "financial_evidence", status: "failed" }`
- `payment_archived`: `{ paymentAttemptId, status, settledAt, createdAt }`

**Sensitive Fields** (redacted before storage):
- Any field matching `/(secret|seed|private|token|authorization|password|api[_-]?key|payment[_-]?payload)/i`
- Redaction is applied at the `AuditLogService` layer

**Cleanup Behavior**:
- Never deleted
- Available indefinitely for compliance queries
- Indexed by `(actorType, actorId)`, `(targetType, targetId)`, `(action, createdAt)`

---

## Cleanup Operations

### Expired Payment Cleanup

**Trigger**: Automatic cleanup job (stalePaymentCleanup worker) runs on schedule

**Condition**: PaymentAttempt records with:
- `status: "received"` (never progressed to verified/settling)
- `createdAt` older than 7 days (configurable: `stalePaymentAgeMs`)

**Action**: 
1. Update `status` from `"received"` to `"expired"`
2. Set `failureCode: "AUTH_EXPIRED"`
3. Set `failureReason: "Payment authorization expired after inactivity"`
4. Create AuditLog entry: `action: "payment.attempt.expired"`, `metadata: { reason: "age_based_expiration" }`

**Idempotency**: Running cleanup multiple times is safe
- First run marks as expired; subsequent runs ignore already-expired records
- Idempotent via status check in worker query

**Auditability**: 
- Every expiration logged in AuditLog
- `correlationId` links to original PaymentAttempt
- Timestamp and actor recorded for compliance

### Archival of Settled Payments

**Trigger**: Automatic archival job runs on schedule

**Condition**: Settlement records with:
- `status: "settled"` or `status: "confirmed"`
- `settledAt` older than 90 days for testnet or 180 days for mainnet (configurable: `archivePaymentAgeMs`)

**Action**:
1. Create `CatalogEvent` record: `type: "payment_archived"`, `metadata: { paymentAttemptId, status, settledAt, createdAt }`
2. No deletion occurs; record remains in database with status intact

**Idempotency**: Archival is idempotent
- Check if CatalogEvent for this payment already exists
- Skip if already archived

**Auditability**:
- CatalogEvent serves as archival audit trail
- Original PaymentAttempt/Settlement records remain unchanged
- Can query `CatalogEvent` table to find archived payments

### Reconciliation Cleanup

**Trigger**: Background reconciliation job (settlement-confirmation queue)

**Condition**: Settlements with:
- `reconciliationState: "pending"` (awaiting confirmation)
- Not reached max retry count (8 attempts)

**Action**:
1. Query Stellar Horizon API for transaction status
2. If confirmed: `reconciliationState: "reconciled"`, `status: "settled"`
3. If failed: `reconciliationState: "needs_review"` for operator attention
4. Retry with exponential backoff (starting at 5 seconds)
5. Remove from queue after completion or max retries

**Auditability**:
- `reconciliationAttempts` tracks retry count
- `lastReconciledAt` records last attempt timestamp
- `reconciliationReason` explains why manual review is needed

---

## Retention Policy Configuration

### Environment-Based Defaults

**Testnet** (`LUMEN_ENV=testnet`):
```javascript
{
  stalePaymentAgeMs: 7 * 24 * 60 * 60 * 1000,      // 7 days
  archivePaymentAgeMs: 90 * 24 * 60 * 60 * 1000,   // 90 days
  enableExpiredCleanup: true,
  enableArchival: true,
  batchSize: 100,
  maxRetries: 3
}
```

**Mainnet** (`LUMEN_ENV=mainnet`):
```javascript
{
  stalePaymentAgeMs: 7 * 24 * 60 * 60 * 1000,      // 7 days
  archivePaymentAgeMs: 180 * 24 * 60 * 60 * 1000,  // 180 days (6 months)
  enableExpiredCleanup: true,
  enableArchival: true,
  batchSize: 50,                                   // Smaller batch for stability
  maxRetries: 5
}
```

### Custom Configuration

To override defaults, pass a custom `PaymentRetentionPolicy`:

```typescript
import { initializeRedactionService, DEFAULT_TESTNET_POLICY } from "@lumenbazaar/shared";

const customPolicy = {
  ...DEFAULT_TESTNET_POLICY,
  cleanup: {
    ...DEFAULT_TESTNET_POLICY.cleanup,
    expiredPaymentThresholdMs: 3 * 24 * 60 * 60 * 1000, // 3 days instead of 7
    archiveThresholdMs: 60 * 24 * 60 * 60 * 1000        // 60 days instead of 90
  }
};

initializeRedactionService(customPolicy);
```

---

## Sensitive Field Redaction Rules

### Field Name Patterns (Metadata Keys)

These patterns are matched against object keys and redacted to `[redacted]`:

```regex
^(secret|seed|private|token|authorization|password|api[_-]?key)$
^(payment[_-]?hash|idempotency[_-]?key|transaction[_-]?hash|contract[_-]?(id|session[_-]?id)|usage[_-]?hash)$
```

**Examples**:
- `secret` → `[redacted]`
- `api_key` → `[redacted]`
- `paymentHash` → `[redacted]`
- `idempotencyKey` → `[redacted]`
- `contractSessionId` → `[redacted]`

### Value Patterns (String Content)

These patterns are replaced with `[redacted]` in error messages and logs:

```regex
\bBearer\s+[A-Za-z0-9._~+/=-]+\b           # Bearer tokens
\bS[A-Z2-7]{55}\b                           # Stellar secret keys
\b(secret|seed|token|password|api[_-]?key|private[_-]?key|signing[_-]?key)\s*[=:]\s*[^\s,;]+
                                            # Key-value pairs
```

**Examples**:
- `Bearer eyJhbGciOiJIUzI1NiIs...` → `[redacted]`
- `SBGCYAXSV52JRYUBJJ3TTVHJ4THVDKUVPVGWYJK4RN3QXU74NI3EVDFX` → `[redacted]`
- `api_key=sk_live_12345678` → `[redacted]`

### Redaction Layers

1. **Storage Layer** (AuditLogService):
   - Applied when creating AuditLog records
   - Metadata sanitized before database insert
   - Never persists raw sensitive values

2. **Output Layer** (ErrorMapping):
   - Applied to error details in HTTP responses
   - Prevents accidental secret leakage to clients
   - Error messages truncated after redaction

3. **Log Layer** (Worker Jobs):
   - Applied to error messages in background job logs
   - Prevents exposure in job queue history
   - Truncated to 300 characters in production

---

## Implementation Guidelines

### For Application Code

**Logging Payments**:
```typescript
import { getGlobalRedactionService } from "@lumenbazaar/shared";

const redaction = getGlobalRedactionService();

// Never log raw payment attempt
// ❌ logger.info("Payment attempt", paymentAttempt);

// Instead, use the service
const redacted = redaction.redactPaymentRecord(paymentAttempt);
logger.info("Payment attempt", redacted);
```

**Audit Recording**:
```typescript
import { AuditLogService } from "./services/audit";

const auditLog = new AuditLogService();

await auditLog.record({
  action: "payment.attempt.created",
  actorType: "buyer",
  actorId: buyerId,
  targetType: "payment_attempt",
  targetId: paymentAttemptId,
  // Metadata is automatically redacted by AuditLogService
  metadata: {
    network: "stellar:testnet",
    amount: "100.00",
    assetCode: "USDC",
    // ❌ Don't include sensitive fields; they'll be redacted anyway
    // paymentHash: "...", // Already redacted by service
  }
});
```

**Error Handling**:
```typescript
import { toPublicError } from "@lumenbazaar/shared";

try {
  // Payment processing
} catch (error) {
  const publicError = toPublicError(asLumenError(error));
  // Details are automatically redacted
  res.status(statusCode).json(publicError);
}
```

### For Worker Jobs

**Job Error Logging**:
```typescript
import { getGlobalRedactionService } from "@lumenbazaar/shared";

const redaction = getGlobalRedactionService();

try {
  // Process payment
} catch (error) {
  const redactedError = redaction.redactJobError(error);
  await jobQueue.log(redactedError); // Safe to log
}
```

---

## Compliance and Audit

### Non-Repudiation

Every payment action is recorded with:
- **Actor**: Who initiated (buyer, seller, facilitator, system)
- **Action**: What was done (created, verified, settled, etc.)
- **Target**: What was affected (payment attempt, settlement, receipt)
- **Timestamp**: When it occurred (ISO 8601)
- **CorrelationId**: Links all events related to one payment flow

### Data Minimization

- Payment payloads are never persisted; only `paymentHash` is stored
- Stellar transaction envelopes are not stored; only settlement results are
- Buyer/seller account info links via ID, not storing credentials
- Audit metadata contains only operational context, no secrets

### Immutability

- No deletion of any payment records (enforced by database constraints)
- Status changes tracked via `status` field and AuditLog entries
- Chain of custody maintained via correlationId links
- Reconciliation state changes auditable

### Breach Response

If a security incident occurs:

1. **Do not delete records**: Immutability is a security feature
2. **Review AuditLog**: Trace all actions using `(actorType, actorId)` or `(targetType, targetId)`
3. **Check redaction**: Verify no secrets were exposed using `RedactionService.getRedactionStatus()`
4. **Reconcile on-chain**: Compare Settlement.transactionHash with Stellar Horizon
5. **Document**: Create AuditLog entry explaining incident response

---

## Troubleshooting

### Q: Why are my logs showing `[redacted]` values?

**A**: This is correct behavior. Sensitive fields like `paymentHash`, `idempotencyKey`, `contractId`, and bearer tokens are redacted to prevent accidental exposure in logs and error messages. If you need to debug a specific payment, use the `correlationId` to query the database directly in a controlled environment.

### Q: Can I disable redaction for development?

**A**: Not recommended. Use the `testnet` policy which allows more verbose logging, but redaction is still applied. For development debugging:

```typescript
// Query database directly for sensitive fields
const payment = await db.paymentAttempt.findUnique({
  where: { id: paymentAttemptId }
});
// Access fields without redaction here
```

### Q: How do I check if a field is redacted?

**A**: Use the RedactionService:

```typescript
const service = getGlobalRedactionService();
console.log(service.isFieldRedacted("paymentHash"));     // true
console.log(service.isFieldRedacted("amount"));          // false
```

### Q: What happens to very old payment records?

**A**: They are never deleted. Records older than the archival threshold (90/180 days) are marked via CatalogEvent but remain in the database. This allows:
- Historical lookups (e.g., "show me all payments from 2 years ago")
- Compliance queries over long periods
- Forensic analysis if needed

---

## References

- **PaymentRetentionPolicy Type**: `packages/shared/src/retentionPolicy.ts`
- **RedactionService**: `packages/shared/src/redactionService.ts`
- **Audit Service**: `apps/api/src/services/audit.ts`
- **Cleanup Worker**: `apps/worker/src/workers/stalePaymentCleanup.ts`
- **Error Mapping**: `packages/shared/src/errorMapping.ts`

