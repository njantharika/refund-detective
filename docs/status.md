# Refund Detective — Build Status

_Last updated: 2026-11-11 (Phase 1 in progress)_

## Ground truth check (2026-11-11)

| Fact | Result |
|---|---|
| Workspace | `.vscode/mcp.json` + `docs/build-prompt.md`. No app code, not a git repo. ✅ |
| Node / npm | v22.23.1 / 10.9.8, registry npmjs.org ✅ |
| `.vscode/mcp.json` token | **Already** uses `${input:paypal-access-token}`, so no plaintext token on disk ✅ |
| `create_refund` schema | `capture_id`, `amount{currency_code,value}`, `invoice_id`, `note_to_payer`. **No idempotency key or PayPal-Request-Id**, so idempotency is app-level only. |
| `list_transactions` (live, editor MCP) | ❌ **403 "Authorization failed due to insufficient permissions"**. This is §6 blocker #1. |
| `list_disputes` (live, editor MCP) | ✅ 200, 0 disputes |

## Plan (10 lines)

1. Git init, npm-workspaces monorepo (client: Vite/React/TS/Tailwind; server: Express/TS), Vitest everywhere.
2. Hygiene: `.gitignore`, `.env.example`, MIT LICENSE, Sandbox-only boot guard, pino redaction.
3. SQLite migration `001_init.sql` run on boot (all §5 tables).
4. PayPal layer: OAuth client-credentials auth, managed MCP stdio client, allowlisted tool registry with Ajv, REST fallback.
5. `/api/settings/integration-status` and the Settings page; live verify `get_order` / `list_transactions`.
6. Transactions API that merges Transaction Search with `demo_orders` (live `get_order`), plus Overview KPIs from real data.
7. Investigator: evidence collection/normalization, deterministic FactSheet (`rules.ts`, tested), LLM report with citation stripping.
8. Decision Council: Advocate ∥ Challenger, citation check, Judge, stricter-only guardrails, persisted; Council UI.
9. Refund flow: validate/approve, lock, idempotency key, `get_refund` verify, reconcile-on-unknown, audit, modal.
10. Polish (disputes → insights → events), then docs, Render deploy, secret scan, demo script and Devpost draft.

## Blockers

- **B1. Transaction Search 403.** Enable *Transaction Search* for the Sandbox app in the PayPal Developer Dashboard (My Apps & Credentials → app → Features), then regenerate credentials. Until then, the explorer can only show orders this app creates (`demo_orders`).
- **B2. Credentials needed in `.env`:** `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` (so tokens auto-refresh), `ANTHROPIC_API_KEY`.

## Acceptance criteria (§17)

1. [ ] App launches; dashboard loads; SANDBOX visible everywhere
2. [ ] Backend MCP client spawns `@paypal/mcp`, discovers tools, Settings shows status
3. [ ] Real Sandbox transactions and orders/captures are retrieved and displayed
4. [ ] Investigation produces a schema-valid, evidence-cited report
5. [ ] UI shows the evidence behind each finding
6. [ ] Decision Council runs Advocate and Challenger in parallel, and the Judge's verdict is persisted and displayed
7. [ ] Guardrails independently validate eligibility and can override the Judge
8. [ ] Refund requires explicit merchant approval
9. [ ] An authorized Sandbox refund executes, and `get_refund` verifies it
10. [ ] Audit log records investigator, council and refund actions
11. [ ] Duplicate-refund scenario is blocked
12. [ ] Errors and empty states are handled; Demo mode is clearly labelled
13. [ ] README lets a stranger run it; MIT LICENSE present
14. [ ] No secrets in the repo or history; public repo; demo URL or run instructions
15. [ ] Demo video under 3 minutes and Devpost draft complete
