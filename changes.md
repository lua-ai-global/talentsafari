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
  → RESOLVED: building a fresh script. Part B rename safe.
- Sheet target: first tab of the bound spreadsheet (script assumes `getSheets()[0]`).

---

# Phase 3 — confirmation email delivers the full report

**Date:** 2026-06-02
**Status:** PROPOSED — not yet applied (awaiting approval)

## Goal
When the lead submits their email after results render, the confirmation email should
contain the actual evaluation report/analysis — not just a verdict line.

## Root finding
- `capture-lead.skill.ts` `sendEmail1()` sends a THIN email: verdict_line + score, plus
  the line *"The full seven-dimension breakdown is attached"* — but nothing is attached
  or included. It promises a report it never delivers.
- `sendEmail1` only receives `roleTitle, verdictLine, score` (3 scalars). It has no
  dimensions or candidate cards to render.
- The full analysis data already exists on `scoringResult` (dimensions added in Phase 1;
  human_candidate / agent_candidate already in the capture_lead schema).
- Fires only when `RESEND_API_KEY` + `FROM_EMAIL` are set; otherwise skips silently
  (non-fatal — same class as the Slack open item).

## Decisions (confirmed with user)
- Format = **inline HTML** in the email body (no attachment). Renders in all clients,
  no PDF dependency, lowest risk.
- Detail = **full report**: verdict + score + rationale + all 7 dimension rationales +
  human vs agent candidate cards + CTA nudge.

## Files changed
**Only:** `src/skills/capture-lead.skill.ts` (1 file). No frontend / persona change.

### Change 1 — new `esc()` + `renderReportHtml()` helpers
HTML-escape all model/user text (prevents broken markup), then render a table-based,
inline-styled report (email-client safe):
```ts
function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderReportHtml(s: ScoringResult): string {
  const dims = (s.dimensions ?? [])
    .slice()
    .sort((a, b) => b.weight - a.weight)
    .map(
      (d) =>
        `<tr>
          <td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(d.label)}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:center">${esc(d.score)}/10</td>
          <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:center">${esc(d.weight)}×</td>
          <td style="padding:6px 10px;border-bottom:1px solid #eee;color:#555">${esc(d.rationale)}</td>
        </tr>`,
    )
    .join('');

  const dimsBlock = dims
    ? `<h3 style="margin:24px 0 8px">Seven-dimension breakdown</h3>
       <table style="width:100%;border-collapse:collapse;font-size:14px">
         <tr style="text-align:left;color:#888;font-size:12px">
           <th style="padding:6px 10px">Dimension</th><th style="padding:6px 10px;text-align:center">Score</th>
           <th style="padding:6px 10px;text-align:center">Weight</th><th style="padding:6px 10px">Why</th>
         </tr>${dims}
       </table>`
    : '';

  const h = s.human_candidate;
  const a = s.agent_candidate;
  const cards =
    `<h3 style="margin:24px 0 8px">Human vs Agent</h3>
     <table style="width:100%;border-collapse:collapse;font-size:14px">
       <tr>
         <td style="vertical-align:top;padding:10px;background:#faf7f2;border-radius:8px;width:50%">
           <strong>Human hire</strong><br>
           ${h.salary_range ? `Salary: ${esc(h.salary_range)}<br>` : ''}
           Time to productive: ${esc(h.time_to_productive)}
         </td>
         <td style="vertical-align:top;padding:10px;background:#f2f6fa;border-radius:8px;width:50%">
           <strong>${esc(a.name)} (Lua agent)</strong><br>
           Monthly cost: ${esc(a.monthly_cost)}<br>
           Live: ${esc(a.start_date)}${a.throughput ? ` · ${esc(a.throughput)}` : ''}
         </td>
       </tr>
     </table>`;

  const ctaLine =
    s.recommended_cta === 'lua'
      ? 'Recommended next step: talk to Lua about building this agent.'
      : 'Recommended next step: brief Talent Safari to source the human hire.';

  return `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:640px;margin:0 auto;color:#1a1a1a">
      <h2 style="margin:0 0 4px">${esc(s.role_title)}</h2>
      <p style="margin:0 0 16px;font-size:18px"><strong>${esc(s.verdict_line)}</strong> · Score ${esc(s.score)}/100</p>
      <p style="font-size:15px;line-height:1.5">${esc(s.rationale)}</p>
      ${dimsBlock}
      ${cards}
      <p style="margin-top:24px;font-size:15px">${esc(ctaLine)}</p>
      <p style="margin-top:24px;color:#888;font-size:13px">— Ada · Built by Lua</p>
    </div>`;
}
```

### Change 2 — `sendEmail1` takes the full `scoringResult`
```ts
// signature: (resendApiKey, fromEmail, toEmail, scoringResult: ScoringResult)
subject: `Your Human or Agent? report — ${scoringResult.role_title}`,
html: renderReportHtml(scoringResult),
```
Removes the false "attached" line.

### Change 3 — update the call site in `execute()`
```ts
await sendEmail1(resendKey, fromEmail, email, scoringResult);
```

## Risk / non-breaking check
- All model text passes through `esc()` → no broken HTML / injection.
- `dimensions` optional → if absent, the breakdown block is omitted; email still sends
  with verdict + rationale + cards. Graceful.
- `sendEmail1` stays wrapped in the existing non-fatal `try/catch` in `execute()`.
- Flag short-circuit unchanged — flagged evaluations still send no email.
- Frontend / persona / Slack / Sheets paths untouched.
- 2h follow-up email (`scheduleFollowupEmail`) left as-is (separate, already has rationale).

## Verification (before ship)
- `npx tsc --noEmit` → zero errors.
- `/lua-doctor` → `lua compile --ci`.
- Ensure `RESEND_API_KEY` + `FROM_EMAIL` set on the Lua agent (else email skips silently).
- Live test: run one eval, submit email → confirm the inbox email contains verdict,
  score, 7 dimensions, and the candidate cards.

## Open / to confirm before applying
- Are `RESEND_API_KEY` + `FROM_EMAIL` set on the Lua agent? (If not, email never sends —
  must set before this is testable / live.)

---

# Phase 4 — extra Google Sheet columns (Verdict, Recommended CTA, JD, Analysis)

**Date:** 2026-06-02
**Status:** APPLIED — `capture-lead.skill.ts` `appendToSheets()` + `sheets-apps-script.gs`.

## Goal
Log 4 more fields per lead row: Verdict, Recommended CTA, JD, Analysis (raw values).

## Decisions (confirmed)
- Raw values: `verdict` (enum), `recommended_cta` (`lua`/`tech_safari`), `jdText`, `buildAnalysis()`.
- New columns APPENDED at END (positions 9-12) — protects existing rows, keeps `EMAIL_COL=4`/`CTA_COL=8` unchanged. User already added the 4 headers to the live sheet.

## Layout
`Name . Title . Company . Email . Date . Role Evaluated . Score . CTA Clicked . Verdict . Recommended CTA . JD . Analysis`

## Changes
- `appendToSheets()` — new `jdText` param; payload += `verdict`, `recommendedCta`, `jd`, `analysis`. Call site passes `jdText ?? .`.
- `sheets-apps-script.gs` — `HEADERS` += 4 cols; `append` row += 4 values (same order).

## Risk / non-breaking
- Append-at-end → existing rows keep alignment (blank trailing cells only).
- `updateCta` unaffected (CTA_COL=8 unchanged).
- `analysis`/`jd` are large text — within Sheets ~50k char/cell limit.
- `appendToSheets` stays in non-fatal try/catch. No frontend/persona/Slack/email impact.

## Verification
- `npx tsc --noEmit` PASS (clean).
- Pending: redeploy Apps Script (new HEADERS) + `lua push`/deploy skills + live eval -> confirm all 12 columns populate.

---

# Phase 5 — DIAGNOSIS: flagged (short_jd) eval recorded nothing

**Date:** 2026-06-03
**Status:** DIAGNOSIS ONLY — no code changes made.

## Symptom
A short JD evaluation: NOT in `evaluations` data primitive, NOT in Google Sheets, NOT
posted to Slack. Agent (Ada) replied in chat on channel `lead-969116e8...`:
"The short_jd flag is set ... the tool will skip silently per policy. No Slack post or
email ... If Robert submits a fuller job description, I can re-score and capture cleanly."

## Root cause
Ada did NOT call `capture_lead` — it produced a TEXT explanation instead.

Why this explains all three misses (verified `capture-lead.skill.ts` execute order):
1. `Data.create('evaluations', ...)` runs FIRST, ALWAYS, regardless of flags (before the short-circuit).
2. THEN the flag short-circuit returns (skips Slack/Sheets/email).

- evaluations empty => capture_lead was NEVER invoked. If it had run, the always-on
  Data.create would have recorded even a flagged lead. => tool not called.
- no Slack / no Sheets => (a) tool not called, AND (b) by design short_jd short-circuits
  BEFORE postToSlack/appendToSheets.

Design intent: ALWAYS call capture_lead; the TOOL decides to skip Slack/email while still
recording to Data. Ada pre-empted the tool based on the flag => always-record never ran.
This is a persona / invocation-contract gap, not a tool-logic bug.

## Candidate fixes (NOT applied — for next phase)
1. Persona/contract: on "Call the capture_lead tool", ALWAYS call it with the exact
   values even if a flag is believed set. Tool handles skipping. Never reply text / refuse.
2. Verify frontend fires capture_lead even for flagged evals (does the wizard render
   results + call submitLead when score_jd returns short_jd=true?).
3. POLICY (confirm with user): should flagged leads still be written to Sheets? (move
   appendToSheets before the short-circuit) and/or pinged to Slack as a flagged notice?

## Note
Google Sheets webhook QA (Phase 4): live endpoint returns bare {"ok":true} for append +
updateCta, NOT the {ok,action,row} our repo sheets-apps-script.gs returns => the DEPLOYED
Apps Script is not our repo version. 200 ok confirms reachable, NOT that cols 9-12 fill.
Verify by inspecting the sheet row, or deploy our .gs.

---

# Phase 6 — FIX: persona/contract + Zod schema (resolve F1 + F2 from QA)

**Date:** 2026-06-03
**Status:** TO BE DONE — plan only, awaiting approval. No code changes yet.
**Branch target:** `review/latest-updates`
**Source of findings:** `/lua-qa` run 2026-06-03T13:07:00Z (thread IDs `qa-leadcols-happy-20260603`,
`qa-leadcols-short-20260603`).

## Goal
Close the two high-severity QA findings so that:
1. Every `score_jd` call is followed by a `capture_lead` call — including flagged
   evals (short_jd / non_english / suspected_fake). Phase 5 root cause closed.
2. The raw `score_jd` output passes `captureLeadInputSchema` on the first relay
   attempt (no validation warn, no retry, no dropped `dimensions[]`). Restores the
   7-dimension breakdown in Sheets col 12 (Analysis) and in the `evaluations`
   primitive's `dimensions` field.

## Files changed
**Only:** `src/skills/capture-lead.skill.ts` (1 file). No frontend / no other skill.
No persona file edit (skill `context` is the persona contract for this tool).
No Apps Script change. No env change.

---

## Part A — F1 fix: persona/contract rewrites (two strings)

### A1 — Tool `description` (line 374-375)
Replace the misleading "Skips silently if any quality flag is set." which Ada read
as "don't call when flagged."

```ts
description =
  "ALWAYS call this tool immediately after score_jd, even when quality flags are set. The tool always records the evaluation to Data; it decides internally whether to also post Slack / send email / append Sheets. Never refuse, explain, or withhold the call.";
```

### A2 — Skill `context` (line 460-468)
Flip the contract from "skip on flag" to "always call; the tool handles skipping."

```ts
context: `Use the capture_lead tool immediately after every successful score_jd call — pass the full scoringResult along with the lead's email and company name. ALWAYS call it, even if you believe a flag (short_jd, non_english, suspected_fake) is set. Never reply with text in place of the call; never explain the flag instead of calling the tool. The tool itself handles flag-based skipping.

The tool will:
1. ALWAYS record the evaluation to the evaluations Data primitive (regardless of flags).
2. If any flag is set → return { skipped: true, reason } and skip Slack/Sheets/email. This is internal; you still MUST call it.
3. Otherwise → post Slack Block Kit, append Google Sheets row, send Resend report email, schedule 2h follow-up.

Returns: { posted, email1Sent, email2ScheduledAt } on success, or { skipped: true, reason } when flagged.`,
```

### A3 — Why this resolves F1
QA log thread `qa-leadcols-short-20260603` shows Ada returned text only, no
`capture_lead` tool entry in logs. Skill `context` line 463 ("Skip silently … do
not retry or explain") was being read as "don't call." A1+A2 invert the
instruction. Tool `execute()` order is already correct: `Data.create` runs
unconditionally (line 383-401) BEFORE the flag short-circuit (line 405). No logic
change needed.

---

## Part B — F2 fix: Zod `.passthrough()` on score_jd-shaped objects

### B1 — Drift between `score_jd` output and `captureLeadInputSchema`
`score_jd` emits these keys NOT declared in `captureLeadInputSchema.scoringResult`:

| Object | Extra keys (rejected by Zod strict default) |
|---|---|
| `human_candidate` | `scale_ceiling`, `coverage`, `great_at`, `hard_at` |
| `agent_candidate` | `avatar_seed`, `coverage`, `great_at`, `cant_do` |
| top-level `scoringResult` | `adjacent_agents` |

Live evidence: log `_id 6a2026a47e566f2327bd0d64` at `2026-06-03T13:05:40.302Z`
— `subType: warn`, message `"Tool input validation failed"`, fired between the
`score_jd` result and the eventual retry. Retry payload at `13:05:51` had
`dimensions` absent → `buildAnalysis()` fell back to verdict+rationale only.

### B2 — Edit (`capture-lead.skill.ts:33-43, 50`)
Add `.passthrough()` to the two nested objects and the outer `scoringResult`:

```ts
human_candidate: z.object({
  salary_range: z.string(),
  time_to_productive: z.string(),
}).passthrough(),
agent_candidate: z.object({
  name: z.string(),
  role_title: z.string(),
  monthly_cost: z.string(),
  start_date: z.string(),
  throughput: z.string().optional(),
}).passthrough(),
```

And on the outer `scoringResult` `.object({...})`:
```ts
}).passthrough().describe('The full scoring result from score_jd'),
```

### B3 — Why this resolves F2 + F3
- First relay passes Zod (no warn, no retry).
- `dimensions[]` survives the relay because no strip step runs.
- `buildAnalysis()` (line 159-170) receives the full `dimensions[]` → composes the
  9-line breakdown.
- `appendToSheets()` writes the full breakdown into Sheets col 12.
- `Data.create('evaluations', ...)` `dimensions` field stops being `[]`.
- F3 is downstream of F2 → resolves with same edit.

---

## Risk / non-breaking check
- A1/A2: prose-only contract rewrite. Tool `execute()` unchanged. No fields renamed,
  no return shape changed. Frontend untouched. Slack/Sheets/email paths unchanged.
- B2: `.passthrough()` is additive — accepts extra keys, still validates declared
  keys. Older `score_jd` payloads without the extra keys remain valid.
- No env change. No Vercel deploy. Apps Script untouched.
- `cta-submissions` primitive untouched.

## Out of scope (deliberately not in Phase 6)
- F4: deployed Apps Script ≠ repo. Manual Google Apps Script re-deploy required
  (paste `sheets-apps-script.gs` into Extensions → Apps Script → re-deploy Web App).
  Operational task, not a code change.
- Frontend behavior on flagged evals: confirm wizard still calls `submitLead()`
  when `score_jd` returns `short_jd=true` (Phase 5 candidate fix #2). Deferred.
- Policy: should flagged leads also appear in Sheets/Slack as a flagged notice?
  (Phase 5 candidate fix #3.) Requires product decision.

## Verification (before push)
1. `npx tsc --noEmit` → zero errors.
2. `lua compile --ci` → exit 0.
3. `lua push` + deploy skills.
4. Live test — normal JD:
   - Submit a realistic JD via chat.
   - Confirm no `"Tool input validation failed"` warn in logs.
   - Inspect `capture_lead` tool input log → `scoringResult.dimensions` is
     a 7-element array, not absent.
   - Inspect `evaluations` primitive → `dimensions` is non-empty.
   - Inspect Sheets row → col 12 (Analysis) contains the 9-line breakdown.
5. Live test — flagged JD (short_jd):
   - Submit "hire a dev" or similar.
   - Confirm Ada DOES call `capture_lead` (tool entry appears in logs for the thread).
   - Confirm `evaluations` primitive has a row for the flagged eval.
   - Confirm Slack / Sheets / email are correctly skipped (this is the intended
     design for flagged leads).

## Rollback
Revert the single file `src/skills/capture-lead.skill.ts` to pre-Phase-6 state
and re-deploy. No data migration; no env to unset.

## Open / to confirm before applying
- Approval to edit `capture-lead.skill.ts` (4 edit points: 1 description string,
  1 context string, 2 nested `.passthrough()` calls + 1 outer `.passthrough()`).
- Order of application: A then B (A is independent of B; B independent of A).
  Can ship both in one push.

---

# Phase 7 — branded email footer (Lua logo) + wider margins

**Date:** 2026-06-03
**Status:** PROPOSED — not applied. Blocked on assets (logo + icon PNGs, social URLs).

## Goal
Replace the plain `— Ada · Built by Lua` email footer with a branded Lua footer: centered
Lua logo, tagline, social icons (Facebook / LinkedIn / Instagram). Also widen the email
margins for more breathing room.

## Constraint (why this needs hosted images)
Email clients strip SVG, external CSS, and most `<style>`. Logos/icons MUST be raster
(PNG/JPG) referenced by ABSOLUTE https URLs. The repo has only `public/talentsafari_logo.jpg`
— no Lua logo, no social icons. So step 1 is hosting the assets.

## Asset hosting
Add PNGs to `public/` (Vercel serves at `https://agent.talentsafari.io/<file>`):
- `lua-logo.png`  — transparent, ~320px wide (2x retina; shown ~120-160px).
- `social-facebook.png`, `social-linkedin.png`, `social-instagram.png` — ~48px each.
Source art = the shared Google Doc. A Doc edit link is NOT a hostable image URL — the logo
must be exported to PNG and committed to `public/` (or a public CDN URL supplied).

## File changed
`src/skills/capture-lead.skill.ts` -> `renderReportHtml()` footer (later mirror into
`submit-cta` confirmation emails for parity).

### Change A — footer block (replaces the `— Ada · Built by Lua` line ~150)
```html
<div style="margin-top:28px;padding-top:24px;border-top:1px solid #ececec;text-align:center">
  <img src="https://agent.talentsafari.io/lua-logo.png" width="120" alt="Lua"
       style="display:inline-block;border:0;outline:none;text-decoration:none">
  <p style="margin:14px 0 0;font-size:13px;line-height:1.5;color:#888">
    Simplify your life with Lua AI personal assistant, available on
    <a href="https://wa.me/LUA_WHATSAPP" style="color:#7a5cff;text-decoration:underline">WhatsApp</a>
    and <a href="https://www.heylua.ai" style="color:#7a5cff;text-decoration:underline">www.heylua.ai</a>
  </p>
  <p style="margin:14px 0 0">
    <a href="FB_URL"><img src="https://agent.talentsafari.io/social-facebook.png" width="22" alt="Facebook" style="border:0"></a>
    &nbsp;&nbsp;
    <a href="LI_URL"><img src="https://agent.talentsafari.io/social-linkedin.png" width="22" alt="LinkedIn" style="border:0"></a>
    &nbsp;&nbsp;
    <a href="IG_URL"><img src="https://agent.talentsafari.io/social-instagram.png" width="22" alt="Instagram" style="border:0"></a>
  </p>
  <p style="margin:14px 0 0;color:#aaa;font-size:12px">— Ada · Built by Lua</p>
</div>
```

### Change B — wider margins (ASSUMPTION: inner padding; confirm)
- Card padding `32px` -> `40px` (line ~138).
- (Optional) outer table padding `24px 0` -> `40px 0` (line ~136) if outer whitespace wanted.

## Assumptions (UNCONFIRMED — AskUserQuestion went unanswered)
- Margin = inner padding widened (32 -> 40).
- Footer copy = the Lua sample verbatim. NOTE: that is Lua's consumer tagline; this email is
  a B2B hiring report — may want reworded copy. Flag for review.

## Inputs still needed
- Lua logo PNG + 3 social icon PNGs (or public URLs).
- Social profile URLs: Facebook, LinkedIn, Instagram (+ WhatsApp number for the wa.me link).

## Risk / non-breaking
- Footer is presentational; `esc()` still applied to all dynamic text. Static URLs safe.
- If an image URL 404s, email still renders (alt text) — no send failure.
- Skill change -> must redeploy to go live (see INC-001 lesson).
- `public/` PNGs ship with the Vercel site (git push) — host them BEFORE the skill goes
  live so the `<img>` URLs resolve.

## Verification
- `npx tsc --noEmit` clean.
- Send a test eval email; confirm logo + icons render in Gmail (desktop + mobile) and the
  margins look right.
