import path from "node:path";
import type { Response, ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import { describe, expect, it, vi } from "vitest";
import { OpenAIShoppingAssistant } from "../src/ai/assistant.js";
import { RuntimeKnowledge } from "../src/data/runtime-knowledge.js";
import { ShopifyCatalog } from "../src/shopify.js";
import { ToolDispatcher } from "../src/tools.js";

const dataDirectory = path.resolve(process.cwd(), "Data-Processing");

function fakeResponse(output: Response["output"], outputText: string): Response {
  return { status: "completed", output, output_text: outputText } as unknown as Response;
}

describe("OpenAIShoppingAssistant", () => {
  it("executes a whitelisted tool and returns its result to the next response call", async () => {
    const knowledge = await RuntimeKnowledge.load(dataDirectory);
    const tools = new ToolDispatcher(knowledge, new ShopifyCatalog({ apiVersion: "2026-07" }));
    const responses = [
      fakeResponse(
        [
          {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: "search_products",
            arguments: JSON.stringify({
              query: "majlis",
              product_type: null,
              color: null,
              dimensions: null,
              budget_max: null,
              currency: null,
              limit: 5,
            }),
            status: "completed",
          },
        ],
        "",
      ),
      fakeResponse(
        [],
        JSON.stringify({
          reply: "Which Majlis size do you need?",
          route: "missing_product_information",
          handoff: false,
          fact_source_ids: [],
        }),
      ),
    ];
    const create = vi.fn(async (_parameters: ResponseCreateParamsNonStreaming) => responses.shift()!);
    const assistant = new OpenAIShoppingAssistant({
      apiKey: "test-key",
      model: "test-model",
      knowledge,
      tools,
      client: { responses: { create } },
    });

    const result = await assistant.reply({
      conversationId: "hashed-conversation",
      messages: [{ role: "user", content: "I need a Majlis", createdAt: new Date() }],
    });

    expect(result.route).toBe("missing_product_information");
    expect(create).toHaveBeenCalledTimes(2);
    const secondCall = create.mock.calls[1]?.[0];
    expect(secondCall?.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "function_call_output",
          call_id: "call_1",
          output: expect.stringContaining("Live Shopify catalog is not configured"),
        }),
      ]),
    );
  });

  it("rejects fact source IDs that were not returned by tools", async () => {
    const knowledge = await RuntimeKnowledge.load(dataDirectory);
    const tools = new ToolDispatcher(knowledge, new ShopifyCatalog({ apiVersion: "2026-07" }));
    const create = vi.fn(async () =>
      fakeResponse(
        [],
        JSON.stringify({
          reply: "This costs $10.",
          route: "product_recommendation",
          handoff: false,
          fact_source_ids: ["shopify:invented"],
        }),
      ),
    );
    const assistant = new OpenAIShoppingAssistant({
      apiKey: "test-key",
      model: "test-model",
      knowledge,
      tools,
      client: { responses: { create } },
    });

    await expect(
      assistant.reply({
        conversationId: "hashed-conversation",
        messages: [{ role: "user", content: "How much?", createdAt: new Date() }],
      }),
    ).rejects.toThrow("fact sources");
  });

  it("rejects an ungrounded product answer even when it cites no invented ID", async () => {
    const knowledge = await RuntimeKnowledge.load(dataDirectory);
    const tools = new ToolDispatcher(knowledge, new ShopifyCatalog({ apiVersion: "2026-07" }));
    const create = vi.fn(async () =>
      fakeResponse(
        [],
        JSON.stringify({
          reply: "This sofa is available.",
          route: "product_recommendation",
          handoff: false,
          fact_source_ids: [],
        }),
      ),
    );
    const assistant = new OpenAIShoppingAssistant({
      apiKey: "test-key",
      model: "test-model",
      knowledge,
      tools,
      client: { responses: { create } },
    });

    await expect(
      assistant.reply({
        conversationId: "hashed-conversation",
        messages: [{ role: "user", content: "Is it available?", createdAt: new Date() }],
      }),
    ).rejects.toThrow("verified shopify:");
  });

  it("does not execute calls from an incomplete response", async () => {
    const knowledge = await RuntimeKnowledge.load(dataDirectory);
    const tools = new ToolDispatcher(knowledge, new ShopifyCatalog({ apiVersion: "2026-07" }));
    const execute = vi.spyOn(tools, "execute");
    const create = vi.fn(async () =>
      ({
        status: "incomplete",
        output: [
          {
            type: "function_call",
            call_id: "call_unsafe",
            name: "search_products",
            arguments: "{}",
            status: "incomplete",
          },
        ],
        output_text: "",
      }) as unknown as Response,
    );
    const assistant = new OpenAIShoppingAssistant({
      apiKey: "test-key",
      model: "test-model",
      knowledge,
      tools,
      client: { responses: { create } },
    });

    await expect(
      assistant.reply({
        conversationId: "hashed-conversation",
        messages: [{ role: "user", content: "Find a sofa", createdAt: new Date() }],
      }),
    ).rejects.toThrow("incomplete");
    expect(execute).not.toHaveBeenCalled();
  });
});
