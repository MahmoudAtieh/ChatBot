import { createHash } from "node:crypto";
import express, { type ErrorRequestHandler, type Express } from "express";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { ChatService, WhatsAppMessageProcessor } from "./processor.js";
import { registerMetaWebhook, type MetaWhatsAppOptions } from "./meta.js";

export interface AppDependencies {
  config: AppConfig;
  chatService: ChatService;
  whatsappProcessor: WhatsAppMessageProcessor;
  metaOptions: MetaWhatsAppOptions;
  integrationStatus: {
    openai: boolean;
    shopify: boolean;
    meta: boolean;
    postgres: boolean;
  };
  readinessCheck(): Promise<boolean>;
}

const testChatSchema = z.object({
  conversation_id: z.string().trim().min(1).max(128),
  message: z.string().trim().min(1).max(4_000),
});

export function createApp(dependencies: AppDependencies): Express {
  const app = express();
  app.disable("x-powered-by");

  app.get("/health", (_request, response) => {
    response.json({
      status: "ok",
      service: "arabic-sofa-whatsapp-assistant",
      integrations: dependencies.integrationStatus,
    });
  });

  app.get("/ready", async (_request, response) => {
    const ready = await dependencies.readinessCheck();
    response.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not_ready" });
  });

  registerMetaWebhook(
    app,
    dependencies.metaOptions,
    dependencies.whatsappProcessor,
  );

  app.use(express.json({ limit: "1mb" }));

  if (dependencies.config.ENABLE_TEST_CHAT && dependencies.config.NODE_ENV !== "production") {
    app.post("/chat/test", async (request, response, next) => {
      try {
        const input = testChatSchema.parse(request.body);
        const conversationId = createHash("sha256")
          .update(`local-test:${input.conversation_id}`)
          .digest("hex");
        const result = await dependencies.chatService.respond(conversationId, input.message);
        response.json(result);
      } catch (error) {
        next(error);
      }
    });
  }

  app.use((_request, response) => response.sendStatus(404));

  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    if (error instanceof z.ZodError) {
      response.status(400).json({ error: "invalid_request", details: error.issues });
      return;
    }
    if (error instanceof SyntaxError && "body" in error) {
      response.status(400).json({ error: "invalid_json" });
      return;
    }
    response.status(500).json({ error: "internal_error" });
  };
  app.use(errorHandler);
  return app;
}
