import { randomUUID } from "node:crypto";

import { PrismaClient, type Prisma } from "@prisma/client";

import {
  getCorrelationId,
  redactSensitiveText,
  type AppConfig,
  type JsonObject,
  type JsonValue,
  RedactionService,
  DEFAULT_TESTNET_POLICY
} from "@lumenbazaar/shared";

export type AuditLogInput = {
  action: string;
  correlationId?: string | null;
  actorId?: string | null;
  actorType: "buyer" | "facilitator" | "seller" | "system";
  metadata?: Record<string, unknown>;
  targetId?: string | null;
  targetType: string;
};

export type AuditLogRecord = {
  action: string;
  correlationId: string | null;
  actorId: string | null;
  actorType: AuditLogInput["actorType"];
  createdAt: string;
  id: string;
  metadata: JsonObject;
  targetId: string | null;
  targetType: string;
};

export type AuditLogStore = {
  create: (input: Omit<AuditLogRecord, "id" | "createdAt">) => Promise<AuditLogRecord>;
  list: () => Promise<AuditLogRecord[]>;
};

export class InMemoryAuditLogStore implements AuditLogStore {
  private readonly records: AuditLogRecord[] = [];

  async create(input: Omit<AuditLogRecord, "id" | "createdAt">) {
    const record: AuditLogRecord = {
      id: `audit_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
      ...input,
      createdAt: new Date().toISOString()
    };

    this.records.push(record);
    return record;
  }

  async list() {
    return [...this.records];
  }
}

export class PrismaAuditLogStore implements AuditLogStore {
  constructor(private readonly db: PrismaClient) {}

  async create(input: Omit<AuditLogRecord, "id" | "createdAt">) {
    const row = await this.db.auditLog.create({
      data: {
        ...input,
        metadata: input.metadata as Prisma.InputJsonValue
      }
    });
    return mapAuditLog(row);
  }

  async list() {
    const rows = await this.db.auditLog.findMany({ orderBy: { createdAt: "asc" } });
    return rows.map(mapAuditLog);
  }
}

export class AuditLogService {
  private redactionService: RedactionService;

  constructor(
    private readonly store: AuditLogStore = new InMemoryAuditLogStore(),
    redactionService?: RedactionService
  ) {
    this.redactionService = redactionService || new RedactionService(DEFAULT_TESTNET_POLICY);
  }

  async record(input: AuditLogInput) {
    return this.store.create({
      action: input.action,
      correlationId: input.correlationId ?? getCorrelationId() ?? null,
      actorId: input.actorId ?? null,
      actorType: input.actorType,
      metadata: this.redactionService.sanitizeMetadata(input.metadata ?? {}),
      targetId: input.targetId ?? null,
      targetType: input.targetType
    });
  }

  async list() {
    return this.store.list();
  }

  setRedactionService(service: RedactionService) {
    this.redactionService = service;
  }
}

export function sanitizeAuditMetadata(metadata: Record<string, unknown>): JsonObject {
  // Maintained for backward compatibility; prefer RedactionService.sanitizeMetadata()
  const service = new RedactionService(DEFAULT_TESTNET_POLICY);
  return service.sanitizeMetadata(metadata);
}

function toJsonValue(value: unknown, service: RedactionService): JsonValue {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return redactSensitiveText(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => toJsonValue(item, service));
  }

  if (typeof value === "object") {
    return service.sanitizeMetadata(value as Record<string, unknown>);
  }

  return String(value);
}

export function createRuntimeAuditLog(config: AppConfig) {
  if (
    process.env.VITEST !== undefined ||
    process.env.NODE_ENV === "test" ||
    config.nodeEnv !== "production" ||
    config.lumenEnv === "local"
  ) {
    return {
      service: new AuditLogService(),
      close: async () => undefined
    };
  }

  const db = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
  return {
    service: new AuditLogService(new PrismaAuditLogStore(db)),
    close: async () => db.$disconnect()
  };
}

function mapAuditLog(row: {
  action: string;
  actorId: string | null;
  actorType: string;
  correlationId: string | null;
  createdAt: Date;
  id: string;
  metadata: Prisma.JsonValue;
  targetId: string | null;
  targetType: string;
}): AuditLogRecord {
  return {
    ...row,
    actorType: row.actorType as AuditLogRecord["actorType"],
    createdAt: row.createdAt.toISOString(),
    metadata: row.metadata as JsonObject
  };
}
