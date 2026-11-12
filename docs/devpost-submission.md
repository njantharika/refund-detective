# Devpost submission draft: Refund Detective

> Fill in the placeholders marked ⟨…⟩ before submitting. Every claim below was run and verified in PayPal Sandbox; nothing here claims a prize or a business impact.

**Project name:** Refund Detective
**Tagline:** Every payment has a story. Let AI investigate it.
**Elevator pitch (≤200 chars):** Refund Detective investigates PayPal payment complaints with cited evidence, debates every refund in an adversarial AI council, and refunds only after code guardrails and merchant approval.
**Links:** Demo video ⟨public YouTube URL⟩ · Repo ⟨public GitHub URL⟩ · Live demo ⟨Render URL⟩
**Who it's for:** small and mid-size online merchants and their support or operations staff, who handle "where's my order / I was charged / refund me" messages without a payments team.
**New project:** built from scratch during the Submission Period (November 11–12, 2026).
**Sponsor tools used:** Render (hosting the live demo as a single web service, via `render.yaml`).

## Inspiration
When a customer says "I was charged but never got confirmation", the merchant has to piece together orders, captures, refunds and disputes from several screens. Then they make a money-moving decision under pressure. Refunding twice, refunding during an open dispute, or refunding on an unverified claim are all easy mistakes. We wanted an AI that *investigates* rather than chats, and that can't move money on its own.

## What it does
- **Evidence-first investigator.** The backend collects live PayPal evidence (order, captures, refunds, disputes, verified webhooks) through PayPal's MCP server and numbers it (`EV-001`…). Code computes a deterministic **FactSheet**: captured, refunded and remaining amounts, plus blockers. A Gemini investigator writes a report in which **every finding must cite evidence**; code deletes uncited claims. Complaints are treated as allegations.
- **Adversarial Decision Council.** For every money-moving decision:
  - an **Advocate** argues 100% for and a **Challenger** argues 100% against, in parallel and blind to each other, on different models;
  - code flags any argument with fake citations;
  - an impartial **Judge** rules;
  - deterministic **guardrails**, recomputed from live PayPal data, can only make the outcome stricter.
- **Controlled resolution.** A refund needs:
  - a passing verdict;
  - a live re-validation;
  - a lock and an idempotency key (one refund per approval, ever);
  - the merchant's explicit confirmation on a button showing the exact amount.

  It executes once via `create_refund`, is verified with `get_refund`, and is fully audited.
- **Also included:** a transactions explorer, disputes with a council-gated "accept claim", signature-verified PayPal webhooks as evidence, metric-cited Insights, a Settings page with MCP and AI health, and a clearly labelled Demo mode when no credentials are set.

## How we built it
- **PayPal:** the backend spawns and owns `@paypal/mcp` (agent toolkit 1.11.0) over stdio and discovers its 28 tools. It allowlists 9 of them and validates every call's arguments against the advertised schema.
  - Reads: `list_transactions`, `get_order`, `get_refund`, `list_disputes`, `get_dispute`.
  - Writes, approval-gated: `create_refund`, `accept_dispute_claim`.
  - Seeding: `create_order`, `pay_order`.
  - OAuth client-credential tokens refresh automatically and restart the MCP child. A REST fallback is used only if MCP is down. Webhook signatures are verified with PayPal's API.
- **AI:** Google Gemini via its OpenAI-compatible endpoint, with JSON-schema structured output validated by Zod. Investigator and Advocate use `gemini-3.5-flash`, the Challenger `gemini-3-flash-preview`, and the Judge `gemini-3.6-flash`. Each role has its own fallback model.
- **Stack:** Node 22, TypeScript, Express 5, SQLite (better-sqlite3), React 19, Vite, Tailwind 4, TanStack Query, Recharts. 145 server and 26 client tests (Vitest).
- **Developer tools:** **Claude Code** (Anthropic, Claude Opus 5.5) was the AI coding assistant used to design, implement, test and document the project. We also used the PayPal Developer Sandbox, VS Code, and headless Chrome (DevTools protocol) for screenshots and 390px responsive checks.

## Challenges we ran into
- **Refunds are invisible in `get_order`.** After our first real Sandbox refund, live verification showed the FactSheet still at "0.00 refunded". PayPal's Orders API never lists refunds. We now discover refunds through `get_refund` and PayPal's `up` links, and we **fail safe**: a capture reported as `PARTIALLY_REFUNDED`, with refunds we can't see, blocks further refunds instead of guessing.
- **No idempotency key on MCP `create_refund`.** We built app-level idempotency (a unique key per refund, one refund per approval) plus locks and reconciliation for unknown outcomes. `create_refund` is never retried.
- **Free-tier AI limits.** The per-minute and per-day quotas caused a timed-out report and a hung council call during testing. The fixes: per-role fallback models (the parallel agents never share one), switching to the fallback first on 429/5xx, and per-attempt timeouts. When a model fails, the council escalates to a human rather than letting the Judge rule on one side.
- **Sandbox realities:** a buyer from another currency or country was declined, declined capture attempts stay on the order, and Transaction Search indexing lags. Each one is handled explicitly and surfaced in the UI.

## Accomplishments that we're proud of
- **A real end-to-end Sandbox refund:** `5YE09135FX432004L`, USD 20.00. Investigation → council (APPROVE, 0.95) → merchant approval → `create_refund` → `get_refund` COMPLETED, with 13 audit entries.
- **A live block of a duplicate refund:** asked to refund the full 64.00 after the 20.00 refund, the Challenger cited the completed refund and the Judge rejected it. Replaying the old approval returned `409 ALREADY_EXECUTED`.
- **A prompt-injection test** in which the mock Judge *obeys* the injected instruction, and the guardrails still block the refund.

## What we learned
LLMs are good at weighing evidence and terrible at being the source of truth for money. Splitting the work — facts from PayPal and code, judgement from an adversarial council, the decision from a human — gives you an AI you can let near a refund button.

## What's next
- Multi-merchant authentication and roles (approver vs. investigator).
- Evidence submission for disputes, once an API or MCP tool exists for it.
- Live webhook-driven re-investigation when a dispute opens.
- Durable storage (Postgres) and a paid AI tier for production quotas.

## Built with
`paypal-mcp` · `paypal-rest-api` · `paypal-sandbox` · `google-gemini` · `claude-code` · `typescript` · `node.js` · `express` · `react` · `vite` · `tailwindcss` · `sqlite` · `zod` · `vitest`

## Testing instructions for judges
**Hosted demo:** ⟨Render URL⟩. It is connected to our PayPal **Sandbox** merchant and Gemini, with no login. Open **Transactions**, pick a captured payment, then **Investigate with AI** → **Convene council** → (on APPROVE) **Review & approve refund**. Only Sandbox money moves. The free instance may take about 30 seconds to wake up.
**Run locally:** see the README "Quick start". You need a PayPal Sandbox app (client ID and secret) and a Gemini API key. Without PayPal credentials the app runs in a clearly labelled **Demo mode**: sample data only, with investigations and refunds disabled.
