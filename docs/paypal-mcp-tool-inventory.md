# PayPal MCP tool inventory

Server: `@paypal/mcp` (npm 1.8.1; it reports itself as `PayPal 1.11.0`, the agent-toolkit version), spawned by the backend as `node @paypal/mcp/dist/index.js --tools=all` with `PAYPAL_ACCESS_TOKEN` and `PAYPAL_ENVIRONMENT=SANDBOX`. It advertises **28 tools**, and Refund Detective allowlists **9** of them. Any other tool is rejected before a call (`TOOL_NOT_ALLOWED`), even though the server advertises it. Arguments are validated with Ajv against each tool's advertised `inputSchema` before every call.

| Tool | Class | Used for | Underlying REST call | Verified live |
|---|---|---|---|---|
| `list_transactions` | read | Explorer, FactSheet record, reconciling unknown refunds (T11xx events) | `GET /v1/reporting/transactions` | ✅ with client-credentials tokens (the initially pasted access token got 403) |
| `get_order` | read | Order and captures for evidence and the FactSheet; seeding status | `GET /v2/checkout/orders/{id}` | ✅ |
| `get_refund` | read | Refund status for the FactSheet; verification after `create_refund` | `GET /v2/payments/refunds/{id}` | ✅ (`5YE09135FX432004L` COMPLETED) |
| `list_disputes` | read | Disputes per capture, dashboard and Insights | `GET /v1/customer/disputes` | ✅ (0 disputes) |
| `get_dispute` | read | Dispute detail and summary; verification after accept | `GET /v1/customer/disputes/{id}` | ⚪ no Sandbox disputes to read (tests only) |
| `create_refund` | **write, approval-gated** | The refund approval flow only | `POST /v2/payments/captures/{id}/refund` | ✅ USD 20.00 |
| `accept_dispute_claim` | **write, approval-gated** | Council-approved dispute accept only | `POST /v1/customer/disputes/{id}/accept-claim` | ⚪ tests only |
| `create_order` | write (seeding) | `npm run seed:sandbox -- create` | `POST /v2/checkout/orders` | ✅ 3 orders |
| `pay_order` | write (seeding) | `npm run seed:sandbox -- capture` | `POST /v2/checkout/orders/{id}/capture` | ✅ 3 captures |

Not used: invoices, products, subscriptions, shipment tracking.

## Behaviours discovered during live verification

| Observation | Consequence in Refund Detective |
|---|---|
| `get_order` returns `payments.captures` only. **Refunds are never listed** on the order. | Refunds come from `get_refund`, linked to their capture through PayPal's `up` link. `PARTIALLY_REFUNDED` with no visible refunds means remaining is unknown and the refund is blocked. |
| `create_refund` accepts no idempotency key or `PayPal-Request-Id` (the header is only set from a process-wide context). | The app enforces idempotency itself: a UUID key per refund row, one refund per approved deliberation, and an operation lock. The REST fallback does send `PayPal-Request-Id`. |
| Errors come back as `{"ok":false,"status":403,...}` text content, or with `isError`. | Both are parsed into a typed `PayPalError` carrying the HTTP status. |
| A bad or expired token produces HTTP 401: "The token passed in was not found in the system" / "Access Token not found in cache". | The token guard re-mints the token, restarts the child and retries **reads** once. Writes are never retried. |
| `accept_dispute_claim` validates `note` with the dispute-ID regex `^[A-Za-z0-9_-]{1,255}$`. | The app sends a slug note: `accepted-via-refund-detective-council-<deliberation id>`. |
| `create_order` only accepts `currencyCode: "USD"`. | Seed orders are USD. A buyer from another country or currency was declined (`INSTRUMENT_DECLINED`); a US Sandbox buyer worked. |
| Declined capture attempts stay on the order as `DECLINED` captures. | They are kept as evidence, but the refund target is chosen only from captures that took money. KPIs say "payment attempts". |
| `list_transactions` returned 403 with the first, manually pasted token and worked with client-credentials tokens. New captures took a while to be indexed. | The 403 is shown with the dashboard hint. The explorer merges in app-created orders fetched live with `get_order`. |
