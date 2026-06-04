# Plan: Ada asks the 4 high-leverage dimension questions (thin-JD intake)

## Context

**Why this change.** Today the scoring engine (`score_jd`) evaluates 7 weighted dimensions, but the user only supplies signal for 3 of them via the fixed multiple-choice Step 2 (`task_structure`, `volume_scale`, and a blunt `exposure` answer). The four hardest-to-infer, highest-leverage dimensions get **no direct user input** and are guessed purely from the JD text:

| Dimension | Weight | User signal today |
|---|---:|---|
| `judgment_complexity` | **2.0 (highest)** | none |
| `regulatory_burden` | 1.5 | only indirectly via exposure |
| `relationship_depth` | 1.3 | only indirectly via exposure |
| `system_integration` | 1.0 | none |

When the JD is thin (< 20 words), these guesses are at their weakest — yet that is exactly the path where today's enrichment chat asks only vague questions about "day-to-day tasks and rough daily volume" (which overlap the MCQs and add little new signal).

**Outcome.** On the thin-JD path, Ada will explicitly ask the user about these four dimensions — all four presented together as a list, re-asking only the ones answered insufficiently (hard cap of 4 turns) — then fold the answers into the JD context that flows to `score_jd`. The 3 MCQs and the entire long-JD flow stay exactly as-is.

**Decisions locked with the user:**
- Keep the 3 MCQs; **add** Ada's question step (it already exists as `s-enrich`).
- Run **only for thin JDs (< 20 words)** — the existing enrichment trigger.
- Feed answers to scoring by **folding into the JD context** (no schema/rubric change) — `buildEnrichedJd()` already does this.
- **Also update Ada's persona** to legitimize an intake mode (requires a gated `lua deploy`).

## Approach (minimal — reuse the enrichment machinery)

The enrichment chat in `index.html` already does 90% of this: triggers on < 20 words ([handleScoreClick, ~L906](../../index.html#L906)), asks questions with no tools, caps at 4 answers (`ENRICH_MAX_ANSWERS`), detects completion via the `[[ENRICH_DONE]]` token ([callEnrichApi, ~L1208](../../index.html#L1208)), folds answers into the JD ([buildEnrichedJd, ~L1162](../../index.html#L1162)), and advances to the MCQs ([finishEnrich, ~L1176](../../index.html#L1176)). **No control-flow JS changes are needed** — the batch-then-re-ask loop maps onto the existing token + answer-cap machinery. We only change the *seed prompt*, light copy, and the persona.

### 1. Rewrite the enrichment seed — the core change
File: `index.html`, in `startEnrichChat()` (the `const seed = ...` string, ~L1154).

Replace today's "ask about tasks/volume, one at a time" seed with one that:
- Presents **all four questions at once, as a numbered list**, in the first message (user asked for "list-wise, all asked together").
- Targets the four dimensions specifically (do **not** ask about work-structure / volume / who-they-interact-with — the 3 MCQs already cover those; avoiding overlap is an established principle, see `docs/llm.md` §8 / §11):
  1. **Judgment** — "When something unexpected or ambiguous comes up, does this role decide independently using deep expertise, or follow set policies / escalate to a senior person?"
  2. **Regulatory** — "Does the work legally require a licensed or certified human to sign off (e.g. compliance, legal, medical, financial advice)?"
  3. **Relationship depth** — "Does this person own long-term relationships (a named book of clients over months), or handle one-off, transactional interactions?"
  4. **System integration** — "How much of the day is in software tools / APIs / data vs. coordinating with people across teams and meetings?"
- Instructs Ada to read the user's reply, and **re-ask only the questions left vague or unanswered**, otherwise emit the `${ENRICH_DONE}` token. Keep the existing rules verbatim: **no tools, no scoring, no email**; token on its own line; no token in the first message.

Keep `ENRICH_MAX_ANSWERS = 4` (~L1145) as the hard turn cap the user asked for. No change to `callEnrichApi` loop logic.

### 2. Label folded answers by dimension (small quality tweak)
File: `index.html`, `buildEnrichedJd()` (~L1162).

Today it appends raw user answers as anonymous bullets. Since the questions now map to specific dimensions, prefix the folded block with a short header (e.g. `Clarifying answers (judgment / regulation / relationships / systems):`) so `score_jd`'s prompt can associate the context with the right dimensions. This stays purely additive text in `state.jdText` / `#jd` — no schema change. (Optional but recommended; keeps "fold into context" minimal.)

### 3. Update on-screen copy
File: `index.html`, `s-enrich` markup (~L635–648).

The intro line currently reads "Ada will ask you 3–4 quick questions, then score it automatically." Adjust to reflect that Ada asks a short set of questions about how the role actually works (no behavior change; keep it brief). Per repo convention, **no em dashes** in user-facing strings.

### 4. Add an intake-mode carve-out to Ada's persona
File: `src/index.ts` (persona string, ~L34–46).

Ada's persona currently says she must **never** ask clarifying questions and must always act via tools (the "Invocation contract"). The enrichment seed overrides this per-call today, but it is in tension with the contract. Add a tightly-scoped exception so questioning is legitimate and the questions are higher quality:
- A new short section (e.g. `## Intake / clarification mode`) stating: *when a message explicitly asks you to gather missing context by questioning the user and forbids tool calls, you may ask a short batch of questions (max 4 turns), never call a tool, and signal completion as instructed.*
- Guidance to ask the **four dimensions above**, warmly and concisely, one batched list, and to re-ask only genuine gaps.
- Leave the existing hard triggers (`Score this job description:` / `Call the capture_lead tool` / `Call the submit_cta tool`) and their "act immediately, never ask" rules **unchanged** — the exception applies only to the enrichment/intake prompt, which starts with none of those triggers.

## Files changed
- `index.html` — seed rewrite (primary), `buildEnrichedJd()` label, `s-enrich` copy. Deploys via Vercel (push to `review/latest-updates`).
- `src/index.ts` — persona intake-mode section. Deploys independently via the gated `/lua-deploy` flow.

No changes to `score-role.skill.ts` (rubric/schema), `capture-lead`, or any `/api/*` handler.

## Verification (end-to-end)

Local (`npm run dev` → http://localhost:3000, needs `.env` with `LUA_AGENT_ID` + `LUA_API_KEY`):
1. **Thin-JD path:** paste a < 20-word JD (e.g. "Customer support rep handling refunds") → confirm `s-enrich` opens and Ada's **first message lists all 4 questions** as a numbered list, asks no tool, no score.
2. Answer all four in one reply → Ada should accept and emit completion (advance to the 3 MCQs). Answer only partially → Ada should **re-ask just the gaps**; confirm it still advances by the 4th turn even if vague (cap).
3. Continue through MCQs → `s-analysis`; confirm the folded "Clarifying answers …" block is present in `state.jdText` (DevTools) and that scoring completes and renders a verdict on `s-result`.
4. **Long-JD path (regression):** paste a ≥ 20-word JD → confirm it goes **straight to the 3 MCQs** (no enrichment step), unchanged.
5. **Persona:** after `/lua-deploy`, run a sandbox `lua chat` with (a) the enrichment seed text → Ada asks the 4 questions, no tool call; (b) a `Score this job description:` message → Ada still calls `score_jd` immediately with no questions (contract intact).

Watch for: Ada calling a tool during enrichment (seed/persona regression), the `[[ENRICH_DONE]]` token leaking into a visible bubble, or the long-JD path accidentally routing through `s-enrich`.
