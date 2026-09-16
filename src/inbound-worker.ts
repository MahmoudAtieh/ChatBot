import { QueuePayloadDecryptionError } from "./queue-payload-cipher.js";
import type { ClaimedInboundJob, InboundQueueRepository } from "./repository.js";

export interface InboundJobHandler {
  process(job: ClaimedInboundJob): Promise<void>;
}

export interface InboundWorkerLogger {
  info(message: string): void;
  error(message: string): void;
}

export interface InboundWorkerOptions {
  pollIntervalMs: number;
  batchSize: number;
  leaseMs: number;
  maxAttempts: number;
  retryBaseMs: number;
  retryMaxMs: number;
  now?: () => Date;
  logger?: InboundWorkerLogger;
}

export class InboundMessageWorker {
  private readonly now: () => Date;
  private readonly logger: InboundWorkerLogger;
  private active = false;
  private timer: NodeJS.Timeout | undefined;
  private currentTick: Promise<void> | undefined;

  constructor(
    private readonly repository: InboundQueueRepository,
    private readonly handler: InboundJobHandler,
    private readonly options: InboundWorkerOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? console;
  }

  get isRunning(): boolean {
    return this.active;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.currentTick;
  }

  async runOnce(): Promise<number> {
    const jobs = await this.repository.claimInboundMessages({
      limit: this.options.batchSize,
      leaseMs: this.options.leaseMs,
      maxAttempts: this.options.maxAttempts,
      now: this.now(),
    });
    const results = await Promise.allSettled(jobs.map((job) => this.processOne(job)));
    const unrecordedFailures = results.filter((result) => result.status === "rejected").length;
    if (unrecordedFailures > 0) {
      this.logger.error(
        `${unrecordedFailures} inbound job failure(s) could not be recorded; leases will recover them.`,
      );
    }
    return jobs.length;
  }

  private schedule(delayMs: number): void {
    if (!this.active) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.active) return;
      const tick = this.runOnce()
        .catch(() => {
          this.logger.error("Inbound worker polling failed; it will retry.");
        })
        .then(() => undefined);
      this.currentTick = tick;
      void tick.finally(() => {
        if (this.currentTick === tick) this.currentTick = undefined;
        this.schedule(this.options.pollIntervalMs);
      });
    }, delayMs);
    this.timer.unref();
  }

  private async processOne(job: ClaimedInboundJob): Promise<void> {
    try {
      await this.handler.process(job);
      const completed = await this.repository.completeInboundMessage(
        job.messageId,
        job.leaseToken,
      );
      if (!completed) {
        this.logger.error(`Inbound job ${safeId(job.messageId)} lost its lease before completion.`);
      }
    } catch (error) {
      const permanent = error instanceof QueuePayloadDecryptionError;
      const dead = permanent || job.attempt >= this.options.maxAttempts;
      const failedAt = this.now();
      const recorded = await this.repository.failInboundMessage({
        messageId: job.messageId,
        leaseToken: job.leaseToken,
        failedAt,
        retryDelayMs: this.retryDelay(job.attempt),
        dead,
        errorCode: permanent ? "payload_invalid" : "processing_failed",
      });
      if (!recorded) {
        this.logger.error(`Inbound job ${safeId(job.messageId)} lost its lease after failure.`);
      } else if (dead) {
        this.logger.error(`Inbound job ${safeId(job.messageId)} moved to the dead-letter state.`);
      } else {
        this.logger.info(`Inbound job ${safeId(job.messageId)} scheduled for retry.`);
      }
    }
  }

  private retryDelay(attempt: number): number {
    return Math.min(
      this.options.retryMaxMs,
      this.options.retryBaseMs * 2 ** Math.max(0, attempt - 1),
    );
  }
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]/g, "").slice(0, 100);
}
