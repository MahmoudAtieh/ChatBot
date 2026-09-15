import { createHmac } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import {
  extractWhatsAppMessages,
  registerMetaWebhook,
  verifyMetaSignature,
} from "../src/meta.js";
import type { WhatsAppMessageProcessor } from "../src/processor.js";

const secret = "test-app-secret";

function signature(body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function webhookBody(messageBody = "Hello") {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "phone-1" },
              messages: [
                {
                  id: "wamid.1",
                  from: "15551234567",
                  timestamp: "1710000000",
                  type: "text",
                  text: { body: messageBody },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe("Meta signature verification", () => {
  it("accepts a valid signature and rejects tampering or malformed headers", () => {
    const body = Buffer.from('{"hello":"world"}');
    const valid = signature(body.toString("utf8"));

    expect(verifyMetaSignature(body, valid, secret)).toBe(true);
    expect(verifyMetaSignature(Buffer.from('{"hello":"tampered"}'), valid, secret)).toBe(false);
    expect(verifyMetaSignature(body, undefined, secret)).toBe(false);
    expect(verifyMetaSignature(body, "sha256=xyz", secret)).toBe(false);
  });
});

describe("Meta payload extraction", () => {
  it("extracts text across entries and ignores status-only events", () => {
    const payload = webhookBody("Need a sofa");
    payload.entry.push({
      changes: [
        {
          field: "messages",
          value: {
            metadata: { phone_number_id: "phone-1" },
            messages: [
              {
                id: "wamid.2",
                from: "15557654321",
                timestamp: "1710000001",
                type: "text",
                text: { body: "Another request" },
              },
            ],
          },
        },
      ],
    });
    payload.entry.push({
      changes: [
        {
          field: "messages",
          value: {
            metadata: { phone_number_id: "phone-1" },
            statuses: [{ id: "sent-id", status: "delivered" }],
          },
        },
      ],
    } as never);

    const messages = extractWhatsAppMessages(payload, "phone-1");

    expect(messages.map((message) => message.id)).toEqual(["wamid.1", "wamid.2"]);
    expect(extractWhatsAppMessages(payload, "different-phone")).toEqual([]);
  });

  it("preserves an image media ID without pretending the image was inspected", () => {
    const payload = webhookBody();
    payload.entry[0]!.changes[0]!.value.messages = [
      {
        id: "wamid.image",
        from: "15551234567",
        timestamp: "1710000002",
        type: "image",
        text: { body: "" },
        image: { id: "media-123", caption: "Reference design" },
      } as never,
    ];

    expect(extractWhatsAppMessages(payload, "phone-1")).toEqual([
      expect.objectContaining({
        id: "wamid.image",
        text: "🖼️ Reference design",
        mediaId: "media-123",
      }),
    ]);
  });
});

describe("Meta webhook routes", () => {
  function makeApp(processor: Pick<WhatsAppMessageProcessor, "claim" | "processClaimed">) {
    const app = express();
    registerMetaWebhook(
      app,
      {
        appSecret: secret,
        phoneNumberId: "phone-1",
        webhookVerifyToken: "verify-me",
      },
      processor as WhatsAppMessageProcessor,
      { info: vi.fn(), error: vi.fn() },
    );
    return app;
  }

  it("verifies the GET challenge", async () => {
    const processor = { claim: vi.fn(), processClaimed: vi.fn() };
    const app = makeApp(processor);

    await request(app)
      .get("/webhooks/meta/whatsapp")
      .query({ "hub.mode": "subscribe", "hub.verify_token": "verify-me", "hub.challenge": "42" })
      .expect(200, "42");
    await request(app)
      .get("/webhooks/meta/whatsapp")
      .query({ "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "42" })
      .expect(403);
  });

  it("acknowledges a valid claimed message before waiting for its slow processing", async () => {
    let releaseProcessing!: () => void;
    const processing = new Promise<void>((resolve) => {
      releaseProcessing = resolve;
    });
    const processor = {
      claim: vi.fn(async () => true),
      processClaimed: vi.fn(async () => processing),
    };
    const app = makeApp(processor);
    const body = JSON.stringify(webhookBody());

    await request(app)
      .post("/webhooks/meta/whatsapp")
      .set("Content-Type", "application/json")
      .set("X-Hub-Signature-256", signature(body))
      .send(body)
      .expect(200);

    await new Promise((resolve) => setImmediate(resolve));
    expect(processor.claim).toHaveBeenCalledOnce();
    expect(processor.processClaimed).toHaveBeenCalledOnce();
    releaseProcessing();
  });

  it("rejects an invalid POST signature before claiming", async () => {
    const processor = { claim: vi.fn(), processClaimed: vi.fn() };
    const app = makeApp(processor);

    await request(app)
      .post("/webhooks/meta/whatsapp")
      .set("Content-Type", "application/json")
      .set("X-Hub-Signature-256", `sha256=${"0".repeat(64)}`)
      .send(webhookBody())
      .expect(401);
    expect(processor.claim).not.toHaveBeenCalled();
  });

  it("verifies the signature before attempting to parse JSON", async () => {
    const processor = { claim: vi.fn(), processClaimed: vi.fn() };
    const app = makeApp(processor);
    const malformed = '{"entry":';

    await request(app)
      .post("/webhooks/meta/whatsapp")
      .set("Content-Type", "application/json")
      .set("X-Hub-Signature-256", `sha256=${"0".repeat(64)}`)
      .send(malformed)
      .expect(401);
    await request(app)
      .post("/webhooks/meta/whatsapp")
      .set("Content-Type", "application/json")
      .set("X-Hub-Signature-256", signature(malformed))
      .send(malformed)
      .expect(400);
  });

  it("still schedules successful claims when another claim fails", async () => {
    const payload = webhookBody("first");
    payload.entry[0]!.changes[0]!.value.messages.push({
      id: "wamid.2",
      from: "15551234567",
      timestamp: "1710000001",
      type: "text",
      text: { body: "second" },
    });
    const processor = {
      claim: vi
        .fn()
        .mockResolvedValueOnce(true)
        .mockRejectedValueOnce(new Error("database unavailable")),
      processClaimed: vi.fn(async (_message: { id: string }) => undefined),
    };
    const app = makeApp(processor);
    const body = JSON.stringify(payload);

    await request(app)
      .post("/webhooks/meta/whatsapp")
      .set("Content-Type", "application/json")
      .set("X-Hub-Signature-256", signature(body))
      .send(body)
      .expect(500);

    await new Promise((resolve) => setImmediate(resolve));
    expect(processor.processClaimed).toHaveBeenCalledOnce();
    expect(processor.processClaimed.mock.calls[0]?.[0]?.id).toBe("wamid.1");
  });
});
