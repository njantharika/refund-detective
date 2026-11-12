# Demo video: run of show (target 2:45, hard limit < 3:00)

The rules say the video must:
- be **< 3 minutes**; judges are not required to watch beyond that;
- show **footage of the project functioning**;
- be **public on YouTube**;
- contain **no third-party trademarks or copyrighted music** without permission.

It is also scored on *Presentation*: "Does the video clearly demonstrate the project working end-to-end? Does the pitch communicate what problem is solved, who it's for, and why it matters?"

## 0. Pre-flight (15 minutes, before you press record)
1. **AI quota.** Enable billing on the Gemini key in Google AI Studio. The free tier allows about 20 requests per model per day, and the demo makes about 9 calls live. Then run `npm run check:ai`; every line must say PASS.
2. **App running:** `npm run dev`, then open http://localhost:5173.
3. **Demo order:** the $25.00 Trench Coat, order `0U257756FL616983T`, capture `5PU26238R4698633N`. It is COMPLETED, with no refunds, disputes or investigations.
4. **Clean browser** (trademark rule plus privacy):
   - Use a **new Chrome profile or Guest window**, so there is no profile avatar, extensions or bookmarks.
   - Hide the toolbar's "Ask Gemini" button, which is a third-party logo.
   - Better still, record the page area only: macOS **⌘⇧5 → Record Selected Portion**, drawn around the web page.
   - Zoom to 100% in a 1440×900 or larger window.
5. **Never on screen:** `.env`, terminals with keys, the PayPal developer dashboard credentials page, and real email addresses.
6. **Microphone:** ⌘⇧5 → Options → your microphone. Do a 5-second test and play it back.
7. Close notifications (Do Not Disturb on).

## 1. Shot list

| # | Time | Do this on screen | Say this (about 140 words per minute) |
|---|---|---|---|
| 1 | 0:00–0:15 | **Overview** page, still | "Small online merchants get messages like 'I was charged but never got confirmation.' Answering means digging through orders, captures, refunds and disputes, then guessing whether to refund. Refund double, or during a dispute, and you lose money twice. Refund Detective fixes that." |
| 2 | 0:15–0:30 | Point at the **SANDBOX** pill, the KPI tiles (13 attempts, $395.89 captured, 2 open disputes), then click **Transactions** | "It runs on PayPal Sandbox through PayPal's MCP server, which our backend owns. Everything here is real Sandbox data: captures, refunds, declined attempts and two buyer-opened disputes." |
| 3 | 0:30–1:05 | Click the **$25.00** row → drawer → **Investigate with AI** → paste the complaint* → **Start investigation**. Let the stages show (*Collecting PayPal evidence → Investigator reviewing → writing the report*). If you cut the wait, put **"sped up"** on screen. Then point at the **FactSheet** strip at the top (captured, refunded, remaining), and on the **Report** tab the findings, the **allegation only** tag and the root cause with **estimate**. Click an **EV chip**: it jumps to the **Evidence** tab and highlights that item. Click **← Back to Report** | "The backend, not the AI, gathers the PayPal evidence and numbers it. Code computes the FactSheet: captured, refunded, what's left. The AI must cite evidence for every claim, and code deletes anything uncited. The customer's complaint counts as an allegation, not proof." |
| 4 | 1:05–1:40 | Click the **Council** tab, amount **25.00** → **Convene council**. Show *Advocate thinking… Challenger thinking…*, then the For and Against columns and the Challenger's safer alternative. The verdict card shows APPROVE and **Guardrail result: all checks passed** | "Every money-moving decision goes to an adversarial council. One agent argues for, one against, in parallel and blind to each other. An impartial judge rules. Then deterministic guardrails check the verdict against live PayPal data, and they can only make it stricter." |
| 5 | 1:40–2:10 | **Review & approve refund · USD 25.00** → the modal re-checks live (original 25.00, refunded 0.00, remaining 25.00) → tick **I authorize this Sandbox refund** → **Refund USD 25.00** → *PayPal Sandbox reports COMPLETED* → **Done** → click the refund under Resolution → **refund detail page** (live PayPal status, verdict, audit trail) | "Nothing moves until I confirm, on a button that carries the exact amount. The server re-validates live, locks the payment, calls PayPal's create_refund exactly once, and only trusts PayPal's own get_refund status. Every step is in the audit trail." |
| 6 | 2:10–2:35 | Back to the investigation → **Council** tab → **Convene council** again with 25.00 → it ends **REJECT** and the Review button is disabled. Optionally cut to the charged-twice case (`inv_f51606e58e87`), where the verdict card shows guardrails failing on an open dispute and a refund already in progress | "Try to refund it again. The Challenger cites the completed refund, and the guardrails see zero left from live PayPal data. Blocked. With an open dispute, refunding is blocked too, because that's how merchants lose money twice." |
| 7 | 2:35–2:50 | Investigation workspace, **Report** tab, wide shot (FactSheet strip and the Resolution sidebar in one frame) | "Refund Detective turns payment confusion into evidence-based action. The AI recommends, code validates, and the merchant approves." |

\*Complaint to paste in shot 3: `I was charged $25 for the trench coat but never got an order confirmation email. Please refund me.`

## 2. Editing (15 minutes)
- macOS: open the recording in QuickTime and use **Edit → Trim**. For jump cuts use iMovie, which is free.
- You may **cut waiting time**, but don't change results. Add a small "sped up" or "cut: waiting for AI" caption where you cut.
- **No music**, or only royalty-free music you have rights to. Silence is fine.
- The total must be **under 3:00**; aim for 2:45.
- Export at 1080p.

## 3. Upload
1. YouTube → Create → Upload video. Title: `Refund Detective — AI payment investigation with an adversarial Decision Council (PayPal AI Hackathon)`.
2. Visibility: **Public**. Unlisted may not count as "publicly visible".
3. Description: the one-liner, plus links to the repo and the live demo.
4. Paste the YouTube link into the Devpost form.

## If something goes wrong while recording
- **"Waiting … for the AI rate limit"** for a long time: stop and re-record that shot. Never edit in a result that didn't happen.
- **The council escalates** because a model timed out: this is real safety behaviour ("the Judge never rules on one side"). Re-convene for the happy path.
- **The $25 refund is already done** after a failed take: use the $10.00 Gift Card order `36T98649RR6226333` (capture `3XM803269K147420R`) and say "$10" in the voice-over.
