import { z } from "zod";
import type { Language } from "./domain.js";
import type { HandoffDetails } from "./domain.js";
import type { RuntimeKnowledge } from "./data/runtime-knowledge.js";
import type { ShopifyCatalog } from "./shopify.js";

const searchProductsArguments = z
  .object({
    query: z.string().trim().min(1).max(120),
    product_type: z.string().trim().max(80).nullable(),
    color: z.string().trim().max(50).nullable(),
    dimensions: z.string().trim().max(80).nullable(),
    budget_max: z.number().positive().max(1_000_000).nullable(),
    currency: z.string().trim().length(3).nullable(),
    limit: z.number().int().min(1).max(10),
  })
  .strict();

const lookupFaqArguments = z
  .object({
    question: z.string().trim().min(1).max(500),
    language: z.enum(["ar", "en"]),
  })
  .strict();

const getPolicyArguments = z
  .object({
    policy: z.enum(["shipping", "refund_and_return"]),
    language: z.enum(["ar", "en"]),
  })
  .strict();

const prepareHandoffArguments = z
  .object({
    reason: z.string().trim().min(1).max(300),
    summary: z.string().trim().min(1).max(1_000),
    language: z.enum(["ar", "en"]),
  })
  .strict();

export const assistantTools = [
  {
    type: "function",
    name: "search_products",
    description:
      "Search the live Shopify catalog for products, prices, variants, and availability. Call before stating any product fact.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          minLength: 1,
          maxLength: 120,
          description: "Short catalog keywords only.",
        },
        product_type: { type: ["string", "null"], maxLength: 80 },
        color: { type: ["string", "null"], maxLength: 50 },
        dimensions: { type: ["string", "null"], maxLength: 80 },
        budget_max: { type: ["number", "null"], exclusiveMinimum: 0, maximum: 1_000_000 },
        currency: {
          type: ["string", "null"],
          minLength: 3,
          maxLength: 3,
          description: "ISO 4217 code or null.",
        },
        limit: { type: "integer", minimum: 1, maximum: 10 },
      },
      required: [
        "query",
        "product_type",
        "color",
        "dimensions",
        "budget_max",
        "currency",
        "limit",
      ],
    },
  },
  {
    type: "function",
    name: "lookup_faq",
    description:
      "Look up a stable non-product FAQ. If unavailable, do not infer an answer from historical conversations.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        question: { type: "string", minLength: 1, maxLength: 500 },
        language: { type: "string", enum: ["ar", "en"] },
      },
      required: ["question", "language"],
    },
  },
  {
    type: "function",
    name: "get_policy",
    description:
      "Read an owner-approved shipping or refund/return policy. An unavailable result requires team confirmation.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        policy: { type: "string", enum: ["shipping", "refund_and_return"] },
        language: { type: "string", enum: ["ar", "en"] },
      },
      required: ["policy", "language"],
    },
  },
  {
    type: "function",
    name: "prepare_handoff",
    description:
      "Prepare a concise human handoff for custom, bulk, complaint, order-action, uncertain, or explicitly requested human cases. This does not claim that a human has replied.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        reason: { type: "string", minLength: 1, maxLength: 300 },
        summary: { type: "string", minLength: 1, maxLength: 1_000 },
        language: { type: "string", enum: ["ar", "en"] },
      },
      required: ["reason", "summary", "language"],
    },
  },
] as const;

export interface ToolExecution {
  output: string;
  factSourceIds: string[];
  handoffDetails: HandoffDetails | null;
}

export class ToolDispatcher {
  constructor(
    private readonly knowledge: RuntimeKnowledge,
    private readonly shopify: ShopifyCatalog,
  ) {}

  async execute(name: string, rawArguments: string): Promise<ToolExecution> {
    let arguments_: unknown;
    try {
      arguments_ = JSON.parse(rawArguments) as unknown;
    } catch {
      return toolError("Tool arguments were not valid JSON.");
    }

    try {
      switch (name) {
        case "search_products": {
          const input = searchProductsArguments.parse(arguments_);
          const result = await this.shopify.searchProducts({
            query: input.query,
            productType: input.product_type,
            color: input.color,
            dimensions: input.dimensions,
            budgetMax: input.budget_max,
            currency: input.currency,
            limit: input.limit,
          });
          return {
            output: JSON.stringify(result),
            factSourceIds: result.factSourceIds,
            handoffDetails: null,
          };
        }
        case "lookup_faq": {
          const input = lookupFaqArguments.parse(arguments_);
          const result = this.knowledge.lookupFaq(input.question, input.language);
          return {
            output: JSON.stringify(result),
            factSourceIds: result.entry ? [result.entry.factSourceId] : [],
            handoffDetails: null,
          };
        }
        case "get_policy": {
          const input = getPolicyArguments.parse(arguments_);
          const result = this.knowledge.getPolicy(input.policy, input.language);
          return {
            output: JSON.stringify(result),
            factSourceIds: result.policy ? [result.policy.factSourceId] : [],
            handoffDetails: null,
          };
        }
        case "prepare_handoff": {
          const input = prepareHandoffArguments.parse(arguments_);
          return {
            output: JSON.stringify({
              prepared: true,
              reason: input.reason,
              summary: input.summary,
              language: input.language satisfies Language,
              note: "Prepared for the backend; do not claim a human has already responded.",
            }),
            factSourceIds: [],
            handoffDetails: { reason: input.reason, summary: input.summary },
          };
        }
        default:
          return toolError("Unknown tool. The request was not executed.");
      }
    } catch (error) {
      return toolError(
        error instanceof z.ZodError
          ? "Invalid tool arguments."
          : "The requested source is temporarily unavailable.",
      );
    }
  }
}

function toolError(message: string): ToolExecution {
  return {
    output: JSON.stringify({ available: false, error: message }),
    factSourceIds: [],
    handoffDetails: null,
  };
}
