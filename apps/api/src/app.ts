import { randomUUID } from "node:crypto";

import cors from "@fastify/cors";
import Fastify from "fastify";

import {
  type AppConfig,
  listConfiguredNetworks,
  loadConfig,
  runWithCorrelationId
} from "@lumenbazaar/shared";
import {
  PaymentSessionService,
  PaymentVerificationService,
  ReceiptService,
  SettlementService,
  createPaymentPersistence,
  createRuntimePaymentReconciliation,
  createX402StellarAdapter,
  type FacilitatorSignerProvider
} from "@lumenbazaar/stellar-payments";

import { registerErrorHandling } from "./http/errors.js";
import { registerRateLimitHook } from "./http/rateLimit.js";
import { registerConformanceRoutes } from "./routes/conformance.js";
import { registerDiscoveryRoutes } from "./routes/discovery.js";
import { registerFacilitatorRoutes } from "./routes/facilitator.js";
import { registerMetadataRoutes } from "./routes/metadata.js";
import { registerPaymentSessionRoutes } from "./routes/paymentSessions.js";
import { registerReceiptVerificationRoutes } from "./routes/receiptVerification.js";
import { registerResourceRoutes } from "./routes/resources.js";
import { registerSellerRoutes } from "./routes/sellers.js";
import { registerStreamRoutes } from "./routes/streams.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import {
  ReceiptStatusStreamService,
  type EventStreamTuning
} from "./services/receiptStatusStreams.js";
import { StreamAccessService } from "./services/streamAccess.js";
import { createRuntimeAuditLog, type AuditLogService } from "./services/audit.js";
import { createCatalogPersistence } from "./services/catalogPersistence.js";
import { CatalogService } from "./services/cataloging.js";
import { CatalogValidationService } from "./services/catalogValidation.js";
import { ConformanceRunService, createServiceConformanceRunner } from "./services/conformance.js";
import { DiscoveryService } from "./services/discovery.js";
import { createMetricsService, type MetricsService } from "./services/metrics.js";
import { createOperationalMetricsRefresher } from "./services/operationalMetrics.js";
import { createRuntimeRateLimitService, type RateLimitService } from "./services/rateLimit.js";
import {
  createReadinessService,
  createRuntimeReadinessProbes,
  type PaymentCapabilities,
  type ReadinessService
} from "./services/readiness.js";
import { ResourceService } from "./services/resources.js";
import { SearchService } from "./services/search.js";
import { SellerService } from "./services/sellers.js";
import { WebhookService } from "./services/webhooks.js";
import { WebhookEventService } from "./services/webhookEvents.js";

export type BuildApiAppOptions = {
  config?: AppConfig;
  logger?: boolean;
  paymentSessionService?: PaymentSessionService;
  verificationService?: PaymentVerificationService;
  settlementService?: SettlementService;
  receiptService?: ReceiptService;
  sellerService?: SellerService;
  webhookService?: WebhookService;
  webhookEventService?: WebhookEventService;
  resourceService?: ResourceService;
  catalogValidationService?: CatalogValidationService;
  catalogService?: CatalogService;
  discoveryService?: DiscoveryService;
  searchService?: SearchService;
  conformanceService?: ConformanceRunService;
  auditLogService?: AuditLogService;
  rateLimitService?: RateLimitService;
  metricsService?: MetricsService;
  paymentCapabilities?: PaymentCapabilities;
  readinessService?: ReadinessService;
  signerProvider?: FacilitatorSignerProvider;
  streamAccessService?: StreamAccessService;
  receiptStatusStreamService?: ReceiptStatusStreamService;
  eventStreamTuning?: EventStreamTuning;
};

export function buildApiApp(options: BuildApiAppOptions = {}) {
  const config = options.config ?? loadConfig();
  const app = Fastify({
    genReqId: () => randomUUID(),
    logger: options.logger ?? config.nodeEnv !== "test",
    trustProxy: false
  });
  const paymentPersistence = createPaymentPersistence(config);
  app.addHook("onClose", async () => paymentPersistence.close());
  const paymentReconciliation = createRuntimePaymentReconciliation(config);
  app.addHook("onClose", async () => paymentReconciliation.close());
  const catalogPersistence = createCatalogPersistence(config);
  app.addHook("onClose", async () => catalogPersistence.close());
  const runtimeAdapter =
    options.signerProvider === undefined
      ? undefined
      : createX402StellarAdapter({ config, signerProvider: options.signerProvider });
  const paymentCapabilities = options.paymentCapabilities ?? {
    exact:
      runtimeAdapter !== undefined &&
      listConfiguredNetworks(config).every((network) =>
        network.assets.some((asset) => asset.contractId !== undefined)
      ),
    upto: false
  };
  const readinessService =
    options.readinessService ??
    createReadinessService(
      config,
      paymentCapabilities,
      createRuntimeReadinessProbes(config, options.signerProvider)
    );

  void app.register(cors, {
    origin: config.api.corsAllowedOrigins
  });

  registerErrorHandling(app);

  app.addHook("onRequest", (request, reply, done) => {
    runWithCorrelationId(request.id, () => {
      reply.header("x-request-id", request.id);
      reply.header("x-correlation-id", request.id);
      done();
    });
  });

  const runtimeAuditLog =
    options.auditLogService === undefined ? createRuntimeAuditLog(config) : undefined;
  const auditLogService = options.auditLogService ?? runtimeAuditLog!.service;
  if (runtimeAuditLog !== undefined) {
    app.addHook("onClose", async () => runtimeAuditLog.close());
  }
  const runtimeRateLimit =
    options.rateLimitService === undefined ? createRuntimeRateLimitService(config) : undefined;
  const rateLimitService = options.rateLimitService ?? runtimeRateLimit!.service;
  if (runtimeRateLimit !== undefined) {
    app.addHook("onClose", async () => runtimeRateLimit.close());
  }
  const metricsService = options.metricsService ?? createMetricsService();
  const operationalMetrics = createOperationalMetricsRefresher(config, metricsService);
  app.addHook("onClose", async () => operationalMetrics.close());
  const receiptService =
    options.receiptService ?? new ReceiptService({ receiptStore: paymentPersistence.receiptStore });

  registerRateLimitHook(app, { rateLimitService });
  registerMetadataRoutes(app, {
    config,
    metrics: metricsService,
    readiness: readinessService,
    operationalMetrics
  });
  const verificationService =
    options.verificationService ??
    new PaymentVerificationService(config, {
      auditLogService,
      attemptStore: paymentPersistence.attemptStore,
      ...(runtimeAdapter === undefined ? {} : { adapter: runtimeAdapter })
    });
  const settlementService =
    options.settlementService ??
    new SettlementService(config, {
      auditLogService,
      attemptStore: verificationService.getAttemptStore(),
      settlementStore: paymentPersistence.settlementStore,
      receiptService,
      ...(paymentReconciliation.scheduler === undefined
        ? {}
        : { reconciliationScheduler: paymentReconciliation.scheduler }),
      ...(options.verificationService === undefined &&
      paymentPersistence.statePersistence !== undefined
        ? { statePersistence: paymentPersistence.statePersistence }
        : {}),
      ...(runtimeAdapter === undefined ? {} : { adapter: runtimeAdapter })
    });
  const routeReceiptService = options.receiptService ?? settlementService.getReceiptService();
  const paymentSessionService =
    options.paymentSessionService ?? new PaymentSessionService(config, { auditLogService });
  const sellerService =
    options.sellerService ?? new SellerService(catalogPersistence.sellerStore, auditLogService);
  const resourceService =
    options.resourceService ??
    new ResourceService(
      config,
      sellerService,
      catalogPersistence.resourceStore,
      catalogPersistence.indexingQueue
    );
  const catalogValidationService =
    options.catalogValidationService ?? new CatalogValidationService(config, sellerService);
  const catalogService =
    options.catalogService ??
    new CatalogService(catalogValidationService, resourceService, {
      auditLogService,
      eventStore: catalogPersistence.eventStore,
      indexingQueue: catalogPersistence.indexingQueue,
      metrics: metricsService
    });
  const discoveryService = options.discoveryService ?? new DiscoveryService(resourceService);
  const searchService =
    options.searchService ??
    new SearchService(resourceService, metricsService, catalogPersistence.searchDocumentStore);
  const conformanceService =
    options.conformanceService ??
    new ConformanceRunService(
      createServiceConformanceRunner(
        config,
        verificationService,
        settlementService,
        paymentSessionService
      ),
      undefined,
      {
        exactEnabled: paymentCapabilities.exact,
        uptoEnabled: config.features.uptoScheme && paymentCapabilities.upto
      }
    );

  const streamAccessService =
    options.streamAccessService ??
    new StreamAccessService({ signingSecret: config.eventStreams.signingSecret });
  const receiptStatusStreams =
    options.receiptStatusStreamService ??
    new ReceiptStatusStreamService({
      receiptService: routeReceiptService,
      streamAccess: streamAccessService,
      ...(options.eventStreamTuning ?? {})
    });
  app.addHook("onClose", async () => receiptStatusStreams.close());
  const unsubscribeReceiptStatusChanges =
    paymentPersistence.statePersistence?.subscribeToReceiptStatusChanges((change) =>
      receiptStatusStreams.publish(change)
    );
  if (unsubscribeReceiptStatusChanges !== undefined) {
    app.addHook("onClose", async () => unsubscribeReceiptStatusChanges());
  }

  const webhookEventService = options.webhookEventService ?? new WebhookEventService();

  registerFacilitatorRoutes(app, {
    config,
    verificationService,
    settlementService,
    receiptService: routeReceiptService,
    metrics: metricsService,
    readiness: readinessService,
    receiptStreams: receiptStatusStreams
  });
  registerPaymentSessionRoutes(app, { paymentSessionService });
  registerSellerRoutes(app, { sellerService });
  registerWebhookRoutes(app, { webhookService: options.webhookService });
  registerResourceRoutes(app, { resourceService });
  registerDiscoveryRoutes(app, {
    catalogValidationService,
    catalogService,
    discoveryService,
    searchService
  });
  registerConformanceRoutes(app, {
    conformanceService
  });
  registerStreamRoutes(app, {
    receiptService: routeReceiptService,
    sellerService,
    streamAccess: receiptStatusStreams.streamAccess,
    streams: receiptStatusStreams
  });
  registerReceiptVerificationRoutes(app, {
    receiptService: routeReceiptService,
    attemptStore: verificationService.getAttemptStore(),
    settlementStore: paymentPersistence.settlementStore
  });

  return app;
}
