import OpenAI from "openai";
import { toResponseInputItems } from "openai/lib/responses/ResponseInputItems";
import type {
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseFunctionToolCall,
  ResponseInput,
} from "openai/resources/responses/responses";
import { z } from "zod";
import {
  assistantRoutes,
  type AssistantResult,
  type HandoffDetails,
  type ReplyContext,
  type ShoppingAssistant,
} from "../domain.js";
import type { RuntimeKnowledge } from "../data/runtime-knowledge.js";
import { assistantTools, type ToolDispatcher } from "../tools.js";

const finalResultSchema = z
  .object({
    reply: z.string().trim().min(1).max(2_000),
    route: z.enum(assistantRoutes),
    handoff: z.boolean(),
    fact_source_ids: z.array(z.string().min(1).max(300)).max(20),
  })
  .strict();

const finalResponseFormat = {
  type: "json_schema",
  name: "arabic_sofa_reply",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      reply: { type: "string" },
      route: { type: "string", enum: assistantRoutes },
      handoff: { type: "boolean" },
      fact_source_ids: { type: "array", items: { type: "string" } },
    },
    required: ["reply", "route", "handoff", "fact_source_ids"],
  },
} as const;

interface ResponsesClient {
  responses: {
    create(parameters: ResponseCreateParamsNonStreaming): Promise<Response>;
  };
}

export interface OpenAIShoppingAssistantOptions {
  apiKey: string;
  model: string;
  promptCacheKey?: string;
  knowledge: RuntimeKnowledge;
  tools: ToolDispatcher;
  client?: ResponsesClient;
}

export class OpenAIShoppingAssistant implements ShoppingAssistant {
  private readonly client: ResponsesClient;

  constructor(private readonly options: OpenAIShoppingAssistantOptions) {
    this.client =
      options.client ??
      new OpenAI({ apiKey: options.apiKey, timeout: 20_000, maxRetries: 1 });
  }

  async reply(context: ReplyContext): Promise<AssistantResult> {
    const input: ResponseInput = context.messages.map((message) => ({
      role: message.role,
      content: message.content,
    }));
    const validFactSources = new Set<string>();
    let preparedHandoff: HandoffDetails | null = null;

    for (let toolRound = 0; toolRound <= 2; toolRound += 1) {
      const parameters: ResponseCreateParamsNonStreaming = {
        model: this.options.model,
        instructions: this.options.knowledge.stablePrompt,
        input,
        tools: [...assistantTools],
        tool_choice: "auto",
        parallel_tool_calls: true,
        max_output_tokens: 1_200,
        store: false,
        include: ["reasoning.encrypted_content"],
        safety_identifier: context.conversationId,
        text: { format: finalResponseFormat },
        ...(this.options.promptCacheKey
          ? { prompt_cache_key: this.options.promptCacheKey }
          : {}),
      };
      const response = await this.client.responses.create(parameters);
      if (response.status !== "completed") {
        throw new Error(`Assistant response ended with status ${response.status}.`);
      }
      const calls = response.output.filter(isFunctionCall);
      if (calls.some((call) => call.status && call.status !== "completed")) {
        throw new Error("Assistant returned an incomplete function call.");
      }
      if (calls.length > 4) {
        throw new Error("Assistant exceeded the per-round tool-call limit.");
      }

      if (calls.length === 0) {
        return validateFinalResult(response.output_text, validFactSources, preparedHandoff);
      }

      if (toolRound === 2) {
        throw new Error("Assistant exceeded the two-round tool limit.");
      }

      const executions = await Promise.all(
        calls.map(async (call) => ({
          call,
          result: await this.options.tools.execute(call.name, call.arguments),
        })),
      );

      input.push(...toResponseInputItems(response.output));
      for (const { call, result } of executions) {
        for (const source of result.factSourceIds) validFactSources.add(source);
        if (result.handoffDetails) preparedHandoff = result.handoffDetails;
        input.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: result.output,
        });
      }
    }

    throw new Error("Assistant did not produce a final response.");
  }
}

export class UnavailableShoppingAssistant implements ShoppingAssistant {
  async reply(context: ReplyContext): Promise<AssistantResult> {
    const lastMessage = context.messages.at(-1)?.content ?? "";
    const isArabic = /[\u0600-\u06FF]/.test(lastMessage);
    return {
      reply: isArabic
        ? "حالياً ما بقدر أتحقق من التفاصيل بدقة. خلّيني أحوّل طلبك للفريق حتى يساعدك بالمعلومة الصحيحة."
        : "I can’t verify that accurately right now. I’ll pass your request to the team so they can help with the correct information.",
      route: "human_handoff",
      handoff: true,
      handoffDetails: {
        reason: "assistant_unavailable",
        summary: `The customer request requires a team reply: ${lastMessage.slice(0, 500)}`,
      },
      factSourceIds: [],
    };
  }
}

function isFunctionCall(item: Response["output"][number]): item is ResponseFunctionToolCall {
  return item.type === "function_call";
}

function validateFinalResult(
  text: string,
  validFactSources: Set<string>,
  preparedHandoff: HandoffDetails | null,
): AssistantResult {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Assistant returned invalid structured output.");
  }

  const parsed = finalResultSchema.parse(parsedJson);
  const unverifiedSources = parsed.fact_source_ids.filter((source) => !validFactSources.has(source));
  if (unverifiedSources.length > 0) {
    throw new Error("Assistant cited fact sources that were not returned by a tool.");
  }
  if (parsed.handoff && !preparedHandoff) {
    throw new Error("Assistant requested a handoff without preparing one.");
  }
  validateGroundingContract(parsed.route, parsed.handoff, parsed.fact_source_ids);

  return {
    reply: parsed.reply,
    route: parsed.route,
    handoff: parsed.handoff,
    handoffDetails: parsed.handoff ? preparedHandoff : null,
    factSourceIds: parsed.fact_source_ids,
  };
}

function validateGroundingContract(
  route: AssistantResult["route"],
  handoff: boolean,
  sources: string[],
): void {
  if (route === "human_handoff" && !handoff) {
    throw new Error("Human handoff route must set handoff=true.");
  }
  if ((route === "order_status" || route === "cancel_or_change_order") && !handoff) {
    throw new Error("Order actions require verified order support or a human handoff.");
  }
  if (handoff) return;

  const requiredPrefixByRoute: Partial<Record<AssistantResult["route"], string>> = {
    product_recommendation: "shopify:",
    static_faq: "faq:",
    shipping_question: "policy:shipping:",
    return_refund_or_exchange: "policy:refund_and_return:",
  };
  const requiredPrefix = requiredPrefixByRoute[route];
  if (requiredPrefix && !sources.some((source) => source.startsWith(requiredPrefix))) {
    throw new Error(`Route ${route} requires a verified ${requiredPrefix} fact source.`);
  }
}
