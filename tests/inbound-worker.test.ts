import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InboundMessageWorker,
  type InboundJobHandler,
  type InboundWorkerOptions,
} from "../src/inbound-worker.js";
import { ChatService, WhatsAppMessageProcessor } from "../src/processor.js";
import {
  QueuePayloadCipher,
  QueuePayloadDecryptionError,
} from "../src/queue-payload-cipher.js";
import { MemoryConversationRepository } from "../src/repository.js";

const start = new Date("2026-09-16T00:00:00.000Z");

async function enqueue(
  repository: MemoryConversationRepository,
  messageId: string,
  conversationId = messageId,
): Promise<void> {
  await repository.enqueueInboundMessage({
    messageId,
    conversationId,
    encryptedPayload: `encrypted:${messageId}`,
    enqueuedAt: start,
  });
}

function workerOptions(
  now: () => Date,
  overrides: Partial<InboundWorkerOptions> = {},
): InboundWorkerOptions {
  return {
    pollIntervalMs: 1_000,
    batchSize: 8,
    leaseMs: 30_000,
    maxAttempts: 3,
    retryBaseMs: 5_000,
    retryMaxMs: 60_000,
    now,
    logger: { info: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("InboundMessageWorker", () => {
  it("marks a successfully handled message done and does not lease it twice", async () => {
    const repository = new MemoryConversationRepository();
    await enqueue(repository, "wamid.1");
    const handler: InboundJobHandler = { process: vi.fn(async () => undefined) };
    const worker = new InboundMessageWorker(repository, handler, workerOptions(() => start));

    expect(await worker.runOnce()).toBe(1);
    expect(await repository.getInboundMessageStatus("wamid.1")).toBe("done");
    expect(await worker.runOnce()).toBe(0);
    expect(handler.process).toHaveBeenCalledOnce();
  });

  it("retries transient failures only after exponential backoff and then succeeds", async () => {
    const repository = new MemoryConversationRepository();
    await enqueue(repository, "wamid.1");
    let now = start;
    const handler: InboundJobHandler = {
      process: vi
        .fn<InboundJobHandler["process"]>()
        .mockRejectedValueOnce(new Error("temporary outage"))
        .mockResolvedValueOnce(undefined),
    };
    const worker = new InboundMessageWorker(repository, handler, workerOptions(() => now));

    expect(await worker.runOnce()).toBe(1);
    expect(await repository.getInboundMessageStatus("wamid.1")).toBe("retry");
    now = new Date(start.getTime() + 4_999);
    expect(await worker.runOnce()).toBe(0);
    now = new Date(start.getTime() + 5_000);
    expect(await worker.runOnce()).toBe(1);

    expect(handler.process).toHaveBeenCalledTimes(2);
    expect(handler.process).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ messageId: "wamid.1", attempt: 2 }),
    );
    expect(await repository.getInboundMessageStatus("wamid.1")).toBe("done");
  });

  it("reuses the prepared reply when Meta sending fails instead of calling the AI twice", async () => {
    const repository = new MemoryConversationRepository();
    let now = start;
    const chats = {
      respond: vi.fn(async () => ({
        reply: "Prepared answer",
        route: "product_recommendation" as const,
        handoff: false,
        handoffDetails: null,
        factSourceIds: [],
      })),
    } as unknown as ChatService;
    const sender = {
      sendText: vi
        .fn<(to: string, body: string) => Promise<void>>()
        .mockRejectedValueOnce(new Error("Meta unavailable"))
        .mockResolvedValueOnce(undefined),
    };
    const cipher = QueuePayloadCipher.fromEnvironment(
      `test:${Buffer.alloc(32, 7).toString("base64url")}`,
      "test",
    );
    const processor = new WhatsAppMessageProcessor(
      chats,
      sender,
      repository,
      cipher,
      "test-conversation-secret",
      () => now,
    );
    await processor.enqueue({
      id: "wamid.prepared",
      from: "15551234567",
      phoneNumberId: "phone-1",
      timestamp: "1710000000",
      text: "Find me a beige sofa",
    });
    const worker = new InboundMessageWorker(repository, processor, workerOptions(() => now));

    await worker.runOnce();
    expect(await repository.getInboundMessageStatus("wamid.prepared")).toBe("retry");
    now = new Date(start.getTime() + 5_000);
    await worker.runOnce();

    expect(chats.respond).toHaveBeenCalledOnce();
    expect(sender.sendText).toHaveBeenCalledTimes(2);
    expect(sender.sendText).toHaveBeenNthCalledWith(2, "15551234567", "Prepared answer");
    expect(await repository.getInboundMessageStatus("wamid.prepared")).toBe("done");
  });

  it("moves a repeatedly failing message to dead after the configured attempt limit", async () => {
    const repository = new MemoryConversationRepository();
    await enqueue(repository, "wamid.1");
    let now = start;
    const handler: InboundJobHandler = {
      process: vi.fn(async () => {
        throw new Error("still unavailable");
      }),
    };
    const worker = new InboundMessageWorker(
      repository,
      handler,
      workerOptions(() => now, { maxAttempts: 2 }),
    );

    await worker.runOnce();
    now = new Date(start.getTime() + 5_000);
    await worker.runOnce();

    expect(handler.process).toHaveBeenCalledTimes(2);
    expect(await repository.getInboundMessageStatus("wamid.1")).toBe("dead");
  });

  it("dead-letters an undecryptable payload immediately without retrying", async () => {
    const repository = new MemoryConversationRepository();
    await enqueue(repository, "wamid.invalid");
    const handler: InboundJobHandler = {
      process: vi.fn(async () => {
        throw new QueuePayloadDecryptionError();
      }),
    };
    const worker = new InboundMessageWorker(repository, handler, workerOptions(() => start));

    await worker.runOnce();

    expect(await repository.getInboundMessageStatus("wamid.invalid")).toBe("dead");
    expect(await worker.runOnce()).toBe(0);
    expect(handler.process).toHaveBeenCalledOnce();
  });

  it("waits for every claimed job even if recording another job's failure also fails", async () => {
    const repository = new MemoryConversationRepository();
    await enqueue(repository, "wamid.fail", "conversation-1");
    await enqueue(repository, "wamid.slow", "conversation-2");
    const originalFail = repository.failInboundMessage.bind(repository);
    vi.spyOn(repository, "failInboundMessage")
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockImplementation(originalFail);
    let releaseSlow!: () => void;
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const handler: InboundJobHandler = {
      async process(job) {
        if (job.messageId === "wamid.fail") throw new Error("handler failed");
        await slow;
      },
    };
    const worker = new InboundMessageWorker(repository, handler, workerOptions(() => start));
    let settled = false;
    const running = worker.runOnce().then((count) => {
      settled = true;
      return count;
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    releaseSlow();
    expect(await running).toBe(2);
    expect(await repository.getInboundMessageStatus("wamid.slow")).toBe("done");
  });

  it("stops polling gracefully after the active job finishes and takes no new job", async () => {
    vi.useFakeTimers();
    const repository = new MemoryConversationRepository();
    await enqueue(repository, "wamid.1", "conversation-1");
    await enqueue(repository, "wamid.2", "conversation-2");
    let release!: () => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler: InboundJobHandler = {
      process: vi.fn(async () => {
        signalStarted();
        await blocked;
      }),
    };
    const worker = new InboundMessageWorker(
      repository,
      handler,
      workerOptions(() => start, { batchSize: 1 }),
    );

    worker.start();
    vi.advanceTimersByTime(0);
    await started;
    const stopping = worker.stop();
    expect(worker.isRunning).toBe(false);
    release();
    await stopping;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(handler.process).toHaveBeenCalledOnce();
    expect(await repository.getInboundMessageStatus("wamid.1")).toBe("done");
    expect(await repository.getInboundMessageStatus("wamid.2")).toBe("pending");
  });
});
