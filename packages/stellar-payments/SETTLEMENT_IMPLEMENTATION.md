# Exact Settlement Implementation with Horizon Verification

## Overview

This document describes the exact settlement payment implementation that ensures transactions are confirmed on the Stellar network before finalizing payment receipts.

## Key Design Principles

### 1. Finality Requirements (No Pending, Failed, or Synthetic Results)

**Acceptance Criterion**: A finalized receipt must only be issued when:

- Transaction successfully submitted to Stellar network
- Transaction confirmed on-chain (recorded in specific ledger)
- Transaction details verified through Horizon API

**Invalid Receipt States**:

- Settlement status "pending" (transaction not yet visible)
- Settlement status "failed" (transaction rejected)
- Settlement status "timed_out" (finality unconfirmed after timeout)
- Receipt without matching evidence hash

### 2. Transaction Submission (Single Attempt Guarantee)

The settlement flow prevents duplicate submissions through idempotent settlement request handling:

```
1. Verify payment payload against requirements
2. Compute deterministic paymentHash from payload
3. Check if hash already submitted (idempotency check)
4. Atomically transition from "verified" → "settling" (claimSettlement)
5. Submit to Stellar via RPC/adapter
6. Resolve finality (RPC polling with retry)
7. Record settlement with transaction hash
8. On concurrent request: wait up to 5 seconds for result, return cached
```

**Idempotency Mechanisms**:

- `PaymentAttemptStore.hashes`: Map<paymentHash, attemptId> prevents replay
- `SettlementStore.byTransactionHash`: Map<txHash, settlementId> prevents duplicate recordings
- `claimSettlement()`: Atomic "verified" → "settling" transition blocks concurrent settlement

### 3. Horizon Finality Verification (Exact Ledger & Hash Matching)

**RPC Finality Resolution** (`resolveRpcFinality()` in x402Adapter.ts):

- 20 retry attempts with exponential backoff (100ms start, 2000ms cap)
- Total resolution window: ~30 seconds
- Handles three RPC response states:
  - `SUCCESS` with ledger number → confirmed
  - `FAILED` → settlement failed on-chain
  - `PENDING` → retry or timeout
- Aborts on network errors and retries

**Horizon Reconciliation Worker** (`handleSettlementConfirmation()` in settlementConfirmation.ts):

- BullMQ job with 8 retry attempts
- Exponential backoff: 5s → 5s\*2^7 (640s max)
- Uses Stellar SDK `Horizon.Server.transactions()`
- Verifies:
  - `transaction.successful === true`
  - `transaction.ledger_attr` matches recorded ledger
  - Transaction hash matches settlement record

### 4. Receipt Finalization (Deferred Until Horizon Confirms)

**Receipt Status Lifecycle**:

```
Creation (settlement.ts):
  settlement.status = "confirmed"
  settlement.reconciliationState = "not_required" (or "pending")
  receipt.status = "pending"
  ↓
Reconciliation (settlementConfirmation.ts, if "pending"):
  settlement.reconciliationState = "reconciled"
  receipt.status = "finalized"
  receipt.evidenceHash = SHA256(attemptId:paymentHash:txHash:ledger:network:amount:assetIssuer)
  ↓
Final State:
  receipt.status = "finalized"
  receipt.evidenceHash matches computation
  Payment is confirmed and cannot be reversed
```

**Important**: Receipts are created in "pending" status when settlement is submitted. They are NOT finalized until the reconciliation worker confirms the transaction on Horizon.

### 5. Idempotent Retries (No Double Submission)

The system ensures that even with concurrent settlement requests, only one transaction is submitted:

```typescript
// Concurrent requests with same paymentHash
const [result1, result2] = await Promise.all([
  service.settle(request),
  service.settle(request) // Same payload
]);

// Both return same result (no double submission)
assert(result1.transactionHash === result2.transactionHash);
assert(result1.settlementId === result2.settlementId);
```

**Implementation**:

1. `findPaymentAttemptByHash()` returns existing attempt if already verified
2. `claimSettlement()` atomically transitions to "settling" status
3. Second request gets `undefined` from `claimSettlement()` and waits
4. `waitForDurableResult()` polls every 20ms up to 5 seconds for completion
5. Both requests eventually return same result

### 6. Error Handling & Manual Review

**Failed Transactions** (Settlement.status = "failed"):

- Adapter returned failure during submission
- Transaction hash available (if submitted before failure)
- Marked for manual review via `reconciliationState = "needs_review"`
- Audit log: "settlement.reconciliation.needs_review"

**Timeout Transactions** (Settlement.status = "timed_out"):

- RPC finality polling exhausted 20 attempts
- Transaction hash exists but finality unconfirmed
- Retried by Horizon reconciliation worker
- If reconciliation fails: marked for manual review

**No Double Spending**: All failure states maintain idempotency - retrying a failed settlement with same payload returns the same failure.

## Data Models

### Settlement

```typescript
{
  id: string;                                    // Unique settlement ID
  correlationId: string;                         // Tracking ID
  paymentAttemptId: string;                      // Links to payment attempt
  transactionHash: string | null;                // Stellar transaction hash
  ledger: number | null;                         // Ledger sequence number
  network: NetworkId;                            // testnet | public
  amount: Decimal;                               // Amount in stroops
  assetCode: string;                             // e.g., "USDC"
  assetIssuer: string;                           // Issuer account public key
  status: "confirmed" | "failed" | "timed_out";  // Final outcome
  reconciliationState:                           // Finality stage
    | "not_required"  // Legacy: settled by adapter
    | "pending"       // Awaiting Horizon confirmation
    | "reconciled"    // Horizon confirmed
    | "needs_review"; // Failed or unresolvable
  reconciliationReason: string | null;           // Failure reason
  reconciliationAttempts: number;                // Retry counter
  lastReconciledAt: DateTime | null;             // Last check time
  settledAt: DateTime | null;                    // When settled
  createdAt: DateTime;
}
```

### Receipt

```typescript
{
  id: string; // Unique receipt ID
  correlationId: string; // Tracking ID
  paymentAttemptId: string; // Links to payment attempt
  resourceId: string | null; // Resource being paid for
  sellerId: string | null; // Seller account
  transactionHash: string | null; // Stellar transaction hash
  ledger: number | null; // Ledger sequence number
  network: NetworkId; // testnet | public
  amount: Decimal; // Amount in stroops
  assetCode: string; // e.g., "USDC"
  assetIssuer: string; // Issuer account public key
  status: "pending" | "finalized"; // Payment proof status
  settledAt: DateTime | null; // Settlement timestamp
  failureCode: string | null; // Error code if failed
  failureReason: string | null; // Error description
  evidenceHash: string; // SHA256 proof of payment
  createdAt: DateTime;
  updatedAt: DateTime;
}
```

### PaymentAttempt

```typescript
{
  id: string;                                    // Unique attempt ID
  correlationId: string;                         // Tracking ID
  resourceId: string | null;                     // Resource identifier
  sellerId: string | null;                       // Seller identifier
  paymentHash: string;                           // Deterministic hash of payload
  idempotencyKey: string;                        // Idempotency key
  network: NetworkId;                            // testnet | public
  assetCode: string;                             // e.g., "USDC"
  assetIssuer: string;                           // Issuer account
  amount: Decimal;                               // Amount in stroops
  payTo: string;                                 // Recipient account
  status:                                        // Verification/settlement stage
    | "verified"   // Payment verified, awaiting settlement
    | "settling"   // Settlement in progress
    | "confirmed"  // Settlement confirmed (awaiting Horizon)
    | "failed";    // Settlement or verification failed
  failureCode: ErrorCode | null;                 // Error classification
  failureReason: string | null;                  // Error message
  expiresAtLedger: number | null;                // Expiry ledger
  createdAt: DateTime;
  updatedAt: DateTime;
}
```

## Flow Diagrams

### Settlement Submission Flow

```
POST /settle
    ↓
1. Parse & validate x402 v2 payload
    ↓
2. Compute paymentHash (deterministic)
    ↓
3. findPaymentAttemptByHash → NOT FOUND?
    ├─ YES: Error "Payment attempt not found"
    └─ NO: Continue
    ↓
4. checkExistingResult() → Settlement exists?
    ├─ YES (confirmed): Return cached result
    ├─ YES (failed/timed_out): Return cached error
    └─ NO: Continue
    ↓
5. claimSettlement(attemptId) → Atomic verified→settling transition
    ├─ NULL: Another request is settling, waitForDurableResult()
    └─ SUCCESS: Continue
    ↓
6. adapter.verifyExact() → Fresh verification
    ├─ FAIL: Record attempt as failed, throw error
    └─ SUCCESS: Continue
    ↓
7. adapter.settleExact() → Submit to Stellar RPC
    ├─ FAIL: recordFailedSettlement(), enqueue reconciliation if txHash exists
    ├─ TIMED_OUT: recordFailedSettlement(), enqueue reconciliation
    └─ SUCCESS (confirmed + ledger): Continue
    ↓
8. Create settlement record
    status = "confirmed"
    reconciliationState = "pending" (if txHash) or "not_required"
    transactionHash = adapter result
    ledger = adapter result
    ↓
9. Update payment attempt
    status = "confirmed"
    ↓
10. Create/finalize receipt
    status = "pending" (will be finalized by reconciliation worker)
    ↓
11. Audit log: "payment.settle"
    ↓
12. Return SettlementServiceResult
    status = "confirmed"
    transactionHash, ledger, settlementId, receiptId
```

### Horizon Reconciliation Flow

```
BullMQ Job: SettlementConfirmationJobData
    ↓
1. Load paymentAttempt with settlement and receipt
    ↓
2. Is settlement already finalized?
    ├─ YES: Return success
    └─ NO: Continue
    ↓
3. Get transactionHash from settlement or job data
    ├─ NULL: Mark needs_review, return
    └─ NOT NULL: Continue
    ↓
4. statusClient.getTransactionState(txHash, network)
    Uses Horizon.Server.transactions().transaction(hash).call()
    ↓
5. Response handling:

    a) PENDING:
       ├─ Update reconciliationState = "pending"
       ├─ Increment reconciliationAttempts
       ├─ Throw ReconciliationPendingError
       └─ BullMQ retries job

    b) FAILED:
       ├─ Call recordNeedsReview()
       ├─ Update settlement.reconciliationState = "needs_review"
       ├─ Return (stop processing)
       └─ Manual review required

    c) CONFIRMED:
       ├─ Verify ledger matches settlement.ledger
       ├─ Compute evidenceHash
       ├─ Create/update receipt with evidenceHash
       ├─ Finalize receipt.status = "finalized"
       ├─ Update settlement.reconciliationState = "reconciled"
       ├─ Update paymentAttempt.status = "confirmed"
       ├─ Create audit log: "settlement.reconciliation.confirmed"
       └─ Return success
    ↓
6. Retry Strategy (if pending):
    Attempt 1: Immediate
    Attempt 2: 5s delay
    Attempt 3: 10s delay
    Attempt 4: 20s delay
    Attempt 5: 40s delay
    Attempt 6: 80s delay
    Attempt 7: 160s delay
    Attempt 8: 320s delay (max: 640s)

    Total window: ~15 minutes of retries
```

## Configuration

Required environment variables:

```
# Network Configuration
STELLAR_TESTNET_RPC_URL=http://stellar-testnet.stellar.org/soroban/rpc
STELLAR_TESTNET_HORIZON_URL=https://horizon-testnet.stellar.org
STELLAR_PUBLIC_RPC_URL=http://stellar.stellar.org/soroban/rpc
STELLAR_PUBLIC_HORIZON_URL=https://horizon.stellar.org

# Settlement Configuration
SETTLEMENT_MAX_TRANSACTION_FEE_STROOPS=100000
SETTLEMENT_INCLUSION_FEE_STROOPS=1000

# Facilitator Signing
STELLAR_FACILITATOR_SECRET=<secret-key>

# Redis for BullMQ
REDIS_URL=redis://localhost:6379
```

## Testing

### Unit Tests

- `settlement.horizonFinality.test.ts`: Settlement service with mocked adapter
- `rpcFinalityRetry.test.ts`: RPC finality retry logic with exponential backoff

### Integration Tests

- `settlement.testnetE2e.integration.test.ts`: End-to-end with actual Horizon

### Running Tests

```bash
# Unit tests (fast)
pnpm test packages/stellar-payments/src/settlement.horizonFinality.test.ts

# RPC retry tests (fast)
pnpm test packages/stellar-payments/src/rpcFinalityRetry.test.ts

# E2E integration (requires TESTNET_FACILITATOR_SECRET)
TESTNET_FACILITATOR_SECRET=... pnpm test packages/stellar-payments/src/settlement.testnetE2e.integration.test.ts
```

## Validation Checklist

- [x] Funded testnet vector produces real successful transaction
- [x] Hash and ledger match network record (Horizon confirms)
- [x] Timeout and failed transaction states remain non-final
- [x] Idempotent retries do not submit twice
- [x] Receipt not finalized until Horizon confirms
- [x] Evidence hash computed and verified
- [x] Audit trails for all state transitions
- [x] Manual review process for failed settlements
- [x] No pending, failed, or synthetic results issued as receipts
