import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  detectCIEnvironment,
  validateTestnetE2ESecurityContext,
  createSecretMaskingConfig,
  validateTestnetE2EEnvironment,
  isSafeForFundedOperations,
  generateSecurityAuditLog
} from "./ci-security.js";

/**
 * Integration tests for CI security module
 */

describe("CI Environment Detection", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should detect GitHub Actions CI environment", () => {
    process.env.GITHUB_ACTIONS = "true";
    process.env.GITHUB_REPOSITORY = "owner/repo";
    process.env.GITHUB_ACTOR = "bot";
    process.env.GITHUB_REF_NAME = "main";
    process.env.GITHUB_EVENT_NAME = "push";

    const ci = detectCIEnvironment();

    expect(ci.isCI).toBe(true);
    expect(ci.isPullRequest).toBe(false);
    expect(ci.isForkPullRequest).toBe(false);
    expect(ci.repository).toBe("owner/repo");
    expect(ci.branch).toBe("main");
    expect(ci.actor).toBe("bot");
    expect(ci.eventName).toBe("push");
  });

  it("should detect pull request from fork", () => {
    process.env.GITHUB_ACTIONS = "true";
    process.env.GITHUB_EVENT_NAME = "pull_request";
    process.env.GITHUB_HEAD_REF = "feature-branch";
    process.env.GITHUB_EVENT_REPOSITORY = "fork/repo";

    const ci = detectCIEnvironment();

    expect(ci.isPullRequest).toBe(true);
    expect(ci.isForkPullRequest).toBe(true);
  });

  it("should detect internal pull request", () => {
    process.env.GITHUB_ACTIONS = "true";
    process.env.GITHUB_EVENT_NAME = "pull_request";
    process.env.GITHUB_REPOSITORY = "owner/repo";

    const ci = detectCIEnvironment();

    expect(ci.isPullRequest).toBe(true);
    expect(ci.isForkPullRequest).toBe(false);
  });

  it("should detect local development environment", () => {
    delete process.env.GITHUB_ACTIONS;
    delete process.env.CI;

    const ci = detectCIEnvironment();

    expect(ci.isCI).toBe(false);
    expect(ci.isPullRequest).toBe(false);
    expect(ci.isForkPullRequest).toBe(false);
  });
});

describe("Testnet E2E Security Validation", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should block full e2e on fork pull requests", () => {
    process.env.GITHUB_ACTIONS = "true";
    process.env.GITHUB_EVENT_NAME = "pull_request";
    process.env.GITHUB_EVENT_REPOSITORY = "fork/repo";

    const result = validateTestnetE2ESecurityContext();

    expect(result.allowed).toBe(true);
    expect(result.mode).toBe("smoke");
    expect(result.forkDetected).toBe(true);
    expect(result.reason).toContain("Fork PR");
  });

  it("should allow full e2e on main branch", () => {
    process.env.GITHUB_ACTIONS = "true";
    process.env.GITHUB_EVENT_NAME = "push";

    const result = validateTestnetE2ESecurityContext();

    expect(result.allowed).toBe(true);
    expect(result.mode).toBe("full");
    expect(result.forkDetected).toBe(false);
    expect(result.reason).toContain("Main branch");
  });

  it("should allow full e2e on internal PR", () => {
    process.env.GITHUB_ACTIONS = "true";
    process.env.GITHUB_EVENT_NAME = "pull_request";
    process.env.GITHUB_REPOSITORY = "owner/repo";
    delete process.env.GITHUB_EVENT_REPOSITORY;

    const result = validateTestnetE2ESecurityContext();

    expect(result.allowed).toBe(true);
    expect(result.mode).toBe("full");
    expect(result.forkDetected).toBe(false);
    expect(result.reason).toContain("Internal PR");
  });

  it("should default to smoke mode in local environment", () => {
    delete process.env.GITHUB_ACTIONS;

    const result = validateTestnetE2ESecurityContext();

    expect(result.mode).toBe("smoke");
    expect(result.reason).toContain("Not in CI");
  });
});

describe("Secret Masking Configuration", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should create masking config for detected secrets", () => {
    process.env.CLIENT_PRIVATE_KEY = "secret_key_12345";
    process.env.FACILITATOR_SIGNING_KEY = "signing_key_67890";

    const config = createSecretMaskingConfig([
      "CLIENT_PRIVATE_KEY",
      "FACILITATOR_SIGNING_KEY"
    ]);

    expect(config.secrets).toHaveLength(2);
    expect(config.maskPatterns).toHaveLength(2);

    const clientSecret = config.secrets.find((s) => s.name === "CLIENT_PRIVATE_KEY");
    expect(clientSecret).toBeDefined();
    expect(clientSecret!.value).toMatch(/^\*\*\*[a-f0-9]{8}\*\*\*$/);
    expect(clientSecret!.hash).toMatch(/^[a-f0-9]{64}$/);

    const signingSecret = config.secrets.find((s) => s.name === "FACILITATOR_SIGNING_KEY");
    expect(signingSecret).toBeDefined();
    expect(signingSecret!.value).toMatch(/^\*\*\*[a-f0-9]{8}\*\*\*$/);
  });

  it("should handle missing secrets gracefully", () => {
    delete process.env.CLIENT_PRIVATE_KEY;
    delete process.env.FACILITATOR_SIGNING_KEY;

    const config = createSecretMaskingConfig([
      "CLIENT_PRIVATE_KEY",
      "FACILITATOR_SIGNING_KEY"
    ]);

    expect(config.secrets).toHaveLength(0);
    expect(config.maskPatterns).toHaveLength(0);
  });

  it("should generate unique masks for different secrets", () => {
    process.env.SECRET_ONE = "value_one";
    process.env.SECRET_TWO = "value_two";

    const config = createSecretMaskingConfig(["SECRET_ONE", "SECRET_TWO"]);

    const hash1 = config.secrets[0]!.hash;
    const hash2 = config.secrets[1]!.hash;

    expect(hash1).not.toBe(hash2);
  });
});

describe("Environment Validation", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should validate smoke mode without credentials", () => {
    delete process.env.CLIENT_PRIVATE_KEY;

    const result = validateTestnetE2EEnvironment("smoke");

    expect(result.valid).toBe(true);
    expect(result.credentialsPresent).toBe(false);
    expect(result.trustLevel).toBe("untrusted");
  });

  it("should require credentials for full mode", () => {
    delete process.env.CLIENT_PRIVATE_KEY;

    const result = validateTestnetE2EEnvironment("full");

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("CLIENT_PRIVATE_KEY is required for full e2e mode");
    expect(result.credentialsPresent).toBe(false);
  });

  it("should accept credentials for full mode", () => {
    process.env.CLIENT_PRIVATE_KEY = "secret_key";
    process.env.GITHUB_ACTIONS = "true";
    process.env.GITHUB_EVENT_NAME = "push";

    const result = validateTestnetE2EEnvironment("full");

    expect(result.valid).toBe(true);
    expect(result.credentialsPresent).toBe(true);
  });

  it("should block full mode on fork PR", () => {
    process.env.CLIENT_PRIVATE_KEY = "secret_key";
    process.env.GITHUB_ACTIONS = "true";
    process.env.GITHUB_EVENT_NAME = "pull_request";
    process.env.GITHUB_EVENT_REPOSITORY = "fork/repo";

    const result = validateTestnetE2EEnvironment("full");

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("not allowed"))).toBe(true);
  });

  it("should determine trust level correctly", () => {
    // Local development - untrusted
    delete process.env.GITHUB_ACTIONS;
    let result = validateTestnetE2EEnvironment("smoke");
    expect(result.trustLevel).toBe("untrusted");

    // Fork PR - untrusted
    process.env.GITHUB_ACTIONS = "true";
    process.env.GITHUB_EVENT_NAME = "pull_request";
    process.env.GITHUB_EVENT_REPOSITORY = "fork/repo";
    result = validateTestnetE2EEnvironment("smoke");
    expect(result.trustLevel).toBe("untrusted");

    // Internal PR - internal
    delete process.env.GITHUB_EVENT_REPOSITORY;
    result = validateTestnetE2EEnvironment("smoke");
    expect(result.trustLevel).toBe("internal");

    // Main branch - trusted
    process.env.GITHUB_EVENT_NAME = "push";
    result = validateTestnetE2EEnvironment("smoke");
    expect(result.trustLevel).toBe("trusted");
  });
});

describe("Funded Operations Safety Check", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should allow funded operations on main branch", () => {
    process.env.GITHUB_ACTIONS = "true";
    process.env.GITHUB_EVENT_NAME = "push";

    const safe = isSafeForFundedOperations();

    expect(safe).toBe(true);
  });

  it("should allow funded operations on internal PR", () => {
    process.env.GITHUB_ACTIONS = "true";
    process.env.GITHUB_EVENT_NAME = "pull_request";
    process.env.GITHUB_REPOSITORY = "owner/repo";

    const safe = isSafeForFundedOperations();

    expect(safe).toBe(true);
  });

  it("should block funded operations on fork PR", () => {
    process.env.GITHUB_ACTIONS = "true";
    process.env.GITHUB_EVENT_NAME = "pull_request";
    process.env.GITHUB_EVENT_REPOSITORY = "fork/repo";

    const safe = isSafeForFundedOperations();

    expect(safe).toBe(false);
  });

  it("should block funded operations in local environment", () => {
    delete process.env.GITHUB_ACTIONS;

    const safe = isSafeForFundedOperations();

    expect(safe).toBe(false);
  });
});

describe("Security Audit Log Generation", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should generate comprehensive audit log for smoke mode", () => {
    process.env.GITHUB_ACTIONS = "true";
    process.env.GITHUB_EVENT_NAME = "push";

    const log = generateSecurityAuditLog("smoke");

    expect(log.timestamp).toBeDefined();
    expect(log.ciEnvironment).toBeDefined();
    expect(log.securityValidation).toBeDefined();
    expect(log.environmentValidation).toBeDefined();
    expect(log.secretMaskingActive).toBe(true);
    expect(log.fundedOperationsAllowed).toBe(true);
  });

  it("should generate audit log for full mode", () => {
    process.env.GITHUB_ACTIONS = "true";
    process.env.GITHUB_EVENT_NAME = "push";
    process.env.CLIENT_PRIVATE_KEY = "secret_key";

    const log = generateSecurityAuditLog("full");

    expect(log.environmentValidation.valid).toBe(true);
    expect(log.environmentValidation.credentialsPresent).toBe(true);
  });

  it("should log security violations", () => {
    process.env.GITHUB_ACTIONS = "true";
    process.env.GITHUB_EVENT_NAME = "pull_request";
    process.env.GITHUB_EVENT_REPOSITORY = "fork/repo";

    const log = generateSecurityAuditLog("full");

    expect(log.securityValidation.mode).toBe("smoke");
    expect(log.fundedOperationsAllowed).toBe(false);
    expect(log.environmentValidation.trustLevel).toBe("untrusted");
  });
});
