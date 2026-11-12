# Refund Detective — Build Status

_Last updated: 2026-11-12 12:30 IST. Phases 1–5 code and docs complete. Remaining: public repo, deploy, video (merchant actions)._

## Demo data run (2026-11-12, afternoon)
- 6 more Sandbox orders created, buyer-approved and captured (USD 467.14 captured in total). The buyer opened 2 real disputes: `PP-R-ULM-10200163` (DUPLICATE_TRANSACTION, $17.25) and `PP-R-NAL-10200165` (not received, $54.00). PayPal then created its own PENDING refunds ($16.10 and $51.16) and put both captures in PENDING.
- 5 live investigations (`inv_f183fad13922`, `inv_e5a76ba8e22f`, `inv_927a5d49b1ca`, `inv_f51606e58e87`, `inv_33e517302603`), all fully cited.
- Councils:
  - damaged lamp $30.00 → **APPROVE** (0.95; executable, not executed);
  - wrong size $38.50 → NEEDS_MORE_INFO, and late delivery $15.00 → REJECT. The Judge caught that the complaint's timeline ("returned yesterday", "9 days late") contradicts a capture two hours earlier;
  - charged twice $17.25 → REJECT, and the guardrails also failed `no_refund_in_progress` and `no_open_dispute`;
  - accept claim on `PP-R-NAL-10200165` → REJECT, whose rationale wrongly assumed the merchant created the $51.16 refund. Re-run → ESCALATE_TO_HUMAN: the Challenger's model timed out and its fallback returned 503.
- Fixes:
  - the dispute normalizer used the buyer transaction ID as the capture ID;
  - the FactSheet now labels each refund `refund_detective` or `outside_app`, with a code-generated *inference* note when an outside pending refund coincides with an open dispute;
  - an applied migration had been edited (Event Monitor 500); this now moved to 005, with a checksum guard.
- The Gemini free tier's daily quota ran out again on `gemini-3.5-flash` and `gemini-3.6-flash` during this run.

## Phase 4–5 report

**Implemented**
- **Disputes:** live list and detail (redacted), an AI summary whose key facts must cite real payload fields, and council `dispute_accept` with its own guardrails (dispute open live; no refund in progress). Accepting requires the exact confirmation, a lock and one execution per deliberation (`dispute_actions`). The note is a slug to satisfy @paypal/mcp's regex, and the result is verified with `get_dispute`. The no-evidence-submission limitation is stated in the UI.
- **Webhooks (backend only; the Event Monitor page was removed because Sandbox delivered no events without a public URL):** signature verification via PayPal `verify-webhook-signature`, dedupe on event ID, related-ID linking, redaction. Unverified events are never evidence. Without `PAYPAL_WEBHOOK_ID`, investigations list webhooks as missing evidence; nothing is simulated.
- **Insights:** metrics from real data (payments, volume, refund rate, status mix, disputes, council verdicts, guardrail overrides, uncited claims removed). The AI summary must cite metric keys; uncited observations are removed. No savings or impact claims.
- **Demo mode** (no PayPal credentials only): `DEMO-` sample rows, a banner on every page, and investigations, councils and refunds refused.
- **Responsive:** verified with CDP device emulation at 390px; no horizontal overflow on Overview, Transactions, the investigation workspace, Insights or Settings.
- **Submission:** README, architecture (Mermaid), MCP tool inventory, investigation methodology, decision council, demo script, Devpost draft, 9 screenshots, `render.yaml`, clean production build verified.
- **Privacy:** Settings showed the absolute DB path (it contains the OS username); it now shows a repo-relative path. The secret and PII scan of tracked files and full git history is clean.

**Not verified live (stated in the docs):** dispute accept (the Sandbox has no disputes), webhooks (no tunnel configured), the Anthropic adapter (no key). The Insights AI summary hit the Gemini free-tier **daily** quota (20 requests per model per day); the metrics endpoint works live.

**Tests:** server 139/139, client 26/26.

## Phase 3 report

**Implemented**
- Decision Council (`server/src/services/council/`): Advocate (100% for) and Challenger (100% against) run in parallel via `Promise.all`, isolated, on different models. There's an optional single rebuttal round (`COUNCIL_REBUTTAL`). A code citation check marks `invalid_citation`/`uncited` before the Judge. If either side fails, the outcome is `ESCALATE_TO_HUMAN` without a Judge ruling. The Judge returns the §8.3 schema. Guardrails are stricter-only, against a FactSheet **recomputed from live PayPal data**: remaining ≤ 0 → REJECT; over remaining → cap (APPROVE_MODIFIED); currency mismatch, pending refund, lock or unknown attempt → REJECT; open dispute → ESCALATE; confidence < 0.6 → NEEDS_MORE_INFO; hidden refunds → REJECT. The real stage is persisted and audited per role.
- Refund flow (`server/src/services/refund/`): `validate` (live), and `approve`, which requires a passing verdict for the exact capture and amount, the exact confirmation label, a live re-validation, the operation lock (409), a `requested` row with a UUID idempotency key, one refund per deliberation (unique index), `create_refund` exactly once, `get_refund` verification, reconciliation on an unknown outcome, lock release and audit.
- UI: council panel (For/Against columns, struck-through uncited arguments, safer alternative, progressive status, verdict card with guardrail result row) and refund modal (live eligibility, IDs and amounts, "I authorize this Sandbox refund", button labelled with the exact amount).

**Verified live (2026-11-12)**
- **Real Sandbox refund:** `5YE09135FX432004L`, USD 20.00 on capture `06W69011L3412890N` (order `15E54074HC612730M`). PayPal returned COMPLETED, verified via `get_refund`. App refund `rf_18f82a383c82`, idempotency key recorded. Audit trail: investigation_requested → evidence_collected → report_generated → council_requested → argument_submitted ×2 → verdict_issued → guardrails_applied → refund_approved → refund_executed.
- Replaying the same approval returned 409 `ALREADY_EXECUTED`; no PayPal call.
- **Duplicate/over-refund attempt:** council on USD 64.00 for the partially refunded capture. The Challenger cited the completed 20.00 refund and the 44.00 remaining; the Judge ruled REJECT (confidence 1.0); nothing executable.

**Serious bug found by live verification and fixed**
- PayPal's `get_order` response **does not list refunds** (`payments` contains only `captures`), so the FactSheet showed 0.00 refunded and 64.00 remaining after the refund. The test fakes had assumed otherwise.
- Fix: refunds now come from `get_refund` for every refund the app created (and any listed), attached to the capture via PayPal's `up` link. Fail-safe: `REFUNDED` means 0 remaining; `PARTIALLY_REFUNDED` with no visible refunds means remaining unknown, and the refund is blocked. Reconciling an unknown outcome uses Transaction Search T11xx events (`paypal_reference_id` = capture) plus `get_refund`. Test fakes now mirror the real PayPal shape.
- Gemini free-tier resilience: per-role fallbacks (the parallel agents never share a model), fallback-first on 429/5xx, and a per-attempt timeout cap.

**Tests:** server 119/119, client 19/19.

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

- **Open:** public GitHub repo, Render deploy and the demo video need the merchant (accounts and recording). The Gemini free-tier daily quota resets at midnight Pacific.


- ~~**B1. Transaction Search 403.**~~ **Resolved 2026-11-11 23:52.** Client-credentials token works; live `list_transactions` returns data via MCP. Original note: Enable *Transaction Search* for the Sandbox app in the PayPal Developer Dashboard (My Apps & Credentials → app → Features), then regenerate credentials. Until then, the explorer can only show orders this app creates (`demo_orders`).
- ~~**B2.**~~ **Resolved.** AI provider is Gemini (`AI_PROVIDER=gemini`); `npm run check:ai` passes for all 4 role models.
- ~~**B3. No Sandbox orders exist yet.**~~ **Resolved 2026-11-12.** Seeded and captured: 2N3925934C459540S→0NM23031PE726202M ($42, untouched), 15E54074HC612730M→06W69011L3412890N ($64, for partial refund), 0U257756FL616983T→5PU26238R4698633N ($25, for full refund). The first buyer was an INR/India account and got INSTRUMENT_DECLINED; a US personal buyer worked. Original note: Live `get_order` can't be verified until orders are seeded. `npm run seed:sandbox -- create` is a PayPal write and needs merchant go-ahead.

## Acceptance criteria (§17)

1. [x] App launches; dashboard loads; SANDBOX visible everywhere (SANDBOX pill in the top bar on every page; boot refuses non-SANDBOX)
2. [x] Backend MCP client spawns `@paypal/mcp`, discovers tools, Settings shows status (live: 28 tools, all reads and the refund write served via MCP)
3. [x] Real Sandbox transactions and orders/captures are retrieved and displayed (verified live 2026-11-12: 3 captured demo orders via get_order + Transaction Search row, merged in /api/transactions)
4. [x] Investigation produces a schema-valid, evidence-cited report (live, inv_7833cb461c58)
5. [x] UI shows the evidence behind each finding (chips scroll to and highlight the timeline item)
6. [x] Decision Council runs Advocate and Challenger in parallel, and the Judge's verdict is persisted and displayed
7. [x] Guardrails independently validate eligibility and can override the Judge
8. [x] Refund requires explicit merchant approval
9. [x] An authorized Sandbox refund executes, and `get_refund` verifies it (5YE09135FX432004L, USD 20.00, COMPLETED)
10. [x] Audit log records investigator, council and refund actions
11. [x] Duplicate-refund scenario is blocked
12. [x] Errors and empty states are handled; Demo mode is clearly labelled
13. [x] README lets a stranger run it; MIT LICENSE present
14. [~] No secrets in the repo or history (scanned, clean); run instructions in README; **public repo and Render URL pending merchant action**
15. [~] Devpost draft complete (docs/devpost-submission.md); **video pending (merchant records; script in docs/demo-script.md)**
