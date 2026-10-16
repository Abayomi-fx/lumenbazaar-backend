# Adversarial x402 Verification Integration Matrix

## Overview

This document describes the adversarial verification test matrix added in issue #14. The matrix validates the x402 Stellar payment-verification pipeline against a comprehensive set of attack vectors, ensuring:

1. **Correctness**: The pipeline correctly rejects each malicious/mismatched transaction variant
2. **Stability**: Each rejection produces a specific, predictable error code and message
3. **Completeness**: One valid control vector proves the test harness can succeed
4. **Safety**: Network errors never resolve to "valid" (critical acceptance criterion)

## Test File

**Location**: `packages/stellar-payments/src/x402AdversarialVerification.integration.test.ts`

**Test Count**: 20+ test cases covering:
- 1 control vector (valid payment)
- 10 adversarial attack vectors
- 3 network-error acceptance criterion tests
- 12+ error mapping precision tests

## Adversarial Vectors

Each vector targets a single failure mode in the verification pipeline. All vectors are isolated: they differ from the valid control in exactly ONE dimension.

### 1. Signature Attack
- **Target**: Invalid or wrong-key signature
- **Expected Rejection**: `INVALID_SIGNATURE`
- **Simulated**: Yes (local mock adapter)
- **Description**: Payment authorization is signed with an unauthorized key or the signature has been tampered with

### 2. Network Mismatch
- **Target**: Transaction signed with wrong network passphrase
- **Expected Rejection**: `UNSUPPORTED_NETWORK`
- **Simulated**: Yes (local mock adapter)
- **Description**: Mainnet-signed transaction submitted against testnet verification, or vice versa

### 3. Asset Mismatch
- **Target**: Payment in different asset than expected
- **Expected Rejection**: `ASSET_MISMATCH`
- **Simulated**: Yes (local mock adapter)
- **Description**: Wrong issuer or wrong asset code in payment operation

### 4. Amount Mismatch
- **Target**: Insufficient or mismatched amount
- **Expected Rejection**: `AMOUNT_MISMATCH`
- **Simulated**: Yes (local mock adapter)
- **Description**: Payment amount below required or different from what was quoted/expected

### 5. Recipient Mismatch
- **Target**: Payment to wrong destination account
- **Expected Rejection**: `RECIPIENT_MISMATCH`
- **Simulated**: Yes (local mock adapter)
- **Description**: Destination account differs from expected payee

### 6. Operation Count Attack
- **Target**: Extra/unexpected operations in transaction
- **Expected Rejection**: `INVALID_PAYMENT_PAYLOAD`
- **Simulated**: Yes (local mock adapter)
- **Description**: Transaction contains additional operations beyond the expected payment op, testing that verification doesn't just check for "contains a valid payment" while ignoring injected operations

### 7. Source Account Mismatch
- **Target**: Wrong source account (incorrect payer)
- **Expected Rejection**: `INVALID_PAYMENT_PAYLOAD`
- **Simulated**: Yes (local mock adapter)
- **Description**: Transaction source account mismatched from expected signer/payer identity

### 8. Expiry Attack
- **Target**: Expired or invalid time bounds
- **Expected Rejection**: `AUTH_EXPIRED`
- **Simulated**: Yes (local mock adapter)
- **Description**: Transaction with expired ledger bounds or missing/invalid time bounds

### 9. Fee Attack
- **Target**: Insufficient or manipulated fee
- **Expected Rejection**: `SETTLEMENT_FAILED`
- **Simulated**: Yes (local mock adapter)
- **Description**: Transaction fee below network minimum or otherwise manipulated. Fee issues typically emerge during RPC simulation.

### 10. Replay Attack
- **Target**: Resubmitted previously-valid transaction
- **Expected Rejection**: Safe reuse OR `REPLAY_DETECTED` on conflicting requirements
- **Simulated**: Yes (local mock adapter)
- **Description**: The verification pipeline uses payment hash (x402 payload hash) as an idempotency key. Identical replays are safely reused. Replays with conflicting requirements (different amount, network, asset, recipient) trigger `REPLAY_DETECTED`.

## Network Error Handling (Critical Acceptance Criterion)

The acceptance criterion states: **"Network error is never interpreted as valid"**

Three tests verify this criterion:

### Test 1: RPC/Transport Failure
Simulates: Timeout, connection refused, network unreachable
Expected: `SETTLEMENT_FAILED` rejection, NOT success
Code: Adapter returns error; verification service propagates rejection

### Test 2: Finality Resolution Timeout
Simulates: Stellar RPC finality check times out or becomes unavailable
Expected: `SETTLEMENT_FAILED` rejection, NOT fallback to success
Code: Adapter's settlement resolution fails; service does NOT default to valid

### Test 3: Malformed Adapter Response
Simulates: Official verifier returns incompatible or incomplete response
Expected: `SETTLEMENT_FAILED` rejection, NOT silent acceptance
Code: Response validation catches structural issues; service rejects incompatible responses

## Local vs. Live Evidence Distinction

All vectors in this suite use **SYNTHETIC/TESTNET DATA ONLY**. They are marked distinctly in test comments:

### Simulated (Local) Vectors
- **Implementation**: Mock adapter that simulates verification outcomes without RPC calls
- **Speed**: Fast, deterministic
- **Dependencies**: None (no network calls)
- **Purpose**: Validates error mapping logic and pipeline structure
- **Markers**: `SIMULATED (local)` in test comments
- **Examples**: All 10 adversarial vectors + control vector

### Live Vectors (Future)
- **Implementation**: Would use real `@x402/stellar ExactStellarScheme` against testnet
- **Speed**: Slower (depends on Stellar testnet RPC)
- **Dependencies**: `@x402/stellar` library + testnet access
- **Purpose**: End-to-end validation with real Stellar transactions
- **Markers**: `LIVE EVIDENCE` in test comments
- **Status**: Not currently implemented (can be added in future iterations)

## Error Mapping Precision

The integration test suite includes 12+ precision tests for the error code mapping defined in `x402Adapter.ts`:

```
Function: failureCode(reason: string) -> ErrorCode

Mappings verified:
- network_mismatch, invalid_network → UNSUPPORTED_NETWORK
- wrong_asset, event_wrong_asset → ASSET_MISMATCH
- wrong_amount, event_wrong_amount → AMOUNT_MISMATCH
- wrong_recipient, event_wrong_to → RECIPIENT_MISMATCH
- expiration → AUTH_EXPIRED
- *signature* → INVALID_SIGNATURE
- unexpected_verify_error, simulation_failed → SETTLEMENT_FAILED
- unknown/default → INVALID_PAYMENT_PAYLOAD
```

These tests ensure no regression in the mapping logic and prevent silent failures from incorrect error codes.

## Verification Pipeline Order

The verification pipeline (from `verification.ts` and `x402Adapter.ts`) performs checks in this order:

1. **Parse Request**: Validate x402 protocol structure (v2, exact scheme)
2. **Network Support**: Verify network is configured
3. **Asset Support**: Verify SEP-41 asset is supported
4. **Replay Detection**: Check idempotency by payment hash
5. **Adapter Verification**: Delegate to @x402/stellar ExactStellarScheme
   - Network passphrase validation
   - Transaction structure validation (operation type, count)
   - Source account validation
   - Signature validation
   - Recipient/destination validation
   - Asset validation
   - Amount validation
   - Time bounds/expiry validation
   - Fee validation (during simulation)
6. **Result Mapping**: Map `invalidReason` from adapter to Lumen error code

## Running the Tests

### In Correct Environment (Node >=24.0.0, pnpm >=10.0.0)

```bash
# Run full check suite (builds, lints, formats, typechecks, tests, validates prisma)
pnpm check

# Run only the adversarial verification tests
pnpm test -- packages/stellar-payments/src/x402AdversarialVerification.integration.test.ts

# Run tests in watch mode (development)
pnpm test -- --watch packages/stellar-payments/src/x402AdversarialVerification.integration.test.ts
```

### Test Data

All test data is synthetic/testnet:
- Uses `testPaymentRequest` fixture from `@lumenbazaar/testkit`
- Testnet asset contract: `testAssetContractId` (from testkit)
- Testnet configuration: `testnetConfig`
- Random keypairs generated fresh (no hardcoded secrets)
- **NO production accounts, NO mainnet data, NO secrets committed**

## Implementation Notes

### Mock Adapter Strategy
Rather than making real RPC calls to the Stellar testnet, the test suite uses a mock adapter that:
1. Simulates each specific failure mode
2. Returns the expected `invalidReason` and error code
3. Allows fast, deterministic test execution
4. Proves the verification pipeline's error mapping logic is correct

This approach is sufficient to validate the pipeline's handling of each failure mode. Future work can add live testnet vectors if end-to-end validation with real Stellar transactions is needed.

### Replay Protection Mechanism
The verification service uses **payment hash idempotency key** for replay protection:
1. Hash is computed from the canonicalized x402 payload
2. First verification: payload is verified through the adapter, stored with hash
3. Identical replay: hash matches → same payment attempt is reused (no re-verification)
4. Conflicting replay: hash matches but requirements differ → `REPLAY_DETECTED` error

This ensures safe replay handling while catching attacks where the same transaction is reused with different requirements.

## Scope

This PR is **test-only**:
- **NO changes** to the verification pipeline logic
- **NO changes** to error codes or error handling
- **NO changes** to OpenAPI specifications or database migrations
- **ONLY addition**: `x402AdversarialVerification.integration.test.ts`

If any genuine bugs are discovered during test development, they are flagged separately, not silently fixed in this PR.

## Related Files

- **Verification Pipeline**: `packages/stellar-payments/src/verification.ts`
- **x402 Adapter**: `packages/stellar-payments/src/x402Adapter.ts`
- **Error Mapping**: `x402Adapter.ts` - `failureCode()` and `failureMessage()` functions
- **Replay Protection**: `packages/stellar-payments/src/paymentAttemptStore.ts`
- **Test Fixtures**: `packages/testkit/src/fixtures.ts`
- **Existing Tests**: `packages/stellar-payments/src/verification.test.ts`, `replayProtection.test.ts`, `officialExactVerifier.test.ts`

## Future Work

1. **Live Testnet Vectors**: Add vectors that use real `@x402/stellar` against Stellar testnet
2. **Additional Attack Categories**: If new attack vectors emerge in production, add them here
3. **Conformance Testing**: Cross-validate against other x402 implementations
4. **Performance Baselines**: Add performance benchmarks for verification speed

---

**Issue**: #14  
**PR**: (to be linked)  
**Branch**: `backend/add-adversarial-x402-verification-integration-matrix`
