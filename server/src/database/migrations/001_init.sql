-- Refund Detective initial schema. Amounts are stored as decimal strings (PayPal's own format) to avoid float drift.

CREATE TABLE IF NOT EXISTS investigations (
  id             TEXT PRIMARY KEY,
  transaction_id TEXT,
  order_id       TEXT,
  capture_id     TEXT,
  complaint      TEXT,
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','awaiting_approval','resolved','closed')),
  summary        TEXT,
  root_cause     TEXT,
  confidence     REAL,
  report_json    TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_investigations_capture ON investigations(capture_id);
CREATE INDEX IF NOT EXISTS idx_investigations_order ON investigations(order_id);

CREATE TABLE IF NOT EXISTS evidence (
  id               TEXT NOT NULL,            -- EV-### (unique within an investigation)
  investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  source           TEXT NOT NULL CHECK (source IN ('paypal_mcp','paypal_rest','webhook_verified','app_internal','merchant_input')),
  type             TEXT NOT NULL,
  description      TEXT,
  payload_json     TEXT,                     -- redacted before persisting
  observed_at      TEXT,
  verified         INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (investigation_id, id)
);

CREATE TABLE IF NOT EXISTS deliberations (
  id               TEXT PRIMARY KEY,
  investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  decision_type    TEXT NOT NULL CHECK (decision_type IN ('refund','dispute_accept','next_action')),
  proposal_json    TEXT,
  advocate_json    TEXT,
  challenger_json  TEXT,
  rebuttals_json   TEXT,
  judge_json       TEXT,
  guardrail_json   TEXT,
  final_outcome    TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_deliberations_investigation ON deliberations(investigation_id);

CREATE TABLE IF NOT EXISTS refunds (
  id                      TEXT PRIMARY KEY,
  investigation_id        TEXT REFERENCES investigations(id),
  deliberation_id         TEXT REFERENCES deliberations(id),
  capture_id              TEXT NOT NULL,
  paypal_refund_id        TEXT,
  amount                  TEXT NOT NULL,
  currency                TEXT NOT NULL,
  reason                  TEXT,
  status                  TEXT NOT NULL CHECK (status IN ('requested','pending','completed','failed','unknown')),
  idempotency_key         TEXT NOT NULL UNIQUE,
  approved_by             TEXT,
  approved_at             TEXT,
  executed_at             TEXT,
  paypal_response_summary TEXT,
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_refunds_capture ON refunds(capture_id);

CREATE TABLE IF NOT EXISTS operation_locks (
  resource_id TEXT PRIMARY KEY,
  operation   TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id                 TEXT PRIMARY KEY,
  paypal_event_id    TEXT NOT NULL UNIQUE,
  event_type         TEXT NOT NULL,
  resource_id        TEXT,
  event_time         TEXT,
  signature_verified INTEGER NOT NULL DEFAULT 0,
  payload_json       TEXT,
  processing_status  TEXT NOT NULL DEFAULT 'received',
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_webhook_resource ON webhook_events(resource_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  actor           TEXT NOT NULL,             -- merchant | system | ai:<role>
  action          TEXT NOT NULL,
  resource_type   TEXT,
  resource_id     TEXT,
  request_summary TEXT,
  result_summary  TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_log(resource_type, resource_id);

-- Orders this app created in Sandbox, so they can be found before Transaction Search indexes them.
CREATE TABLE IF NOT EXISTS demo_orders (
  order_id     TEXT PRIMARY KEY,
  label        TEXT,
  amount       TEXT,
  currency     TEXT,
  approve_url  TEXT,
  status       TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
