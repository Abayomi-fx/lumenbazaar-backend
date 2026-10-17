-- Create WebhookEndpoint table
CREATE TABLE "WebhookEndpoint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sellerId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastDeliveryAt" TIMESTAMP,
    "lastDeliveryStatus" INTEGER,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WebhookEndpoint_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller" ("id") ON DELETE CASCADE
);

CREATE INDEX "WebhookEndpoint_sellerId_isActive_idx" ON "WebhookEndpoint" ("sellerId", "isActive");
CREATE INDEX "WebhookEndpoint_createdAt_idx" ON "WebhookEndpoint" ("createdAt");

-- Create WebhookSecret table
CREATE TABLE "WebhookSecret" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "endpointId" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotatedOutAt" TIMESTAMP,
    CONSTRAINT "WebhookSecret_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "WebhookEndpoint" ("id") ON DELETE CASCADE
);

CREATE INDEX "WebhookSecret_endpointId_isCurrent_idx" ON "WebhookSecret" ("endpointId", "isCurrent");
CREATE INDEX "WebhookSecret_endpointId_rotatedOutAt_idx" ON "WebhookSecret" ("endpointId", "rotatedOutAt");

-- Create WebhookEvent table
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventId" TEXT NOT NULL UNIQUE,
    "sellerId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "paymentAttemptId" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WebhookEvent_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller" ("id") ON DELETE CASCADE
);

CREATE INDEX "WebhookEvent_sellerId_createdAt_idx" ON "WebhookEvent" ("sellerId", "createdAt");
CREATE INDEX "WebhookEvent_eventId_idx" ON "WebhookEvent" ("eventId");
CREATE INDEX "WebhookEvent_paymentAttemptId_idx" ON "WebhookEvent" ("paymentAttemptId");
CREATE INDEX "WebhookEvent_settlementId_idx" ON "WebhookEvent" ("settlementId");
CREATE INDEX "WebhookEvent_eventType_createdAt_idx" ON "WebhookEvent" ("eventType", "createdAt");

-- Create WebhookDeliveryAttempt table
CREATE TABLE "WebhookDeliveryAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventId" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "requestUrl" TEXT NOT NULL,
    "requestHeaders" JSONB NOT NULL,
    "statusCode" INTEGER,
    "responseBodyTruncated" TEXT,
    "latencyMs" INTEGER NOT NULL,
    "errorClass" TEXT,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WebhookDeliveryAttempt_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "WebhookEvent" ("id") ON DELETE CASCADE,
    CONSTRAINT "WebhookDeliveryAttempt_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "WebhookEndpoint" ("id") ON DELETE CASCADE
);

CREATE INDEX "WebhookDeliveryAttempt_eventId_attemptNumber_idx" ON "WebhookDeliveryAttempt" ("eventId", "attemptNumber");
CREATE INDEX "WebhookDeliveryAttempt_endpointId_createdAt_idx" ON "WebhookDeliveryAttempt" ("endpointId", "createdAt");
CREATE INDEX "WebhookDeliveryAttempt_createdAt_idx" ON "WebhookDeliveryAttempt" ("createdAt");
