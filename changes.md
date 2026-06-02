# Change Log — `analysis` field in evaluations

**Date:** 2026-06-02
**Branch:** `review/latest-updates`
**Status:** APPLIED — `src/skills/capture-lead.skill.ts` edited. Stores BOTH a readable
`analysis` string AND the raw `dimensions[]` array. Pending: `lua compile --ci` + live eval.

---

## Goal
Record the agent's analysis in the `evaluations` data primitive. Each evaluation
should persist the per-dimension reasoning Ada produces during `score_jd`, not just
the final score/verdict.

## Decision
Store **structured analysis** (agent's verdict + rationale + all 7 dimension
rationales), composed into a readable string. Chosen over capturing the freeform
chat narrative because the frontend wizard flow never generates that narrative —
it renders structured cards from `dimensions[]`. The dimension rationales ARE the
agent's analysis.

## Root finding
- Frontend `submitLead()` (`index.html:1246`) already sends the **full**
  `state.result` JSON (including `dimensions[]`) to Ada → `capture_lead`.
- `capture-lead.skill.ts` schema does NOT declare `dimensions`, so Zod **strips it**
  before the tool runs. The analysis data arrives at the proxy and is discarded.
- Write point: `Data.create('evaluations', {...})` (`capture-lead.skill.ts:264–279`).
  No `analysis` field today.

---

## Files changed
**Only:** `src/skills/capture-lead.skill.ts` (1 file). No frontend change. No other skill.

### Change 1 — accept `dimensions` in input schema
Stop Zod from stripping the dimension data the frontend already sends. Optional so
existing/older callers never break.
```ts
// inside captureLeadInputSchema.scoringResult, after `rationale`:
dimensions: z.array(z.object({
  key: z.string(),
  label: z.string(),
  score: z.number(),
  weight: z.number(),
  rationale: z.string(),
})).optional(),
```

### Change 2 — compose analysis string (new helper)
```ts
function buildAnalysis(s: ScoringResult): string {
  const lines: string[] = [];
  lines.push(`Score: ${s.score}/100 — ${s.verdict_line} (${s.verdict})`);
  if (s.rationale) lines.push('', s.rationale);
  if (s.dimensions?.length) {
    lines.push('', 'Dimension breakdown:');
    for (const d of [...s.dimensions].sort((a, b) => b.weight - a.weight)) {
      lines.push(`- ${d.label}: ${d.score}/10 (weight ${d.weight}×) — ${d.rationale}`);
    }
  }
  return lines.join('\n');
}
```

### Change 3 — store it in the evaluations record (string + raw array)
```ts
jd_text: jdText ?? '',
analysis: buildAnalysis(scoringResult),      // ← NEW: readable string
dimensions: scoringResult.dimensions ?? [],  // ← NEW: raw array (lossless insurance)
timestamp: new Date().toISOString(),
```

---

## Risk / non-breaking check
- `dimensions` is **optional** → if absent, analysis still builds from
  `verdict_line` + `rationale`. Graceful degradation.
- `Data.create` is schemaless → adding a key is safe. Old records simply lack
  `analysis` (null on read). Backward compatible.
- **Frontend untouched** — already sends full `state.result`. Persona / invocation
  contract unchanged.
- No impact on latency, `maxDuration`, Slack, email, or Sheets paths.

## Verification (before push)
- `lua compile --ci` → must exit 0 (zero-error standard).
- No `lua deploy` (Ada agent unchanged; `api/` deploys via git push to Vercel branch).
- Confirm a fresh evaluation writes the `analysis` field.

## Decided
Store BOTH the readable `analysis` string and the raw `dimensions[]` array.
Rationale: the `scoringResult` is relayed THROUGH the LLM (Ada) as prompt text
(`index.html:1252`), so faithful reproduction of the 7-item `dimensions[]` is not
guaranteed. Storing both = lossless when relayed, graceful fallback when not.

## Residual risk (accepted)
LLM relay may occasionally drop/abbreviate `dimensions[]` → `analysis` degrades to
verdict + rationale only, `dimensions` stores `[]`. True fix = bypass the LLM relay
(frontend → tool directly), which is an architecture change, out of scope here.

---

# Phase 2 — CTA-clicked label + Google Sheets lead logging

**Date:** 2026-06-02
**Status:** APPLIED — Parts A/B/C done. `submit-cta.skill.ts` (+`cta_clicked`, contract
key `ctaClicked`), `capture-lead.skill.ts` (append payload: `date`/`roleEvaluated`/
`ctaClicked:'No'`), new `sheets-apps-script.gs`. Pending: deploy Apps Script + set
`SHEETS_WEBHOOK_URL` on Lua + `lua push`/deploy + live test (Part D).

## Goals
1. Record the specific CTA clicked as a clean label (`Lua` / `Talent Safari`) in the
   `cta-submissions` data primitive.
2. On lead submit, append a row to a Google Sheet with columns:
   `Name · Title · Company · Email · Date · Role Evaluated · Score · CTA Clicked`.
   The **CTA Clicked** column starts `No` and flips to `Lua` / `Talent Safari` when
   the user clicks a CTA — matched by email.

## Root finding (most plumbing already exists)
- `capture-lead.skill.ts:56` `appendToSheets()` already POSTs `{action:'append', …}`
  when `SHEETS_WEBHOOK_URL` is set.
- `submit-cta.skill.ts:43` `updateSheetsRow()` already POSTs
  `{action:'updateCta', email, ctaPath}` to flip the CTA cell by email.
- The append → update-by-email design is already in code. Phase 2 only closes gaps
  (Date column, initial `No`, clean label field) + adds the Google-side Apps Script.

## Decisions (confirmed with user)
- **Q1** Add a clean `cta_clicked` label field to `cta-submissions` (keep existing `path` too).
- **Q2** CTA Clicked semantics: row born `No` at lead submit → `Lua`/`Talent Safari` on click, matched by email. ✔
- **Q3** Date source = **agent-sent ISO timestamp** (recommended — single source, consistent
  with the existing `timestamp` field; no dependency on when the Apps Script runs).
- **Q4** Provide the full Google Apps Script (below).
- **Q7** `SHEETS_WEBHOOK_URL` set on the **Lua platform** (skills side), NOT Vercel —
  no Vercel access required (verified: only read via `env()` in skills).

---

## Files changed

### Part A — `src/skills/submit-cta.skill.ts`
Add the clean label to the `cta-submissions` record (inside `Data.create`):
```ts
recommended_cta: scoringResult.recommended_cta,
cta_clicked: path === 'lua' ? 'Lua' : 'Talent Safari',   // ← NEW clean label
jd_text: jdText ?? '',
```
(Optional consistency rename — align the update contract key with the script below:
`ctaPath` → `ctaClicked` in `updateSheetsRow()`. Low priority.)

### Part B — `src/skills/capture-lead.skill.ts` → `appendToSheets()`
Send the columns the sheet needs, with `CTA Clicked` defaulted to `No` and an
agent-sent `date`:
```ts
body: JSON.stringify({
  action: 'append',
  name,
  title,
  company,
  email,
  date: new Date().toISOString(),          // ← NEW: Date (agent-sent ISO)
  roleEvaluated: scoringResult.role_title, // Role Evaluated
  score: scoringResult.score,
  ctaClicked: 'No',                        // ← NEW: initial CTA Clicked
}),
```
> ⚠️ This changes the `append` payload key names. Safe ONLY because the receiving
> Apps Script is new / under our control (Part C). If a DIFFERENT Apps Script already
> consumes the old keys (`path`, `jobTitle`), it must be updated in lockstep — FLAG
> before applying.

### Part C — NEW file `sheets-apps-script.gs` (deploy in Google, not bundled)
Reference copy kept in repo. User pastes into Google Sheet → Extensions → Apps Script,
deploys as Web App (Execute as: Me; Access: Anyone), copies the `/exec` URL.
```javascript
// TalentSafari — leads logger. Bound to the target Google Sheet.
const HEADERS = ['Name','Title','Company','Email','Date','Role Evaluated','Score','CTA Clicked'];
const EMAIL_COL = 4;   // 1-based column index of "Email"
const CTA_COL   = 8;   // 1-based column index of "CTA Clicked"

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const body  = JSON.parse(e.postData.contents);
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    ensureHeaders_(sheet);

    if (body.action === 'append') {
      sheet.appendRow([
        body.name || '',
        body.title || '',
        body.company || '',
        body.email || '',
        body.date ? new Date(body.date) : new Date(),
        body.roleEvaluated || '',
        body.score != null ? body.score : '',
        body.ctaClicked || 'No',
      ]);
      return json_({ ok: true, action: 'append' });
    }

    if (body.action === 'updateCta') {
      const row = findLastRowByEmail_(sheet, body.email);
      if (row > 0) {
        sheet.getRange(row, CTA_COL).setValue(body.ctaClicked || body.ctaPath || 'No');
        return json_({ ok: true, action: 'updateCta', row: row });
      }
      return json_({ ok: false, reason: 'email_not_found' });
    }

    return json_({ ok: false, reason: 'unknown_action' });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function ensureHeaders_(sheet) {
  if (sheet.getLastRow() === 0) sheet.appendRow(HEADERS);
}

function findLastRowByEmail_(sheet, email) {
  if (!email) return -1;
  const last = sheet.getLastRow();
  if (last < 2) return -1;
  const values = sheet.getRange(2, EMAIL_COL, last - 1, 1).getValues();
  for (let i = values.length - 1; i >= 0; i--) {            // last match wins
    if (String(values[i][0]).trim().toLowerCase() === email.trim().toLowerCase()) {
      return i + 2;                                          // back to sheet row index
    }
  }
  return -1;
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
```

### Part D — env `SHEETS_WEBHOOK_URL` (Lua platform, no Vercel)
1. Deploy the Apps Script Web App → copy the `…/exec` URL.
2. Set `SHEETS_WEBHOOK_URL` on the **Lua agent** (via lua-cli or Lua dashboard — confirm
   exact command via `/lua-docs`). NOT Vercel.
3. Redeploy skills so the env is picked up.
4. (Local/sandbox dev) set the same var in the Lua sandbox env.

---

## Risk / non-breaking check
- `cta_clicked` — additive field, schemaless Data primitive. Safe.
- `appendToSheets` payload rename — safe IFF the new Apps Script is the only consumer
  (Part C). FLAG if a prior script exists.
- **email match edge cases:** duplicate emails → `updateCta` updates the LAST matching
  row (intended). CTA clicked before lead appended (race) → `email_not_found`, no-op
  (acceptable; append fires at results render, click is later).
- LLM relay: `title`, `score`, `role_title` are small scalars → reliably relayed
  (same path as today's working fields).
- If `SHEETS_WEBHOOK_URL` unset → both Sheets calls silently skip (existing behavior,
  non-fatal). No regression.

## Verification (before ship)
- `npx tsc --noEmit` → zero errors (lua-cli not yet installed).
- `/lua-doctor` → install lua-cli → `lua compile --ci`.
- Set env, deploy skills (`lua push` + deploy — these are SKILLS, not Vercel `api/`).
- Live test: run one eval → confirm a Sheet row appends with `CTA Clicked = No`; click a
  CTA → confirm same row flips to `Lua`/`Talent Safari`; confirm `cta_clicked` in the
  `cta-submissions` primitive.

## Open / to confirm before applying
- Does a Google Apps Script ALREADY exist behind the current `SHEETS_WEBHOOK_URL`
  (old `append`/`updateCta` shape)? If yes, Part B payload rename must match it.
- Sheet target: first tab of the bound spreadsheet (script assumes `getSheets()[0]`).
