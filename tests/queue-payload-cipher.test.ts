import { describe, expect, it } from "vitest";
import type { IncomingWhatsAppMessage } from "../src/domain.js";
import {
  QueuePayloadCipher,
  QueuePayloadDecryptionError,
} from "../src/queue-payload-cipher.js";

const oldKey = Buffer.alloc(32, 1).toString("base64url");
const newKey = Buffer.alloc(32, 2).toString("base64url");

const message: IncomingWhatsAppMessage = {
  id: "wamid.123",
  from: "15551234567",
  phoneNumberId: "phone-1",
  timestamp: "1710000000",
  text: "بدي كنبة لونها بيج",
  mediaId: "media-1",
};

function makeCipher(): QueuePayloadCipher {
  return QueuePayloadCipher.fromEnvironment(`old:${oldKey}`, "old");
}

describe("QueuePayloadCipher", () => {
  it("round-trips message and prepared-reply payloads", () => {
    const cipher = makeCipher();
    const encryptedMessage = cipher.encryptMessage(message, "conversation-1");
    const encryptedReply = cipher.encryptReply("أكيد، هذه أفضل الخيارات.", message.id, "conversation-1");

    expect(cipher.decryptMessage(encryptedMessage, message.id, "conversation-1")).toEqual(message);
    expect(cipher.decryptReply(encryptedReply, message.id, "conversation-1")).toBe(
      "أكيد، هذه أفضل الخيارات.",
    );
    expect(encryptedMessage).not.toContain(message.text);
    expect(encryptedReply).not.toContain("أفضل الخيارات");
  });

  it("round-trips a text message without inventing an optional media ID", () => {
    const cipher = makeCipher();
    const { mediaId: _mediaId, ...textMessage } = message;
    const encrypted = cipher.encryptMessage(textMessage, "conversation-1");
    const decrypted = cipher.decryptMessage(encrypted, textMessage.id, "conversation-1");

    expect(decrypted).toEqual(textMessage);
    expect(Object.hasOwn(decrypted, "mediaId")).toBe(false);
  });

  it("uses a fresh IV so identical plaintexts do not produce identical envelopes", () => {
    const cipher = makeCipher();

    expect(cipher.encryptMessage(message, "conversation-1")).not.toBe(
      cipher.encryptMessage(message, "conversation-1"),
    );
  });

  it("rejects ciphertext tampering with a generic decryption error", () => {
    const cipher = makeCipher();
    const envelope = JSON.parse(
      cipher.encryptMessage(message, "conversation-1"),
    ) as { ct: string };
    envelope.ct = `${envelope.ct[0] === "A" ? "B" : "A"}${envelope.ct.slice(1)}`;

    expect(() =>
      cipher.decryptMessage(JSON.stringify(envelope), message.id, "conversation-1"),
    ).toThrow(QueuePayloadDecryptionError);
  });

  it("binds ciphertext to its message ID, conversation ID, and payload kind", () => {
    const cipher = makeCipher();
    const encrypted = cipher.encryptMessage(message, "conversation-1");

    expect(() => cipher.decryptMessage(encrypted, "wamid.other", "conversation-1")).toThrow(
      QueuePayloadDecryptionError,
    );
    expect(() => cipher.decryptMessage(encrypted, message.id, "conversation-2")).toThrow(
      QueuePayloadDecryptionError,
    );
    expect(() => cipher.decryptReply(encrypted, message.id, "conversation-1")).toThrow(
      QueuePayloadDecryptionError,
    );
  });

  it("decrypts old jobs after key rotation while encrypting new jobs with the active key", () => {
    const beforeRotation = QueuePayloadCipher.fromEnvironment(`old:${oldKey}`, "old");
    const afterRotation = QueuePayloadCipher.fromEnvironment(
      `old:${oldKey},new:${newKey}`,
      "new",
    );
    const oldEnvelope = beforeRotation.encryptMessage(message, "conversation-1");
    const newEnvelope = afterRotation.encryptMessage(message, "conversation-1");

    expect(afterRotation.decryptMessage(oldEnvelope, message.id, "conversation-1")).toEqual(message);
    expect(JSON.parse(newEnvelope)).toMatchObject({ kid: "new", alg: "A256GCM", v: 1 });
    expect(() =>
      beforeRotation.decryptMessage(newEnvelope, message.id, "conversation-1"),
    ).toThrow(QueuePayloadDecryptionError);
  });

  it("rejects invalid, duplicate, missing, or non-32-byte key configuration", () => {
    expect(() => QueuePayloadCipher.fromEnvironment("", "old")).toThrow();
    expect(() => QueuePayloadCipher.fromEnvironment("bad entry", "old")).toThrow();
    expect(() => QueuePayloadCipher.fromEnvironment(`old:${oldKey},old:${newKey}`, "old")).toThrow();
    expect(() => QueuePayloadCipher.fromEnvironment(`old:${oldKey}`, "missing")).toThrow();
    expect(() =>
      QueuePayloadCipher.fromEnvironment(`old:${Buffer.alloc(31).toString("base64url")}`, "old"),
    ).toThrow();
    expect(() => QueuePayloadCipher.fromEnvironment("old:not+base64/url", "old")).toThrow();
  });
});
