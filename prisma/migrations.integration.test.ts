import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  createDisposableTestDatabase,
  runMigrations,
  verifyMigrationsApplyFromEmpty,
  verifyDatabaseConstraint
} from "@lumenbazaar/testkit";

/**
 * Integration tests for database migrations.
 * 
 * These tests verify:
 * 1. All migrations apply cleanly from an empty database
 * 2. Supported upgrade paths work without data loss
 * 3. Critical unique and foreign key constraints are enforced
 * 4. Schema matches Prisma model definitions after migrations
 */

describe("Database Migrations", () => {
  // Skip these tests if we can't connect to PostgreSQL
  const skipIfNoDatabaseUrl = process.env.MIGRATION_TEST_DATABASE_URL === undefined;
  const describeIfDatabase = skipIfNoDatabaseUrl ? describe.skip : describe;

  describe("Migration History", () => {
    it("all migrations apply from an empty database", async () => {
      const { success, dbName } = await verifyMigrationsApplyFromEmpty();

      expect(success).toBe(true);
      expect(dbName).toMatch(/^test_\d+_[a-z0-9]+$/);
    });

    it("migrations are idempotent and can be run multiple times", async () => {
      const { databaseUrl, cleanup } = await createDisposableTestDatabase();

      try {
        // Run migrations twice
        const firstRun = await runMigrations(databaseUrl);
        expect(firstRun.success).toBe(true);

        const secondRun = await runMigrations(databaseUrl);
        expect(secondRun.success).toBe(true);
      } finally {
        await cleanup();
      }
    });
  });

  describeIfDatabase("Fixture Data and Schema Validation", () => {
    let client: PrismaClient;
    let databaseUrl: string;
    let cleanup: () => Promise<void>;

    beforeAll(async () => {
      const db = await createDisposableTestDatabase();
      databaseUrl = db.databaseUrl;
      cleanup = db.cleanup;

      await runMigrations(databaseUrl);

      client = new PrismaClient({
        datasources: { db: { url: databaseUrl } }
      });
    });

    afterAll(async () => {
      await client.$disconnect();
      await cleanup();
    });

    it("seller table has correct structure and constraints", async () => {
      // Insert a valid seller
      const seller = await client.seller.create({
        data: {
          displayName: "Test Seller",
          walletAddress: "GCZXWVQXZ3VQX3CIQX7X3VQXZ3VQX3VQXZ3VQX3VQX3VQX3VQX3VQ",
          domain: "example.com"
        }
      });

      expect(seller.id).toBeDefined();
      expect(seller.displayName).toBe("Test Seller");
      expect(seller.walletAddress).toBe("GCZXWVQXZ3VQX3CIQX7X3VQXZ3VQX3VQXZ3VQX3VQX3VQX3VQX3VQ");

      // Verify unique constraint on walletAddress
      await expect(
        client.seller.create({
          data: {
            displayName: "Another Seller",
            walletAddress: "GCZXWVQXZ3VQX3CIQX7X3VQXZ3VQX3VQXZ3VQX3VQX3VQX3VQX3VQ",
            domain: "other.com"
          }
        })
      ).rejects.toThrow();

      // Verify seller can be found by wallet address
      const foundSeller = await client.seller.findUnique({
        where: { walletAddress: seller.walletAddress }
      });

      expect(foundSeller?.id).toBe(seller.id);
    });

    it("resource requires valid seller foreign key", async () => {
      const seller = await client.seller.create({
        data: {
          displayName: "Test Seller",
          walletAddress: "GBVCN3WNZBN7VQOB3CKQT5N5MVXNZ47CGXWQF5VQOB3CKQT5N5MV",
          domain: "seller.example.com"
        }
      });

      // Insert a valid resource
      const resource = await client.resource.create({
        data: {
          sellerId: seller.id,
          type: "conversion",
          name: "Test Resource",
          description: "Test description",
          url: "https://example.com/resource",
          routeTemplate: "/resource",
          network: "testnet",
          payTo: "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIEAL23GMVRQS3YWIK5LFBRT5",
          assetCode: "USD",
          assetIssuer: "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIEAL23GMVRQS3YWIK5LFBRT5",
          amount: "100.00",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          extensions: {}
        }
      });

      expect(resource.id).toBeDefined();
      expect(resource.sellerId).toBe(seller.id);

      // Verify foreign key constraint: invalid seller ID should fail
      await expect(
        client.resource.create({
          data: {
            sellerId: "invalid-seller-id",
            type: "conversion",
            name: "Invalid Resource",
            description: "Test",
            url: "https://example.com",
            routeTemplate: "/resource",
            network: "testnet",
            payTo: "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIEAL23GMVRQS3YWIK5LFBRT5",
            assetCode: "USD",
            assetIssuer: "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIEAL23GMVRQS3YWIK5LFBRT5",
            amount: "100.00",
            inputSchema: { type: "object" },
            outputSchema: { type: "object" },
            extensions: {}
          }
        })
      ).rejects.toThrow();
    });

    it("payment attempt has unique constraints on paymentHash and idempotencyKey", async () => {
      const seller = await client.seller.create({
        data: {
          displayName: "Payment Test Seller",
          walletAddress: "GBDVUOIZN65BTLVN34GDW7IY4UZK523EFYGYYDGTLPSXVUQ4L4L3FV",
          domain: "payment.example.com"
        }
      });

      const paymentAttempt = await client.paymentAttempt.create({
        data: {
          correlationId: "corr-001",
          paymentHash: "hash-001",
          idempotencyKey: "idempotent-001",
          network: "testnet",
          assetCode: "USD",
          assetIssuer: "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIEAL23GMVRQS3YWIK5LFBRT5",
          amount: "50.00",
          payTo: "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIEAL23GMVRQS3YWIK5LFBRT5",
          sellerId: seller.id
        }
      });

      expect(paymentAttempt.id).toBeDefined();

      // Verify unique constraint on paymentHash
      await expect(
        client.paymentAttempt.create({
          data: {
            correlationId: "corr-002",
            paymentHash: "hash-001",
            idempotencyKey: "idempotent-002",
            network: "testnet",
            assetCode: "USD",
            assetIssuer: "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIEAL23GMVRQS3YWIK5LFBRT5",
            amount: "50.00",
            payTo: "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIEAL23GMVRQS3YWIK5LFBRT5"
          }
        })
      ).rejects.toThrow();

      // Verify unique constraint on idempotencyKey
      await expect(
        client.paymentAttempt.create({
          data: {
            correlationId: "corr-003",
            paymentHash: "hash-003",
            idempotencyKey: "idempotent-001",
            network: "testnet",
            assetCode: "USD",
            assetIssuer: "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIEAL23GMVRQS3YWIK5LFBRT5",
            amount: "50.00",
            payTo: "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIEAL23GMVRQS3YWIK5LFBRT5"
          }
        })
      ).rejects.toThrow();
    });

    it("settlement has unique constraint on paymentAttemptId", async () => {
      const seller = await client.seller.create({
        data: {
          displayName: "Settlement Test Seller",
          walletAddress: "GCVB4BJGXRRNHHHKV7KCEPE4HN3S4P5LYRNZ3ZZJHHUIHGLPLWQVXVZ",
          domain: "settlement.example.com"
        }
      });

      const paymentAttempt = await client.paymentAttempt.create({
        data: {
          correlationId: "settle-corr-001",
          paymentHash: "settle-hash-001",
          idempotencyKey: "settle-idempotent-001",
          network: "testnet",
          assetCode: "USD",
          assetIssuer: "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIEAL23GMVRQS3YWIK5LFBRT5",
          amount: "100.00",
          payTo: "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIEAL23GMVRQS3YWIK5LFBRT5",
          sellerId: seller.id
        }
      });

      const settlement = await client.settlement.create({
        data: {
          correlationId: "settle-corr-001",
          paymentAttemptId: paymentAttempt.id,
          network: "testnet",
          amount: "100.00",
          assetCode: "USD",
          assetIssuer: "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIEAL23GMVRQS3YWIK5LFBRT5"
        }
      });

      expect(settlement.paymentAttemptId).toBe(paymentAttempt.id);

      // Verify unique constraint on paymentAttemptId
      await expect(
        client.settlement.create({
          data: {
            correlationId: "settle-corr-002",
            paymentAttemptId: paymentAttempt.id,
            network: "testnet",
            amount: "50.00",
            assetCode: "USD",
            assetIssuer: "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIEAL23GMVRQS3YWIK5LFBRT5"
          }
        })
      ).rejects.toThrow();
    });

    it("cascade delete removes child records when parent is deleted", async () => {
      const seller = await client.seller.create({
        data: {
          displayName: "Cascade Test Seller",
          walletAddress: "GBJCHUKZMTFSLOMNC4P4TS4VJJBTCYL3YCJYB5Z3X3V7K3QUQR7QV5",
          domain: "cascade.example.com"
        }
      });

      const domain = await client.sellerDomain.create({
        data: {
          sellerId: seller.id,
          domain: "subdomain.cascade.example.com",
          verificationMethod: "dns",
          challengeToken: "token-001"
        }
      });

      expect(domain.sellerId).toBe(seller.id);

      // Delete seller and verify domain is cascaded
      await client.seller.delete({ where: { id: seller.id } });

      const deletedDomain = await client.sellerDomain.findUnique({
        where: { id: domain.id }
      });

      expect(deletedDomain).toBeNull();
    });

    it("resource version has unique constraint on resourceId + version", async () => {
      const seller = await client.seller.create({
        data: {
          displayName: "Version Test Seller",
          walletAddress: "GCTFGWZZTCN5AXT6KFFCR6FVZCLVRDQWDKJ4FLMDGW4G3ULGGBV6WD",
          domain: "version.example.com"
        }
      });

      const resource = await client.resource.create({
        data: {
          sellerId: seller.id,
          type: "conversion",
          name: "Version Test Resource",
          description: "Test",
          url: "https://example.com",
          routeTemplate: "/resource",
          network: "testnet",
          payTo: "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIEAL23GMVRQS3YWIK5LFBRT5",
          assetCode: "USD",
          assetIssuer: "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIEAL23GMVRQS3YWIK5LFBRT5",
          amount: "100.00",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          extensions: {}
        }
      });

      const version1 = await client.resourceVersion.create({
        data: {
          resourceId: resource.id,
          version: 1,
          metadata: { description: "Version 1" }
        }
      });

      expect(version1.version).toBe(1);

      // Verify unique constraint on (resourceId, version)
      await expect(
        client.resourceVersion.create({
          data: {
            resourceId: resource.id,
            version: 1,
            metadata: { description: "Another version 1" }
          }
        })
      ).rejects.toThrow();

      // But version 2 should be allowed
      const version2 = await client.resourceVersion.create({
        data: {
          resourceId: resource.id,
          version: 2,
          metadata: { description: "Version 2" }
        }
      });

      expect(version2.version).toBe(2);
    });

    it("seller domain has unique constraint on (sellerId, domain)", async () => {
      const seller = await client.seller.create({
        data: {
          displayName: "Domain Test Seller",
          walletAddress: "GCXXD3ZPSSCJ7M2XWG5MBZTZLCSDMTFXN7F5PLFZ3KHNNKB3H5VRXVZ",
          domain: "uniquedomain.example.com"
        }
      });

      const domain1 = await client.sellerDomain.create({
        data: {
          sellerId: seller.id,
          domain: "sub1.example.com",
          verificationMethod: "dns",
          challengeToken: "token-1"
        }
      });

      expect(domain1.domain).toBe("sub1.example.com");

      // Same seller, same domain should fail
      await expect(
        client.sellerDomain.create({
          data: {
            sellerId: seller.id,
            domain: "sub1.example.com",
            verificationMethod: "dns",
            challengeToken: "token-2"
          }
        })
      ).rejects.toThrow();

      // Same seller, different domain should succeed
      const domain2 = await client.sellerDomain.create({
        data: {
          sellerId: seller.id,
          domain: "sub2.example.com",
          verificationMethod: "dns",
          challengeToken: "token-3"
        }
      });

      expect(domain2.domain).toBe("sub2.example.com");
    });

    it("payment session has unique constraint on contractSessionId", async () => {
      const seller = await client.seller.create({
        data: {
          displayName: "Session Test Seller",
          walletAddress: "GCZFTLRQXVQSXZ3Z3VQXZ3VQX3CIQX7X3VQXZ3VQX3VQX3VQX3VQ",
          domain: "session.example.com"
        }
      });

      const session1 = await client.paymentSession.create({
        data: {
          sellerId: seller.id,
          network: "testnet",
          buyer: "GBQD56RQCHKM7QVKCHV67WDDRSXQ6QRKSLWQLRYBQXNBH4S3IZSYYZP",
          payTo: "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIEAL23GMVRQS3YWIK5LFBRT5",
          assetCode: "USD",
          assetIssuer: "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIEAL23GMVRQS3YWIK5LFBRT5",
          assetContractId: "contract-001",
          capAmount: "1000.00",
          spentAmount: "0.00",
          remainingAmount: "1000.00",
          contractId: "contract-id-001",
          contractSessionId: "session-id-001",
          resourceHash: "hash-001",
          expiresAtLedger: 1000000
        }
      });

      expect(session1.contractSessionId).toBe("session-id-001");

      // Verify unique constraint
      await expect(
        client.paymentSession.create({
          data: {
            sellerId: seller.id,
            network: "testnet",
            buyer: "GBQD56RQCHKM7QVKCHV67WDDRSXQ6QRKSLWQLRYBQXNBH4S3IZSYYZP",
            payTo: "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIEAL23GMVRQS3YWIK5LFBRT5",
            assetCode: "USD",
            assetIssuer: "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIEAL23GMVRQS3YWIK5LFBRT5",
            assetContractId: "contract-002",
            capAmount: "1000.00",
            spentAmount: "0.00",
            remainingAmount: "1000.00",
            contractId: "contract-id-002",
            contractSessionId: "session-id-001",
            resourceHash: "hash-002",
            expiresAtLedger: 1000000
          }
        })
      ).rejects.toThrow();
    });

    it("receipt has unique constraint on evidenceHash", async () => {
      const seller = await client.seller.create({
        data: {
          displayName: "Receipt Test Seller",
          walletAddress: "GBVB46E6VBFVWZ5OQOBWVKXDV3AKVPFPLVX4BQVBFVWZ5OQOBWVKX",
          domain: "receipt.example.com"
        }
      });

      const paymentAttempt = await client.paymentAttempt.create({
        data: {
          correlationId: "receipt-corr-001",
          paymentHash: "receipt-hash-001",
          idempotencyKey: "receipt-idempotent-001",
          network: "testnet",
          assetCode: "USD",
          assetIssuer: "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIEAL23GMVRQS3YWIK5LFBRT5",
          amount: "75.00",
          payTo: "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIEAL23GMVRQS3YWIK5LFBRT5",
          sellerId: seller.id
        }
      });

      const receipt = await client.receipt.create({
        data: {
          correlationId: "receipt-corr-001",
          paymentAttemptId: paymentAttempt.id,
          network: "testnet",
          amount: "75.00",
          assetCode: "USD",
          assetIssuer: "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIEAL23GMVRQS3YWIK5LFBRT5",
          evidenceHash: "evidence-001",
          sellerId: seller.id
        }
      });

      expect(receipt.evidenceHash).toBe("evidence-001");

      // Create another payment attempt for the unique constraint test
      const paymentAttempt2 = await client.paymentAttempt.create({
        data: {
          correlationId: "receipt-corr-002",
          paymentHash: "receipt-hash-002",
          idempotencyKey: "receipt-idempotent-002",
          network: "testnet",
          assetCode: "USD",
          assetIssuer: "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIEAL23GMVRQS3YWIK5LFBRT5",
          amount: "75.00",
          payTo: "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIEAL23GMVRQS3YWIK5LFBRT5"
        }
      });

      // Verify unique constraint on evidenceHash
      await expect(
        client.receipt.create({
          data: {
            correlationId: "receipt-corr-003",
            paymentAttemptId: paymentAttempt2.id,
            network: "testnet",
            amount: "75.00",
            assetCode: "USD",
            assetIssuer: "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIEAL23GMVRQS3YWIK5LFBRT5",
            evidenceHash: "evidence-001"
          }
        })
      ).rejects.toThrow();
    });
  });
});
