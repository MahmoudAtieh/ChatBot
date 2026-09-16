-- Run this migration with application workers stopped. It upgrades databases
-- created by the original 001_initial.sql to the durable inbound queue schema.
-- Supported PostgreSQL version: 16 or newer.
BEGIN;

ALTER TABLE inbound_messages
  ADD COLUMN IF NOT EXISTS queue_id BIGSERIAL,
  ADD COLUMN IF NOT EXISTS payload_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS prepared_reply_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS lease_token TEXT,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_error_code TEXT,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

ALTER TABLE conversation_messages
  ADD COLUMN IF NOT EXISTS source_message_id TEXT;

ALTER TABLE handoffs
  ADD COLUMN IF NOT EXISTS source_message_id TEXT;

ALTER TABLE inbound_messages
  ALTER COLUMN queue_id SET NOT NULL,
  ALTER COLUMN status SET DEFAULT 'pending';

-- The legacy constraint accepts only processing/done/failed, so remove it
-- before converting unreplayable legacy rows to the new dead state.
ALTER TABLE inbound_messages
  DROP CONSTRAINT IF EXISTS inbound_messages_status_check,
  DROP CONSTRAINT IF EXISTS inbound_messages_attempts_check,
  DROP CONSTRAINT IF EXISTS inbound_messages_payload_check,
  DROP CONSTRAINT IF EXISTS inbound_messages_lease_check;

-- Rows created by the old runtime contain only a fingerprint, not a replayable
-- payload. They cannot be retried safely, so close them explicitly rather than
-- pretending that they are pending work.
UPDATE inbound_messages
SET status = 'dead',
    last_error_code = 'legacy_payload_unavailable',
    completed_at = COALESCE(completed_at, updated_at, NOW()),
    lease_token = NULL,
    lease_expires_at = NULL
WHERE status = 'failed'
   OR (status = 'processing' AND payload_encrypted IS NULL);

UPDATE inbound_messages
SET completed_at = COALESCE(completed_at, updated_at, NOW()),
    payload_encrypted = NULL,
    prepared_reply_encrypted = NULL,
    lease_token = NULL,
    lease_expires_at = NULL
WHERE status = 'done';

ALTER TABLE inbound_messages
  ADD CONSTRAINT inbound_messages_status_check
    CHECK (status IN ('pending', 'processing', 'retry', 'done', 'dead')),
  ADD CONSTRAINT inbound_messages_attempts_check
    CHECK (attempts >= 0),
  ADD CONSTRAINT inbound_messages_payload_check
    CHECK (status IN ('done', 'dead') OR payload_encrypted IS NOT NULL),
  ADD CONSTRAINT inbound_messages_lease_check
    CHECK (
      (status = 'processing' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR
      (status <> 'processing' AND lease_token IS NULL AND lease_expires_at IS NULL)
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

CREATE UNIQUE INDEX IF NOT EXISTS conversation_messages_source_uidx
  ON conversation_messages (conversation_id, source_message_id, role)
  WHERE source_message_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS handoffs_source_uidx
  ON handoffs (conversation_id, source_message_id)
  WHERE source_message_id IS NOT NULL;

COMMIT;
