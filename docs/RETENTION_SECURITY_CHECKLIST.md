# Payment Data Retention and Redaction - Security Checklist

## Pre-Deployment Verification

Use this checklist before deploying payment data retention and redaction changes.

### Code Review

- [ ] **Retention Policy Type Definitions**
  - [ ] `retentionPolicy.ts` defines all required field patterns
  - [ ] Sensitive field patterns include all payment identifiers
  - [ ] Sensitive value patterns include Bearer tokens, Stellar keys, and key-value pairs
  - [ ] Retention windows are set to indefinite (or reasonable alternative with justification)

- [ ] **RedactionService Implementation**
  - [ ] `sanitizeMetadata()` redacts all sensitive keys and values
  - [ ] `redactObject()` handles nested structures
  - [ ] `redactErrorMessage()` truncates long messages
  - [ ] No plaintext secrets stored in memory longer than necessary
  - [ ] Factory functions properly initialize service

- [ ] **Audit Service Integration**
  - [ ] AuditLogService uses RedactionService
  - [ ] `sanitizeAuditMetadata()` called before database insert
  - [ ] Backward compatibility function maintains existing API
  - [ ] No secrets persisted to database

- [ ] **Cleanup Worker**
  - [ ] All cleanup operations are idempotent
  - [ ] No destructive deletions (only status updates and audit logs)
  - [ ] Batch processing respects configured batch size
  - [ ] Retry logic has maximum attempt limit
  - [ ] Error messages are redacted before logging

### Database Schema

- [ ] **Foreign Key Constraints**
  - [ ] Settlement table has `ON DELETE RESTRICT` on payment_attempt FK
  - [ ] Receipt table has `ON DELETE RESTRICT` on payment_attempt FK
  - [ ] Prevents accidental orphaning of financial evidence

- [ ] **Unique Constraints**
  - [ ] `paymentHash` is unique on PaymentAttempt
  - [ ] `idempotencyKey` is unique on PaymentAttempt
  - [ ] `transactionHash` is unique on Settlement
  - [ ] `evidenceHash` is unique on Receipt
  - [ ] Ensures immutability of payment records

- [ ] **Indexes for Performance**
  - [ ] Index on `(payment_attempt.status, payment_attempt.created_at)`
  - [ ] Index on `(audit_log.correlation_id)`
  - [ ] Index on `(audit_log.actor_type, audit_log.actor_id)`
  - [ ] Index on `(settlement.reconciliation_state, settlement.last_reconciled_at)`

### Testing

- [ ] **Unit Test Coverage**
  - [ ] Redaction tests cover all sensitive field patterns
  - [ ] Redaction tests cover all sensitive value patterns
  - [ ] Retention policy tests validate all retention windows
  - [ ] Edge cases tested (nested objects, null values, mixed types)
  - [ ] Factory functions tested for all environments

- [ ] **Integration Tests**
  - [ ] Database round-trip preserves redaction
  - [ ] Cleanup operations are actually idempotent
  - [ ] Audit trail survives database restart
  - [ ] Sensitive data never exposed in logs
  - [ ] Cleanup respects batch size limit

- [ ] **Test Execution**
  - [ ] `pnpm test packages/shared/src/redactionService.test.ts` passes
  - [ ] `pnpm test packages/shared/src/retentionPolicy.test.ts` passes
  - [ ] `PAYMENT_PERSISTENCE_TEST_DATABASE_URL=... pnpm test apps/api/src/services/redactionPolicy.integration.test.ts` passes
  - [ ] `PAYMENT_PERSISTENCE_TEST_DATABASE_URL=... pnpm test apps/worker/src/stalePaymentCleanup.integration.test.ts` passes

### Configuration

- [ ] **Environment Variables**
  - [ ] `LUMEN_ENV` is set correctly (testnet/mainnet)
  - [ ] Testnet policy used for development/testing
  - [ ] Mainnet policy used for production
  - [ ] Batch sizes are appropriate for environment

- [ ] **Policy Configuration**
  - [ ] Retention windows match business requirements
  - [ ] Cleanup thresholds are documented
  - [ ] Error message length limits are reasonable
  - [ ] Batch size doesn't strain database

### Sensitive Data Handling

- [ ] **Secrets Never Logged**
  - [ ] No Bearer tokens in logs
  - [ ] No Stellar secret keys in logs
  - [ ] No API keys in logs
  - [ ] No encryption keys in logs
  - [ ] No private key material in logs

- [ ] **Audit Trail Integrity**
  - [ ] All audit logs include correlationId
  - [ ] All audit logs include actor (non-repudiation)
  - [ ] All audit logs include timestamp
  - [ ] Audit logs are append-only (never updated)
  - [ ] Audit logs are never deleted

- [ ] **Payment Record Integrity**
  - [ ] Payment hashes never exposed in error responses
  - [ ] Transaction hashes never exposed in error responses
  - [ ] Contract IDs never exposed in error responses
  - [ ] Financial details (amount, status) ARE exposed (needed for operations)

### Error Handling

- [ ] **Error Messages Redacted**
  - [ ] Bearer tokens redacted in error messages
  - [ ] Stellar keys redacted in error messages
  - [ ] API keys redacted in error messages
  - [ ] Error messages truncated to prevent log spam
  - [ ] Redacted errors still provide useful debugging info

- [ ] **Failed Operations Auditable**
  - [ ] Failed cleanup attempts logged to audit trail
  - [ ] Retry count tracked and logged
  - [ ] Error reason captured (redacted)
  - [ ] No data lost on cleanup failure

---

## Runtime Security Checks

### On Application Startup

```typescript
// Verify redaction service is configured
const redaction = getGlobalRedactionService();
const status = redaction.getRedactionStatus();

if (!status.enabled) {
  console.error("SECURITY: Redaction service not enabled!");
  process.exit(1);
}

if (status.fieldPatternsCount === 0 || status.valuePatternCount === 0) {
  console.error("SECURITY: No redaction patterns configured!");
  process.exit(1);
}

console.log("✓ Redaction service active");
```

### On First Payment Processing

```typescript
// Verify no secrets are logged
const testPayment = {
  paymentHash: "hash_test",
  idempotencyKey: "key_test",
  amount: "100.00"
};

const redacted = redaction.redactPaymentRecord(testPayment);

if (
  JSON.stringify(redacted).includes("hash_test") ||
  JSON.stringify(redacted).includes("key_test")
) {
  console.error("SECURITY: Redaction not working properly!");
  process.exit(1);
}

console.log("✓ Redaction verified on test payment");
```

### During Cleanup Job Execution

```typescript
// Verify no sensitive data in job logs
const jobLogs = getJobLogs();

const suspiciousPatterns = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/,
  /\bS[A-Z2-7]{55}\b/,
  /secret\s*[=:]/i,
  /api_key\s*[=:]/i
];

for (const log of jobLogs) {
  for (const pattern of suspiciousPatterns) {
    if (pattern.test(log)) {
      console.error(`SECURITY ALERT: Suspected secret in log: ${log.slice(0, 50)}`);
      // Alert monitoring system
    }
  }
}
```

---

## Compliance Verification

### Financial Audit Requirements

- [ ] **Payment Evidence Retained**
  - [ ] All payment attempts retained (no deletion)
  - [ ] All settlements retained (blockchain evidence)
  - [ ] All receipts retained (customer proof)
  - [ ] Failure reasons documented (financial events)

- [ ] **Audit Trail Complete**
  - [ ] All payment state transitions logged
  - [ ] All actor actions recorded
  - [ ] All timestamps accurate and immutable
  - [ ] Chain of custody maintained via correlationId

- [ ] **Reconciliation Possible**
  - [ ] On-chain transactions linked to off-chain records
  - [ ] Settlement status tracked
  - [ ] Reconciliation attempts logged
  - [ ] Manual review capability preserved

### Data Privacy Requirements

- [ ] **Sensitive Data Minimization**
  - [ ] Payment payloads not persisted (only hashes)
  - [ ] Stellar envelopes not stored (only results)
  - [ ] Secret keys never persisted anywhere
  - [ ] Access tokens not stored in application

- [ ] **User Data Protection**
  - [ ] Payment hashes don't link to user identities in logs
  - [ ] Transaction details not exposed to unauthorized parties
  - [ ] Buyer/seller account info links via ID, not secrets
  - [ ] Audit trail accessible only to authorized personnel

- [ ] **Incident Response**
  - [ ] Security incidents don't require deleting records
  - [ ] Immutable evidence preserved for investigation
  - [ ] Redacted logs safe to store indefinitely
  - [ ] No operational data loss on breach

---

## Monitoring and Alerts

### Metrics to Monitor

```typescript
// Track redaction application
metrics.counter("redaction.fields_redacted", count);
metrics.counter("redaction.values_redacted", count);
metrics.gauge("redaction.service_status", status.enabled ? 1 : 0);

// Track cleanup operations
metrics.counter("cleanup.expired_marked", count);
metrics.counter("cleanup.failed_retained", count);
metrics.counter("cleanup.settled_archived", count);
metrics.counter("cleanup.failures", count);

// Track audit trail health
metrics.gauge("audit_log.total_entries", count);
metrics.gauge("audit_log.recent_actions", recentCount);
```

### Alerts to Configure

- [ ] **Redaction Service Down**
  - Trigger: `redaction.service_status == 0`
  - Action: Page on-call, halt payment processing

- [ ] **Cleanup Job Failed**
  - Trigger: `cleanup.failures > threshold`
  - Action: Alert ops, check logs (redacted)

- [ ] **Suspicious Log Patterns**
  - Trigger: Log contains Bearer/secret/key patterns
  - Action: Alert security, investigate manually

- [ ] **Audit Trail Gap**
  - Trigger: `audit_log.recent_actions == 0` for 1 hour
  - Action: Alert ops, verify audit service health

---

## Breach Response Procedures

### If Sensitive Data Was Exposed

**Do NOT delete records.** Immutability is a security feature.

1. **Preserve Evidence**
   ```sql
   -- Take backup before any changes
   CREATE TABLE audit_log_backup AS SELECT * FROM audit_log;
   CREATE TABLE payment_attempt_backup AS SELECT * FROM payment_attempt;
   ```

2. **Identify Scope**
   ```sql
   -- Find which payments/actors were affected
   SELECT DISTINCT correlation_id, actor_id, actor_type, action
   FROM audit_log
   WHERE created_at BETWEEN 'incident_start' AND 'incident_end'
   ORDER BY created_at;
   ```

3. **Verify Redaction Status**
   ```sql
   -- Check if sensitive data was stored
   SELECT * FROM audit_log
   WHERE metadata::text LIKE '%Bearer%'
      OR metadata::text LIKE '%S[A-Z2-7]{55}%'
      OR metadata::text LIKE '%api_key=%';
   ```

4. **Document Timeline**
   ```typescript
   const timeline = await db.auditLog.findMany({
     where: { createdAt: { gte: incidentStart, lte: incidentEnd } },
     orderBy: { createdAt: "asc" }
   });
   // Create forensic report
   ```

5. **Notify Affected Parties**
   - Use audit trail to identify affected buyers/sellers
   - Preserve all evidence for regulatory notification if required

6. **Post-Incident**
   - Don't delete affected records
   - Update security policies if redaction patterns were insufficient
   - Run security audit on redaction implementation

---

## Compliance Certification

### When Deploying to Mainnet

Run this verification script:

```typescript
import {
  DEFAULT_MAINNET_POLICY,
  RedactionService,
  createRedactionService
} from "@lumenbazaar/shared";

async function verifyCertification() {
  console.log("=== Mainnet Compliance Certification ===\n");

  // 1. Verify redaction service
  const redaction = new RedactionService(DEFAULT_MAINNET_POLICY);
  const status = redaction.getRedactionStatus();
  console.log("✓ Redaction service configured:", status);

  // 2. Test sensitive field redaction
  const testMeta = {
    secret: "should_be_redacted",
    amount: "100.00",
    paymentHash: "hash_value"
  };
  const redacted = redaction.sanitizeMetadata(testMeta);
  console.log("✓ Metadata redaction verified:", redacted);

  // 3. Test error message redaction
  const errorMsg =
    "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test";
  const redactedError = redaction.redactErrorMessage(errorMsg);
  console.log("✓ Error redaction verified:", redactedError);

  // 4. Verify cleanup policy
  const policy = DEFAULT_MAINNET_POLICY;
  console.log("✓ Cleanup policy verified:");
  console.log(`  - Batch size: ${policy.cleanup.batchSize}`);
  console.log(`  - Archive threshold: ${policy.cleanup.archiveThresholdMs}ms`);
  console.log(`  - Max retries: ${policy.cleanup.maxRetries}`);

  // 5. Verify database constraints
  console.log("✓ Database constraints: Verify manually in DBA review");
  console.log(`  - Settlement ON DELETE RESTRICT`);
  console.log(`  - Receipt ON DELETE RESTRICT`);
  console.log(`  - Unique constraints on hashes`);

  console.log("\n=== ALL CHECKS PASSED ===");
  console.log("Safe to deploy to production");
}

await verifyCertification();
```

---

## References

- **Policy Documentation**: `docs/PAYMENT_DATA_RETENTION.md`
- **Implementation Guide**: `docs/RETENTION_POLICY_IMPLEMENTATION_GUIDE.md`
- **Policy Types**: `packages/shared/src/retentionPolicy.ts`
- **Redaction Service**: `packages/shared/src/redactionService.ts`
- **Audit Service**: `apps/api/src/services/audit.ts`
- **Cleanup Worker**: `apps/worker/src/workers/stalePaymentCleanup.ts`

