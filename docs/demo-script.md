# Demo video script (under 3:00)

Real footage only, against PayPal Sandbox. No copyrighted music. Record at 1440×900 or larger, with the browser zoomed to 90–100%.

## Before recording (about 10 minutes)
1. Run `npm run check:ai`. All role models must PASS. On the Gemini free tier each model allows about 20 requests per day, so record on a day you haven't used up the quota, or enable billing on the key.
2. Run `npm run dev` and open http://localhost:5173.
3. Use the **$25.00 order `0U257756FL616983T`** (capture `5PU26238R4698633N`, untouched) for the live refund. Its seed label is "full-refund".
4. Optional rehearsal: start the investigation for that order once before recording. Recording the live run is better, though: it shows the real pipeline stages.
5. Close other tabs, hide bookmarks, and make sure nothing in view shows an email address or account name.

## Shot list

| Time | Scene | On screen | Voice-over (suggested) |
|---|---|---|---|
| 0:00–0:15 | **Problem** | Title card, then the Overview | "A customer writes: 'I was charged but never got confirmation.' Today a merchant juggles the PayPal dashboard, transaction search, refunds and disputes to work out what happened, and then guesses whether to refund." |
| 0:15–0:35 | **Overview** | The SANDBOX pill; KPIs (payment attempts, $131 captured, refunds); then **Transactions**, open the $25 order's drawer | "Refund Detective runs on the PayPal Sandbox through PayPal's own MCP server, which our backend owns. These are real Sandbox transactions: captures, refunds, and even the declined attempts." |
| 0:35–1:10 | **Investigate** | **Investigate with AI**, complaint "I was charged $25 but never got a confirmation email, please refund me." Show the live stages (Collecting PayPal evidence → Investigator reviewing evidence → writing the report). Then the FactSheet, findings with EV chips (click one to show it highlighted in the timeline), the **allegation only** tag, root cause at ~80% (**estimate**), and missing information | "The backend, not the AI, collects the evidence and numbers it. Code computes the FactSheet: captured, refunded, remaining. The AI must cite evidence for every claim; uncited claims are removed by code. The complaint is an allegation, not proof." |
| 1:10–1:45 | **Decision Council** | Set the amount to 25.00 → **Convene council**. Show "Advocate thinking… Challenger thinking…", the For/Against columns, a struck-through uncited argument if one appears, the Challenger's safer alternative, and the verdict card with guardrail result "all checks passed" | "Every money-moving decision goes to an adversarial council. One agent argues for and one against, in parallel and blind to each other. An impartial Judge rules, then deterministic guardrails check the verdict against live PayPal data. They can only make the outcome stricter." |
| 1:45–2:15 | **Resolve** | **Review & approve refund · USD 25.00** → the modal re-checks live (original 25.00, refunded 0.00, remaining 25.00) → tick **I authorize this Sandbox refund** → **Refund USD 25.00** → "PayPal Sandbox reports COMPLETED", verified with `get_refund` → **Refunds** page → the Overview's recent activity audit feed | "Nothing executes until I confirm, on a button that carries the exact amount. The server re-validates live, takes a lock, calls create_refund exactly once, and only trusts PayPal's own get_refund status. Every step is audited." |
| 2:15–2:40 | **Safety moment** | Same investigation → **Convene council** again for 25.00. The Challenger flags the already-refunded capture; the outcome is REJECT; the Review button is disabled. Optionally show the earlier REJECT on the $64 order (`inv_4965eef2dd21`) | "Try to refund it again. The Challenger cites the completed refund, and the guardrails see 0.00 remaining from live PayPal data. Blocked. Replaying the old approval is refused too: one refund per approval, ever." |
| 2:40–2:55 | **Close** | Investigation workspace, wide shot | "Refund Detective turns payment confusion into evidence-based action. AI recommends, code validates, you approve." |

## Fallbacks if something goes wrong while recording
- **AI rate limit** (the banner says "Waiting … for the AI rate limit"): keep recording if it recovers within a few seconds. Otherwise stop and re-record that scene later. Never edit in a fake result.
- **The council escalates** because a model timed out: that's a real safety behaviour and fine to show ("the Judge never rules on one side"). Re-convene for the happy path.
- **Already used up the $25 order:** the $42 order `2N3925934C459540S` (capture `0NM23031PE726202M`) already has an APPROVE council for USD 42.00 (`inv_7833cb461c58`).
