import path from "node:path";
import { z } from "zod";

const optionalText = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).optional(),
);

const booleanFromEnvironment = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  return value.toLowerCase() === "true";
}, z.boolean());

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    DATA_PROCESSING_DIR: z.string().trim().min(1).default("./Data-Processing"),
    OPENAI_API_KEY: optionalText,
    OPENAI_MODEL: optionalText,
    OPENAI_PROMPT_CACHE_KEY: optionalText.default("arabic-sofa-assistant-v1"),
    SHOPIFY_STORE_DOMAIN: optionalText,
    SHOPIFY_ADMIN_ACCESS_TOKEN: optionalText,
    SHOPIFY_API_VERSION: optionalText.default("2026-07"),
    META_ACCESS_TOKEN: optionalText,
    META_PHONE_NUMBER_ID: optionalText,
    META_WABA_ID: optionalText,
    META_APP_SECRET: optionalText,
    META_WEBHOOK_VERIFY_TOKEN: optionalText,
    META_GRAPH_API_VERSION: optionalText,
    DATABASE_URL: optionalText,
    CONVERSATION_HASH_SECRET: optionalText,
    ENABLE_TEST_CHAT: booleanFromEnvironment.default(true),
  })
  .superRefine((environment, context) => {
    if (environment.NODE_ENV !== "production") return;

    const requiredInProduction = [
      "OPENAI_API_KEY",
      "OPENAI_MODEL",
      "SHOPIFY_STORE_DOMAIN",
      "SHOPIFY_ADMIN_ACCESS_TOKEN",
      "META_ACCESS_TOKEN",
      "META_PHONE_NUMBER_ID",
      "META_APP_SECRET",
      "META_WEBHOOK_VERIFY_TOKEN",
      "META_GRAPH_API_VERSION",
      "DATABASE_URL",
      "CONVERSATION_HASH_SECRET",
    ] as const;

    for (const key of requiredInProduction) {
      if (!environment[key]) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: `${key} is required in production`,
        });
      }
    }

    if (
      environment.CONVERSATION_HASH_SECRET &&
      environment.CONVERSATION_HASH_SECRET.length < 32
    ) {
      context.addIssue({
        code: "custom",
        path: ["CONVERSATION_HASH_SECRET"],
        message: "CONVERSATION_HASH_SECRET must be at least 32 characters in production",
      });
    }

    if (environment.ENABLE_TEST_CHAT) {
      context.addIssue({
        code: "custom",
        path: ["ENABLE_TEST_CHAT"],
        message: "ENABLE_TEST_CHAT must be false in production",
      });
    }
  });

export type Environment = z.infer<typeof environmentSchema>;

export interface AppConfig extends Environment {
  dataProcessingDirectory: string;
}

export function loadConfig(
  source: NodeJS.ProcessEnv = process.env,
  workingDirectory = process.cwd(),
): AppConfig {
  const environment = environmentSchema.parse(source);
  return {
    ...environment,
    dataProcessingDirectory: path.resolve(workingDirectory, environment.DATA_PROCESSING_DIR),
  };
}
