import { describe, it, expect } from "vitest";
import { LumenError } from "@lumenbazaar/shared";
import {
  validateWebhookUrl,
  generateWebhookSecret,
  hashWebhookSecret,
  WebhookService,
  createWebhookEndpointSchema,
  updateWebhookEndpointSchema,
} from "./webhooks.js";

describe("webhook URL validation (SSRF protection)", () => {
  it("rejects HTTP URLs", () => {
    expect(() => validateWebhookUrl("http://example.com/webhook")).toThrow(
      /HTTPS/
    );
  });

  it("rejects URLs with credentials", () => {
    expect(() => validateWebhookUrl("https://user:pass@example.com/webhook")).toThrow(
      /credentials/
    );
  });

  it("rejects localhost", () => {
    expect(() => validateWebhookUrl("https://localhost:8000/webhook")).toThrow(
      /localhost/
    );
  });

  it("rejects loopback IP addresses", () => {
    expect(() => validateWebhookUrl("https://127.0.0.1/webhook")).toThrow(
      /private/
    );
  });

  it("rejects private IP ranges", () => {
    expect(() => validateWebhookUrl("https://192.168.1.100/webhook")).toThrow(
      /private/
    );
    expect(() => validateWebhookUrl("https://10.0.0.1/webhook")).toThrow(
      /private/
    );
    expect(() => validateWebhookUrl("https://172.16.0.1/webhook")).toThrow(
      /private/
    );
  });

  it("rejects link-local addresses", () => {
    expect(() => validateWebhookUrl("https://169.254.1.1/webhook")).toThrow(
      /private/
    );
  });

  it("accepts valid HTTPS URLs", () => {
    const url = validateWebhookUrl("https://api.example.com/webhook");
    expect(url.protocol).toBe("https:");
    expect(url.hostname).toBe("api.example.com");
  });
});

describe("webhook secret generation and hashing", () => {
  it("generates random secrets", () => {
    const secret1 = generateWebhookSecret();
    const secret2 = generateWebhookSecret();
    expect(secret1).not.toBe(secret2);
    expect(secret1.length).toBeGreaterThan(0);
  });

  it("hashes secrets deterministically", () => {
    const secret = "my-webhook-secret";
    const hash1 = hashWebhookSecret(secret);
    const hash2 = hashWebhookSecret(secret);
    expect(hash1).toBe(hash2);
  });

  it("produces different hashes for different secrets", () => {
    const hash1 = hashWebhookSecret("secret1");
    const hash2 = hashWebhookSecret("secret2");
    expect(hash1).not.toBe(hash2);
  });
});

describe("WebhookService", () => {
  it("creates webhook endpoints", async () => {
    const service = new WebhookService();
    const result = await service.createWebhookEndpoint(
      "seller_123",
      {
        url: "https://api.example.com/webhook",
        isActive: true,
      }
    );

    expect(result.id).toBeDefined();
    expect(result.url).toBe("https://api.example.com/webhook");
    expect(result.isActive).toBe(true);
    expect(result.secret).toBeDefined();
    expect(result.lastDeliveryAt).toBeNull();
  });

  it("lists webhook endpoints for a seller", async () => {
    const service = new WebhookService();
    const seller1 = await service.createWebhookEndpoint("seller_1", {
      url: "https://api1.example.com/webhook",
    });
    const seller2 = await service.createWebhookEndpoint("seller_2", {
      url: "https://api2.example.com/webhook",
    });

    const { endpoints: list1, total: total1 } = await service.listWebhookEndpoints(
      "seller_1",
      100,
      0
    );
    const { endpoints: list2, total: total2 } = await service.listWebhookEndpoints(
      "seller_2",
      100,
      0
    );

    expect(total1).toBe(1);
    expect(list1[0].id).toBe(seller1.id);
    expect(total2).toBe(1);
    expect(list2[0].id).toBe(seller2.id);
  });

  it("updates webhook endpoint", async () => {
    const service = new WebhookService();
    const endpoint = await service.createWebhookEndpoint("seller_123", {
      url: "https://api.example.com/webhook",
    });

    const updated = await service.updateWebhookEndpoint("seller_123", endpoint.id, {
      isActive: false,
      url: "https://api2.example.com/webhook",
    });

    expect(updated.isActive).toBe(false);
    expect(updated.url).toBe("https://api2.example.com/webhook");
  });

  it("deletes webhook endpoint", async () => {
    const service = new WebhookService();
    const endpoint = await service.createWebhookEndpoint("seller_123", {
      url: "https://api.example.com/webhook",
    });

    await service.deleteWebhookEndpoint("seller_123", endpoint.id);

    const retrieved = await service
      .getStore()
      .getWebhookEndpoint(endpoint.id);
    expect(retrieved).toBeUndefined();
  });

  it("rotates webhook secrets with overlap window", async () => {
    const service = new WebhookService();
    const endpoint = await service.createWebhookEndpoint("seller_123", {
      url: "https://api.example.com/webhook",
    });

    const oldSecret = endpoint.secret;
    const rotated = await service.rotateSecret("seller_123", endpoint.id);

    expect(rotated.secret).not.toBe(oldSecret);
    expect(rotated.isCurrent).toBe(true);

    // Check that old secret is still in overlap window
    const validSecrets = await service.getStore().getValidSecrets(endpoint.id);
    expect(validSecrets.length).toBe(2); // Old and new
  });

  it("prevents unauthorized access", async () => {
    const service = new WebhookService();
    const endpoint = await service.createWebhookEndpoint("seller_1", {
      url: "https://api.example.com/webhook",
    });

    await expect(
      service.getWebhookEndpoint("seller_2", endpoint.id)
    ).rejects.toThrow(LumenError);
  });

  it("validates URL format on creation", async () => {
    const service = new WebhookService();

    await expect(
      service.createWebhookEndpoint("seller_123", {
        url: "not a url",
      })
    ).rejects.toThrow();
  });
});

describe("schema validation", () => {
  it("validates create webhook endpoint input", () => {
    const valid = {
      url: "https://api.example.com/webhook",
      isActive: true,
    };
    expect(() => createWebhookEndpointSchema.parse(valid)).not.toThrow();

    const invalid = {
      url: "not-a-url",
    };
    expect(() => createWebhookEndpointSchema.parse(invalid)).toThrow();
  });

  it("validates update webhook endpoint input", () => {
    const valid1 = { isActive: false };
    expect(() => updateWebhookEndpointSchema.parse(valid1)).not.toThrow();

    const valid2 = { url: "https://new.example.com/webhook" };
    expect(() => updateWebhookEndpointSchema.parse(valid2)).not.toThrow();

    const valid3 = {};
    expect(() => updateWebhookEndpointSchema.parse(valid3)).not.toThrow();
  });
});
