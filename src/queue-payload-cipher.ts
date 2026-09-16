import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { z } from "zod";
import type { IncomingWhatsAppMessage } from "./domain.js";

const keyIdPattern = /^[A-Za-z0-9_-]{1,32}$/;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/;
const additionalDataNamespace = "arabic-sofa.whatsapp-queue";
const maximumPlaintextBytes = 16_384;

const envelopeSchema = z
  .object({
    v: z.literal(1),
    alg: z.literal("A256GCM"),
    kid: z.string().regex(keyIdPattern),
    iv: z.string().regex(base64UrlPattern),
    ct: z.string().regex(base64UrlPattern).max(30_000),
    tag: z.string().regex(base64UrlPattern),
  })
  .strict();

const messagePayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("message"),
    message: z
      .object({
        id: z.string().min(1).max(255),
        from: z.string().regex(/^\d{6,20}$/),
        phoneNumberId: z.string().min(1).max(255),
        timestamp: z.string().min(1).max(30),
        text: z.string().min(1).max(4_096),
        mediaId: z.string().min(1).max(255).optional(),
      })
      .strict(),
  })
  .strict();

const replyPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("reply"),
    reply: z.string().min(1).max(4_096),
  })
  .strict();

type PayloadKind = "message" | "reply";

export class QueuePayloadDecryptionError extends Error {
  constructor() {
    super("Queued payload could not be decrypted or validated.");
    this.name = "QueuePayloadDecryptionError";
  }
}

export class QueuePayloadCipher {
  private constructor(
    private readonly keys: ReadonlyMap<string, Buffer>,
    private readonly activeKeyId: string,
  ) {}

  static fromEnvironment(serializedKeys: string, activeKeyId: string): QueuePayloadCipher {
    if (!keyIdPattern.test(activeKeyId)) {
      throw new Error("QUEUE_ENCRYPTION_ACTIVE_KEY_ID is invalid.");
    }

    const keys = new Map<string, Buffer>();
    for (const entry of serializedKeys.split(",")) {
      const separator = entry.indexOf(":");
      if (separator <= 0 || separator === entry.length - 1) {
        throw new Error("QUEUE_ENCRYPTION_KEYS must contain key-id:base64url-key entries.");
      }
      const keyId = entry.slice(0, separator).trim();
      const encodedKey = entry.slice(separator + 1).trim();
      if (!keyIdPattern.test(keyId) || keys.has(keyId)) {
        throw new Error("QUEUE_ENCRYPTION_KEYS contains an invalid or duplicate key ID.");
      }
      keys.set(keyId, decodeEncryptionKey(encodedKey));
    }

    if (!keys.has(activeKeyId)) {
      throw new Error("QUEUE_ENCRYPTION_ACTIVE_KEY_ID does not exist in QUEUE_ENCRYPTION_KEYS.");
    }
    return new QueuePayloadCipher(keys, activeKeyId);
  }

  static ephemeral(): QueuePayloadCipher {
    return new QueuePayloadCipher(new Map([["ephemeral", randomBytes(32)]]), "ephemeral");
  }

  encryptMessage(message: IncomingWhatsAppMessage, conversationId: string): string {
    return this.encrypt(
      "message",
      { schemaVersion: 1, kind: "message", message },
      message.id,
      conversationId,
    );
  }

  decryptMessage(
    envelope: string,
    messageId: string,
    conversationId: string,
  ): IncomingWhatsAppMessage {
    const payload = this.decrypt("message", envelope, messageId, conversationId);
    try {
      const parsed = messagePayloadSchema.parse(payload);
      if (parsed.message.id !== messageId) throw new Error("Message ID mismatch.");
      const { mediaId, ...requiredFields } = parsed.message;
      return mediaId === undefined
        ? requiredFields
        : { ...requiredFields, mediaId };
    } catch {
      throw new QueuePayloadDecryptionError();
    }
  }

  encryptReply(reply: string, messageId: string, conversationId: string): string {
    return this.encrypt(
      "reply",
      { schemaVersion: 1, kind: "reply", reply },
      messageId,
      conversationId,
    );
  }

  decryptReply(envelope: string, messageId: string, conversationId: string): string {
    const payload = this.decrypt("reply", envelope, messageId, conversationId);
    try {
      return replyPayloadSchema.parse(payload).reply;
    } catch {
      throw new QueuePayloadDecryptionError();
    }
  }

  private encrypt(
    kind: PayloadKind,
    payload: unknown,
    messageId: string,
    conversationId: string,
  ): string {
    const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
    if (plaintext.length > maximumPlaintextBytes) {
      throw new Error("Queue payload exceeds the allowed size.");
    }

    const keyId = this.activeKeyId;
    const key = this.keys.get(keyId)!;
    const initializationVector = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, initializationVector, {
      authTagLength: 16,
    });
    cipher.setAAD(buildAdditionalData(kind, keyId, messageId, conversationId));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope = {
      v: 1 as const,
      alg: "A256GCM" as const,
      kid: keyId,
      iv: initializationVector.toString("base64url"),
      ct: ciphertext.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
    };
    return JSON.stringify(envelope);
  }

  private decrypt(
    kind: PayloadKind,
    serializedEnvelope: string,
    messageId: string,
    conversationId: string,
  ): unknown {
    try {
      if (Buffer.byteLength(serializedEnvelope, "utf8") > 50_000) {
        throw new Error("Envelope too large.");
      }
      const envelope = envelopeSchema.parse(JSON.parse(serializedEnvelope) as unknown);
      const key = this.keys.get(envelope.kid);
      if (!key) throw new Error("Unknown key ID.");

      const initializationVector = decodeCanonicalBase64Url(envelope.iv, 12);
      const authenticationTag = decodeCanonicalBase64Url(envelope.tag, 16);
      const ciphertext = decodeCanonicalBase64Url(envelope.ct);
      const decipher = createDecipheriv("aes-256-gcm", key, initializationVector, {
        authTagLength: 16,
      });
      decipher.setAAD(
        buildAdditionalData(kind, envelope.kid, messageId, conversationId),
      );
      decipher.setAuthTag(authenticationTag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      if (plaintext.length > maximumPlaintextBytes) throw new Error("Plaintext too large.");
      return JSON.parse(plaintext.toString("utf8")) as unknown;
    } catch {
      throw new QueuePayloadDecryptionError();
    }
  }
}

function decodeEncryptionKey(value: string): Buffer {
  return decodeCanonicalBase64Url(value, 32, "Queue encryption keys must be 32-byte base64url values.");
}

function decodeCanonicalBase64Url(
  value: string,
  expectedLength?: number,
  errorMessage = "Queued payload is malformed.",
): Buffer {
  if (!base64UrlPattern.test(value)) throw new Error(errorMessage);
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) throw new Error(errorMessage);
  if (expectedLength !== undefined && decoded.length !== expectedLength) {
    throw new Error(errorMessage);
  }
  return decoded;
}

function buildAdditionalData(
  kind: PayloadKind,
  keyId: string,
  messageId: string,
  conversationId: string,
): Buffer {
  return Buffer.from(
    JSON.stringify([additionalDataNamespace, 1, kind, keyId, messageId, conversationId]),
    "utf8",
  );
}
