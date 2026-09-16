import { describe, expect, it } from "vitest";
import { MemoryConversationRepository } from "../src/repository.js";

const start = new Date("2026-09-16T00:00:00.000Z");

async function enqueue(
  repository: MemoryConversationRepository,
  messageId: string,
  conversationId = "conversation-1",
): Promise<boolean> {
  return repository.enqueueInboundMessage({
    messageId,
    conversationId,
    encryptedPayload: `encrypted:${messageId}`,
    enqueuedAt: start,
  });
}

function claimOptions(now = start, overrides: Partial<{
  limit: number;
  leaseMs: number;
  maxAttempts: number;
}> = {}) {
  return {
    limit: overrides.limit ?? 10,
    leaseMs: overrides.leaseMs ?? 30_000,
    maxAttempts: overrides.maxAttempts ?? 3,
    now,
  };
}

describe("MemoryConversationRepository durable inbound queue", () => {
  it("atomically enqueues a provider message ID only once", async () => {
    const repository = new MemoryConversationRepository();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => enqueue(repository, "wamid.1")),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await repository.getInboundMessageStatus("wamid.1")).toBe("pending");
  });

  it("completes a claimed job only with the current lease and never leases it again", async () => {
    const repository = new MemoryConversationRepository();
    await enqueue(repository, "wamid.1");
    const [job] = await repository.claimInboundMessages(claimOptions());

    expect(job).toMatchObject({ messageId: "wamid.1", attempt: 1 });
    expect(await repository.completeInboundMessage("wamid.1", "stale-token")).toBe(false);
    expect(await repository.completeInboundMessage("wamid.1", job!.leaseToken)).toBe(true);
    expect(await repository.getInboundMessageStatus("wamid.1")).toBe("done");
    expect(await repository.claimInboundMessages(claimOptions(new Date(start.getTime() + 60_000)))).toEqual([]);
  });

  it("recovers an expired lease with a new fencing token and rejects the stale worker", async () => {
    const repository = new MemoryConversationRepository();
    await enqueue(repository, "wamid.1");
    const [firstLease] = await repository.claimInboundMessages(
      claimOptions(start, { leaseMs: 1_000 }),
    );
    const [secondLease] = await repository.claimInboundMessages(
      claimOptions(new Date(start.getTime() + 1_001), { leaseMs: 1_000 }),
    );

    expect(secondLease).toMatchObject({ messageId: "wamid.1", attempt: 2 });
    expect(secondLease!.leaseToken).not.toBe(firstLease!.leaseToken);
    expect(await repository.completeInboundMessage("wamid.1", firstLease!.leaseToken)).toBe(false);
    expect(await repository.failInboundMessage({
      messageId: "wamid.1",
      leaseToken: firstLease!.leaseToken,
      failedAt: start,
      retryDelayMs: 2_000,
      dead: false,
      errorCode: "stale_worker",
    })).toBe(false);
    expect(await repository.completeInboundMessage("wamid.1", secondLease!.leaseToken)).toBe(true);
  });

  it("extends the active lease when it durably saves a prepared reply", async () => {
    const repository = new MemoryConversationRepository();
    await enqueue(repository, "wamid.1");
    const [lease] = await repository.claimInboundMessages(
      claimOptions(start, { leaseMs: 1_000 }),
    );

    expect(await repository.savePreparedReply(
      "wamid.1",
      lease!.leaseToken,
      "encrypted-reply",
      new Date(start.getTime() + 900),
      5_000,
    )).toBe(true);
    expect(await repository.claimInboundMessages(
      claimOptions(new Date(start.getTime() + 2_000), { leaseMs: 1_000 }),
    )).toEqual([]);

    const [recovered] = await repository.claimInboundMessages(
      claimOptions(new Date(start.getTime() + 6_000), { leaseMs: 1_000 }),
    );
    expect(recovered).toMatchObject({ messageId: "wamid.1", attempt: 2 });
    expect(await repository.savePreparedReply(
      "wamid.1",
      lease!.leaseToken,
      "stale-reply",
      new Date(start.getTime() + 6_000),
      5_000,
    )).toBe(false);
  });

  it("preserves FIFO per conversation while allowing different conversations in parallel", async () => {
    const repository = new MemoryConversationRepository();
    await enqueue(repository, "conversation-a-first", "conversation-a");
    await enqueue(repository, "conversation-a-second", "conversation-a");
    await enqueue(repository, "conversation-b-first", "conversation-b");

    const firstBatch = await repository.claimInboundMessages(claimOptions());
    expect(firstBatch.map((job) => job.messageId)).toEqual([
      "conversation-a-first",
      "conversation-b-first",
    ]);
    expect(await repository.completeInboundMessage(
      firstBatch[0]!.messageId,
      firstBatch[0]!.leaseToken,
    )).toBe(true);

    const secondBatch = await repository.claimInboundMessages(claimOptions());
    expect(secondBatch.map((job) => job.messageId)).toEqual(["conversation-a-second"]);
  });

  it("moves an expired final lease to dead instead of retrying forever", async () => {
    const repository = new MemoryConversationRepository();
    await enqueue(repository, "wamid.1");
    await repository.claimInboundMessages(
      claimOptions(start, { leaseMs: 1_000, maxAttempts: 1 }),
    );

    expect(await repository.claimInboundMessages(
      claimOptions(new Date(start.getTime() + 1_001), { maxAttempts: 1 }),
    )).toEqual([]);
    expect(await repository.getInboundMessageStatus("wamid.1")).toBe("dead");
  });

  it("dead-letters a retry above a lowered attempt limit and unblocks the next message", async () => {
    const repository = new MemoryConversationRepository();
    await enqueue(repository, "wamid.first", "conversation-1");
    await enqueue(repository, "wamid.second", "conversation-1");
    const [first] = await repository.claimInboundMessages(
      claimOptions(start, { maxAttempts: 3 }),
    );
    await repository.failInboundMessage({
      messageId: first!.messageId,
      leaseToken: first!.leaseToken,
      failedAt: start,
      retryDelayMs: 0,
      dead: false,
      errorCode: "temporary",
    });

    const next = await repository.claimInboundMessages(
      claimOptions(start, { maxAttempts: 1 }),
    );

    expect(await repository.getInboundMessageStatus("wamid.first")).toBe("dead");
    expect(next.map((job) => job.messageId)).toEqual(["wamid.second"]);
  });
});
