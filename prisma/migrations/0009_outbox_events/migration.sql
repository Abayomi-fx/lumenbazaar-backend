-- Create OutboxEvent table for transactional outbox pattern
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payloadVersion" INTEGER NOT NULL DEFAULT 1,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedBy" TEXT,
    "lockExpiresAt" TIMESTAMP,
    "lastError" TEXT,
    "deliveredAt" TIMESTAMP,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Unique constraint prevents duplicate events for same aggregate transition
CREATE UNIQUE INDEX "OutboxEvent_aggregateType_aggregateId_eventType_createdAt_key" 
ON "OutboxEvent" ("aggregateType", "aggregateId", "eventType", "createdAt");

-- Index for relay query: find next batch to process
CREATE INDEX "OutboxEvent_status_nextAttemptAt_idx" ON "OutboxEvent" ("status", "nextAttemptAt");

-- Index for cleanup query: find delivered events to remove
CREATE INDEX "OutboxEvent_status_createdAt_idx" ON "OutboxEvent" ("status", "createdAt");

-- Index for finding events for specific aggregate
CREATE INDEX "OutboxEvent_aggregateType_aggregateId_idx" ON "OutboxEvent" ("aggregateType", "aggregateId");

-- Index for finding stale locks for recovery
CREATE INDEX "OutboxEvent_lockedBy_lockExpiresAt_idx" ON "OutboxEvent" ("lockedBy", "lockExpiresAt");

-- Create ProcessedOutboxEvent table for idempotency tracking
CREATE TABLE "ProcessedOutboxEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "outboxEventId" TEXT NOT NULL UNIQUE,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "consumerId" TEXT NOT NULL,
    "processedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Idempotency: same event+consumer combo never processed twice
CREATE UNIQUE INDEX "ProcessedOutboxEvent_outboxEventId_consumerId_key" 
ON "ProcessedOutboxEvent" ("outboxEventId", "consumerId");

-- Index for finding processed events for specific aggregate and consumer
CREATE INDEX "ProcessedOutboxEvent_aggregateType_aggregateId_consumerId_idx" 
ON "ProcessedOutboxEvent" ("aggregateType", "aggregateId", "consumerId");
