# Bug fix: phantom `rares@heylua.ai` lead rows

**Status:** ✅ Fully fixed and live — `capture-lead` **v1.0.35** (2026-06-03). v1.0.34 added the
Slack/Sheets/email gate; v1.0.35 also stops placeholder records entering the `evaluations` Data
primitive (see "Follow-up" below).
**Affected:** Lua agent skill `capture-lead` (`src/skills/capture-lead.skill.ts`)
**Severity:** Medium — data pollution + duplicate notifications, no data loss

---

## Symptom

After the `capture-lead` "extended sheets schema" change went live (skill **v1.0.29**), the
Google Sheet started getting a **phantom row before every real lead**: an entry with no name, an
empty title, company `Lua`, and email `rares@heylua.ai`, carrying the same role + score as the
real lead that followed ~20–30 seconds later.

```
        Lua  rares@heylua.ai  03/06/2026 20:57:02  Data Analyst  82  No      ← phantom
Mayank  CXO  mayank.india@…   03/06/2026 20:57:27  Data Analyst  82  Lua     ← real lead
```

The same junk path also **double-posted to Slack** and **sent a report email to
`rares@heylua.ai`** on every single evaluation.

---

## Root cause

`capture_lead` was firing **twice per evaluation**, and the first call had no real contact info.

1. A visitor scores a role. The skill's tool description instructed the model:
   *"ALWAYS call this tool immediately after `score_jd`."*
2. So the agent called `capture_lead` **at score time** — before the visitor had filled in the
   lead form.
3. The tool requires `email` + `company`, so with no real lead yet the agent **fabricated**
   them from its own builder identity: name `Lua`, company `Lua`, email `rares@heylua.ai`
   (a Lua-team contact it had in context).
4. `execute()` only skipped on quality flags; otherwise it went ahead and wrote the Sheets row,
   posted to Slack, and emailed — using those fabricated values. → **the phantom row.**
5. ~25 s later the visitor submitted the form and `capture_lead` ran again with the **real**
   details → the correct row.

This was effectively a regression of an earlier known issue (Ada auto-chaining `capture_lead`
after `score_jd`).

### Why always `rares@heylua.ai`?
It is **not** hardcoded anywhere (not in code, persona, or env). Production logs showed every
score-time call as:

```
Calling tool with input {"email":"rares@heylua.ai","company":"Lua","jdText":"…"}   // no name, no title
```

The literal name `"Lua"` proves these are agent-fabricated, not human submissions — the model
reached for its builder's identity (`Lua` / a Lua contact) to satisfy the required fields.

---

## The fix

Gate the outward side-effects (Slack / Sheets / email) on a **genuine lead**. Only the lead-form
submission carries a real `name` **and** `title` (both are required form fields); the score-time
auto-call has neither. The evaluation is still always recorded to the Data primitive.

`src/skills/capture-lead.skill.ts`, in `captureLeadTool.execute()`, after the quality-flag
short-circuit:

```ts
// Real-lead gate. capture_lead is called twice per evaluation: once right
// after score_jd (records to Data — done above) and once on form submit.
// Only the form submission has real contact details (name + title). Emitting
// Slack/Sheets/email on the score-time call produced phantom rows + duplicate
// Slack posts + report emails with placeholder data, so skip until we have a
// genuine lead.
if (!name?.trim() || !title?.trim()) {
  return { posted: false, email1Sent: false, email2ScheduledAt: '', skipped: true, reason: 'no_lead_details' };
}
```

The tool description was also updated to state that the score-time call only records to Data, and
that Slack/Sheets/email fire later on form submission — and to never fabricate contact details.

> **Why gate on `title` (not just `name`)?** Logs showed the fabricated calls used name `"Lua"`
> (non-empty) but **no title**. Real leads always have both. Requiring both reliably separates
> the two.

**What did *not* change (in v1.0.34):** the quality-flag short-circuit (`short_jd` / `non_english` /
`suspected_fake`) is untouched, and at this stage every evaluation was still recorded to the
`evaluations` Data primitive (see the follow-up below, which changes that).

---

## Follow-up: stop placeholder records in the `evaluations` Data primitive (v1.0.35, live)

v1.0.34 stopped the phantom **Sheets rows, Slack posts, and emails**, but the `Data.create('evaluations', …)`
call sat at the **top** of `execute()` and ran *unconditionally* — before both guards. So the
score-time auto-call still inserted a placeholder record (`email: rares@heylua.ai`, `name: "Lua"`)
into the Data primitive.

**Fix:** move the `Data.create` to **below the real-lead gate**, so only genuine lead-form
submissions are recorded:

```ts
// real-lead gate first…
if (!name?.trim() || !title?.trim()) {
  return { posted:false, email1Sent:false, email2ScheduledAt:'', skipped:true, reason:'no_lead_details' };
}

// …then record to Data (genuine leads only)
await Data.create('evaluations', { email, name, title, company, role_title, score, … });
```

Because the write now also sits below the quality-flag short-circuit, **flagged evaluations**
(`short_jd` / `non_english` / `suspected_fake`) are **no longer stored** either — only clean,
genuine leads land in the primitive.

---

## Verification

- **Sandbox test** (`lua test skill --name capture_lead`) with a score-time-style input
  (email + company, **no name/title**) returned:
  ```json
  { "posted": false, "email1Sent": false, "email2ScheduledAt": "", "skipped": true, "reason": "no_lead_details" }
  ```
  → records to Data, emits nothing. The phantom path is neutralized.
- A real-lead input (with name + title) proceeds normally (`posted: true`).
- `lua compile --ci` clean; `lua sync --check` reported no drift.

---

## Deployment

Shipped via the gated `lua deploy` flow:

- Live (buggy) version was `capture-lead` **v1.0.29**. Versions 1.0.30–1.0.33 existed on the
  server but were never deployed.
- The fix was pushed and deployed as **v1.0.34** (the first clean version to go live).
- Note: the Lua agent deploy is independent of the website/Vercel deploy.

### How to confirm it's resolved
Score a role on the live tool and submit the lead form. The Google Sheet should now show **one**
row (on submit) instead of a `rares@heylua.ai` phantom row plus the real row. `lua logs --type
skill --name capture-lead` should show the score-time call returning `skipped: no_lead_details`.

### Rollback
If needed, redeploy the previous version: `lua deploy skill --name capture-lead --set-version 1.0.29`
(restores prior behavior, including the bug). Prefer fixing forward.

---

## Note on "clearing the cache"
Clearing the agent's conversation memory (`lua chat clear`) was considered, since that is where the
remembered `rares@heylua.ai` lived. It is **not** a fix — the score-time call would simply fabricate
a different placeholder and keep writing phantom rows. The code gate above resolves the bug
regardless of what any session remembers.
