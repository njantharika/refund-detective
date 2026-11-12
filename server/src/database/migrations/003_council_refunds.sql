-- Decision Council progress (real, polled by the UI) and the executable decision that guardrails produced.
ALTER TABLE deliberations ADD COLUMN stage TEXT NOT NULL DEFAULT 'arguing'
  CHECK (stage IN ('arguing','rebuttal','judging','guardrails','complete','failed'));
ALTER TABLE deliberations ADD COLUMN stage_detail TEXT;
ALTER TABLE deliberations ADD COLUMN error TEXT;
ALTER TABLE deliberations ADD COLUMN capture_id TEXT;
ALTER TABLE deliberations ADD COLUMN fact_sheet_json TEXT;      -- the live FactSheet the guardrails used
ALTER TABLE deliberations ADD COLUMN executable_amount TEXT;     -- set only when the final outcome allows execution
ALTER TABLE deliberations ADD COLUMN executable_currency TEXT;
ALTER TABLE deliberations ADD COLUMN completed_at TEXT;

-- One executed refund per approved deliberation: replaying an approval can never create a second refund.
CREATE UNIQUE INDEX IF NOT EXISTS idx_refunds_deliberation ON refunds(deliberation_id) WHERE deliberation_id IS NOT NULL;
