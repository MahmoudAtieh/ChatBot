import { createHmac, timingSafeEqual } from "node:crypto";
import express, { type Express } from "express";
import type { IncomingWhatsAppMessage } from "./domain.js";
import type { MessageSender } from "./processor.js";

export interface InboundMessageEnqueuer {
  enqueue(message: IncomingWhatsAppMessage): Promise<boolean>;
}

export interface MetaWhatsAppOptions {
  accessToken?: string;
  phoneNumberId?: string;
  appSecret?: string;
  webhookVerifyToken?: string;
  graphApiVersion?: string;
  fetchImplementation?: typeof fetch;
}

export interface WebhookLogger {
  info(message: string): void;
  error(message: string): void;
}

export class MetaWhatsAppClient implements MessageSender {
  private readonly fetchImplementation: typeof fetch;

  constructor(private readonly options: MetaWhatsAppOptions) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    if (options.graphApiVersion && !/^v\d+\.\d+$/.test(options.graphApiVersion)) {
      throw new Error("META_GRAPH_API_VERSION must look like vXX.X.");
    }
  }

  get configured(): boolean {
    return Boolean(
      this.options.accessToken &&
        this.options.phoneNumberId &&
        this.options.graphApiVersion,
    );
  }

  async sendText(to: string, body: string): Promise<void> {
    if (!this.configured) throw new Error("Meta WhatsApp sending is not configured.");
    if (!/^\d{6,20}$/.test(to)) throw new Error("WhatsApp recipient must contain digits only.");
    if (body.length === 0 || body.length > 4_096) {
      throw new Error("WhatsApp text reply must contain 1 to 4096 characters.");
    }

    const response = await this.fetchImplementation(
      `https://graph.facebook.com/${this.options.graphApiVersion}/${this.options.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          type: "text",
          text: { preview_url: false, body },
        }),
        signal: AbortSignal.timeout(8_000),
      },
    );

    if (!response.ok) {
      throw new Error(`Meta send failed with status ${response.status}.`);
    }
  }
}

export function registerMetaWebhook(
  app: Express,
  options: MetaWhatsAppOptions,
  enqueuer: InboundMessageEnqueuer,
  logger: WebhookLogger = console,
): void {
  app.get("/webhooks/meta/whatsapp", (request, response) => {
    if (!options.webhookVerifyToken) {
      response.sendStatus(503);
      return;
    }
    const mode = singleQueryValue(request.query["hub.mode"]);
    const token = singleQueryValue(request.query["hub.verify_token"]);
    const challenge = singleQueryValue(request.query["hub.challenge"]);
    if (
      mode === "subscribe" &&
      token !== undefined &&
      constantTimeTextEqual(token, options.webhookVerifyToken) &&
      challenge !== undefined
    ) {
      response.status(200).type("text/plain").send(challenge);
      return;
    }
    response.sendStatus(403);
  });

  app.post(
    "/webhooks/meta/whatsapp",
    express.raw({ type: "application/json", limit: "1mb" }),
    async (request, response) => {
      if (!options.appSecret || !options.phoneNumberId || !Buffer.isBuffer(request.body)) {
        response.sendStatus(503);
        return;
      }
      const signature = request.header("X-Hub-Signature-256");
      if (!verifyMetaSignature(request.body, signature, options.appSecret)) {
        response.sendStatus(401);
        return;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(request.body.toString("utf8")) as unknown;
      } catch {
        response.sendStatus(400);
        return;
      }

      const messages = extractWhatsAppMessages(payload, options.phoneNumberId);
      try {
        const enqueueResults = await Promise.allSettled(
          messages.map((message) => enqueuer.enqueue(message)),
        );
        if (enqueueResults.some((result) => result.status === "rejected")) {
          logger.error("Could not persist some inbound WhatsApp messages.");
          response.sendStatus(500);
          return;
        }
        response.sendStatus(200);
      } catch {
        logger.error("Could not persist inbound WhatsApp messages.");
        response.sendStatus(500);
      }
    },
  );
}

export function verifyMetaSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader || !/^sha256=[a-f0-9]{64}$/i.test(signatureHeader)) return false;
  const supplied = Buffer.from(signatureHeader.slice("sha256=".length), "hex");
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function extractWhatsAppMessages(
  payload: unknown,
  expectedPhoneNumberId: string,
): IncomingWhatsAppMessage[] {
  if (
    !isRecord(payload) ||
    payload.object !== "whatsapp_business_account" ||
    !Array.isArray(payload.entry)
  ) {
    return [];
  }
  const results: IncomingWhatsAppMessage[] = [];

  for (const entry of payload.entry) {
    if (!isRecord(entry) || !Array.isArray(entry.changes)) continue;
    for (const change of entry.changes) {
      if (!isRecord(change) || change.field !== "messages" || !isRecord(change.value)) continue;
      const metadata = change.value.metadata;
      if (!isRecord(metadata) || metadata.phone_number_id !== expectedPhoneNumberId) continue;
      if (!Array.isArray(change.value.messages)) continue;

      for (const message of change.value.messages) {
        if (!isRecord(message)) continue;
        const id = stringValue(message.id);
        const from = stringValue(message.from);
        const timestamp = stringValue(message.timestamp);
        if (!id || !from || !timestamp || !/^\d{6,20}$/.test(from)) continue;

        if (message.type === "text" && isRecord(message.text)) {
          const body = stringValue(message.text.body)?.trim();
          if (body) {
            results.push({
              id: id.slice(0, 255),
              from,
              timestamp,
              phoneNumberId: expectedPhoneNumberId,
              text: body.slice(0, 4_096),
            });
          }
        } else if (message.type === "image" && isRecord(message.image)) {
          const caption = stringValue(message.image.caption)?.trim();
          results.push({
            id: id.slice(0, 255),
            from,
            timestamp,
            phoneNumberId: expectedPhoneNumberId,
            text: caption ? `🖼️ ${caption.slice(0, 1_024)}` : "🖼️",
            ...(stringValue(message.image.id)
              ? { mediaId: stringValue(message.image.id)!.slice(0, 255) }
              : {}),
          });
        }
      }
    }
  }
  return results;
}

function singleQueryValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
