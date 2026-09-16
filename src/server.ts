import "dotenv/config";
import { createServer } from "node:http";
import { createApp } from "./app.js";
import { OpenAIShoppingAssistant, UnavailableShoppingAssistant } from "./ai/assistant.js";
import { loadConfig } from "./config.js";
import { RuntimeKnowledge } from "./data/runtime-knowledge.js";
import { InboundMessageWorker } from "./inbound-worker.js";
import { MetaWhatsAppClient } from "./meta.js";
import { ChatService, WhatsAppMessageProcessor } from "./processor.js";
import { QueuePayloadCipher } from "./queue-payload-cipher.js";
import {
  MemoryConversationRepository,
  PostgresConversationRepository,
} from "./repository.js";
import { ShopifyCatalog } from "./shopify.js";
import { ToolDispatcher } from "./tools.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const knowledge = await RuntimeKnowledge.load(config.dataProcessingDirectory);
  const repository = config.DATABASE_URL
    ? new PostgresConversationRepository(config.DATABASE_URL)
    : new MemoryConversationRepository();
  const shopify = new ShopifyCatalog({
    ...(config.SHOPIFY_STORE_DOMAIN ? { storeDomain: config.SHOPIFY_STORE_DOMAIN } : {}),
    ...(config.SHOPIFY_ADMIN_ACCESS_TOKEN
      ? { accessToken: config.SHOPIFY_ADMIN_ACCESS_TOKEN }
      : {}),
    apiVersion: config.SHOPIFY_API_VERSION,
    storefrontDomain: "arabicsofa.com",
  });
  const tools = new ToolDispatcher(knowledge, shopify);
  const assistant =
    config.OPENAI_API_KEY && config.OPENAI_MODEL
      ? new OpenAIShoppingAssistant({
          apiKey: config.OPENAI_API_KEY,
          model: config.OPENAI_MODEL,
          ...(config.OPENAI_PROMPT_CACHE_KEY
            ? { promptCacheKey: config.OPENAI_PROMPT_CACHE_KEY }
            : {}),
          knowledge,
          tools,
        })
      : new UnavailableShoppingAssistant();
  const chatService = new ChatService(knowledge, assistant, repository);
  const payloadCipher = createQueuePayloadCipher(
    config.QUEUE_ENCRYPTION_KEYS,
    config.QUEUE_ENCRYPTION_ACTIVE_KEY_ID,
  );
  const metaOptions = {
    ...(config.META_ACCESS_TOKEN ? { accessToken: config.META_ACCESS_TOKEN } : {}),
    ...(config.META_PHONE_NUMBER_ID ? { phoneNumberId: config.META_PHONE_NUMBER_ID } : {}),
    ...(config.META_APP_SECRET ? { appSecret: config.META_APP_SECRET } : {}),
    ...(config.META_WEBHOOK_VERIFY_TOKEN
      ? { webhookVerifyToken: config.META_WEBHOOK_VERIFY_TOKEN }
      : {}),
    ...(config.META_GRAPH_API_VERSION
      ? { graphApiVersion: config.META_GRAPH_API_VERSION }
      : {}),
  };
  const meta = new MetaWhatsAppClient(metaOptions);
  const whatsappProcessor = new WhatsAppMessageProcessor(
    chatService,
    meta,
    repository,
    payloadCipher,
    config.CONVERSATION_HASH_SECRET ?? "local-development-only",
    () => new Date(),
    config.WORKER_LEASE_MS,
  );
  const worker = new InboundMessageWorker(repository, whatsappProcessor, {
    pollIntervalMs: config.WORKER_POLL_INTERVAL_MS,
    batchSize: config.WORKER_BATCH_SIZE,
    leaseMs: config.WORKER_LEASE_MS,
    maxAttempts: config.WORKER_MAX_ATTEMPTS,
    retryBaseMs: config.WORKER_RETRY_BASE_MS,
    retryMaxMs: config.WORKER_RETRY_MAX_MS,
  });
  const app = createApp({
    config,
    chatService,
    whatsappProcessor,
    metaOptions,
    integrationStatus: {
      openai: Boolean(config.OPENAI_API_KEY && config.OPENAI_MODEL),
      shopify: shopify.configured,
      meta: meta.configured && Boolean(config.META_APP_SECRET && config.META_WEBHOOK_VERIFY_TOKEN),
      postgres: Boolean(config.DATABASE_URL),
    },
    readinessCheck: async () => worker.isRunning && (await repository.isReady()),
  });
  const server = createServer(app);

  worker.start();
  server.listen(config.PORT, () => {
    console.info(`Arabic Sofa assistant listening on port ${config.PORT}.`);
  });

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    const httpStopped = new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    void Promise.all([httpStopped, worker.stop()])
      .then(() => repository.close())
      .then(() => process.exit(0))
      .catch(() => {
        console.error("Graceful shutdown failed.");
        process.exit(1);
      });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function createQueuePayloadCipher(
  serializedKeys: string | undefined,
  activeKeyId: string | undefined,
): QueuePayloadCipher {
  if (serializedKeys && activeKeyId) {
    return QueuePayloadCipher.fromEnvironment(serializedKeys, activeKeyId);
  }
  if (serializedKeys || activeKeyId) {
    throw new Error(
      "QUEUE_ENCRYPTION_KEYS and QUEUE_ENCRYPTION_ACTIVE_KEY_ID must be configured together.",
    );
  }
  return QueuePayloadCipher.ephemeral();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown startup error";
  console.error(`Startup failed: ${message}`);
  process.exitCode = 1;
});
