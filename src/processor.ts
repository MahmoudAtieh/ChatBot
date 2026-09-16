import { createHmac } from "node:crypto";
import type {
  AssistantResult,
  IncomingWhatsAppMessage,
  ShoppingAssistant,
} from "./domain.js";
import { detectLanguage, type RuntimeKnowledge } from "./data/runtime-knowledge.js";
import type { QueuePayloadCipher } from "./queue-payload-cipher.js";
import type {
  AppRepository,
  ClaimedInboundJob,
  ConversationRepository,
} from "./repository.js";

export interface MessageSender {
  sendText(to: string, body: string): Promise<void>;
}

export class ChatService {
  private readonly conversationLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly knowledge: RuntimeKnowledge,
    private readonly assistant: ShoppingAssistant,
    private readonly repository: ConversationRepository,
  ) {}

  async respond(
    conversationId: string,
    customerMessage: string,
    mediaId?: string,
    sourceMessageId?: string,
  ): Promise<AssistantResult> {
    return this.serialized(conversationId, async () => {
      const language = detectLanguage(customerMessage);
      const sensitive = redactSensitiveData(customerMessage);
      await this.repository.appendMessage(
        conversationId,
        "user",
        sensitive.redacted,
        mediaId,
        sourceMessageId,
      );

      if (sourceMessageId) {
        const existingReply = await this.repository.findAssistantReplyBySource(
          conversationId,
          sourceMessageId,
        );
        if (existingReply) {
          return {
            reply: existingReply,
            route: "unsupported",
            handoff: false,
            handoffDetails: null,
            factSourceIds: [],
          };
        }
      }

      const fastReply = sensitive.detected
        ? {
            reply:
              this.knowledge.getPattern("security_after_exposure", language) ??
              "For your security, do not send payment credentials in chat.",
            route: "human_handoff" as const,
            handoff: true,
            handoffDetails: {
              reason: "sensitive_data_exposure",
              summary: "Customer shared apparent sensitive data; the original value was omitted.",
            },
            factSourceIds: [],
          }
        : this.fastPath(customerMessage, language) ??
          this.approvedFaqFastPath(customerMessage, language);

      let result: AssistantResult;
      if (fastReply) {
        result = fastReply;
      } else {
        const messages = await this.repository.getRecentMessages(conversationId, 20);
        try {
          result = await this.assistant.reply({ conversationId, messages });
        } catch {
          result = {
            reply:
              language === "ar"
                ? "صار عندي عطل مؤقت وما بدي أعطيك معلومة غير مؤكدة. خلّيني أحوّل طلبك للفريق."
                : "I hit a temporary issue and don’t want to give you unverified information. I’ll pass this to the team.",
            route: "human_handoff",
            handoff: true,
            handoffDetails: {
              reason: "assistant_error",
              summary: "The automated assistant failed and the customer needs a team reply.",
            },
            factSourceIds: [],
          };
        }
      }

      if (result.handoff && result.handoffDetails) {
        const recentMessages = await this.repository.getRecentMessages(conversationId, 20);
        const mediaIds = [...new Set(recentMessages.flatMap((message) => message.mediaId ?? []))];
        await this.repository.recordHandoff(conversationId, result.route, {
          reason: result.handoffDetails.reason,
          summary:
            mediaIds.length > 0
              ? `${result.handoffDetails.summary}\nMeta media references: ${mediaIds.join(", ")}`
              : result.handoffDetails.summary,
        }, sourceMessageId);
      }
      await this.repository.appendMessage(
        conversationId,
        "assistant",
        result.reply,
        undefined,
        sourceMessageId,
      );
      return result;
    });
  }

  private fastPath(message: string, language: "ar" | "en"): AssistantResult | undefined {
    const normalized = normalizeForFastPath(message);
    const greeting = new Set([
      "السلام عليكم",
      "مرحبا",
      "مرحبا بكم",
      "اهلا",
      "اهلا وسهلا",
      "hi",
      "hello",
      "hey",
    ]);
    if (greeting.has(normalized)) {
      const reply = this.knowledge.getPattern("greeting", language);
      if (reply) {
        return {
          reply,
          route: "greeting",
          handoff: false,
          handoffDetails: null,
          factSourceIds: [],
        };
      }
    }

    const thanks = new Set([
      "شكرا",
      "شكرا لكم",
      "تمام شكرا",
      "thanks",
      "thank you",
      "ok thanks",
    ]);
    if (thanks.has(normalized)) {
      const reply = this.knowledge.getPattern("warm_close", language);
      if (reply) {
        return {
          reply,
          route: "greeting",
          handoff: false,
          handoffDetails: null,
          factSourceIds: [],
        };
      }
    }
    return undefined;
  }

  private approvedFaqFastPath(
    message: string,
    language: "ar" | "en",
  ): AssistantResult | undefined {
    const result = this.knowledge.lookupExactFaq(message, language);
    if (!result.available || !result.entry) return undefined;
    return {
      reply: result.entry.answer,
      route: "static_faq",
      handoff: false,
      handoffDetails: null,
      factSourceIds: [result.entry.factSourceId],
    };
  }

  private async serialized<T>(conversationId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.conversationLocks.get(conversationId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.conversationLocks.set(conversationId, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.conversationLocks.get(conversationId) === tail) {
        this.conversationLocks.delete(conversationId);
      }
    }
  }
}

export class WhatsAppMessageProcessor {
  constructor(
    private readonly chats: ChatService,
    private readonly sender: MessageSender,
    private readonly repository: AppRepository,
    private readonly payloadCipher: QueuePayloadCipher,
    private readonly conversationHashSecret = "local-development-only",
    private readonly now: () => Date = () => new Date(),
    private readonly leaseMs = 300_000,
  ) {}

  async enqueue(message: IncomingWhatsAppMessage): Promise<boolean> {
    const conversationId = this.conversationId(message);
    const encryptedPayload = this.payloadCipher.encryptMessage(message, conversationId);
    return this.repository.enqueueInboundMessage({
      messageId: message.id,
      conversationId,
      encryptedPayload,
      enqueuedAt: this.now(),
    });
  }

  async process(job: ClaimedInboundJob): Promise<void> {
    const message = this.payloadCipher.decryptMessage(
      job.encryptedPayload,
      job.messageId,
      job.conversationId,
    );
    let reply: string;
    if (job.encryptedReply) {
      reply = this.payloadCipher.decryptReply(
        job.encryptedReply,
        job.messageId,
        job.conversationId,
      );
    } else {
      const result = await this.chats.respond(
        job.conversationId,
        message.text,
        message.mediaId,
        job.messageId,
      );
      reply = result.reply;
      const encryptedReply = this.payloadCipher.encryptReply(
        reply,
        job.messageId,
        job.conversationId,
      );
      const saved = await this.repository.savePreparedReply(
        job.messageId,
        job.leaseToken,
        encryptedReply,
        this.now(),
        this.leaseMs,
      );
      if (!saved) throw new Error("Inbound message lease was lost before sending.");
    }
    await this.sender.sendText(message.from, reply);
  }

  private conversationId(message: IncomingWhatsAppMessage): string {
    return hashConversationId(
      `${message.phoneNumberId}:${message.from}`,
      this.conversationHashSecret,
    );
  }
}

export function hashConversationId(phoneNumber: string, secret = "local-development-only"): string {
  return createHmac("sha256", secret).update(phoneNumber).digest("hex");
}

export function containsSensitiveData(text: string): boolean {
  return redactSensitiveData(text).detected;
}

export function redactSensitiveData(text: string): { detected: boolean; redacted: string } {
  let detected = false;
  const cardContext = /\b(card|visa|mastercard|amex|payment card)\b/i.test(text) ||
    /(بطاقه|بطاقة|كرت)\s*(الدفع|الائتمان|البنك)?/i.test(text);
  let redacted = text.replace(
    /(?<!\p{Nd})\p{Nd}(?:[\p{Nd}\s.\-\u00A0]{11,32})\p{Nd}(?!\p{Nd})/gu,
    (candidate) => {
      const digits = normalizeDigits(candidate).replace(/\D/g, "");
      if (digits.length < 13 || digits.length > 19) return candidate;
      const grouped = /[\s.\-\u00A0]/u.test(candidate);
      const candidateIsWholeMessage = candidate.trim() === text.trim();
      if (!cardContext && !(passesLuhn(digits) && (grouped || candidateIsWholeMessage))) {
        return candidate;
      }
      detected = true;
      return "[payment number removed]";
    },
  );

  redacted = redacted.replace(
    /(\b(?:otp|cvv|cvc|pin)\b|رمز\s*(?:التحقق|الامان|الأمان))\s*(?:is|هو)?\s*[:=\-]?\s*([\p{Nd}]{3,8})/giu,
    (_match, label: string) => {
      detected = true;
      return `${label} [security code removed]`;
    },
  );
  redacted = redacted.replace(
    /(\bpassword\b|كلمه\s*المرور|كلمة\s*المرور)\s*[:=\-]?\s*(\S+)/giu,
    (_match, label: string) => {
      detected = true;
      return `${label} [password removed]`;
    },
  );

  return { detected, redacted };
}

function normalizeForFastPath(text: string): string {
  return text
    .toLocaleLowerCase("und")
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDigits(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.codePointAt(0)!;
      if (code >= 0x0660 && code <= 0x0669) return String(code - 0x0660);
      if (code >= 0x06f0 && code <= 0x06f9) return String(code - 0x06f0);
      return character;
    })
    .join("");
}

function passesLuhn(digits: string): boolean {
  let sum = 0;
  let doubleDigit = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}
