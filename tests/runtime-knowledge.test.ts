import path from "node:path";
import { describe, expect, it } from "vitest";
import { RuntimeKnowledge } from "../src/data/runtime-knowledge.js";

const dataDirectory = path.resolve(process.cwd(), "Data-Processing");

describe("RuntimeKnowledge", () => {
  it("loads only the audited behavior package into the stable prompt", async () => {
    const knowledge = await RuntimeKnowledge.load(dataDirectory);

    expect(knowledge.style.runtime_eligible).toBe(true);
    expect(knowledge.playbooks.playbooks).toHaveLength(11);
    expect(knowledge.stablePrompt).toContain("Speak as the Arabic Sofa team");
    expect(knowledge.stablePrompt).toContain("product_recommendation");
    expect(knowledge.stablePrompt).not.toContain("business_text_messages_reviewed");
    expect(knowledge.stablePrompt).not.toContain("evaluation_cases.jsonl");
    expect(knowledge.stablePrompt).not.toContain("extraction_report.json");
    expect(knowledge.stablePrompt).not.toContain("Free express shipping");
    expect(knowledge.stablePrompt).not.toContain("return_window_days_from_delivery");
    expect(knowledge.stablePrompt).not.toContain("Measure each wall section");
  });

  it("exposes owner-approved FAQ and policy facts through lookups", async () => {
    const knowledge = await RuntimeKnowledge.load(dataDirectory);

    expect(knowledge.lookupFaq("كيف أقيس الغرفة؟", "ar")).toMatchObject({
      available: true,
      entry: { id: "how_to_measure_room", factSourceId: "faq:how_to_measure_room" },
    });
    expect(knowledge.getPolicy("shipping", "ar")).toMatchObject({
      available: true,
      policy: { type: "shipping" },
    });
    expect(knowledge.getPolicy("refund_and_return", "en")).toMatchObject({
      available: true,
      policy: { type: "refund_and_return" },
    });
  });

  it("exposes the exact approved style responses for deterministic fast paths", async () => {
    const knowledge = await RuntimeKnowledge.load(dataDirectory);

    expect(knowledge.getPattern("greeting", "ar")).toContain("Arabic Sofa");
    expect(knowledge.getPattern("warm_close", "en")).toContain("Take your time");
  });
});
