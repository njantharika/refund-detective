# Refund Detective — Build Status

_Last updated: 2026-11-12 00:50 IST. Phases 1–2 complete and verified live. Next: Phase 3 (Decision Council + refund)._

## Phase 2 report

**Implemented**
- `server/src/ai/provider.ts`: `complete({system, messages, schema, model, timeoutMs})` returns Zod-validated JSON. Invalid output gets one retry with the validation error, then fails with `AI_INVALID_OUTPUT`. 429/5xx get 2 backoff retries (honouring Gemini `retryDelay`), then the fallback model. Adapters: OpenAI-compatible (Gemini, live) and Anthropic (untested live: no key). No key means "AI not configured"; nothing is substituted.
- Evidence: backend-collected `EV-###` items with source, `verified` and provenance (tool and path). Payer PII is redacted. The complaint is `merchant_input`, `verified:false`. Failed sources become *missing evidence*.
- `rules.ts` FactSheet: pure functions with exact minor-unit money. Covers captured, completed and pending refunds, remaining refundable, open disputes, in-app pending or unknown attempts, locks, currency mismatch, conflicting statuses, missing evidence and refund blockers. `checkRefundAmount()` is ready for the guardrails.
- Investigator: a planning step can request ≤6 read-only lookups (`get_order/get_refund/get_dispute/search_events`), only for IDs already in the evidence; 60s budget. The report must match the §7 schema. Code strips uncited findings and invalid IDs. Chat answers are citation-checked too.
- §7 safety rules are in every prompt verbatim, and all free text is wrapped in `<untrusted>`.
- Migration 002 adds a real `stage`/`stage_detail` (the UI polls the true pipeline state; no fake progress) and `investigation_messages`.
- API: `POST/GET /api/investigations`, `GET /:id`, `POST /:id/chat`, `POST /:id/refresh-evidence`, `GET /:id/audit`. AI endpoints are rate-limited (12/min).
- UI: investigations list, new-investigation form, three-panel workspace (FactSheet, cited findings with clickable evidence chips, "allegation only" tag, removed-claims notice, root cause with an "estimate" meter, timeline with verified/app/merchant/missing markers, chat, eligibility card, Markdown copy/download). The council panel says "Not built yet".

**Verified live (2026-11-12)**
- Investigation `inv_7833cb461c58` on order `2N3925934C459540S`: real PayPal evidence via MCP, 2 allowlisted lookups, report by `gemini-3.5-flash`. All findings cited, 0 stripped, FactSheet respected. A 503 was retried automatically, and the UI showed the real retry status.
- Live chat answer was correct and cited `EV-001,EV-002`.
- `npm run check:ai` now does a live call per role model (the list alone was misleading); all three models pass.
- Headless-Chrome screenshot of the workspace confirms it renders.

**Found and fixed live**
- Gemini's JSON-schema mode returns 400 for `maxLength/maxItems`. Those are stripped in the request; Zod still enforces them.
- `gemini-2.5-*` are listed but 404 for new keys; Pro and 4-* have no free quota. Defaults are now `gemini-3.5-flash` (investigator, advocate), `gemini-3-flash-preview` (challenger), `gemini-3.6-flash` (judge), with `gemini-3-flash-preview` as fallback.
- `.env` had `AI_MODEL_JUDGE=22` (stray). It's blanked so the default is used.

**Tests:** server 77/77, client 14/14, typecheck clean.

## Phase 1 report

**Implemented**
- Monorepo (npm workspaces): `server/` (Express 5, TS, Zod 4, better-sqlite3, pino) and `client/` (React 19, Vite, Tailwind 4, TanStack Query, Recharts, lucide). Root `dev/build/test/start/seed:sandbox/test:sandbox` scripts.
- Hygiene: `.gitignore`, `.env.example`, MIT `LICENSE`, Sandbox-only boot guard (verified: `PAYPAL_ENVIRONMENT=LIVE` makes the process exit with code 1), pino redaction plus a token scrubber.
- `001_init.sql` with all §5 tables, applied on boot.
- PayPal layer: OAuth client-credentials auth with refresh 5 min before expiry (emits `token`, which restarts the MCP child). The managed `@paypal/mcp` stdio child is pinned as a dependency and spawned with `node`, not `npx`; it restarts with backoff and has 15s/30s timeouts. An allowlisted registry validates arguments with Ajv against the discovered `inputSchema`, and writes require `{approved:true}`. The REST fallback is used only when MCP is down before a call, and sends `PayPal-Request-Id` for refunds.
- Explorer merges Transaction Search (31-day chunks, paging) with `demo_orders` fetched live. A 403 is surfaced with the dashboard hint.
- API: `/api/health`, `/api/settings/integration-status`, `POST /api/settings/test-connection` (read-only), `/api/transactions`, `/api/transactions/:id/details`, `/api/dashboard/summary`.
- UI: shell (sidebar, SANDBOX pill, global ID search), Overview (KPIs, activity and refund charts, pipeline, audit feed), Transactions (filters, sort, pagination, refresh, detail drawer with "Investigate with AI"), Settings (MCP and AI status, token countdown, test connection). Unbuilt sections say "Not built yet" and simulate nothing.
- Scripts: `npm run test:sandbox` (read-only live smoke) and `npm run seed:sandbox -- create|capture|status` (**write; not run**).

**Verified live**
- The backend spawned its own MCP child, which reported `PayPal 1.11.0`, `ready`, 28 tools; all 9 allowlisted tools were discovered (dummy token, no PayPal calls).
- The production build serves the SPA and API from a single Express process (`GET /` 200, SPA fallback 200, `/api/health` ok).

**Tests:** server 30/30 pass; client 7/7 pass. Typecheck is clean for both.

**Notes and decisions**
- TypeScript 7's native `tsc` binary is being SIGKILLed on this Mac (even `tsc --version`), so it's pinned to TS 5.9.
- `@paypal/mcp` npm version is 1.8.1; it reports itself as `PayPal 1.11.0` (agent-toolkit version).
- MCP `create_refund` has **no idempotency parameter**. The app-level `idempotency_key` plus the lock is the guard on the MCP path.
- `@paypal/mcp`'s `accept_dispute_claim` validates `note` against an ID regex (`^[A-Za-z0-9_-]{1,255}$`), which looks like an upstream bug. Notes must be slug-like on the MCP path.
- `npm audit`: 13 advisories from `@paypal/mcp`'s transitive dependencies (not app code).
- AG Grid was skipped. The custom table is done and tested.

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

- ~~**B1. Transaction Search 403.**~~ **Resolved 2026-11-11 23:52.** Client-credentials token works; live `list_transactions` returns data via MCP. Original note: Enable *Transaction Search* for the Sandbox app in the PayPal Developer Dashboard (My Apps & Credentials → app → Features), then regenerate credentials. Until then, the explorer can only show orders this app creates (`demo_orders`).
- ~~**B2.**~~ **Resolved.** AI provider is Gemini (`AI_PROVIDER=gemini`); `npm run check:ai` passes for all 4 role models.
- ~~**B3. No Sandbox orders exist yet.**~~ **Resolved 2026-11-12.** Seeded and captured: 2N3925934C459540S→0NM23031PE726202M ($42, untouched), 15E54074HC612730M→06W69011L3412890N ($64, for partial refund), 0U257756FL616983T→5PU26238R4698633N ($25, for full refund). The first buyer was an INR/India account and got INSTRUMENT_DECLINED; a US personal buyer worked. Original note: Live `get_order` can't be verified until orders are seeded. `npm run seed:sandbox -- create` is a PayPal write and needs merchant go-ahead.

## Acceptance criteria (§17)

1. [ ] App launches; dashboard loads; SANDBOX visible everywhere
2. [x] Backend MCP client spawns `@paypal/mcp`, discovers tools, Settings shows status (verified 2026-11-11 with a dummy token; live calls pending B2)
3. [x] Real Sandbox transactions and orders/captures are retrieved and displayed (verified live 2026-11-12: 3 captured demo orders via get_order + Transaction Search row, merged in /api/transactions)
4. [x] Investigation produces a schema-valid, evidence-cited report (live, inv_7833cb461c58)
5. [x] UI shows the evidence behind each finding (chips scroll to and highlight the timeline item)
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
