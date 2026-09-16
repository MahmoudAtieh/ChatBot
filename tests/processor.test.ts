import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ShoppingAssistant } from "../src/domain.js";
import { RuntimeKnowledge } from "../src/data/runtime-knowledge.js";
import {
  ChatService,
  containsSensitiveData,
  redactSensitiveData,
} from "../src/processor.js";
import { MemoryConversationRepository } from "../src/repository.js";

const dataDirectory = path.resolve(process.cwd(), "Data-Processing");

async function createDataDirectoryWithOneApprovedFaq(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "arabic-sofa-data-"));
  const editableDirectory = path.join(directory, "editable_knowledge");
  await mkdir(editableDirectory);
  await Promise.all([
    copyFile(path.join(dataDirectory, "style_reference.json"), path.join(directory, "style_reference.json")),
    copyFile(
      path.join(dataDirectory, "playbook_candidates.json"),
      path.join(directory, "playbook_candidates.json"),
    ),
    copyFile(
      path.join(dataDirectory, "editable_knowledge", "refund_policy.json"),
      path.join(editableDirectory, "refund_policy.json"),
    ),
    copyFile(
      path.join(dataDirectory, "editable_knowledge", "shipping_policy.json"),
      path.join(editableDirectory, "shipping_policy.json"),
    ),
  ]);

  const sourceFaq = path.join(dataDirectory, "editable_knowledge", "faq.json");
  const targetFaq = path.join(editableDirectory, "faq.json");
  const faq = JSON.parse(await readFile(sourceFaq, "utf8")) as {
    review_status: string;
    runtime_eligible: boolean;
    entries: Array<{ status: string; runtime_eligible: boolean }>;
  };
  faq.review_status = "approved";
  faq.runtime_eligible = true;
  faq.entries[0]!.status = "approved";
  faq.entries[0]!.runtime_eligible = true;
  await writeFile(targetFaq, JSON.stringify(faq), "utf8");
  return directory;
}

describe("ChatService", () => {
  it("answers exact greetings without an LLM call", async () => {
    const knowledge = await RuntimeKnowledge.load(dataDirectory);
    const repository = new MemoryConversationRepository();
    const assistant: ShoppingAssistant = { reply: vi.fn() };
    const service = new ChatService(knowledge, assistant, repository);

    const result = await service.respond("conversation-1", "السلام عليكم");

    expect(result.route).toBe("greeting");
    expect(result.reply).toContain("Arabic Sofa");
    expect(assistant.reply).not.toHaveBeenCalled();
  });

  it("answers an exact owner-approved FAQ without an LLM call", async () => {
    const approvedDirectory = await createDataDirectoryWithOneApprovedFaq();
    try {
      const knowledge = await RuntimeKnowledge.load(approvedDirectory);
      const repository = new MemoryConversationRepository();
      const assistant: ShoppingAssistant = { reply: vi.fn() };
      const service = new ChatService(knowledge, assistant, repository);

      const result = await service.respond("conversation-faq", "شو هو المجلس أو الفرش الأرضي؟");

      expect(result.route).toBe("static_faq");
      expect(result.factSourceIds).toEqual(["faq:what_is_a_majlis"]);
      expect(result.reply).toContain("أسلوب جلوس عربي منخفض");
      expect(assistant.reply).not.toHaveBeenCalled();
    } finally {
      await rm(approvedDirectory, { recursive: true, force: true });
    }
  });

  it("does not store or send apparent payment credentials to the model", async () => {
    const knowledge = await RuntimeKnowledge.load(dataDirectory);
    const repository = new MemoryConversationRepository();
    const assistant: ShoppingAssistant = { reply: vi.fn() };
    const service = new ChatService(knowledge, assistant, repository);

    const result = await service.respond(
      "conversation-2",
      "card 4242 4242 4242 4242 and CVV 123",
    );
    const messages = await repository.getRecentMessages("conversation-2", 10);

    expect(result.handoff).toBe(true);
    expect(assistant.reply).not.toHaveBeenCalled();
    expect(messages[0]?.content).toContain("[payment number removed]");
    expect(JSON.stringify(messages)).not.toContain("4242");
  });

  it("serializes simultaneous messages from the same conversation", async () => {
    const knowledge = await RuntimeKnowledge.load(dataDirectory);
    const repository = new MemoryConversationRepository();
    let active = 0;
    let maximumActive = 0;
    const assistant: ShoppingAssistant = {
      async reply() {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return {
          reply: "checked",
          route: "missing_product_information",
          handoff: false,
          handoffDetails: null,
          factSourceIds: [],
        };
      },
    };
    const service = new ChatService(knowledge, assistant, repository);

    await Promise.all([
      service.respond("conversation-3", "first request"),
      service.respond("conversation-3", "second request"),
    ]);

    expect(maximumActive).toBe(1);
  });

  it("keeps media references in the structured handoff record", async () => {
    const knowledge = await RuntimeKnowledge.load(dataDirectory);
    const repository = new MemoryConversationRepository();
    const assistant: ShoppingAssistant = {
      async reply() {
        return {
          reply: "The team needs to review this.",
          route: "custom_order",
          handoff: true,
          handoffDetails: { reason: "custom_review", summary: "Review the requested design." },
          factSourceIds: [],
        };
      },
    };
    const service = new ChatService(knowledge, assistant, repository);

    await service.respond("conversation-media", "🖼️ Reference design", "media-123");

    expect(repository.handoffs[0]?.details.summary).toContain("media-123");
  });

  it("reuses persisted WhatsApp results without duplicating history or handoffs", async () => {
    const knowledge = await RuntimeKnowledge.load(dataDirectory);
    const repository = new MemoryConversationRepository();
    const assistant: ShoppingAssistant = {
      reply: vi.fn(async () => ({
        reply: "The team will review this request.",
        route: "custom_order" as const,
        handoff: true,
        handoffDetails: { reason: "custom_review", summary: "Review this request." },
        factSourceIds: [],
      })),
    };
    const service = new ChatService(knowledge, assistant, repository);

    const first = await service.respond(
      "conversation-idempotent",
      "Please make a completely custom design",
      undefined,
      "wamid.same",
    );
    const recovered = await service.respond(
      "conversation-idempotent",
      "Please make a completely custom design",
      undefined,
      "wamid.same",
    );
    const messages = await repository.getRecentMessages("conversation-idempotent", 10);

    expect(recovered.reply).toBe(first.reply);
    expect(assistant.reply).toHaveBeenCalledOnce();
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(repository.handoffs).toHaveLength(1);
  });
});

describe("sensitive-data detection", () => {
  it("detects long card-like numbers and OTPs with context", () => {
    expect(containsSensitiveData("4111 1111 1111 1111")).toBe(true);
    expect(containsSensitiveData("card 4242.4242.4242.4242")).toBe(true);
    expect(containsSensitiveData("رقم البطاقة ٤٢٤٢ ٤٢٤٢ ٤٢٤٢ ٤٢٤٢")).toBe(true);
    expect(containsSensitiveData("OTP is 123456")).toBe(true);
    expect(containsSensitiveData("my budget is 1500")).toBe(false);
    expect(containsSensitiveData("tracking number 123456789012345")).toBe(false);
  });

  it("redacts secrets while preserving useful request context", () => {
    const result = redactSensitiveData("My card 4242-4242-4242-4242 was declined");
    expect(result.detected).toBe(true);
    expect(result.redacted).toBe("My card [payment number removed] was declined");
  });
});
