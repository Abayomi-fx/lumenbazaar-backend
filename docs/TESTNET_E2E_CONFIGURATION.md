# Testnet E2E Suite Configuration Guide

## GitHub Actions Setup

### 1. Create Deployment Environment

Go to: **Repository Settings > Environments > New environment**

**Environment Name:** `testnet-e2e`

**Deployment branches:**
- Allow specific branches: `main`
- Allow deployments to production environments when: Keep checked

**Required reviewers:** 
- (Optional) Add team members who must approve full e2e runs
- Recommended: 1+ reviewer for additional security

**Environment secrets:**
- None required (use repository secrets instead)

### 2. Add Repository Secrets

Go to: **Repository Settings > Secrets and variables > Actions > New repository secret**

#### Required Secrets

**Name:** `CLIENT_PRIVATE_KEY`  
**Value:** Stellar testnet private key (Ed25519 format)

```
SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

Format: 56-character base32 string starting with 'S'

Get a testnet key:
1. Visit https://stellar.expert/testnet
2. Or generate locally: https://stellar.org/developers/js-stellar-sdk

**Name:** `TESTNET_MANIFEST_PATH` (Optional)  
**Value:** Path to testnet endpoints manifest  
**Default:** `docs/deployment/testnet-endpoints.json`

### 3. Disable Workflow in Forks

The workflow automatically enforces smoke-only mode in fork PRs. No additional configuration needed - the `isSafeForFundedOperations()` check prevents funded operations from untrusted sources.

## Local Development Setup

### 1. Install Dependencies

```bash
pnpm install
```

### 2. Generate Testnet Account

Using Stellar CLI:
```bash
# Generate keypair
stellar keys generate

# Fund account (use testnet faucet)
# Copy private key
```

Or use Node.js:
```bash
import { Keypair } from '@stellar/stellar-sdk';
const keypair = Keypair.random();
console.log('Private:', keypair.secret());
console.log('Public:', keypair.publicKey());
```

### 3. Configure Environment

Create `.env.local` (git-ignored):
```bash
CLIENT_PRIVATE_KEY=SXXXXXXX...
TESTNET_MANIFEST_PATH=docs/deployment/testnet-endpoints.json
TESTNET_E2E_OUTPUT=deployment-evidence/e2e-local.json
```

**Important:** `.env.local` is git-ignored. Never commit credentials.

### 4. Configure Testnet Endpoints Manifest

Create `docs/deployment/testnet-endpoints.json`:

```json
{
  "environment": "testnet",
  "status": "deployed",
  "commits": {
    "api": "0000000000000000000000000000000000000000",
    "worker": "0000000000000000000000000000000000000000",
    "mcp": "0000000000000000000000000000000000000000",
    "paidResource": "0000000000000000000000000000000000000000"
  },
  "migrationRunId": "mig_local_development",
  "api": {
    "baseUrl": "https://api.testnet.example.com",
    "health": "https://api.testnet.example.com/health",
    "readiness": "https://api.testnet.example.com/ready",
    "metrics": "https://api.testnet.example.com/metrics",
    "supported": "https://api.testnet.example.com/v1/supported",
    "version": "https://api.testnet.example.com/version"
  },
  "mcp": {
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
    "resourceId": "res_weather_uuid",
    "resourceUrl": "https://weather.testnet.example.com/weather"
  }
}
```

Replace URLs with actual testnet deployment endpoints.

### 5. Verify Setup

```bash
# Test smoke mode (no credentials needed)
pnpm deploy:testnet:e2e:smoke

# Should output deployment health summary
```

## CI/CD Integration

### 1. Workflow Triggers

The `.github/workflows/testnet-e2e.yml` workflow runs:

**Automatic:**
- Main branch push to testnet-related files
- All PR changes to testnet-related files (smoke mode)

**Manual:**
- GitHub Actions > Testnet E2E > workflow_dispatch
- Choose smoke or full mode
- Select manifest path (optional)

### 2. PR Workflow Behavior

```
Fork PR (from external contributor)
├── Security Check: Fork detected → mode=smoke
├── Smoke Tests: Run (deployment health)
└── Full E2E: Skipped (fork protection)

Internal PR (from organization member)
├── Security Check: Internal → mode=full (if secrets available)
├── Smoke Tests: Run
└── Full E2E: Require approval (if credentials available)

Main Branch Push
├── Security Check: Main branch → mode=full (if secrets available)
├── Smoke Tests: Run
└── Full E2E: Run automatically
```

### 3. Approval Requirements

For full e2e on internal PRs:

1. Workflow requests approval
2. Reviewer approves deployment to `testnet-e2e` environment
3. Full e2e suite runs with credentials
4. Results posted as PR comment

To add reviewers:
- Settings > Environments > testnet-e2e > Required reviewers

### 4. Evidence Retention

Evidence artifacts are retained for **90 days**:

```bash
# Download evidence
gh run download <run-id> -n testnet-e2e-smoke-evidence
gh run download <run-id> -n testnet-e2e-full-evidence

# View in UI
# Actions > Testnet E2E > <run> > Artifacts
```

## Monitoring and Alerts

### 1. Workflow Status

Monitor via:
- GitHub Actions tab in repository
- Commit status checks on PRs
- GitHub CLI: `gh run list --workflow testnet-e2e.yml`

### 2. Evidence Metrics

Extract from evidence JSON:
```bash
# Get execution duration
jq '.summary.totalDuration' deployment-evidence/e2e-full.json

# Check all validations passed
jq '.summary | all(. == true)' deployment-evidence/e2e-full.json

# Get transaction hash (verify on network)
jq '.settlement.transaction' deployment-evidence/e2e-full.json
```

### 3. Custom Alerting

Integrate with monitoring systems:

```bash
# Post to Slack on failure
if [[ "${{ job.status }}" == "failure" ]]; then
  curl -X POST $SLACK_WEBHOOK \
    -d '{"text": "E2E suite failed: ${{ github.run_id }}"}'
fi

# Send to monitoring service
curl -X POST https://monitoring.example.com/events \
  -H "Content-Type: application/json" \
  -d @deployment-evidence/e2e-full.json
```

## Troubleshooting Configuration

### Issue: "CLIENT_PRIVATE_KEY is required"

**Cause:** Secret not set in repository  
**Solution:**
1. Go to Settings > Secrets and variables > Actions
2. Add `CLIENT_PRIVATE_KEY` secret
3. Retry workflow

### Issue: "Fork PR detected - enforcing smoke mode"

**Cause:** Expected behavior for fork PRs  
**Solution:**
- This is intentional security protection
- Fork PRs cannot run full e2e (no funded operations from untrusted code)
- Maintainers can approve for internal PRs

### Issue: "Manifest not found"

**Cause:** Manifest path incorrect or file missing  
**Solution:**
1. Create `docs/deployment/testnet-endpoints.json`
2. Use `--manifest` flag with correct path
3. Or set `TESTNET_MANIFEST_PATH` env var

### Issue: "Invalid private key format"

**Cause:** Key not in Ed25519 format  
**Solution:**
1. Key must be 56-character base32 string
2. Must start with 'S'
3. Generate via: https://stellar.org/developers/js-stellar-sdk

### Issue: "API returned HTTP 500"

**Cause:** Testnet endpoints unreachable  
**Solution:**
1. Verify API URLs in manifest
2. Check firewall/network access
3. Verify API deployment is healthy
4. Use `pnpm deploy:testnet:probe` to debug

## Security Considerations

### 1. Credential Management

**Do:**
- ✅ Store `CLIENT_PRIVATE_KEY` in GitHub Actions secrets
- ✅ Use separate testnet key (not production)
- ✅ Rotate keys quarterly
- ✅ Audit access logs

**Don't:**
- ❌ Commit credentials to repository
- ❌ Paste keys in workflow files
- ❌ Use production keys for testing
- ❌ Share secrets with external services

### 2. Fork Protection

The workflow automatically prevents funded operations in fork PRs:

```typescript
if (isForkPullRequest) {
  mode = "smoke"; // Read-only, no credentials
}
```

This is enforced at multiple levels:
1. Workflow job condition: `needs.security-check.outputs.safe-for-funded == 'true'`
2. Script validation: `isSafeForFundedOperations()`
3. Secret masking: Secrets not available in fork jobs

### 3. Audit Logging

All executions are logged with:
- CI environment context
- Security decisions
- Execution mode
- Trust level

Access via:
```bash
# Generate audit log
pnpm deploy:testnet:e2e:validate

# View in GitHub Actions logs
# Or extract from workflow output
```

### 4. Evidence Integrity

Evidence includes:
- Commit hashes (proves code version)
- Transaction hashes (proves on-chain execution)
- Receipt IDs (proves finalization)
- Cryptographic signatures

Validate via:
```bash
# Verify evidence completeness
jq '.integrity' deployment-evidence/e2e-full.json

# Check against Stellar network
stellar tx <transaction-hash> --testnet
```

## Advanced Configuration

### 1. Custom Manifest Generation

Automate manifest creation from deployment:

```typescript
// scripts/generate-testnet-manifest.ts
import { readFile, writeFile } from 'fs/promises';

const manifest = {
  environment: 'testnet',
  status: 'deployed',
  commits: {
    api: process.env.API_COMMIT,
    worker: process.env.WORKER_COMMIT,
    mcp: process.env.MCP_COMMIT,
    paidResource: process.env.PAID_RESOURCE_COMMIT
  },
  // ... rest of manifest
};

await writeFile(
  'docs/deployment/testnet-endpoints.json',
  JSON.stringify(manifest, null, 2)
);
```

### 2. Conditional Evidence Storage

Store evidence in custom locations:

```bash
# S3 bucket
aws s3 cp deployment-evidence/e2e-full.json \
  s3://testnet-evidence/$(date +%Y%m%d)/

# Database
curl -X POST https://api.example.com/evidence \
  -d @deployment-evidence/e2e-full.json

# Long-term storage
gsutil cp deployment-evidence/e2e-full.json \
  gs://testnet-archive/$(date +%Y/%m/%d)/
```

### 3. Multi-Environment Setup

Configure separate e2e suites:

```yaml
# .github/workflows/testnet-e2e.yml
environments:
  testnet-staging:
    manifest: docs/deployment/staging-endpoints.json
    secrets: [STAGING_PRIVATE_KEY]
  
  testnet-prod:
    manifest: docs/deployment/prod-endpoints.json
    secrets: [PROD_PRIVATE_KEY]
```

## Next Steps

1. **Set up repository secrets:** Add `CLIENT_PRIVATE_KEY`
2. **Create deployment environment:** `testnet-e2e`
3. **Configure manifest:** `docs/deployment/testnet-endpoints.json`
4. **Run smoke test:** `pnpm deploy:testnet:e2e:smoke`
5. **Test full e2e locally:** With credentials set
6. **Enable workflow:** Merge `.github/workflows/testnet-e2e.yml`
7. **Monitor deployments:** Check Actions tab on main branch

See [TESTNET_E2E_SUITE.md](./TESTNET_E2E_SUITE.md) for full usage guide.
