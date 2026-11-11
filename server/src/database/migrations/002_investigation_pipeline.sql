-- Real pipeline progress (no simulated progress bars) and investigator chat history.
ALTER TABLE investigations ADD COLUMN stage TEXT NOT NULL DEFAULT 'collecting'
  CHECK (stage IN ('collecting','analyzing','ready','failed','ai_unavailable'));
ALTER TABLE investigations ADD COLUMN stage_detail TEXT;
ALTER TABLE investigations ADD COLUMN error TEXT;
ALTER TABLE investigations ADD COLUMN fact_sheet_json TEXT;

CREATE TABLE IF NOT EXISTS investigation_messages (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  role             TEXT NOT NULL CHECK (role IN ('merchant','investigator')),
  content          TEXT NOT NULL,
  evidence_ids     TEXT,          -- JSON array, validated against the investigation's evidence
  kind             TEXT,          -- observed | inferred | unknown (investigator replies)
  model            TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_investigation ON investigation_messages(investigation_id);
