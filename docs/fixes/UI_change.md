# Re-ship the chat-first hero — wired to the current 4-dimension intake brain

## Context

The "Human or Agent?" frontend ([index.html](../../index.html)) once had a **chat-first hero** (Ada leading
the conversation on the first screen, commit `2be603ca`). It shipped via PR #4, then was **reverted**
(`d1f3d9a7`) — so production today is the old paste-textarea hero. After the revert, we built a
**better enrichment brain**: the thin-JD enrichment chat now asks the **4 high-leverage scoring
dimensions** (judgment / regulatory / relationship / systems) as one numbered batch, with bold +
line-break rendering and a dimension-labeled fold into the JD.

We want Ada back on the first screen — but a naive "revert the revert" would resurrect the hero
*with its old, generic 3-question enrichment seed and plain-text rendering*, **throwing away the
intake work**. So this is a **merge**: take the chat-first hero *shell* (markup + CSS + nav) and wire
it to the *current* enrichment brain, deleting the now-redundant separate `s-enrich` screen.

Plus an explicit redesign ask from the user: **Ada's chat was too small** — make it bigger and the
copy cleaner.

**Locked design decisions:**
1. **Big centered single column** — keep the centered structure, but a much taller/wider chat panel and full-width composer.
2. **Detailed JDs (≥20 words) → quick ack → calibration MCQs.** The 4-dimension enrichment fires **only** for thin (<20-word) first messages.
3. **Sample/PDF buttons = icon-only, expand label on hover.**
4. **Trim copy for a clean look** (short sub-headline, minimal greeting).

The Ada **persona** (`src/index.ts`) and **capture-lead** skill already carry the intake-mode + phantom-lead fixes — **no backend change needed**. This is a single-file (`index.html`) change.

## What wins in the merge

| Concern | SHELL (from `2be603ca`, read via `git show 2be603ca:index.html`) | BRAIN (current working tree — **must win**) |
|---|---|---|
| Hero markup `.hero-chat`/`.composer`/`.tool-btn` | ✅ source | — |
| `HERO_GREETING`, `heroStage`, `initHeroChat`, `sendHeroMessage` | ✅ source (with edits) | — |
| Enrichment seed | ❌ discard its inline generic 3-Q seed | ✅ `startEnrichChat()` 4-dimension numbered batch |
| Message rendering | ❌ discard plain-`textContent` version | ✅ `appendEnrichMsg()` HTML-escape + `**bold**` + pre-wrap |
| JD fold | ❌ discard "Additional details provided:" | ✅ `buildEnrichedJd()` "Clarifying answers (judgment, regulation, relationships, systems):" |
| `callEnrichApi`, `finishEnrich`, `ENRICH_*` consts | — | ✅ keep as-is |

**Single-seed invariant:** `sendHeroMessage()`'s thin branch must **call the existing `startEnrichChat()`**, not inline its own seed — this preserves `enrichHistory[0] == seed`, which `buildEnrichedJd().slice(1)` and `callEnrichApi`'s `userAnswers = length-1` both depend on.

## Edits to `index.html` (the only file changed)

1. **Delete the redeploy marker** (line 2, `<!-- redeploy marker… -->`) — per the §12 convention, re-shipping the redesign supersedes it.

2. **Replace the `s-hero` markup** (~566–596) with the chat-first shell: hidden `<textarea id="jd" hidden>` (kept — `runAnalysis`/`finishEnrich`/`restart` depend on it), `#pdfInput`, `.hero-chat > .chat-row(.ava "A" + .enrich-msgs#enrichMsgs) + .composer(#enrichInput + two .tool-btn + #enrichSendBtn onclick="sendHeroMessage()")`, `.trust` row. **Trim** the `.sub` to one clean line. This removes `#heroBtn`, `#textWrap`, `#otherRoles`/`#orTitle`/`#orChips`, `#dzSep`, `.dz-foot`.

3. **Replace the old enrichment CSS** (~487–523) with the chat-first `.hero-chat/.chat-row/.ava/.composer/.tool-btn/#enrichSendBtn` rules, **enlarged**: `.enrich-msgs` height **260→~440**, padding 20→24; `.hero-chat` max-width **680→720**; `.composer textarea` min-height **110→120**, max 220→240; `.emsg` font **14→15**, line-height 1.6; `.ava` 36→40. Keep the `.tool-btn` hover-expand label pattern verbatim. **Leave `.dropzone` rules intact** (still used by `s-brief`/`s-connect`). Ensure exactly **one** definition each of `.enrich-msgs`/`.emsg*`/`.enrich-input-row` survives (delete the old `display:flex` `.enrich-input-row` rules).

4. **Delete the `s-enrich` `<section>`** (~636–649). It held the only *other* `#enrichMsgs`/`#enrichInput`/`#enrichSendBtn` — after deletion those IDs resolve uniquely to the hero (required, since the brain functions use `getElementById`). `railMap`/`URL_MAP` already have no `s-enrich` entry → no change.

5. **Add 4 new JS symbols** above `startEnrichChat()` (after the `enrichHistory`/`ENRICH_*` consts ~1144–1146):
   - `HERO_GREETING` — short, clean, invites *paste-or-describe*; does **not** pre-ask the 4 dimensions (those fire only on the thin branch). e.g. *"Hi, I'm Ada. Paste a job description below, or describe the role in a sentence or two — and I'll tell you whether it's a human or an agent hire."*
   - `let heroStage = 'awaiting_jd';`
   - `initHeroChat()` — reset `heroStage`/`enrichHistory`/panel/input, append greeting, `scrollTop=0`.
   - `sendHeroMessage()` — first msg = role: `appendEnrichMsg('user', …)`, set **both** `state.jdText` and `#jd.value`, word-count branch: **≥20** → typing bubble → ack → `go('s-questions')`; **<20** → `heroStage='enriching'` then **call `startEnrichChat()`** (single seed source). Keep `if (!text) return;` empty guard. Subsequent turns (`heroStage==='enriching'`) → push user answer → `callEnrichApi(false)`.

6. **Reconcile the existing brain functions:**
   - **DELETE `sendEnrichMessage()`** (~1197–1205) — its logic moves into `sendHeroMessage`'s enriching branch; no caller after edit 4.
   - **MODIFY `enrichEnterSend()`** (~1193–1195) → call `sendHeroMessage()` (keep the name; markup `onkeydown` references it).
   - **DELETE `handleScoreClick()`** (~907–924) — old `#heroBtn` handler, now unreachable.
   - **KEEP unchanged:** `startEnrichChat`, `buildEnrichedJd`, `finishEnrich`, `appendEnrichMsg` (markdown version), `callEnrichApi`. **Do not** copy any of these from the old commit (avoid duplicate definitions).

7. **Retarget input helpers to the composer:**
   - `loadSample()` (~926–932) → write sample to `#enrichInput`, then `sendHeroMessage()`.
   - `handlePdfUpload()` (~885–905) → target `#enrichInput` (set value, manage disabled/focus, clear `#pdfInput.value`); **does not auto-send** (lets the user review long extracted text).

8. **Navigation + boot:**
   - In `renderScreen()` (~after 852) add `if (id === 's-hero') initHeroChat();` (resets chat on Back-nav and `restart()`'s `go('s-hero')`).
   - Add a one-time `initHeroChat();` at the **end** of the inline `<script>` so the greeting paints on first load (the static `active` `s-hero` + initial `history.replaceState` don't route through `renderScreen`).

9. **Fix the `restart()` regression** (~line 1702): delete the `document.getElementById('otherRoles').style.display='none';` line — `#otherRoles` no longer exists (edit 2) and would throw a null-ref. Keep the `#jd` reset (1701).

## Risks / edge cases (verify these)
- **`restart()` null-ref on `#otherRoles`** — highest-risk regression; edit 9 removes it.
- **Duplicate IDs / duplicate function defs** — only paste the 4 new symbols from the old commit; ensure single definitions remain.
- **`startEnrichChat()` clears the panel** (wiping the user's thin first bubble + greeting) before showing the 4-dimension batch — acceptable per locked design; do **not** refactor it to preserve the bubble (breaks the shared contract).
- PDF upload populates composer but does not auto-send (intentional); `loadSample()` auto-sends.

## Verification (end-to-end, local)
Run `npm run dev` → http://localhost:3000 (needs `.env` with `LUA_AGENT_ID` + `LUA_API_KEY`; **not** a bare static server). Then exercise:
1. **First paint:** Ada greeting visible in an enlarged chat panel; clean copy; Sample/PDF icons expand label on hover.
2. **Detailed JD path (≥20 words):** type/paste a full JD → "Got it…" ack bubble → lands on `s-questions` → MCQs → `runAnalysis` → `s-result` (verify `#jd` carried the text).
3. **Thin path (<20 words):** type a short phrase → Ada opens with the **4-dimension numbered batch** (bold + line breaks rendered) → answer → `[[ENRICH_DONE]]` *or* 4-answer cap → folds answers ("Clarifying answers (judgment, regulation, relationships, systems):") → `s-questions` → full funnel.
4. **Sample JD** button → flows through chat as a detailed JD. **PDF upload** → text lands in composer, not auto-sent.
5. **Back-nav** from `s-questions` → hero resets to greeting (no stale enrichment state). **Restart** from result → no console error, hero resets.
6. Check the browser console is clean throughout (esp. the `restart()` path).

## Delivery (per saved git-workflow memory: PR, not direct push)
- Create a **feature branch** off `review/latest-updates` (e.g. `yash/chat-first-hero-v2`).
- Single focused commit (e.g. `feat(hero): re-ship chat-first intake on the 4-dimension brain`).
- Open a **PR into `review/latest-updates`** (Vercel preview deploy auto-runs). Do **not** direct-push to the production branch; check `git log origin/review/latest-updates..HEAD` before pushing.
- After review/merge, update `docs/llm.md/llm.md` §11/§12 to record the re-ship (the old commit is no longer "reverted, not deployed").
