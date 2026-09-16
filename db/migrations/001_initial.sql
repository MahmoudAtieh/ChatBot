CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id BIGSERIAL PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  media_id TEXT,
  source_message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS conversation_messages_recent_idx
  ON conversation_messages (conversation_id, created_at DESC, id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS conversation_messages_source_uidx
  ON conversation_messages (conversation_id, source_message_id, role)
  WHERE source_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS inbound_messages (
  message_id TEXT PRIMARY KEY,
  queue_id BIGSERIAL NOT NULL,
  conversation_id TEXT NOT NULL,
  payload_encrypted TEXT,
  prepared_reply_encrypted TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'retry', 'done', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  last_error_code TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT inbound_messages_payload_check CHECK (
    status IN ('done', 'dead') OR payload_encrypted IS NOT NULL
  ),
  CONSTRAINT inbound_messages_lease_check CHECK (
    (status = 'processing' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR
    (status <> 'processing' AND lease_token IS NULL AND lease_expires_at IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS inbound_messages_queue_id_uidx
  ON inbound_messages (queue_id);

CREATE INDEX IF NOT EXISTS inbound_messages_ready_idx
  ON inbound_messages (available_at, queue_id)
  WHERE status IN ('pending', 'retry');

CREATE INDEX IF NOT EXISTS inbound_messages_conversation_order_idx
  ON inbound_messages (conversation_id, queue_id)
  WHERE status IN ('pending', 'processing', 'retry');

CREATE INDEX IF NOT EXISTS inbound_messages_expired_lease_idx
  ON inbound_messages (lease_expires_at)
  WHERE status = 'processing';

CREATE TABLE IF NOT EXISTS handoffs (
  id BIGSERIAL PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  route TEXT NOT NULL,
  reason TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'assigned', 'closed')) DEFAULT 'pending',
  source_message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS handoffs_pending_idx
  ON handoffs (status, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS handoffs_source_uidx
  ON handoffs (conversation_id, source_message_id)
  WHERE source_message_id IS NOT NULL;
