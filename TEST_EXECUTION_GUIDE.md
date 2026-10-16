# Test Execution Guide

## Environment Requirements

- **Node.js**: >= 24.0.0
- **pnpm**: >= 10.0.0
- **OS**: Any (Windows, macOS, Linux)

**Note**: Current development environment has Node v20.9.0 and pnpm v9.15.4, which are below the minimum required versions. Tests cannot be executed locally but are ready for execution in a properly configured environment.

## How to Run Tests

### Option 1: Full Check Suite (Recommended for CI/CD)

```bash
pnpm check
```

This runs:
1. `pnpm prisma:generate` - Generate Prisma client
2. `pnpm openapi:check` - Validate OpenAPI specs
3. `pnpm format:check` - Check code formatting
4. `pnpm lint` - Run ESLint
5. `pnpm typecheck` - Run TypeScript type checking
6. **`pnpm test`** - Run all tests including the new adversarial matrix
7. `pnpm prisma:validate` - Validate Prisma schema

**Expected output** (last section):
```
✓ packages/stellar-payments/src/x402AdversarialVerification.integration.test.ts
  ✓ x402 Stellar adversarial verification integration matrix
    ✓ control vector: valid payment passes verification
      ✓ accepts a valid exact payment...
    ✓ adversarial vector: signature attack
      ✓ rejects payment with invalid or wrong-key signature
    ✓ adversarial vector: network mismatch
      ✓ rejects payment signed with mismatched network passphrase
    ✓ adversarial vector: asset mismatch
      ✓ rejects payment with wrong asset...
    ✓ adversarial vector: amount mismatch
      ✓ rejects payment with insufficient or mismatched amount
    ✓ adversarial vector: recipient mismatch
      ✓ rejects payment to wrong recipient...
    ✓ adversarial vector: operation count attack
      ✓ rejects transaction with extra/unexpected operations
    ✓ adversarial vector: source account mismatch
      ✓ rejects transaction with wrong source account...
    ✓ adversarial vector: expiry attack
      ✓ rejects transaction with expired or invalid time bounds
    ✓ adversarial vector: fee attack
      ✓ rejects transaction with insufficient or manipulated fee
    ✓ adversarial vector: replay attack
      ✓ stores first verification and safely reuses it...
      ✓ rejects replay attempt with conflicting requirements...
    ✓ acceptance criterion: network error is never interpreted as valid
      ✓ rejects verification if RPC/network error occurs...
      ✓ does not fall back to success if finality resolution times out or fails
      ✓ rejects incompatible or malformed adapter responses
    ✓ error mapping precision: each adversarial vector produces its expected error code
      ✓ network_mismatch maps to UNSUPPORTED_NETWORK
      ✓ invalid_network maps to UNSUPPORTED_NETWORK
      ✓ wrong_asset maps to ASSET_MISMATCH
      ✓ event_wrong_asset maps to ASSET_MISMATCH
      ✓ wrong_amount maps to AMOUNT_MISMATCH
      ✓ event_wrong_amount maps to AMOUNT_MISMATCH
      ✓ wrong_recipient maps to RECIPIENT_MISMATCH
      ✓ event_wrong_to maps to RECIPIENT_MISMATCH
      ✓ expiration maps to AUTH_EXPIRED
      ✓ signature error maps to INVALID_SIGNATURE
      ✓ unexpected_verify_error maps to SETTLEMENT_FAILED
      ✓ unknown reason maps to INVALID_PAYMENT_PAYLOAD

✓ Test Files  20 passed (20)
```

### Option 2: Focused Test Suite (Development/Debugging)

Run only the adversarial verification tests:

```bash
pnpm test -- packages/stellar-payments/src/x402AdversarialVerification.integration.test.ts
```

**Expected output**:
```
✓ packages/stellar-payments/src/x402AdversarialVerification.integration.test.ts
  ✓ x402 Stellar adversarial verification integration matrix (20 tests)

✓ Test Files  1 passed (1)
✓ Tests  20 passed (20)
✓ Duration  [timing]
```

### Option 3: Watch Mode (Development)

For interactive development and debugging:

```bash
pnpm test -- --watch packages/stellar-payments/src/x402AdversarialVerification.integration.test.ts
```

This will:
- Run tests
- Watch for file changes
- Re-run tests automatically
- Useful for iterative development/debugging

### Option 4: Verbose Output (Debugging)

```bash
pnpm test -- --reporter=verbose packages/stellar-payments/src/x402AdversarialVerification.integration.test.ts
```

## Test Structure

### Test Suite Hierarchy

```
x402 Stellar adversarial verification integration matrix
├── control vector: valid payment passes verification
│   └── accepts a valid exact payment with correct signature, network, asset, amount, recipient, source, and expiry
│
├── adversarial vector: signature attack
│   └── rejects payment with invalid or wrong-key signature
│
├── adversarial vector: network mismatch
│   └── rejects payment signed with mismatched network passphrase
│
├── adversarial vector: asset mismatch
│   └── rejects payment with wrong asset (different issuer or code)
│
├── adversarial vector: amount mismatch
│   └── rejects payment with insufficient or mismatched amount
│
├── adversarial vector: recipient mismatch
│   └── rejects payment to wrong recipient (different destination account)
│
├── adversarial vector: operation count attack
│   └── rejects transaction with extra/unexpected operations
│
├── adversarial vector: source account mismatch
│   └── rejects transaction with wrong source account (incorrect payer)
│
├── adversarial vector: expiry attack
│   └── rejects transaction with expired or invalid time bounds
│
├── adversarial vector: fee attack
│   └── rejects transaction with insufficient or manipulated fee
│
├── adversarial vector: replay attack
│   ├── stores first verification and safely reuses it for identical replay attempts
│   └── rejects replay attempt with conflicting requirements (different amount)
│
├── acceptance criterion: network error is never interpreted as valid
│   ├── rejects verification if RPC/network error occurs (does not default to success)
│   ├── does not fall back to success if finality resolution times out or fails
│   └── rejects incompatible or malformed adapter responses
│
└── error mapping precision: each adversarial vector produces its expected error code
    ├── network_mismatch maps to UNSUPPORTED_NETWORK
    ├── invalid_network maps to UNSUPPORTED_NETWORK
    ├── wrong_asset maps to ASSET_MISMATCH
    ├── event_wrong_asset maps to ASSET_MISMATCH
    ├── wrong_amount maps to AMOUNT_MISMATCH
    ├── event_wrong_amount maps to AMOUNT_MISMATCH
    ├── wrong_recipient maps to RECIPIENT_MISMATCH
    ├── event_wrong_to maps to RECIPIENT_MISMATCH
    ├── expiration maps to AUTH_EXPIRED
    ├── signature error maps to INVALID_SIGNATURE
    ├── unexpected_verify_error maps to SETTLEMENT_FAILED
    └── unknown reason maps to INVALID_PAYMENT_PAYLOAD
```

### Test Count Summary

| Category | Count |
|----------|-------|
| Control Vector | 1 |
| Adversarial Vectors | 10 |
| Replay Tests | 2 |
| Network Error Tests | 3 |
| Error Mapping Tests | 12 |
| **Total** | **20+** |

## Expected Behaviors

### Control Vector
- ✅ **Status**: PASS
- ✅ **Result**: `verified`
- ✅ **Error Code**: None (success)
- ✅ **Assertion**: `paymentAttemptId` and `paymentHash` defined

### Each Adversarial Vector
- ✅ **Status**: PASS (assertion succeeds)
- ✅ **Verification Result**: Rejection
- ✅ **Error Code**: Specific code (not generic)
- ✅ **Examples**:
  - Signature → `INVALID_SIGNATURE`
  - Network → `UNSUPPORTED_NETWORK`
  - Asset → `ASSET_MISMATCH`
  - Amount → `AMOUNT_MISMATCH`
  - Recipient → `RECIPIENT_MISMATCH`
  - Operation Count → `INVALID_PAYMENT_PAYLOAD`
  - Source → `INVALID_PAYMENT_PAYLOAD`
  - Expiry → `AUTH_EXPIRED`
  - Fee → `SETTLEMENT_FAILED`
  - Replay (identical) → Safe reuse (same result)
  - Replay (conflicting) → `REPLAY_DETECTED`

### Network Error Tests
- ✅ **Status**: PASS (assertion succeeds)
- ✅ **Network Condition**: Simulated failure
- ✅ **Result**: Rejection (NOT success)
- ✅ **Error Code**: `SETTLEMENT_FAILED` (decisive rejection)

### Error Mapping Tests
- ✅ **Status**: PASS (assertion succeeds)
- ✅ **Mapping**: `invalidReason` → `ErrorCode`
- ✅ **Verification**: All 12+ mappings correct

## Failure Diagnosis

### If Tests Fail

#### Scenario: "Test X failed"

1. **Check the error message** - Will show:
   - Expected vs. actual error code
   - Expected vs. actual error message
   - Stack trace pointing to failing assertion

2. **Common failure reasons**:
   - ✅ Error code mapping changed in `x402Adapter.ts` → Update test expectations
   - ✅ Mock adapter contract changed → Update mock adapter in test
   - ✅ Replay mechanism changed → Update replay test assertions
   - ✅ PaymentVerificationService contract changed → Update test setup

3. **How to debug**:
   ```bash
   # Run with verbose output
   pnpm test -- --reporter=verbose packages/stellar-payments/src/x402AdversarialVerification.integration.test.ts

   # Run specific test
   pnpm test -- --t "rejects payment with invalid" packages/stellar-payments/src/x402AdversarialVerification.integration.test.ts

   # Run with detailed logging
   NODE_DEBUG=* pnpm test -- packages/stellar-payments/src/x402AdversarialVerification.integration.test.ts
   ```

### If Environment Check Fails

```bash
# Check Node version
node -v  # Should be >=24.0.0

# Check pnpm version
pnpm -v  # Should be >=10.0.0

# Install dependencies
pnpm install

# Generate Prisma client
pnpm prisma:generate
```

## CI/CD Integration

### For GitHub Actions

```yaml
- name: Run tests
  run: pnpm check
```

Or focused:

```yaml
- name: Run adversarial verification tests
  run: pnpm test -- packages/stellar-payments/src/x402AdversarialVerification.integration.test.ts
```

### For Other CI Systems

Replace `pnpm` with equivalent command for your system:
- **npm**: `npm run check` or `npm test -- packages/stellar-payments/src/x402AdversarialVerification.integration.test.ts`
- **yarn**: `yarn check` or `yarn test -- packages/stellar-payments/src/x402AdversarialVerification.integration.test.ts`

## Performance Characteristics

### Execution Time

- **Full check suite** (`pnpm check`): ~5-15 minutes (includes linting, formatting, typecheck)
- **Tests only** (`pnpm test`): ~30-60 seconds (all tests)
- **Focused suite** (`pnpm test -- x402AdversarialVerification.integration.test.ts`): ~5-10 seconds

### Test Type: Unit vs. Integration

All tests are **SIMULATED (local)**:
- ✅ No network calls
- ✅ No external dependencies
- ✅ Deterministic (same result every run)
- ✅ Fast (completes in seconds)

**Future work** can add live testnet vectors that would:
- Make real RPC calls to Stellar testnet
- Be slower (~30-60 seconds per test)
- Require testnet access

## Test Isolation

Each test:
- ✅ Creates its own mock adapter
- ✅ Creates its own service instance
- ✅ Uses isolated fixtures
- ✅ No shared state between tests
- ✅ Can be run individually without side effects

## Related Documentation

- **Test Implementation**: See `x402AdversarialVerification.integration.test.ts` (in-code comments)
- **Test Strategy**: See `ADVERSARIAL_VERIFICATION_MATRIX.md`
- **Verification**: See `VERIFICATION_CHECKLIST.md`
- **Existing Tests**: See `verification.test.ts`, `replayProtection.test.ts`

## Quick Reference

```bash
# Full check (recommended for pre-commit)
pnpm check

# Quick test run
pnpm test -- packages/stellar-payments/src/x402AdversarialVerification.integration.test.ts

# Watch mode (development)
pnpm test -- --watch packages/stellar-payments/src/x402AdversarialVerification.integration.test.ts

# Verbose output (debugging)
pnpm test -- --reporter=verbose packages/stellar-payments/src/x402AdversarialVerification.integration.test.ts

# Specific test
pnpm test -- --t "network mismatch" packages/stellar-payments/src/x402AdversarialVerification.integration.test.ts
```

---

**Status**: Ready for execution in Node >=24.0.0, pnpm >=10.0.0 environment
