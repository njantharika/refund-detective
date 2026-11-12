# Architecture

Refund Detective is a single Node service. Express serves the built React client and the JSON API, and it owns a `@paypal/mcp` child process over stdio. State lives in SQLite. There are no queues or microservices.

```mermaid
flowchart LR
  subgraph Browser
    UI[React UI<br/>Vite · Tailwind · TanStack Query]
  end

  subgraph Server["Node service (Express)"]
    API[REST API<br/>Zod validation · 100kb limit · rate-limited AI routes]
    EX[Explorer<br/>Transaction Search + app-created orders]
    INV[Investigation pipeline<br/>collect → normalize → FactSheet → LLM]
    CNC[Decision Council<br/>Advocate ∥ Challenger → Judge → Guardrails]
    RF[Refund service<br/>validate · lock · idempotency · verify · reconcile]
    DS[Dispute service<br/>council-gated accept]
    WH[Webhook service<br/>signature verify · dedupe]
    REG[Tool registry<br/>allowlist · Ajv schema validation · timeouts · token guard]
    AUTH[PayPal OAuth<br/>client credentials · refresh]
    AI[AI provider<br/>Zod-validated JSON · retries · per-role fallback]
    DB[(SQLite<br/>investigations · evidence · deliberations<br/>refunds · locks · webhook_events · audit_log)]
  end

  MCP["@paypal/mcp<br/>(child process, stdio)"]
  PP[(PayPal Sandbox APIs)]
  GEM[(Google Gemini<br/>OpenAI-compatible API)]

  UI -->|/api/*| API
  API --> EX & INV & CNC & RF & DS & WH
  EX & INV & RF & DS --> REG
  REG -->|primary| MCP --> PP
  REG -.->|fallback only if MCP is down| PP
  AUTH -->|token via env; restart child on refresh| MCP
  WH -->|verify-webhook-signature| PP
  INV & CNC & DS --> AI --> GEM
  INV & CNC & RF & DS & WH --> DB
```

## Request flow: from complaint to verified refund

```mermaid
sequenceDiagram
  autonumber
  participant M as Merchant (UI)
  participant S as Server
  participant P as PayPal (via MCP)
  participant G as Gemini
  M->>S: POST /api/investigations {targetId, complaint}
  S->>P: get_order, get_refund×n, list_transactions, list_disputes
  S->>S: normalize → EV-### evidence, compute FactSheet (code)
  S->>G: plan lookups (≤6, IDs must exist in evidence)
  S->>G: InvestigationReport (Zod-validated)
  S->>S: strip uncited findings · persist · audit
  M->>S: POST /council {decisionType: refund, amount}
  S->>P: recompute FactSheet LIVE
  par isolated
    S->>G: Advocate (100% for)
  and
    S->>G: Challenger (100% against)
  end
  S->>S: citation check (invalid_citation / uncited)
  S->>G: Judge verdict
  S->>S: guardrails (stricter only) → executable amount or none
  M->>S: POST /refund/approve {deliberationId, amount, confirmationText}
  S->>P: re-validate live
  S->>S: lock capture · insert refunds row (UUID idempotency key)
  S->>P: create_refund (exactly once)
  S->>P: get_refund (verify)
  S->>S: release lock · audit
```

## Key modules

| Path | Responsibility |
|---|---|
| `server/src/config.ts` | Env parsing (Zod), the **Sandbox-only guard**, per-provider model defaults and per-role fallbacks |
| `server/src/services/paypal/paypal-auth.ts` | OAuth client credentials, refresh 5 minutes before expiry with retry and backoff, `isStale()` / `invalidate()` |
| `server/src/services/paypal/paypal-mcp-client.ts` | Spawns `node @paypal/mcp --tools=all` with the token in env, `listTools()`, restart with backoff, 15s/30s timeouts, clean shutdown |
| `server/src/services/paypal/paypal-tool-registry.ts` | Allowlist, Ajv validation against the advertised `inputSchema`, write gate, token guard (refresh before calls; one 401 recovery for reads only), REST fallback selection |
| `server/src/services/paypal/paypal-rest-fallback.ts` | The same operations over REST; used only when MCP is unavailable *before* a call |
| `server/src/services/investigation/` | `evidence.ts` (collection, redaction, EV IDs), `rules.ts` (FactSheet, pure), `money.ts` (minor units), `investigator.ts` (lookups, report), `prompts.ts` (safety rules, untrusted wrapping) |
| `server/src/services/council/` | `advocate.ts`, `challenger.ts`, `judge.ts` (prompts), `council.ts` (orchestration), `schemas.ts` (Zod schemas and citation check), `guardrails.ts` |
| `server/src/services/refund/refund.service.ts` | Validate, approve, reconcile |
| `server/src/services/dispute/dispute-resolution.service.ts` | Dispute list, detail and cited summary; council-gated accept |
| `server/src/services/paypal/paypal-webhook.service.ts` | Signature verification, dedupe, related-ID linking |
| `server/src/database/migrations/*.sql` | Schema, applied on boot |
| `client/src/pages/InvestigationWorkspace.tsx` | Three-panel workspace (case, report and timeline, chat and resolution) plus the council panel |

## Data model
Migrations `001`–`004` create:
- `investigations` (with a real `stage` for UI polling)
- `evidence` (redacted payloads)
- `deliberations` (proposal, both arguments, rebuttals, judge, guardrails, live FactSheet, executable amount)
- `refunds` (`idempotency_key UNIQUE`, unique per `deliberation_id`)
- `operation_locks`
- `webhook_events` (`paypal_event_id UNIQUE`, `related_ids`)
- `dispute_actions` (unique per deliberation)
- `investigation_messages`
- `insight_summaries`
- `audit_log` (actor `merchant | system | ai:<role>`)
- `demo_orders` (orders this app created in Sandbox)

## Why the FactSheet is recomputed so often
State can change between the investigation, the council and the approval. A refund may happen elsewhere, or a dispute may open. The FactSheet is a pure function of live PayPal data plus the app's own records. It is recomputed live at three points: when the council starts (for the guardrails), when the approval modal opens, and inside `approve`, right before `create_refund`.
