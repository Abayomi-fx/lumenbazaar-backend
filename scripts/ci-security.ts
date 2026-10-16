/**
 * CI Security Module
 * Handles secret masking, fork execution prevention, and secure credential validation
 */

import { createHash } from "node:crypto";

/**
 * CI environment detection and validation
 */
export type CIEnvironment = {
  isCI: boolean;
  isPullRequest: boolean;
  isForkPullRequest: boolean;
  repository: string;
  branch: string;
  actor: string;
  eventName: string;
};

/**
 * Detects CI environment and determines if running in PR/fork context
 */
export function detectCIEnvironment(): CIEnvironment {
  const isGitHub = process.env.GITHUB_ACTIONS === "true";
  const eventName = process.env.GITHUB_EVENT_NAME || "";
  const isPullRequest =
    eventName === "pull_request" ||
    eventName === "pull_request_target" ||
    eventName === "workflow_run";

  // Determine if PR is from a fork
  // In fork PRs, GITHUB_HEAD_REF is set but repo is different
  const headRef = process.env.GITHUB_HEAD_REF;
  const repository = process.env.GITHUB_REPOSITORY || "";
  const eventRepository = process.env.GITHUB_EVENT_PATH ? "fork" : "main";
  const isForkPullRequest =
    isPullRequest &&
    (eventRepository === "fork" ||
      process.env.GITHUB_EVENT_REPOSITORY?.includes("fork") ||
      false);

  return {
    isCI: isGitHub || process.env.CI === "true",
    isPullRequest,
    isForkPullRequest,
    repository,
    branch: process.env.GITHUB_REF_NAME || process.env.BRANCH || "",
    actor: process.env.GITHUB_ACTOR || process.env.USER || "unknown",
    eventName
  };
}

/**
 * Validates that testnet e2e suite is safe to run
 * Prevents running funded settlement from untrusted pull requests
 */
export type SecurityValidationResult = {
  allowed: boolean;
  mode: "full" | "smoke" | "blocked";
  reason: string;
  forkDetected: boolean;
};

export function validateTestnetE2ESecurityContext(): SecurityValidationResult {
  const ci = detectCIEnvironment();

  // Block full e2e on fork PRs (prevents funded settlement from untrusted code)
  if (ci.isForkPullRequest) {
    return {
      allowed: true,
      mode: "smoke",
      reason: "Fork PR detected - only smoke mode allowed (no credentials)",
      forkDetected: true
    };
  }

  // Block full e2e if environment is not recognized as CI
  if (!ci.isCI) {
    return {
      allowed: true,
      mode: "smoke",
      reason: "Not in CI environment - only smoke mode allowed by default",
      forkDetected: false
    };
  }

  // Allow full e2e on non-PR main branch CI runs with proper secrets
  if (!ci.isPullRequest) {
    return {
      allowed: true,
      mode: "full",
      reason: "Main branch deployment - full e2e allowed with credentials",
      forkDetected: false
    };
  }

  // Allow full e2e on PRs from main repository only
  if (ci.isPullRequest && !ci.isForkPullRequest) {
    return {
      allowed: true,
      mode: "full",
      reason: "Internal PR - full e2e allowed with credentials",
      forkDetected: false
    };
  }

  return {
    allowed: true,
    mode: "smoke",
    reason: "Conservative security posture - defaulting to smoke mode",
    forkDetected: false
  };
}

/**
 * Secret masking configuration for CI logs
 */
export type SecretMaskingConfig = {
  secrets: Array<{
    name: string;
    value: string;
    hash: string;
  }>;
  maskPatterns: string[];
};

/**
 * Creates masking configuration for detected secrets
 * Generates masks to prevent accidental secret exposure in logs
 */
export function createSecretMaskingConfig(
  secretNames: string[] = ["CLIENT_PRIVATE_KEY", "FACILITATOR_SIGNING_KEY"]
): SecretMaskingConfig {
  const secrets: SecretMaskingConfig["secrets"] = [];
  const maskPatterns: string[] = [];

  for (const secretName of secretNames) {
    const value = process.env[secretName];

    if (value && value.length > 0) {
      const hash = sha256(value);
      const mask = `***${hash.substring(0, 8)}***`;

      secrets.push({
        name: secretName,
        value: mask,
        hash
      });

      // Add pattern for GitHub Actions ::add-mask::
      maskPatterns.push(`::add-mask::${value}`);
    }
  }

  return { secrets, maskPatterns };
}

/**
 * Outputs GitHub Actions add-mask commands to prevent secret leakage
 * Must be called early in CI workflows
 */
export function outputGitHubActionsMasks(secretNames: string[] = []): void {
  if (process.env.GITHUB_ACTIONS !== "true") {
    return;
  }

  const config = createSecretMaskingConfig(secretNames);

  for (const pattern of config.maskPatterns) {
    console.log(pattern);
  }

  // Also set as GitHub Actions environment variables
  if (process.env.GITHUB_OUTPUT) {
    for (const secret of config.secrets) {
      console.log(`::add-mask::${secret.value}`);
    }
  }
}

/**
 * Validates environment for testnet e2e execution
 */
export type EnvironmentValidation = {
  valid: boolean;
  errors: string[];
  warnings: string[];
  credentialsPresent: boolean;
  trustLevel: "untrusted" | "internal" | "trusted";
};

export function validateTestnetE2EEnvironment(
  mode: "smoke" | "full"
): EnvironmentValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  let credentialsPresent = false;
  const ci = detectCIEnvironment();

  // Check mode-specific requirements
  if (mode === "full") {
    const clientKey = process.env.CLIENT_PRIVATE_KEY;
    if (!clientKey || clientKey.length === 0) {
      errors.push("CLIENT_PRIVATE_KEY is required for full e2e mode");
    } else {
      credentialsPresent = true;
    }

    if (ci.isForkPullRequest) {
      errors.push("Full e2e mode is not allowed on fork pull requests");
    }
  }

  // Check manifest
  const manifestPath = process.env.TESTNET_MANIFEST_PATH || "docs/deployment/testnet-endpoints.json";
  if (!manifestPath) {
    warnings.push("TESTNET_MANIFEST_PATH not set - using default");
  }

  // Check output path
  const outputPath = process.env.TESTNET_E2E_OUTPUT || "deployment-evidence/e2e-suite.json";
  if (!outputPath) {
    warnings.push("TESTNET_E2E_OUTPUT not set - using default");
  }

  // Determine trust level
  let trustLevel: "untrusted" | "internal" | "trusted" = "untrusted";

  if (!ci.isCI) {
    trustLevel = "untrusted"; // Local development
  } else if (ci.isForkPullRequest) {
    trustLevel = "untrusted"; // Fork PR
  } else if (ci.isPullRequest) {
    trustLevel = "internal"; // Internal PR
  } else {
    trustLevel = "trusted"; // Main branch push
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    credentialsPresent,
    trustLevel
  };
}

/**
 * Fork execution prevention check
 * Returns true if safe to execute funded operations
 */
export function isSafeForFundedOperations(): boolean {
  const ci = detectCIEnvironment();

  // Never run funded operations from fork PRs
  if (ci.isForkPullRequest) {
    return false;
  }

  // Only safe on main branch or internal PRs
  return !ci.isPullRequest || (ci.isPullRequest && !ci.isForkPullRequest);
}

/**
 * Generates security audit log for testnet e2e execution
 */
export type SecurityAuditLog = {
  timestamp: string;
  ciEnvironment: CIEnvironment;
  securityValidation: SecurityValidationResult;
  environmentValidation: EnvironmentValidation;
  secretMaskingActive: boolean;
  fundedOperationsAllowed: boolean;
};

export function generateSecurityAuditLog(
  mode: "smoke" | "full"
): SecurityAuditLog {
  return {
    timestamp: new Date().toISOString(),
    ciEnvironment: detectCIEnvironment(),
    securityValidation: validateTestnetE2ESecurityContext(),
    environmentValidation: validateTestnetE2EEnvironment(mode),
    secretMaskingActive: process.env.GITHUB_ACTIONS === "true",
    fundedOperationsAllowed: isSafeForFundedOperations()
  };
}

/**
 * CLI for testing security configuration
 */
async function main() {
  const command = process.argv[2];

  switch (command) {
    case "detect-ci":
      console.log(JSON.stringify(detectCIEnvironment(), null, 2));
      break;

    case "validate-security":
      console.log(JSON.stringify(validateTestnetE2ESecurityContext(), null, 2));
      break;

    case "validate-env": {
      const mode = (process.argv[3] as "smoke" | "full") || "smoke";
      console.log(JSON.stringify(validateTestnetE2EEnvironment(mode), null, 2));
      break;
    }

    case "audit-log": {
      const mode = (process.argv[3] as "smoke" | "full") || "smoke";
      console.log(JSON.stringify(generateSecurityAuditLog(mode), null, 2));
      break;
    }

    case "mask-secrets":
      outputGitHubActionsMasks(process.argv.slice(3));
      break;

    case "safe-for-funded":
      console.log(isSafeForFundedOperations());
      break;

    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// Only run main if called directly
const entrypoint = process.argv[1];
if (entrypoint && entrypoint.endsWith("ci-security.ts")) {
  await main();
}

export {};
