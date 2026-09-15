import pg from "pg";
import type { AssistantRoute, ChatMessage, ChatRole, HandoffDetails } from "./domain.js";

export interface ConversationRepository {
  claimInboundMessage(messageId: string, conversationId: string): Promise<boolean>;
  markInboundDone(messageId: string): Promise<void>;
  markInboundFailed(messageId: string): Promise<void>;
  appendMessage(
    conversationId: string,
    role: ChatRole,
    content: string,
    mediaId?: string,
  ): Promise<void>;
  getRecentMessages(conversationId: string, limit: number): Promise<ChatMessage[]>;
  recordHandoff(
    conversationId: string,
    route: AssistantRoute,
    details: HandoffDetails,
  ): Promise<void>;
  isReady(): Promise<boolean>;
  close(): Promise<void>;
}

interface InboundState {
  status: "processing" | "done" | "failed";
  updatedAt: number;
}

export class MemoryConversationRepository implements ConversationRepository {
  private readonly inbound = new Map<string, InboundState>();
  private readonly messages = new Map<string, ChatMessage[]>();
  public readonly handoffs: Array<{
    conversationId: string;
    route: AssistantRoute;
    details: HandoffDetails;
  }> = [];

  async claimInboundMessage(messageId: string, _conversationId: string): Promise<boolean> {
    const existing = this.inbound.get(messageId);
    if (existing && existing.status !== "failed") return false;
    this.inbound.set(messageId, { status: "processing", updatedAt: Date.now() });
    return true;
  }

  async markInboundDone(messageId: string): Promise<void> {
    this.inbound.set(messageId, { status: "done", updatedAt: Date.now() });
  }

  async markInboundFailed(messageId: string): Promise<void> {
    this.inbound.set(messageId, { status: "failed", updatedAt: Date.now() });
  }

  async appendMessage(
    conversationId: string,
    role: ChatRole,
    content: string,
    mediaId?: string,
  ): Promise<void> {
    const messages = this.messages.get(conversationId) ?? [];
    messages.push({ role, content, createdAt: new Date(), ...(mediaId ? { mediaId } : {}) });
    this.messages.set(conversationId, messages);
  }

  async getRecentMessages(conversationId: string, limit: number): Promise<ChatMessage[]> {
    return (this.messages.get(conversationId) ?? []).slice(-limit);
  }

  async recordHandoff(
    conversationId: string,
    route: AssistantRoute,
    details: HandoffDetails,
  ): Promise<void> {
    this.handoffs.push({ conversationId, route, details });
  }

  async isReady(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {}
}

export class PostgresConversationRepository implements ConversationRepository {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 10 });
    this.pool.on("error", () => {
      console.error("An idle PostgreSQL client encountered an unexpected error.");
    });
  }

  async claimInboundMessage(messageId: string, conversationId: string): Promise<boolean> {
    const result = await this.pool.query(
      `
        INSERT INTO inbound_messages (message_id, conversation_id, status)
        VALUES ($1, $2, 'processing')
        ON CONFLICT (message_id) DO UPDATE
          SET status = 'processing', updated_at = NOW()
          WHERE inbound_messages.status = 'failed'
        RETURNING message_id
      `,
      [messageId, conversationId],
    );
    return result.rowCount === 1;
  }

  async markInboundDone(messageId: string): Promise<void> {
    await this.pool.query(
      "UPDATE inbound_messages SET status = 'done', updated_at = NOW() WHERE message_id = $1",
      [messageId],
    );
  }

  async markInboundFailed(messageId: string): Promise<void> {
    await this.pool.query(
      "UPDATE inbound_messages SET status = 'failed', updated_at = NOW() WHERE message_id = $1",
      [messageId],
    );
  }

  async appendMessage(
    conversationId: string,
    role: ChatRole,
    content: string,
    mediaId?: string,
  ): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO conversations (id) VALUES ($1)
        ON CONFLICT (id) DO UPDATE SET updated_at = NOW()
      `,
      [conversationId],
    );
    await this.pool.query(
      "INSERT INTO conversation_messages (conversation_id, role, content, media_id) VALUES ($1, $2, $3, $4)",
      [conversationId, role, content, mediaId ?? null],
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

  async recordHandoff(
    conversationId: string,
    route: AssistantRoute,
    details: HandoffDetails,
  ): Promise<void> {
    await this.pool.query(
      "INSERT INTO handoffs (conversation_id, route, reason, summary, status) VALUES ($1, $2, $3, $4, 'pending')",
      [conversationId, route, details.reason, details.summary],
    );
  }

  async isReady(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
