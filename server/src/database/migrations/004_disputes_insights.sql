-- Council-gated dispute claim acceptance: at most one execution per approved deliberation.
CREATE TABLE IF NOT EXISTS dispute_actions (
  id                      TEXT PRIMARY KEY,
  investigation_id        TEXT REFERENCES investigations(id),
  deliberation_id         TEXT NOT NULL UNIQUE REFERENCES deliberations(id),
  dispute_id              TEXT NOT NULL,
  action                  TEXT NOT NULL CHECK (action IN ('accept_claim')),
  status                  TEXT NOT NULL CHECK (status IN ('requested','completed','failed','unknown')),
  approved_by             TEXT NOT NULL,
  approved_at             TEXT NOT NULL,
  paypal_response_summary TEXT,
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
ALTER TABLE deliberations ADD COLUMN dispute_id TEXT;

-- Cached AI insight summaries (regenerated on demand; metrics are always recomputed).
CREATE TABLE IF NOT EXISTS insight_summaries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  range_key    TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  model        TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Webhook events link to every related PayPal ID (order, capture, refund), not just resource.id.
ALTER TABLE webhook_events ADD COLUMN related_ids TEXT;   -- ",id1,id2," for exact LIKE matching
ALTER TABLE webhook_events ADD COLUMN summary TEXT;
