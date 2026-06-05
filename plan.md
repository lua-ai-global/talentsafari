# Plan — Email + CTA Landing Implementation

**Owner branch:** `review/latest-updates`
**Scope locked:** 4 features listed in §2. Anything outside is OUT-OF-SCOPE.
**Working principle:** Audit existing code first, refactor where needed, rebuild nothing that already works.

---

## 1. Roles

| Role | Owner | Files in their lane |
|---|---|---|
| Backend | **User (you)** | `src/skills/capture-lead.skill.ts`, `src/skills/submit-cta.skill.ts`, `sheets-apps-script.gs`, `lua.skill.yaml`, env config |
| Frontend | **Collaborator** | `index.html` (CTA deep-link handler + landing screens), any frontend glue |

Neither side edits files in the other lane without a heads-up in chat / commit.

---

## 2. In-Scope Features (4)

### F1. Email with full rendered analysis report
- Confirmation email to the lead must contain the **rendered evaluation report** (verdict, score band, 7-dimension breakdown, human vs agent compare cards, CTAs, footer).
- Trigger point: when `capture_lead` runs for a genuine lead-form submission (after `score_jd`), email1 sends.

### F2. Email primary CTA = `recommended_cta` from the scoring primitive
- Primary CTA in the email body must match `scoringResult.recommended_cta` (`lua` or `tech_safari`).
- Alternative CTA = the other path, styled smaller.

### F3. CTA click updates Google Sheets — Lua column or Talent Safari column
- When lead clicks the email CTA and submits the landing form, Sheets row for that email gets its `CTA Clicked` cell updated to `Lua` or `Talent Safari` depending on which path was taken.

### F4. CTA URL lands on the existing landing screens inside `index.html`
- Lua path → renders the existing **Lua landing screen** (purple "Sent. Lua will be in touch within 24 hours." after form submit).
- Talent Safari path → renders the existing **Talent Safari brief screen** (green "Brief Talent Safari on this role." → "Brief sent. Talent Safari will reply within 1 business day.").
- Mechanism: `index.html` reads `?cta=lua|tech_safari` from `location.search` on page load → auto-jumps to that screen → prefills `name`, `email`, `company` from query params.

---

## 3. Out-Of-Scope (do NOT touch)

- Score-JD logic, Ada chat, brief-wizard, scrape-jd skills.
- Slack post format (existing).
- Follow-up email (`scheduleFollowupEmail`).
- Data primitive schemas already in production.
- Score-time auto-call gating.
- `changes.md` content — leave intact.
- Any styling/layout changes outside the CTA landing screens.
- Adding new env vars beyond what's already in `env.example`.

If a touched file needs a change that drifts into out-of-scope behavior, STOP and ask before proceeding.

---

## 4. Current-State Audit

| Feature | File | Status | Action |
|---|---|---|---|
| F1 | `capture-lead.skill.ts` `renderReportHtml()` L137-225 | Built; QA never confirmed firing in prod | Audit + QA |
| F1 | `capture-lead.skill.ts` `sendEmail1()` L348-373 | Calls `renderReportHtml`, gated on `RESEND_API_KEY` + `FROM_EMAIL` | Confirm env vars set in prod |
| F2 | `capture-lead.skill.ts` L149 `primaryTs = s.recommended_cta !== 'lua'` | Built | Audit |
| F3 | `submit-cta.skill.ts` `updateSheetsRow()` L43-54 | Built; posts `action:'updateCta'` w/ `ctaClicked:'Lua'\|'Talent Safari'` | Audit + verify Apps Script side |
| F3 | `sheets-apps-script.gs` `updateCta` handler L46-54 | Built — finds row by email, writes to CTA Clicked column | Audit |
| F4 | `capture-lead.skill.ts` `ctaUrl()` L101-112 | Emits `?cta=lua\|tech_safari&rec=&role=&score=&email=&name=&company=` | Keep as-is |
| F4 | `index.html` query-param handler | **MISSING** — no code reads `?cta=` on load to auto-jump | **Build** |

---

## 5. Task Allocation

### Backend (User) — Lua skills + Apps Script

**B1.** Audit `renderReportHtml()` against the production-deployed version.
- Diff `src/skills/capture-lead.skill.ts` ↔ `dist-v2/artifacts/tool/capture_lead.js` to confirm local edits match what's deployed (or stage a push).
- Verify all asset URLs in the email body resolve under `ASSET_BASE = https://agent.talentsafari.io` (the 8 PNG/SVG files in `public/` are now tracked under that path).

**B2.** Verify `recommended_cta` → primary CTA mapping is correct for all 3 verdicts.
- `needs_human` → recommended should typically be `tech_safari` (primary = TS, alt = Lua).
- `strong_agent` → recommended should be `lua` (primary = Lua, alt = TS).
- `human_led_agent_assist` → check what `score_jd` sets; primary must follow whatever `recommended_cta` is, not the verdict.

**B3.** Run sandbox QA via `/lua-qa` on the email-send path.
- Trigger: `lua chat --ci -e sandbox -m "<full lead-form submission payload>" -t qa-email-report-<ts>`.
- Verify in logs: `Resend API` HTTP 200, no `Resend API error` thrown, `email1Sent: true` in tool result.
- If env vars missing in sandbox, document required keys for the collaborator's local test setup.

**B4.** Confirm Apps Script `updateCta` action is wired to the same spreadsheet/webhook that `append` writes to.
- Read `sheets-apps-script.gs` — confirm `getSheets()[0]` matches the sheet where leads are appended.
- Confirm column index for `CTA Clicked` matches the position in `HEADERS`.

**B5.** Verify CTA URL query-param contract is stable so the frontend can rely on it.
- Document exact keys emitted by `ctaUrl()`: `cta`, `rec`, `role`, `score`, `email`, `name`, `company`.
- Send the contract to Frontend so they read the same keys.

**B6.** Push + deploy via `/lua-deploy` once F1-F3 audited and B3 QA passes.

### Frontend (Collaborator) — index.html CTA landing

**F1.** Add a `?cta=` reader on page load (or on `DOMContentLoaded`).
- Parse `URLSearchParams(location.search)`.
- If `cta=lua` → auto-show the Lua confirm/landing screen (the one ending with `#luaSuccess` per `index.html:830`).
- If `cta=tech_safari` → auto-show the Talent Safari brief screen (the one with `#tsBriefBody` → `#tsSuccess` per `index.html:793-795`).
- If `cta` absent → keep current default behavior; don't break the existing entry flow.

**F2.** Prefill the landing form using `state.leadName`, `state.leadEmail`, `state.leadCompany` from query params.
- Hydrate `state` from `?name`, `?email`, `?company` before `prefillCtaForms()` runs (see existing `prefillCtaForms()` at `index.html:1412`).
- If a value is missing, leave the field empty — do not fabricate.

**F3.** Sanity-check the existing `submitCta(path)` flow (`index.html:1387`).
- After deep-link land + prefill + user clicks submit, confirm it still fires `adaSessionUrl('cta')` POST so the backend `submit_cta` tool runs.
- Don't change the success-message strings (they match the screenshots).

**F4.** Verify behavior on both desktop and mobile widths for the two landing variants — no layout regression vs the existing screens shown in the screenshots.

**F5.** Update CTA contract doc (or inline comment) once F1/F2 land so Backend can confirm shared keys match.

---

## 6. Definition of Done

A test run satisfies every box below before this slice ships:

- [ ] Submitting the lead form in production triggers an email to the lead's address within ~10s.
- [ ] Email body renders the full report (header logos, verdict chip, score bar, dimensions, candidate cards, CTAs, footer) in Gmail + Outlook web.
- [ ] Email primary CTA label + destination match `scoringResult.recommended_cta`.
- [ ] Clicking the primary CTA opens `index.html` and auto-lands on the matching screen (Lua confirm OR TS brief), prefilled.
- [ ] Submitting the landing form fires `submit_cta` → posts Slack + updates Sheets `CTA Clicked` cell for that email to `Lua` or `Talent Safari`.
- [ ] No regression to score_jd flow, Ada chat, or any out-of-scope behavior.
- [ ] No new env vars introduced beyond existing.

---

## 7. Open Questions / Risks

- **Email asset hosting:** `ASSET_BASE = https://agent.talentsafari.io` — confirm `public/*.png` files are actually served at that origin in production (Vercel `public/` is served at root, so this should work, but verify after deploy).
- **`talent-safari-logo.png` vs `talent-safari-logo.jpg`:** both exist in `public/`. `renderReportHtml` references `.png`. Confirm the `.png` is the canonical one.
- **Apps Script idempotency:** if `updateCta` runs twice for the same email, behavior = overwrite (acceptable). Confirm with collaborator that double-submit on the landing page is prevented client-side.
- **Query param max length:** if `role` title is very long, the URL could approach mail-client limits. `ctaUrl` truncation not currently in place — flag if QA shows broken links.
- **Sandbox vs production parity:** `lua sync --check` must be clean before deploy; B3 QA targets whichever env is in sync.

---

## 8. Working Agreement

- One PR (or one commit batch) per feature slice. Don't bundle F1+F4 into a single change.
- Backend pushes go through `/lua-deploy`. Frontend goes through the existing Vercel build.
- If either side hits a question that affects the other lane, ping in chat **before** editing.
- `changes.md` is read-only for this slice — historical record, do not append.
