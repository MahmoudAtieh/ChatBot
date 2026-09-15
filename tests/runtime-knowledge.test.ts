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
  });

  it("fails closed while FAQ and policies await owner approval", async () => {
    const knowledge = await RuntimeKnowledge.load(dataDirectory);

    expect(knowledge.lookupFaq("كيف أقيس الغرفة؟", "ar")).toMatchObject({ available: false });
    expect(knowledge.getPolicy("shipping", "ar")).toMatchObject({ available: false });
    expect(knowledge.getPolicy("refund_and_return", "en")).toMatchObject({ available: false });
  });

  it("exposes the exact approved style responses for deterministic fast paths", async () => {
    const knowledge = await RuntimeKnowledge.load(dataDirectory);

    expect(knowledge.getPattern("greeting", "ar")).toContain("Arabic Sofa");
    expect(knowledge.getPattern("warm_close", "en")).toContain("Take your time");
  });
});
