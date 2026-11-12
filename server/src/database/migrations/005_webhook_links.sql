-- Webhook events link to every related PayPal ID (order, capture, refund), not just resource.id.
-- (Split out of 004: applied migrations are never edited.)
ALTER TABLE webhook_events ADD COLUMN related_ids TEXT;   -- ",id1,id2," for exact LIKE matching
ALTER TABLE webhook_events ADD COLUMN summary TEXT;
