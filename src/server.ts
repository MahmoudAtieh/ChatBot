import "dotenv/config";
import { createServer } from "node:http";
import { createApp } from "./app.js";
import { OpenAIShoppingAssistant, UnavailableShoppingAssistant } from "./ai/assistant.js";
import { loadConfig } from "./config.js";
import { RuntimeKnowledge } from "./data/runtime-knowledge.js";
import { MetaWhatsAppClient } from "./meta.js";
import { ChatService, WhatsAppMessageProcessor } from "./processor.js";
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
    config.CONVERSATION_HASH_SECRET ?? "local-development-only",
  );
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
    readinessCheck: () => repository.isReady(),
  });
  const server = createServer(app);

  server.listen(config.PORT, () => {
    console.info(`Arabic Sofa assistant listening on port ${config.PORT}.`);
  });

  const shutdown = (): void => {
    server.close(() => {
      void repository.close().finally(() => process.exit(0));
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown startup error";
  console.error(`Startup failed: ${message}`);
  process.exitCode = 1;
});
