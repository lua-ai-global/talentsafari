# Merge the JD paste box + Ada enrichment chat into one step

## Context

Today, gathering the role description spans **two separate `.screen` sections** in
[index.html](../../index.html), even though they're one logical step ("describe the role"):

1. **`s-hero`** ([index.html:564-594](../../index.html#L564-L594)) — the paste box (`#jd` textarea),
   sample/PDF chips, "Score this role" button.
2. **`s-enrich`** ([index.html:634-647](../../index.html#L634-L647)) — a *full-screen* Ada chat that
   only appears when the pasted JD is short (`< 20` words). `handleScoreClick()`
   ([index.html:905-922](../../index.html#L905-L922)) navigates there via `go('s-enrich')`.

Because `s-enrich` is a distinct screen the user is bounced off the hero, the progress rail
goes blank (`s-enrich` is absent from `railMap`), and it reads as a second step.

**Goal:** make these feel like **one step**. Per the chosen direction (confirmed with the user):
- **Inline expand on the hero** — when a short JD is detected, the Ada chat unfolds *in place*
  on the same `s-hero` screen instead of navigating to a separate screen.
- **Long JDs (≥ 20 words) keep skipping the chat** — they go straight to `s-questions` as today.

This is a contained, frontend-only change in the single-file `index.html`. No backend, Lua agent,
or API changes. All enrichment logic (`[[ENRICH_DONE]]` token, `ENRICH_MAX_ANSWERS` cap,
`buildEnrichedJd()`, the no-tools seed prompt) is **reused unchanged** — only *where* the chat
renders and *how* we enter/leave it changes.

## Approach

Relocate the enrichment chat UI into the hero, hidden by default, and toggle it in-place.

### 1. Move the chat markup into `s-hero`

In [index.html:570-587](../../index.html#L570-L587), after the `.dropzone` block (or as a sibling inside
the hero), add a hidden container that holds the **same** chat elements (keep the existing IDs and
CSS classes so all JS and styles keep working):

```html
<div class="enrich-inline" id="enrichInline" hidden>
  <p class="enrich-intro" id="enrichIntro">The role description is a bit brief — Ada will ask a
    couple of quick questions, then we'll score it.</p>
  <div class="enrich-msgs" id="enrichMsgs"></div>
  <div class="enrich-input-row">
    <textarea id="enrichInput" placeholder="Type your reply…" rows="2" onkeydown="enrichEnterSend(event)"></textarea>
    <button id="enrichSendBtn" onclick="sendEnrichMessage()">Send →</button>
  </div>
  <button class="back-link enrich-edit" onclick="exitEnrichInline()">← Edit description</button>
</div>
```

Then **delete the standalone `<section class="screen" id="s-enrich">…</section>`**
([index.html:634-647](../../index.html#L634-L647)) entirely.

### 2. Reuse existing CSS

The `.enrich-msgs`, `.emsg`, `.emsg.ada/.user/.typing`, and `.enrich-input-row` rules
([index.html:492-521](../../index.html#L492-L521)) are reused as-is. Add a small amount of CSS near
them for the new wrapper: `.enrich-inline { margin-top: 18px; }` and an `.enrich-intro`/
`.enrich-edit` style consistent with the existing `.sub` / `.back-link` tokens. The old
`.enrich-wrap` rules ([index.html:487-491](../../index.html#L487-L491)) can be removed since that
wrapper no longer exists.

### 3. Toggle inline instead of navigating

Modify `handleScoreClick()` ([index.html:905-922](../../index.html#L905-L922)). For the short-JD branch,
replace `startEnrichChat(); go('s-enrich');` with a call to a new helper that stays on the hero:

```js
if (wordCount < 20) {
  state.jdText = jdVal;
  enterEnrichInline();      // reveal chat in-place; no navigation
} else {
  go('s-questions');
}
```

Add two small helpers (next to the other enrichment fns ~[index.html:1146](../../index.html#L1146)):

- **`enterEnrichInline()`** — hide the paste affordances (`#textWrap`, `.dz-foot`/`#heroBtn`,
  `#dzSep`, `#otherRoles`) and the `.trust` line, show `#enrichInline` (`hidden = false`), swap the
  hero `.sub` / eyebrow copy to signal the conversation, then call the **unchanged**
  `startEnrichChat()`. Rail stays at step 0 (`s-hero`) — exactly the "one step" feel we want.
- **`exitEnrichInline()`** — reverse the above (re-show paste UI, hide `#enrichInline`, clear
  `enrichHistory`/`#enrichMsgs`) so the user can edit the JD and try again. Replaces the old
  per-screen "← Back" affordance.

`startEnrichChat()`, `sendEnrichMessage()`, `callEnrichApi()`, `appendEnrichMsg()`, and
`buildEnrichedJd()` need **no changes**.

### 4. `finishEnrich()` is essentially unchanged

`finishEnrich()` ([index.html:1175-1181](../../index.html#L1175-L1181)) already folds answers into
`#jd`/`state.jdText` and calls `go('s-questions')` — keep that. Confirm that pressing browser Back
from `s-questions` returns to a sane hero state — if needed, call `exitEnrichInline()` inside the
`popstate`/`renderScreen('s-hero')` path so a returning user sees the paste box, not a stale chat.

### Files touched
- **`index.html`** only:
  - Markup: move chat into `s-hero` (~L570-587), delete `s-enrich` section (L634-647).
  - CSS: minor additions near L487-521; drop unused `.enrich-wrap`.
  - JS: edit `handleScoreClick()` (L905-922); add `enterEnrichInline()`/`exitEnrichInline()`;
    optional one-line guard in the `s-hero` render path.

### Not changing
- The `< 20` word threshold, the calibration questions (`s-questions`), the seed prompt's
  "no tools / no scoring" contract, `railMap`, `URL_MAP`, and all `/api/*` behavior.

## Verification

Run locally (per [docs/llm.md/llm.md §9](../llm.md/llm.md)):

```bash
npm install          # ensure express is present on this branch
# .env needs LUA_AGENT_ID + LUA_API_KEY
npm run dev          # → http://localhost:3000
```

Manual checks:
1. **Short JD path:** type a < 20-word role (e.g. "support agent for refunds") → click
   "Score this role" → chat appears **inline on the hero** (no screen jump, rail still at
   step 1), paste box/buttons hidden. Answer Ada's questions → on `[[ENRICH_DONE]]` (or after
   4 answers) it advances to `s-questions`. Confirm answers were folded into the JD (verify the
   later score reflects them).
2. **Long JD path:** click "▲ Try a sample JD" (`loadSample()` inserts a long JD) → "Score this
   role" → goes **straight to `s-questions`**, no chat. PDF upload of a real JD behaves the same.
3. **Edit/back:** start a short-JD chat, click "← Edit description" → paste box returns, chat
   cleared. Then browser Back from `s-questions` → hero shows the paste box (not a stale chat).
4. **No premature side effects:** during the inline chat, confirm zero scoring/Slack/email calls
   fire (Network tab: only `enrich-*` channel calls, ~3-4s each) — the enrichment-fix contract
   from [docs/llm.md/llm.md §8](../llm.md/llm.md) must hold.
