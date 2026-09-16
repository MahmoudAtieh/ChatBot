import { randomUUID } from "node:crypto";
import pg from "pg";
import type { AssistantRoute, ChatMessage, ChatRole, HandoffDetails } from "./domain.js";

export type InboundJobStatus = "pending" | "processing" | "retry" | "done" | "dead";

export interface EnqueueInboundJob {
  messageId: string;
  conversationId: string;
  encryptedPayload: string;
  enqueuedAt: Date;
}

export interface ClaimedInboundJob {
  messageId: string;
  conversationId: string;
  encryptedPayload: string;
  encryptedReply: string | null;
  leaseToken: string;
  attempt: number;
}

export interface ClaimInboundJobsOptions {
  limit: number;
  leaseMs: number;
  maxAttempts: number;
  now: Date;
}

export interface FailInboundJobOptions {
  messageId: string;
  leaseToken: string;
  failedAt: Date;
  retryDelayMs: number;
  dead: boolean;
  errorCode: string;
}

export interface InboundQueueRepository {
  enqueueInboundMessage(job: EnqueueInboundJob): Promise<boolean>;
  claimInboundMessages(options: ClaimInboundJobsOptions): Promise<ClaimedInboundJob[]>;
  savePreparedReply(
    messageId: string,
    leaseToken: string,
    encryptedReply: string,
    renewedAt: Date,
    leaseMs: number,
  ): Promise<boolean>;
  completeInboundMessage(messageId: string, leaseToken: string): Promise<boolean>;
  failInboundMessage(options: FailInboundJobOptions): Promise<boolean>;
  getInboundMessageStatus(messageId: string): Promise<InboundJobStatus | null>;
}

export interface ConversationRepository {
  appendMessage(
    conversationId: string,
    role: ChatRole,
    content: string,
    mediaId?: string,
    sourceMessageId?: string,
  ): Promise<void>;
  findAssistantReplyBySource(
    conversationId: string,
    sourceMessageId: string,
  ): Promise<string | null>;
  getRecentMessages(conversationId: string, limit: number): Promise<ChatMessage[]>;
  recordHandoff(
    conversationId: string,
    route: AssistantRoute,
    details: HandoffDetails,
    sourceMessageId?: string,
  ): Promise<void>;
  isReady(): Promise<boolean>;
  close(): Promise<void>;
}

export type AppRepository = ConversationRepository & InboundQueueRepository;

interface MemoryInboundJob {
  queueId: number;
  messageId: string;
  conversationId: string;
  encryptedPayload: string;
  encryptedReply: string | null;
  status: InboundJobStatus;
  attempts: number;
  availableAt: number;
  leaseToken: string | null;
  leaseExpiresAt: number | null;
}

interface StoredChatMessage extends ChatMessage {
  sourceMessageId?: string;
}

export class MemoryConversationRepository implements AppRepository {
  private readonly inbound = new Map<string, MemoryInboundJob>();
  private readonly messages = new Map<string, StoredChatMessage[]>();
  private readonly handoffSources = new Set<string>();
  private nextQueueId = 1;
  public readonly handoffs: Array<{
    conversationId: string;
    route: AssistantRoute;
    details: HandoffDetails;
  }> = [];

  async enqueueInboundMessage(job: EnqueueInboundJob): Promise<boolean> {
    if (this.inbound.has(job.messageId)) return false;
    this.inbound.set(job.messageId, {
      queueId: this.nextQueueId++,
      messageId: job.messageId,
      conversationId: job.conversationId,
      encryptedPayload: job.encryptedPayload,
      encryptedReply: null,
      status: "pending",
      attempts: 0,
      availableAt: job.enqueuedAt.getTime(),
      leaseToken: null,
      leaseExpiresAt: null,
    });
    return true;
  }

  async claimInboundMessages(options: ClaimInboundJobsOptions): Promise<ClaimedInboundJob[]> {
    const now = options.now.getTime();
    for (const job of this.inbound.values()) {
      if (
        (job.status === "pending" || job.status === "retry") &&
        job.attempts >= options.maxAttempts
      ) {
        job.status = "dead";
        job.encryptedPayload = "";
        job.encryptedReply = null;
      }
    }
    for (const job of this.inbound.values()) {
      if (job.status !== "processing" || job.leaseExpiresAt === null || job.leaseExpiresAt > now) {
        continue;
      }
      job.status = job.attempts >= options.maxAttempts ? "dead" : "retry";
      if (job.status === "dead") {
        job.encryptedPayload = "";
        job.encryptedReply = null;
      }
      job.availableAt = now;
      job.leaseToken = null;
      job.leaseExpiresAt = null;
    }

    const claimed: ClaimedInboundJob[] = [];
    while (claimed.length < options.limit) {
      const next = [...this.inbound.values()]
        .filter((job) => {
          if (!(["pending", "retry"] as InboundJobStatus[]).includes(job.status)) return false;
          if (job.availableAt > now || job.attempts >= options.maxAttempts) return false;
          return ![...this.inbound.values()].some(
            (earlier) =>
              earlier.conversationId === job.conversationId &&
              earlier.queueId < job.queueId &&
              (["pending", "retry", "processing"] as InboundJobStatus[]).includes(
                earlier.status,
              ),
          );
        })
        .sort((left, right) => left.availableAt - right.availableAt || left.queueId - right.queueId)[0];
      if (!next) break;

      const leaseToken = randomUUID();
      next.status = "processing";
      next.attempts += 1;
      next.leaseToken = leaseToken;
      next.leaseExpiresAt = now + options.leaseMs;
      claimed.push({
        messageId: next.messageId,
        conversationId: next.conversationId,
        encryptedPayload: next.encryptedPayload,
        encryptedReply: next.encryptedReply,
        leaseToken,
        attempt: next.attempts,
      });
    }
    return claimed;
  }

  async savePreparedReply(
    messageId: string,
    leaseToken: string,
    encryptedReply: string,
    renewedAt: Date,
    leaseMs: number,
  ): Promise<boolean> {
    const job = this.currentLease(messageId, leaseToken);
    if (!job) return false;
    job.encryptedReply = encryptedReply;
    job.leaseExpiresAt = renewedAt.getTime() + leaseMs;
    return true;
  }

  async completeInboundMessage(messageId: string, leaseToken: string): Promise<boolean> {
    const job = this.currentLease(messageId, leaseToken);
    if (!job) return false;
    job.status = "done";
    job.encryptedPayload = "";
    job.encryptedReply = null;
    job.leaseToken = null;
    job.leaseExpiresAt = null;
    return true;
  }

  async failInboundMessage(options: FailInboundJobOptions): Promise<boolean> {
    const job = this.currentLease(options.messageId, options.leaseToken);
    if (!job) return false;
    job.status = options.dead ? "dead" : "retry";
    if (options.dead) {
      job.encryptedPayload = "";
      job.encryptedReply = null;
    }
    job.availableAt = options.failedAt.getTime() + options.retryDelayMs;
    job.leaseToken = null;
    job.leaseExpiresAt = null;
    return true;
  }

  async getInboundMessageStatus(messageId: string): Promise<InboundJobStatus | null> {
    return this.inbound.get(messageId)?.status ?? null;
  }

  private currentLease(messageId: string, leaseToken: string): MemoryInboundJob | undefined {
    const job = this.inbound.get(messageId);
    return job?.status === "processing" && job.leaseToken === leaseToken ? job : undefined;
  }

  async appendMessage(
    conversationId: string,
    role: ChatRole,
    content: string,
    mediaId?: string,
    sourceMessageId?: string,
  ): Promise<void> {
    const messages = this.messages.get(conversationId) ?? [];
    if (
      sourceMessageId &&
      messages.some(
        (message) => message.role === role && message.sourceMessageId === sourceMessageId,
      )
    ) {
      return;
    }
    messages.push({
      role,
      content,
      createdAt: new Date(),
      ...(mediaId ? { mediaId } : {}),
      ...(sourceMessageId ? { sourceMessageId } : {}),
    });
    this.messages.set(conversationId, messages);
  }

  async getRecentMessages(conversationId: string, limit: number): Promise<ChatMessage[]> {
    return (this.messages.get(conversationId) ?? []).slice(-limit).map((message) => ({
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
      ...(message.mediaId ? { mediaId: message.mediaId } : {}),
    }));
  }

  async findAssistantReplyBySource(
    conversationId: string,
    sourceMessageId: string,
  ): Promise<string | null> {
    return this.messages
      .get(conversationId)
      ?.find(
        (message) =>
          message.role === "assistant" && message.sourceMessageId === sourceMessageId,
      )?.content ?? null;
  }

  async recordHandoff(
    conversationId: string,
    route: AssistantRoute,
    details: HandoffDetails,
    sourceMessageId?: string,
  ): Promise<void> {
    const sourceKey = sourceMessageId ? `${conversationId}:${sourceMessageId}` : undefined;
    if (sourceKey && this.handoffSources.has(sourceKey)) return;
    this.handoffs.push({ conversationId, route, details });
    if (sourceKey) this.handoffSources.add(sourceKey);
  }

  async isReady(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {}
}

export class PostgresConversationRepository implements AppRepository {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 10 });
    this.pool.on("error", () => {
      console.error("An idle PostgreSQL client encountered an unexpected error.");
    });
  }

  async enqueueInboundMessage(job: EnqueueInboundJob): Promise<boolean> {
    const result = await this.pool.query(
      `
        INSERT INTO inbound_messages (
          message_id, conversation_id, payload_encrypted, status, available_at, received_at, updated_at
        )
        VALUES ($1, $2, $3, 'pending', NOW(), NOW(), NOW())
        ON CONFLICT (message_id) DO NOTHING
        RETURNING message_id
      `,
      [job.messageId, job.conversationId, job.encryptedPayload],
    );
    return result.rowCount === 1;
  }

  async claimInboundMessages(options: ClaimInboundJobsOptions): Promise<ClaimedInboundJob[]> {
    await this.pool.query(
      `
        UPDATE inbound_messages
        SET status = 'dead', completed_at = NOW(),
            payload_encrypted = NULL, prepared_reply_encrypted = NULL,
            last_error_code = 'max_attempts_exhausted', updated_at = NOW()
        WHERE status IN ('pending', 'retry') AND attempts >= $1
      `,
      [options.maxAttempts],
    );
    await this.pool.query(
      `
        UPDATE inbound_messages
        SET status = CASE WHEN attempts >= $1 THEN 'dead' ELSE 'retry' END,
            available_at = CASE WHEN attempts >= $1 THEN available_at ELSE NOW() END,
            lease_token = NULL,
            lease_expires_at = NULL,
            last_error_code = 'lease_expired',
            payload_encrypted = CASE WHEN attempts >= $1 THEN NULL ELSE payload_encrypted END,
            prepared_reply_encrypted = CASE
              WHEN attempts >= $1 THEN NULL ELSE prepared_reply_encrypted
            END,
            completed_at = CASE WHEN attempts >= $1 THEN NOW() ELSE NULL END,
            updated_at = NOW()
        WHERE status = 'processing' AND lease_expires_at <= NOW()
      `,
      [options.maxAttempts],
    );

    const leaseToken = randomUUID();
    const result = await this.pool.query<{
      message_id: string;
      conversation_id: string;
      payload_encrypted: string;
      prepared_reply_encrypted: string | null;
      lease_token: string;
      attempts: number;
    }>(
      `
        WITH candidates AS (
          SELECT job.message_id
          FROM inbound_messages AS job
          WHERE job.status IN ('pending', 'retry')
            AND job.available_at <= NOW()
            AND job.attempts < $3
            AND NOT EXISTS (
              SELECT 1
              FROM inbound_messages AS earlier
              WHERE earlier.conversation_id = job.conversation_id
                AND earlier.queue_id < job.queue_id
                AND earlier.status IN ('pending', 'retry', 'processing')
            )
          ORDER BY job.available_at, job.queue_id
          FOR UPDATE OF job SKIP LOCKED
          LIMIT $1
        )
        UPDATE inbound_messages AS job
        SET status = 'processing',
            attempts = job.attempts + 1,
            lease_token = $2,
            lease_expires_at = NOW() + ($4::double precision * INTERVAL '1 millisecond'),
            updated_at = NOW()
        FROM candidates
        WHERE job.message_id = candidates.message_id
        RETURNING job.message_id, job.conversation_id, job.payload_encrypted,
                  job.prepared_reply_encrypted, job.lease_token, job.attempts
      `,
      [
        Math.min(Math.max(options.limit, 1), 50),
        leaseToken,
        options.maxAttempts,
        options.leaseMs,
      ],
    );
    return result.rows.map((row) => ({
      messageId: row.message_id,
      conversationId: row.conversation_id,
      encryptedPayload: row.payload_encrypted,
      encryptedReply: row.prepared_reply_encrypted,
      leaseToken: row.lease_token,
      attempt: row.attempts,
    }));
  }

  async savePreparedReply(
    messageId: string,
    leaseToken: string,
    encryptedReply: string,
    _renewedAt: Date,
    leaseMs: number,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `
        UPDATE inbound_messages
        SET prepared_reply_encrypted = $3,
            lease_expires_at = NOW() + ($4::double precision * INTERVAL '1 millisecond'),
            updated_at = NOW()
        WHERE message_id = $1 AND status = 'processing' AND lease_token = $2
        RETURNING message_id
      `,
      [messageId, leaseToken, encryptedReply, leaseMs],
    );
    return result.rowCount === 1;
  }

  async completeInboundMessage(messageId: string, leaseToken: string): Promise<boolean> {
    const result = await this.pool.query(
      `
        UPDATE inbound_messages
        SET status = 'done', payload_encrypted = NULL, prepared_reply_encrypted = NULL,
            lease_token = NULL, lease_expires_at = NULL, last_error_code = NULL,
            completed_at = NOW(), updated_at = NOW()
        WHERE message_id = $1 AND status = 'processing' AND lease_token = $2
        RETURNING message_id
      `,
      [messageId, leaseToken],
    );
    return result.rowCount === 1;
  }

  async failInboundMessage(options: FailInboundJobOptions): Promise<boolean> {
    const result = await this.pool.query(
      `
        UPDATE inbound_messages
        SET status = CASE WHEN $3 THEN 'dead' ELSE 'retry' END,
            available_at = CASE
              WHEN $3 THEN available_at
              ELSE NOW() + ($4::double precision * INTERVAL '1 millisecond')
            END,
            lease_token = NULL, lease_expires_at = NULL,
            payload_encrypted = CASE WHEN $3 THEN NULL ELSE payload_encrypted END,
            prepared_reply_encrypted = CASE
              WHEN $3 THEN NULL ELSE prepared_reply_encrypted
            END,
            last_error_code = LEFT($5, 64),
            completed_at = CASE WHEN $3 THEN NOW() ELSE NULL END,
            updated_at = NOW()
        WHERE message_id = $1 AND status = 'processing' AND lease_token = $2
        RETURNING message_id
      `,
      [
        options.messageId,
        options.leaseToken,
        options.dead,
        options.retryDelayMs,
        options.errorCode,
      ],
    );
    return result.rowCount === 1;
  }

  async getInboundMessageStatus(messageId: string): Promise<InboundJobStatus | null> {
    const result = await this.pool.query<{ status: InboundJobStatus }>(
      "SELECT status FROM inbound_messages WHERE message_id = $1",
      [messageId],
    );
    return result.rows[0]?.status ?? null;
  }

  async appendMessage(
    conversationId: string,
    role: ChatRole,
    content: string,
    mediaId?: string,
    sourceMessageId?: string,
  ): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO conversations (id) VALUES ($1)
        ON CONFLICT (id) DO UPDATE SET updated_at = NOW()
      `,
      [conversationId],
    );
    await this.pool.query(
      `
        INSERT INTO conversation_messages (
          conversation_id, role, content, media_id, source_message_id
        ) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (conversation_id, source_message_id, role)
          WHERE source_message_id IS NOT NULL
        DO NOTHING
      `,
      [conversationId, role, content, mediaId ?? null, sourceMessageId ?? null],
    );
  }

  async getRecentMessages(conversationId: string, limit: number): Promise<ChatMessage[]> {
    const result = await this.pool.query<{
      role: ChatRole;
      content: string;
      created_at: Date;
      media_id: string | null;
    }>(
      `
        SELECT role, content, media_id, created_at
        FROM conversation_messages
        WHERE conversation_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2
      `,
      [conversationId, Math.min(Math.max(limit, 1), 20)],
    );
    return result.rows.reverse().map((row) => ({
      role: row.role,
      content: row.content,
      createdAt: row.created_at,
      ...(row.media_id ? { mediaId: row.media_id } : {}),
    }));
  }

  async findAssistantReplyBySource(
    conversationId: string,
    sourceMessageId: string,
  ): Promise<string | null> {
    const result = await this.pool.query<{ content: string }>(
      `
        SELECT content
        FROM conversation_messages
        WHERE conversation_id = $1 AND source_message_id = $2 AND role = 'assistant'
        ORDER BY id DESC
        LIMIT 1
      `,
      [conversationId, sourceMessageId],
    );
    return result.rows[0]?.content ?? null;
  }

  async recordHandoff(
    conversationId: string,
    route: AssistantRoute,
    details: HandoffDetails,
    sourceMessageId?: string,
  ): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO handoffs (
          conversation_id, route, reason, summary, status, source_message_id
        ) VALUES ($1, $2, $3, $4, 'pending', $5)
        ON CONFLICT (conversation_id, source_message_id)
          WHERE source_message_id IS NOT NULL
        DO NOTHING
      `,
      [conversationId, route, details.reason, details.summary, sourceMessageId ?? null],
    );
  }

  async isReady(): Promise<boolean> {
    try {
      await this.pool.query(
        "SELECT payload_encrypted, lease_expires_at FROM inbound_messages LIMIT 0",
      );
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
