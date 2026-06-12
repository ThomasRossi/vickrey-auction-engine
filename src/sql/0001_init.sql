-- Vickrey auction engine — Postgres schema (v1).
--
-- Money is integer micros (CPM × 1e6) everywhere. The ledger is the
-- system of record for spend and credits; `balances` is a materialized
-- projection maintained by the outbox worker.
--
-- Idempotency is enforced in two layers:
--   1. Redis SET NX EX on (mode, token_hash, event_id) — fast path.
--   2. UNIQUE constraint on impressions / clicks (token_hash, event_id) —
--      defense-in-depth in case Redis loses state.

BEGIN;

CREATE TABLE campaigns (
  id                     BIGINT PRIMARY KEY,
  advertiser_id          BIGINT NOT NULL,
  active                 BOOLEAN NOT NULL DEFAULT true,
  killed                 BOOLEAN NOT NULL DEFAULT false,
  max_cpm_micros         BIGINT NOT NULL CHECK (max_cpm_micros >= 0),
  quality_factor         DOUBLE PRECISION NOT NULL DEFAULT 1.0 CHECK (quality_factor > 0),
  remaining_impressions  BIGINT NOT NULL DEFAULT 0 CHECK (remaining_impressions >= 0),
  starts_at_ms           BIGINT NOT NULL,
  ends_at_ms             BIGINT NOT NULL,
  mode                   TEXT NOT NULL CHECK (mode IN ('live', 'demo')),
  targeting              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX campaigns_eligible_idx
  ON campaigns (active, killed, starts_at_ms, ends_at_ms)
  WHERE active = true AND killed = false;

-- Async outbox projection of served tokens, written by the outbox worker
-- (NOT on the hot /v1/portfolio path). Useful for forensics and reporting.
CREATE TABLE served_tokens (
  id               BIGSERIAL PRIMARY KEY,
  token_hash       TEXT NOT NULL UNIQUE,
  campaign_id      BIGINT NOT NULL,
  clearing_micros  BIGINT NOT NULL,
  user_id          TEXT NOT NULL,
  surface_id       SMALLINT NOT NULL,
  mode             TEXT NOT NULL CHECK (mode IN ('live', 'demo')),
  issued_at_ms     BIGINT NOT NULL,
  expires_at_ms    BIGINT NOT NULL
);

CREATE TABLE impressions (
  id           BIGSERIAL PRIMARY KEY,
  token_hash   TEXT NOT NULL,
  event_id     TEXT NOT NULL,
  viewed_ms    INTEGER NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (token_hash, event_id)
);

CREATE TABLE clicks (
  id           BIGSERIAL PRIMARY KEY,
  token_hash   TEXT NOT NULL,
  event_id     TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (token_hash, event_id)
);

-- Append-only double-entry ledger. One row per settled event.
-- credit_micros == 0 in demo mode (advertiser still debited; no user payout).
CREATE TABLE ledger_entries (
  id                  BIGSERIAL PRIMARY KEY,
  ts_ms               BIGINT NOT NULL,
  advertiser_id       BIGINT NOT NULL,
  user_id             TEXT NOT NULL,
  debit_micros        BIGINT NOT NULL CHECK (debit_micros >= 0),
  credit_micros       BIGINT NOT NULL CHECK (credit_micros >= 0 AND credit_micros <= debit_micros),
  event_kind          TEXT NOT NULL CHECK (event_kind IN ('impression', 'click')),
  mode                TEXT NOT NULL CHECK (mode IN ('live', 'demo')),
  source_token_hash   TEXT NOT NULL,
  event_id            TEXT NOT NULL,
  UNIQUE (source_token_hash, event_id, event_kind)
);

CREATE INDEX ledger_user_idx ON ledger_entries (user_id, mode);
CREATE INDEX ledger_advertiser_idx ON ledger_entries (advertiser_id, mode);

-- Transactional outbox. The settlement path writes a ledger_entry and
-- an outbox row in the same transaction. A worker drains this into
-- the balances projection (and any other downstream readers).
CREATE TABLE outbox (
  id           BIGSERIAL PRIMARY KEY,
  payload      JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX outbox_unprocessed_idx ON outbox (id) WHERE processed_at IS NULL;

-- Materialized balances. Updated only by the outbox worker.
CREATE TABLE balances (
  user_id          TEXT PRIMARY KEY,
  credit_micros    BIGINT NOT NULL DEFAULT 0 CHECK (credit_micros >= 0),
  settled_at_ms    BIGINT NOT NULL
);

COMMIT;
