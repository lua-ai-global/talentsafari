# Fix: Ada enrichment chat — wrong navigation + "Something went wrong"

The short-JD path (the Ada enrichment chat) had two layered problems:

1. **Navigation:** on completion it jumped straight to the final result screen (`s-result`),
   skipping Step 2 (the clarifying questions) and `s-analysis` (the email-gate / lead-capture form).
2. **Reliability:** the chat itself frequently failed with "Something went wrong" and never advanced,
   because it ran `score_jd` (slow, ~40s) and auto-chained `capture_lead` (premature Slack post +
   emails) on every completion.

All changes are in [index.html](../../index.html) (the `enrichment chat` section); no backend/skill
changes are required.

---

## Problem 1 — jumped to the last step instead of Step 2

For short job descriptions (< 20 words), the hero launches the **Ada enrichment chat** (`s-enrich`)
instead of the clarifying-questions screen.

The original `callEnrichApi()` detected completion when `score_jd` returned a valid score and then
called `go('s-result')` — skipping every screen in between, including `s-analysis`, which holds the
**lead-capture / email-gate form**. So the short-JD path never captured the lead and landed the user
on the final screen prematurely.

The normal (long-JD) path runs the full funnel:
`s-hero` → `s-questions` → `runAnalysis()` → `s-analysis` (theater + email gate) → `s-result`.

**Intended behavior:** Ada is part of Step 1 (input). When the enrichment chat completes, advance to
**Step 2 — the clarifying questions** (`s-questions`), then continue through the normal funnel.

---

## Problem 2 — "Something went wrong" / chat never advanced

Root cause, confirmed by reproducing the exact enrichment API calls:

- The enrichment **seed prompt told Ada to call `score_jd`**, so every completion ran the full
  scoring tool — **~41 seconds** for a long JD.
- Ada then **auto-chained `capture_lead`** (posts to Slack + sends two emails) — observed firing in
  a probe run. This is premature (the user hasn't gone through the funnel or given an email yet) and
  adds latency + failure surface.
- The combined request got heavy/slow enough to hit a network/gateway timeout, so the request failed
  → the UI showed **"Something went wrong"** → the navigation code never ran. The backend still
  finished scoring and *remembered* it, which is why a follow-up message replied "the evaluation is
  already done."

Key insight: since the enrichment chat now hands off to Step 2 (where the real scoring + email gate
happen via `callScoreApi()` and the lead form), **the enrichment chat does not need to score at
all.** It only needs to gather a little context and signal that it's done.

---

## The fix (current behavior)

The enrichment chat now **only gathers context** — no tools, no scoring, no email/Slack — and
advances to Step 2 on a completion token, with a hard cap so it can never get stuck.

1. **Seed prompt** (`startEnrichChat`): ask at most 4 short questions, **not** call any tools / score
   / email, and once the user has answered, reply with one short confirmation ending in the exact
   token `[[ENRICH_DONE]]`.
2. **Completion detection** (`callEnrichApi`): instead of parsing a `score_jd` tool result, read
   `data.text`, check for `ENRICH_DONE` (strip it before display), and advance when the token is
   present **or** after `ENRICH_MAX_ANSWERS` (= 4) user replies — the cap guarantees the chat always
   moves on. Otherwise show Ada's next question and continue.
3. **Advance + fold the JD** (`finishEnrich` + `buildEnrichedJd`): assemble an enriched JD from the
   gathered answers, write it to **both** `state.jdText` and the `#jd` textarea (so the later
   re-score uses the enriched text and won't re-trip the `short_jd` flag), then `go('s-questions')`.

### Verified against the live API
- Before: enrichment completion ≈ **41s**, with `score_jd` + `capture_lead`.
- After: each turn ≈ **3–4s**, **zero tool calls**; Ada emits `[[ENRICH_DONE]]` after the user's
  answer. No premature Slack/email.

---

## How to verify in the browser

1. Paste a **short** JD (< 20 words, e.g. "Customer support rep for our store") → **Score this
   role →**. The enrichment chat (`s-enrich`) appears and Ada asks one question within ~2–4s.
2. Answer it. Ada confirms (the `[[ENRICH_DONE]]` token is hidden) and the UI advances to
   **`s-questions` (Step 2 of 3)** — not the result screen, and with no "Something went wrong".
3. Answer the 3 clarifying questions → **Run the analysis →** → `s-analysis` runs the theater **and
   shows the lead-capture / email-gate form**.
4. Submit the form → `s-result` with a valid score that is **not** flagged `short_jd` (proves the
   enriched JD was used).
5. Regression: paste a normal long JD and confirm the standard path
   (`s-hero` → `s-questions` → `s-analysis` → `s-result`) is unchanged.
