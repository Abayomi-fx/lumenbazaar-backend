# Testnet E2E Suite Documentation

The testnet e2e suite is an opt-in deployed testing framework that validates x402 payment flows on Stellar testnet. It provides two operational modes: **smoke mode** (read-only, no credentials) and **full e2e mode** (with settlement and replay verification).

## Quick Start

### Smoke Mode (No Credentials Required)

Run deployment health checks without any secrets:

```bash
pnpm deploy:testnet:e2e:smoke
```

This validates:
- API health and readiness
- MCP server availability
- Network configuration
- HTTP 402 payment-required headers
- Stellar exact scheme support

### Full E2E Mode (With Credentials)

Run complete payment flow testing (requires `CLIENT_PRIVATE_KEY` secret):

```bash
# Set credentials
export CLIENT_PRIVATE_KEY="your_testnet_private_key"

pnpm deploy:testnet:e2e:full
```

This validates:
- Payment flow execution
- Settlement confirmation
- Receipt finalization
- Replay rejection
- Durable evidence persistence

## Architecture

### Core Modules

#### 1. **testnet-e2e-suite.ts** - Main Orchestrator
Coordinates all e2e testing activities.

**Key Functions:**
- `runTestnetE2ESmoke()` - Read-only deployment health checks
- `runTestnetE2ESuite()` - Full payment flow with replay verification
- `createOfficialTestnetSigner()` - Creates Ed25519 signer for test payments

**Evidence Types:**
- `TestnetE2ESmokeModeEvidence` - Deployment health summary
- `TestnetE2ESuiteEvidence` - Complete flow evidence with replay data

#### 2. **testnet-evidence-collector.ts** - Evidence Collection
Gathers cryptographic proof of all operations.

**Collectors:**
- `APIDeploymentEvidenceCollector` - API commit, version, capabilities
- `NetworkEvidenceCollector` - Network health and configuration
- `AssetPaymentEvidenceCollector` - Payment requirements and assets
- `TransactionEvidenceCollector` - On-chain transaction data
- `ReceiptEvidenceCollector` - Receipt finalization proof

**Validation:**
- `verifyEvidenceIntegrity()` - Validates evidence completeness and format

#### 3. **ci-security.ts** - Security Validation
Prevents unsafe execution and masks secrets.

**Security Functions:**
- `detectCIEnvironment()` - Identifies GitHub Actions context
- `validateTestnetE2ESecurityContext()` - Enforces smoke-only on forks
- `isSafeForFundedOperations()` - Blocks untrusted funded operations
- `createSecretMaskingConfig()` - Generates log masking patterns
- `generateSecurityAuditLog()` - Creates security audit trail

## Execution Modes

### Smoke Mode

**Purpose:** Read-only deployment health validation  
**Credentials Required:** None  
**Funded Operations:** No  
**Use Cases:**
- PR validation (all PRs)
- Deployment monitoring
- Pre-flight checks

**Output:** `TestnetE2ESmokeModeEvidence`
```json
{
  "checkedAt": "2024-10-16T...",
  "environment": "testnet",
  "mode": "smoke",
  "deployment": { ... },
  "summary": {
    "deploymentHealthy": true,
    "apiReachable": true,
    "mcpHealthy": true,
    "paidResourceAccessible": true,
    "totalDuration": 2543
  }
}
```

### Full E2E Mode

**Purpose:** Complete payment flow validation with settlement  
**Credentials Required:** `CLIENT_PRIVATE_KEY` (Stellar testnet private key)  
**Funded Operations:** Yes (creates actual transactions)  
**Use Cases:**
- Main branch deployment verification
- Pre-release validation
- Manual testnet testing

**Execution Restrictions:**
- ✅ Allowed: Main branch pushes
- ✅ Allowed: Internal PRs (with manual approval)
- ❌ Blocked: Fork pull requests
- ❌ Blocked: Local development (unless explicitly enabled)

**Output:** `TestnetE2ESuiteEvidence`
```json
{
  "checkedAt": "2024-10-16T...",
  "environment": "testnet",
  "mode": "full",
  "deployment": { ... },
  "firstFlow": {
    "authorizationHash": "sha256_of_signed_payment",
    "challengeProof": { ... },
    "settlement": {
      "transactionHash": "stellar_tx_hash",
      "ledger": 123456,
      "receiptId": "receipt_id"
    },
    "receipt": { ... }
  },
  "replayRejection": {
    "rejectedAt": "2024-10-16T...",
    "errorCode": "REPLAY_DETECTED",
    "errorMessage": "Payment already settled"
  },
  "durableVerification": {
    "receiptPersisted": true,
    "settlementIdempotent": true
  },
  "summary": {
    "resourceRegistration": true,
    "http402Response": true,
    "verificationSuccess": true,
    "settlementSuccess": true,
    "receiptFinalized": true,
    "replayBlocked": true,
    "totalDuration": 8234
  }
}
```

## Security Model

### Fork Pull Request Protection

Fork PRs are automatically restricted to **smoke mode only**:

1. **Detection:** GitHub Actions detects fork PRs via `github.event.pull_request.head.repo.fork`
2. **Enforcement:** Workflow sets `mode=smoke` regardless of user input
3. **Reason:** Prevents untrusted code from accessing funded settlement credentials

### Credential Masking

Sensitive values are masked from logs:

```yaml
# GitHub Actions automatically masks secrets
- name: Mask CLIENT_PRIVATE_KEY
  run: echo "::add-mask::${{ secrets.CLIENT_PRIVATE_KEY }}"
```

### Audit Logging

All executions generate comprehensive audit logs:

```bash
pnpm deploy:testnet:e2e:validate
```

Output includes:
- CI environment context
- Security validation results
- Credential presence
- Trust level (untrusted/internal/trusted)

## GitHub Actions Workflow

### Workflow File
`.github/workflows/testnet-e2e.yml`

### Triggers

1. **Manual Dispatch** (`workflow_dispatch`)
   - Choose mode: smoke or full
   - Specify manifest path
   - Select deployment environment

2. **Automatic Smoke Tests**
   - Main branch: Runs on push
   - PRs: Runs on all PR events

3. **Conditional Full E2E**
   - Main branch: Runs if credentials available
   - Internal PR: Requires approval + credentials
   - Fork PR: Blocked (smoke only)

### Workflow Jobs

```
security-check (always runs)
  ├── smoke-tests (always runs)
  ├── full-e2e-tests (conditional: safe-for-funded && full mode && secrets)
  ├── report (generates summary)
  └── summary (displays results)
```

### Environment Setup

1. **Repository Settings > Environments > testnet-e2e**
   - Configure deployment branch policy
   - Add required reviewers for manual approval
   - Set timeout for approval

2. **Repository Settings > Secrets and variables > Actions**
   - Add `CLIENT_PRIVATE_KEY` (Stellar testnet private key)
   - Add `TESTNET_MANIFEST_PATH` (if non-default)

### Evidence Retention

All evidence artifacts are uploaded and retained for **90 days**:
- `testnet-e2e-smoke-evidence/smoke-mode.json`
- `testnet-e2e-full-evidence/e2e-full.json`

Access via:
- GitHub Actions artifacts UI
- API: `/repos/:owner/:repo/actions/runs/:id/artifacts`

## Local Testing

### Setup

1. **Install dependencies**
   ```bash
   pnpm install
   ```

2. **Create testnet account** (or use existing)
   ```bash
   # Generate keypair for testnet
   # Fund account via Stellar testnet faucet
   # Export private key
   export CLIENT_PRIVATE_KEY="SXXXXXXX..."
   ```

3. **Configure manifest**
   ```bash
   cp docs/deployment/testnet-endpoints.json.example docs/deployment/testnet-endpoints.json
   # Edit with actual testnet endpoints
   ```

### Running Locally

**Smoke mode (no credentials):**
```bash
pnpm deploy:testnet:e2e:smoke --manifest docs/deployment/testnet-endpoints.json
```

**Full e2e (with credentials):**
```bash
export CLIENT_PRIVATE_KEY="your_private_key"
pnpm deploy:testnet:e2e:full --manifest docs/deployment/testnet-endpoints.json
```

**Output:**
```bash
# Evidence saved to
deployment-evidence/e2e-smoke.json
deployment-evidence/e2e-full.json
```

## Configuration

### Environment Variables

#### Deployment
- `TESTNET_MANIFEST_PATH` - Path to testnet endpoints manifest (default: `docs/deployment/testnet-endpoints.json`)
- `TESTNET_E2E_OUTPUT` - Output path for evidence (default: `deployment-evidence/e2e-suite.json`)

#### Credentials (Full Mode Only)
- `CLIENT_PRIVATE_KEY` - Stellar testnet private key (Ed25519 format)
- Must be set in GitHub Actions secrets, not in .env

#### CI Context (Auto-detected)
- `GITHUB_ACTIONS` - Set to "true" in GitHub Actions
- `GITHUB_EVENT_NAME` - "push", "pull_request", "workflow_dispatch"
- `GITHUB_HEAD_REF` - Branch name (for fork detection)

### Manifest File

**Location:** `docs/deployment/testnet-endpoints.json`

**Schema:**
```json
{
  "environment": "testnet",
  "status": "deployed",
  "commits": {
    "api": "full_40_char_git_sha",
    "worker": "full_40_char_git_sha",
    "mcp": "full_40_char_git_sha",
    "paidResource": "full_40_char_git_sha"
  },
  "migrationRunId": "mig_deployment_identifier",
  "api": {
    "baseUrl": "https://api.testnet.example.com",
    "health": "https://api.testnet.example.com/health",
    "readiness": "https://api.testnet.example.com/ready",
    "metrics": "https://api.testnet.example.com/metrics",
    "supported": "https://api.testnet.example.com/v1/supported",
    "version": "https://api.testnet.example.com/version"
  },
  "mcp": {
    "baseUrl": "https://mcp.testnet.example.com",
    "health": "https://mcp.testnet.example.com/health",
    "readiness": "https://mcp.testnet.example.com/ready",
    "metrics": "https://mcp.testnet.example.com/metrics",
    "schema": "https://mcp.testnet.example.com/schema",
    "version": "https://mcp.testnet.example.com/version"
  },
  "paidResource": {
    "baseUrl": "https://weather.testnet.example.com",
    "health": "https://weather.testnet.example.com/health",
    "readiness": "https://weather.testnet.example.com/ready",
    "metrics": "https://weather.testnet.example.com/metrics",
    "version": "https://weather.testnet.example.com/version",
    "resourceId": "res_resource_uuid",
    "resourceUrl": "https://weather.testnet.example.com/paid/endpoint"
  }
}
```

## Evidence Validation

### Evidence Chain

Full e2e evidence records:
1. API commit hash
2. Migration run ID
3. Payment requirement hash
4. Transaction hash
5. Receipt ID

### Integrity Verification

```bash
# Check evidence completeness
pnpm deploy:testnet:e2e:full | jq '.summary | all(. == true)'

# Verify evidence hash
cat deployment-evidence/e2e-full.json | jq '.integrity.collectionIntegrityHash'

# Validate receipt
cat deployment-evidence/e2e-full.json | jq '.firstFlow.receipt'
```

### Supported Formats

- **JSON:** Machine-readable, parseable by scripts
- **SHA256 Hashes:** Cryptographic proof of evidence
- **Transaction Hashes:** Verifiable on Stellar network
- **Receipt IDs:** Queryable via API

## Troubleshooting

### Smoke Mode Failures

| Error | Cause | Solution |
|-------|-------|----------|
| "API health endpoint returned HTTP 500" | API unreachable | Check API URL in manifest |
| "Paid resource omitted PAYMENT-REQUIRED" | Missing x402 header | Verify paid resource implements HTTP 402 |
| "Paid resource did not return official v2 challenge" | Wrong x402 version | Ensure API uses x402 v2 spec |

### Full E2E Failures

| Error | Cause | Solution |
|-------|-------|----------|
| "CLIENT_PRIVATE_KEY is required" | Credentials missing | Set secret in GitHub or environment |
| "Full e2e mode is not allowed on fork pull requests" | Fork PR detected | Expected behavior - fork PRs use smoke only |
| "Receipt is not finalized" | Settlement incomplete | Check Stellar network status |
| "Replay was not rejected" | Settlement not idempotent | Database issue - check persistence layer |

### Local Testing Issues

| Issue | Solution |
|-------|----------|
| "Network error" when running locally | Check internet connection, proxy settings |
| "Invalid private key format" | Ensure Ed25519 format, 56 char base32 string |
| "Manifest not found" | Use `--manifest` flag or create file |

## Best Practices

### Security

1. **Never commit credentials**
   - Use GitHub Actions secrets only
   - .env files are git-ignored
   - Audit logs are masked automatically

2. **Rotate testnet keys regularly**
   - Keep CLIENT_PRIVATE_KEY secure
   - Regenerate after suspected compromise
   - Use separate key from production

3. **Validate manifest signatures**
   - Verify commit hashes against actual deployment
   - Cross-check with deployment logs
   - Document source of manifest

### Operations

1. **Run smoke tests frequently**
   - Continuous deployment health checks
   - Early detection of issues
   - No credential management needed

2. **Full e2e before releases**
   - Verify complete payment flow
   - Confirm replay protection
   - Document evidence for audit trail

3. **Archive evidence regularly**
   - Download from GitHub Actions artifacts
   - Store in secure location
   - Retain for compliance period

### Monitoring

1. **Track evidence trends**
   - Duration changes indicate performance issues
   - Error patterns suggest infrastructure problems
   - Ledger numbers track Stellar activity

2. **Set up alerts**
   - E2E suite failures trigger incident response
   - Smoke mode failures block deployments
   - Replay detection indicates security issue

3. **Regular audits**
   - Review execution logs monthly
   - Verify fork detection working
   - Confirm credential masking active

## Integration with CI/CD

### Before Merge

```bash
# Run in PR (smoke mode - auto)
pnpm deploy:testnet:e2e:smoke
```

### Before Deploy

```bash
# Manual trigger for full validation
# Accessed via GitHub Actions > Testnet E2E > workflow_dispatch
# Select full mode, approve if needed
```

### Post-Deploy

```bash
# Verify deployed service
pnpm deploy:testnet:probe --manifest docs/deployment/testnet-endpoints.json
```

## Advanced Topics

### Custom Payment Signer

```typescript
import { createOfficialTestnetSigner } from './scripts/testnet-e2e-suite.js';

const signer = createOfficialTestnetSigner(process.env.CLIENT_PRIVATE_KEY);
const payload = await signer(requirements, { url: resourceUrl });
```

### Extend Evidence Collection

```typescript
import { EvidenceCollector } from './scripts/testnet-evidence-collector.js';

const collector = new EvidenceCollector();
const evidence = await collector.collectFullEvidence(
  apiUrl,
  deploymentProbe,
  requirements,
  paymentPayload,
  receipt
);
```

### Custom CI Integration

```bash
# Export evidence for external systems
cat deployment-evidence/e2e-full.json | jq -r '.settlement.transaction'

# Feed into monitoring
curl -X POST https://monitoring.example.com/evidence \
  -d @deployment-evidence/e2e-full.json
```

## Related Documentation

- [x402 Specification](https://x402.dev)
- [Stellar Developer Guide](https://developers.stellar.org)
- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [LumenRoute Deployment Guide](./DEPLOYMENT.md)
- [Payment Flow Documentation](./PAYMENT_FLOW.md)

## Support

For issues or questions:

1. **Check logs:** GitHub Actions workflow run details
2. **Review artifacts:** Downloaded evidence for analysis
3. **Check manifest:** Verify testnet endpoints are correct
4. **Local reproduction:** Run smoke mode locally to isolate issues
5. **File issue:** Include workflow run ID and evidence summary
