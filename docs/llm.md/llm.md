# Project Guide for LLMs — "Human or Agent?" (Talent Safari × Lua)

> Read this first. It gives a complete mental model of the repo, the runtime architecture,
> the deployment, and the gotchas, so you can work effectively without re-deriving everything.

---

## 1. What this project is

**"Human or Agent?"** is a free, no-signup web tool, a **joint lead magnet** built by
**Talent Safari × Lua**. A user pastes a **job description (JD)**; an AI agent named **Ada**
scores it across **7 weighted dimensions** and returns an honest verdict: should this role be
filled by a **human** (recruited by Talent Safari) or an **AI agent** (built & deployed by Lua)?

The product is **honest by design** — ~40% of evaluations recommend a human. That honesty is the
trust mechanism: it's a genuine decision-support tool that *happens* to route warm leads to the
right partner (Talent Safari for humans, Lua for agents).

There are **two halves**:
1. **Frontend** — a single static `index.html` (~1700 lines, vanilla JS, no framework/build).
2. **Lua agent "Ada"** — a TypeScript agent on the [Lua platform](https://docs.heylua.ai)
   (`src/`), reached over HTTP. Ada owns scoring, lead capture, and CTA handling.

Hosting/runtime is **Vercel** (static HTML + `/api/*` serverless functions that proxy Lua and
keep secrets server-side).

---

## 2. Repository layout

```
talentsafari/
├── index.html                # The ENTIRE frontend: markup + CSS + JS in one file
├── api/                       # Vercel serverless functions (the live backend)
│   ├── lua-chat.js            # Proxy to Ada's chat API (scoring/enrichment/capture/cta)
│   ├── fetch-jd.js            # Server-side JD-URL fetch (CORS + SSRF protection)
│   ├── slack-notify.js        # Server-side Slack webhook proxy
│   └── _lib/
│       ├── origin.js          # Origin allowlist (CORS-ish gate) for all /api/*
│       ├── rate-limit.js      # Per-IP sliding-window limit (Vercel KV; no-op if unset)
│       └── stream-aggregate.js# Re-assembles Lua SSE stream into {text, steps[]} shape
├── dev-server.mjs             # Local dev server (Express) mirroring Vercel: static + /api/*
├── vercel.json                # Vercel config (no build step; maxDuration; rewrites; headers)
├── src/                       # The Lua agent "Ada" (TypeScript, lua-cli)
│   ├── index.ts               # Agent definition: name, persona, model, skills[]
│   └── skills/
│       ├── score-role.skill.ts   # score_jd — the scoring engine (7 dims, verdict)
│       ├── capture-lead.skill.ts # capture_lead — Slack + report email + follow-up
│       ├── submit-cta.skill.ts   # submit_cta — CTA form → Slack + confirmation email
│       ├── ada-chat.skill.ts     # ada_chat — follow-up Q&A after a score (legacy/aux)
│       ├── brief-wizard.skill.ts # brief wizard
│       ├── scrape-jd.skill.ts    # scrape a JD from a URL
│       └── tools/                # ScoreJd.ts, CaptureLead.ts, SubmitCta.ts
├── lua.skill.yaml             # Lua state manifest (skill IDs + versions; auto-managed)
├── netlify/ + netlify.toml     # LEGACY — pre-Vercel hosting. Not the live path. (see §7)
├── docs/
│   ├── fixes/fix_ada_flow.md  # Writeup of the enrichment-chat fix (see §8)
│   └── llm.md/llm.md          # THIS FILE
├── build.md                   # Original full build spec (brand, flow, scoring, integrations)
├── changes.md                 # Change log
└── package.json               # scripts: dev (dev-server.mjs), build (tsc), start (agent)
```

> **README.md / QUICKSTART.md are generic Lua boilerplate** — they do NOT describe this project.
> The real spec is `build.md`; the real architecture is this file.

---

## 3. Frontend (`index.html`)

Vanilla JS. State lives in a single `state` object; navigation is a set of `.screen` sections
toggled by `go(id)` / `goBack()`. A top progress rail is driven by `railMap`.

### Screens (sections with `class="screen"`)
| ID            | Step (user-facing)        | Purpose |
|---------------|---------------------------|---------|
| `s-hero`      | Step 1                    | JD paste / URL input; "Score this role" |
| `s-questions` | Step 2 of 3               | 3 calibration questions (volume / stakes / customer-facing) |
| `s-enrich`    | (sub-step of Step 1)      | **Ada enrichment chat** for short JDs (< 20 words) |
| `s-analysis`  | Step 3                    | Analysis "theater" **+ lead-capture / email-gate form** |
| `s-result`    | Step 4 (final verdict)    | Score gauge + Human card vs. Agent (Ada) card + dimensions |
| `s-brief`     | CTA                       | Talent Safari brief CTA |
| `s-connect`   | CTA                       | Lua connect/build CTA |

`railMap = { 's-hero':0,'s-questions':1,'s-analysis':2,'s-result':3,'s-brief':3,'s-connect':3 }`

### State object (`index.html`, ~line 816)
```js
const state = {
  jdText:'', volume:'medium', stakes:'low', taskFreq:'medium',
  exposure:'customer_unregulated', result:null,
  leadName:'', leadTitle:'', leadCompany:'', leadEmail:'',
  leadSubmitted:false, leadCaptured:false, apiDone:false, formDone:false,
};
```

### The two flows
- **Normal (JD ≥ 20 words):** `s-hero` → `s-questions` → `runAnalysis()` → `s-analysis`
  (theater + email gate) → `s-result`.
- **Short JD (< 20 words):** `s-hero` → `s-enrich` (Ada asks a couple of questions) →
  **`s-questions`** → … same funnel. (See §8 for the fix that made this correct.)

### How the frontend talks to Ada
All Ada calls go through the **Vercel proxy**, never directly to Lua. The frontend builds a
**per-call session URL** via `adaSessionUrl(prefix)`:
```js
function adaSessionUrl(prefix='eval') { return `/api/lua-chat?channel=${prefix}-${randomUUID}`; }
```
Prefixes: `eval-*` (scoring), `enrich-*` (enrichment chat), `lead-*` (capture), `cta-*` (CTA).
- `callScoreApi()` → `scoreViaAda()` posts `Score this job description:\n\n<jd>\n\nContext: …`.
- Enrichment chat → `callEnrichApi()` posts the running conversation.
- Lead form submit → `/api/lua-chat` (capture) + `/api/slack-notify`.
- **No API key in the browser** — the proxy injects it (see §5/§6).

---

## 4. The Lua agent "Ada" (`src/`)

Defined in `src/index.ts`: `name:"Ada"`, `model:"anthropic/claude-sonnet-4-6"`, 6 skills.

### Persona essentials (do not break these)
- Ada is the **AI side** of the lead magnet; Talent Safari is the human side.
- **Invocation contract (CRITICAL):** every inbound message is a *programmatic API call*, not a
  human chat. Ada must **act immediately, never ask clarifying questions, never reply with text
  when a tool call is required**:
  - Message starts with `Score this job description:` / `Score this job posting:` → call
    `score_jd` **every time** (memory of a prior score does NOT exempt re-calling).
  - `Call the capture_lead tool …` → call `capture_lead` with exact values.
  - `Call the submit_cta tool …` → call `submit_cta` with exact values.
  - **ONE exception — intake/clarification mode:** when a message is *not* one of the triggers above
    and explicitly asks Ada to gather context by questioning the user (and forbids tools), Ada may
    ask a short batch of questions, no tools (this is the enrichment/intake path — see §8 / §14).
- Signs off as **"Ada · Built by Lua"**. Never reveals it's powered by Claude.

### Skills
1. **`score_jd`** (`score-role.skill.ts`) — the scoring engine. You pass raw `jd_text` (+ optional
   context); the tool runs the full structured evaluation internally and returns the verdict.
   **Ada does NOT score by hand.** Returns the full result object (below) or a quality-flagged /
   error payload.
2. **`capture_lead`** (`capture-lead.skill.ts`) — records the evaluation to the **`evaluations`
   Data primitive**, posts to **Slack #leads**, appends a **Google Sheets** row, sends the
   report-delivery email, and schedules Ada's follow-up note (~2h later). **All of this is gated
   to genuine lead-form submissions only** (real `name` **and** `title` present, no quality flags).
   `capture_lead` is called twice per evaluation — once at score time (placeholder/no contact →
   returns `{ skipped, reason:'no_lead_details' }`, does nothing) and once on form submit (real
   data → full effects). Quality flags (`short_jd`/`non_english`/`suspected_fake`) also short-
   circuit to `{ skipped }`. **See §13 for the bug this gating fixed.**
3. **`submit_cta`** (`submit-cta.skill.ts`) — CTA form submissions (Talent Safari brief or Lua
   intro) → Slack + confirmation email.
4. **`ada_chat`** (`ada-chat.skill.ts`) — follow-up Q&A after a score (auxiliary).
5. **`brief_wizard`**, 6. **`scrape_jd`** — supporting skills.

### Scoring model (7 weighted dimensions)
Each dimension is scored 1–10 (10 = "agent-friendly"); the weighted sum maps to a 10–100 score.

| key                  | weight | axis (human ↔ agent) |
|----------------------|:------:|----------------------|
| `task_structure`     | 1.8    | novel/ambiguous ↔ structured/repeatable |
| `judgment_complexity`| 2.0    | human expertise/judgment ↔ rule-based/learnable |
| `volume_scale`       | 1.5    | one-off strategic ↔ high-throughput repeated |
| `regulatory_burden`  | 1.5    | legally needs human sign-off ↔ agent can act autonomously |
| `relationship_depth` | 1.3    | sustained relationship ownership ↔ episodic/transactional |
| `system_integration` | 1.0    | heavy human coordination ↔ tool/API-heavy |
| `data_sensitivity`   | 0.9    | regulated PII/constrained ↔ open/standard data |

**Verdicts:** `needs_human` · `human_led_agent_assist` · `strong_agent`.
**Quality flags** (block Slack/email, return early): `short_jd`, `non_english`, `suspected_fake`.
Result object also includes `verdict_line`, `rationale`, per-dimension `rationale`,
`human_candidate` & `agent_candidate` cards (incl. `monthly_cost`), `recommended_cta`,
and `adjacent_agents`. The frontend gates `monthly_cost` visibility behind the email gate; the
tool always returns it.

---

## 5. Vercel serverless API (`api/`) — the live backend

All `/api/*` handlers share two gates: **`isOriginAllowed()`** and **`checkRateLimit()`**.

### `api/lua-chat.js` — the core proxy (the most important file)
- Injects `Authorization: Bearer ${LUA_API_KEY}` server-side; the key never reaches the browser.
- Forwards the `?channel=` param so the per-call session pattern (`eval-/enrich-/lead-/cta-<uuid>`)
  reaches Lua intact.
- **Primary path = streaming** (`/chat/stream`, SSE), aggregated server-side by
  `stream-aggregate.js` back into the exact `{ text, steps:[{toolResults}] }` shape the old
  `/chat/generate` returned — so the frontend is unchanged. **Why:** a synchronous `/generate`
  holds the connection open with no bytes; long runs (>60s) trip an upstream gateway timeout that
  returns an HTML error page the browser can't `JSON.parse`. Streaming keeps the connection alive.
- **Fallback path** = non-streaming `/chat/generate` if the stream endpoint can't be reached.
- 115s `AbortController` timeout; `maxDuration: 120` (matches `vercel.json`). On abort →
  `504 {error:'scoring_timeout'}`.
- Requires env: **`LUA_AGENT_ID`**, **`LUA_API_KEY`** (500 if missing).

### `api/fetch-jd.js`
Server-side fetch of a JD URL (CORS workaround) **with SSRF protection** — blocks loopback,
RFC1918 private ranges, link-local/AWS-metadata (`169.254.*`), and IPv6 local addresses.

### `api/slack-notify.js`
Proxies the frontend's Slack pings, keeping `SLACK_LEADS_WEBHOOK_URL` server-side. No-op (200,
empty) if the webhook isn't configured.

### `api/_lib/`
- **`origin.js`** — `isOriginAllowed(origin, host)`. Allowed = `ALLOWED_ORIGINS` (CSV) ∪ Vercel
  auto URLs (`VERCEL_URL`, `VERCEL_BRANCH_URL`, `VERCEL_PROJECT_PRODUCTION_URL`) ∪ default dev
  origins (`localhost:3000/5173/8000/8080`, `127.0.0.1:3000/5173`) ∪ same-origin host match.
  → **`http://localhost:3000` is allowed out of the box**; no env needed for local dev.
- **`rate-limit.js`** — per-IP sliding window backed by **Vercel KV**. If `KV_REST_API_URL` /
  `KV_REST_API_TOKEN` are unset (e.g. locally), it logs `rate limiting disabled` and is a no-op.
  `lua-chat`/`slack-notify` limits: 10/min and 60/hr (stricter wins).

---

## 6. Environment variables

| Var | Used by | Notes |
|-----|---------|-------|
| `LUA_AGENT_ID` | `api/lua-chat.js` | Ada's agent id (`baseAgent_agent_1779215133611_x0svb7j5d`) |
| `LUA_API_KEY` | `api/lua-chat.js` | **Server-side only.** Lua agent API key (`api_…`). |
| `SLACK_LEADS_WEBHOOK_URL` | `api/slack-notify.js` | Slack #leads webhook |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | `api/_lib/rate-limit.js` | Vercel KV; optional (no-op if unset) |
| `ALLOWED_ORIGINS` | `api/_lib/origin.js` | CSV of extra allowed origins (prod domains) |

The Lua **agent** itself (deployed separately on the Lua platform) also uses `ANTHROPIC_API_KEY`,
`RESEND_API_KEY`, `FROM_EMAIL`, `ADA_FROM_EMAIL`, `SLACK_LEADS_WEBHOOK_URL` for `capture_lead` /
`submit_cta`. `.env` is gitignored.

> **Security history:** the API key used to be inline in `index.html` (and once expired → 401
> "Invalid or expired token"). It was moved server-side into the `/api/lua-chat` proxy. Do **not**
> reintroduce a browser-side key.

---

## 7. Branches & deployment

- **`main`** — *stale* (`88795126`, pre-Vercel). 52 commits **behind** `review/latest-updates`,
  0 ahead. Do not assume `main` is current.
- **`review/latest-updates`** — the **active integration branch**; contains the Vercel migration,
  server-side keys, streaming proxy, etc. **Almost certainly the Vercel production branch**
  (the live site serves `/api/lua-chat`, which only exists here — not on stale `main`).
- **`yash/fixes`** — feature branch off `review/latest-updates` (the enrichment fix; PR #3 targets
  `review/latest-updates`).
- `netlify/` + `netlify.toml` are **legacy** (pre-Vercel) and not the live path.

**Deploy mechanics:** no `.github/workflows`, no git/branch override in `vercel.json` → Vercel's
**default git integration**. Push to the production branch → production deploy; push to any other
branch → preview deploy. So **merging into the production branch auto-deploys to the live site**
within ~1–2 min. Confirm the production branch in *Vercel → Settings → Git → Production Branch*.

---

## 8. The enrichment-chat fix (recent; PR #3)

**Bug 1 (navigation):** for short JDs, when the enrichment chat finished it called `go('s-result')`
— jumping to the final verdict and skipping Step 2 **and** the `s-analysis` email-gate, so leads
were never captured.

**Bug 2 ("Something went wrong"):** the enrichment seed told Ada to call `score_jd` (~40s) and she
auto-chained `capture_lead` (premature Slack + emails). The heavy request hit a timeout → the
browser request failed → navigation never ran (backend still scored & "remembered" it).

**Fix (in `index.html`, enrichment section):** the enrichment chat now **only gathers context** —
no tools, no scoring, no email. Ada asks up to **4** short questions and signals completion with a
`[[ENRICH_DONE]]` token. The frontend advances on the token **or** after a hard cap
(`ENRICH_MAX_ANSWERS = 4`), folds the answers into the JD (`buildEnrichedJd()` → `state.jdText` +
`#jd`), and goes to **`s-questions`** (`finishEnrich()`). Real scoring + the email gate happen later
in the normal funnel. Verified live: ~3–4s/turn, zero tool calls. Full writeup:
`docs/fixes/fix_ada_flow.md`.

> **Update (§14):** this enrichment chat was later **repurposed** to ask four specific,
> high-leverage dimension questions (judgment / regulatory / relationship / systems) as one
> numbered batch, instead of generic "tasks & volume" questions. The mechanics below (no tools,
> `[[ENRICH_DONE]]` token, 4-answer cap, fold-into-JD) are unchanged — only the seed content,
> the rendering, and Ada's persona changed. See §14.

---

## 9. Local development

```bash
npm install            # this branch needs `express` (stale node_modules from main won't have it)
# create .env in repo root:
#   LUA_AGENT_ID=baseAgent_agent_1779215133611_x0svb7j5d
#   LUA_API_KEY=<working agent api key>
npm run dev            # → http://localhost:3000  (serves index.html + /api/* via dev-server.mjs)
```

- **Use `npm run dev` (port 3000), NOT a plain static server.** A bare `python3 -m http.server`
  serves the HTML but **not** `/api/lua-chat`, so the chat 404s → "Something went wrong".
- `dev-server.mjs` parses `.env` itself (no dotenv), mounts the three `/api/*` handlers, and serves
  static files with an SPA fallback. KV rate-limiting is disabled locally (benign log line).
- The Lua agent (`src/`) is managed with **lua-cli** (`lua chat/test/push/deploy`, etc.). A Claude
  Code plugin gates `lua deploy` — never run bare `lua deploy`; use the `/lua-deploy` flow.

---

## 10. Gotchas & conventions

- **Frontend ↔ Lua coupling:** the proxy must return `{ text, steps:[{toolResults:[{payload:{toolName,result}}]}] }`.
  Tool names arrive namespaced, e.g. `score_role__score_jd` — match with `includes('score_jd')`,
  not strict equality.
- **The enrichment chat no longer parses tool results** — it keys on the `[[ENRICH_DONE]]` token
  and an answer-count cap (see §8). Don't reintroduce `score_jd` into the enrichment path.
- **Calibration bounds** (held in the persona/scoring): e.g. Tier-1 support JDs ~70–85,
  high-judgment leadership roles lower. Keep the ~40%-human honesty property.
- **Never** post to Slack / send email when a quality flag is set.
- **Secrets stay server-side** (proxy). Don't put keys in `index.html`.
- `main` is stale — branch from / target `review/latest-updates` for live-bound work.
- Single-file frontend: edit `index.html` directly; there's no bundler/build for the UI.
- **Vercel skips duplicate deploys.** If you push a commit whose source tree is byte-identical
  to an existing deployment (e.g. a `git revert` that restores an already-deployed state), Vercel
  deduplicates and **creates no new deployment** — the live alias stays put and you'll see the
  Vercel check missing (only Cursor Bugbot runs). Fixes: use Vercel **Instant Rollback** in the
  dashboard (re-aliases instantly, no rebuild), or push a behavior-neutral change (e.g. an HTML
  comment marker) to make the source unique and force a build. (See §12.)

---

## 11. Chat-first hero redesign — original commit `2be603ca` (superseded by §15)

> **Update (§15):** the chat-first hero was **re-shipped** on branch `feat/ui_changes`, this time
> wired to the current 4-dimension intake brain and with a redesigned single-panel "pill" composer.
> The section below describes the *original* `2be603ca` build for history; for the live re-ship see §15.

A reworked, conversational hero exists on **`origin/yash/fixes`** (commit `2be603ca`,
"feat(hero): chat-first intake with Ada leading the conversation"). It was merged to
`review/latest-updates` via **PR #4** and then **reverted** (see §12), so **production currently
runs the original flow** described in §3 (paste box → separate `s-enrich` screen). This commit is
the source of truth if/when the redesign is re-shipped.

**What it changes (all in `index.html`):**
- **`s-hero` becomes a chat surface.** The big paste `<textarea>` / `.dropzone` is replaced by an
  always-visible Ada chat: a greeting renders instantly (local string `HERO_GREETING`, no API
  call), the user's **first message is the role** (paste or describe). The headline is kept above
  the chat (smaller: `clamp(28px,4.2vw,48px)`), content shifted up.
- **`s-enrich` screen deleted.** Thin JDs (< 20 words) now trigger the enrichment loop **inline**
  in the same hero chat: `sendHeroMessage()` branches — ≥ 20 words → ack bubble → `s-questions`;
  < 20 words → seed Ada (no tools) and reuse the existing `callEnrichApi` / `[[ENRICH_DONE]]` /
  4-answer-cap loop. A hidden `#jd` textarea is kept in sync for downstream code (`runAnalysis`,
  `finishEnrich`) so the funnel past the hero is unchanged.
- **Composer UX:** full-width box matching the chat panel; `Try a sample JD` / `Upload PDF` are
  icon-only buttons **inside** the box that expand on hover; Send sits inside bottom-right. The
  chat panel (`.enrich-msgs`) is a **fixed-height (260px) scrolling box** with the "A" avatar to
  its left (no "Ada / Built by Lua" label).
- **Enrichment seed steered away from §3-step-2 topics** (don't re-ask volume / who-they-interact-
  with / routine-vs-novel — those are the calibration questions). Greeting lists 3 non-overlapping
  questions (role/tasks, decision stakes, tools/systems).
- **Copy:** em dashes removed from all user-facing strings (kept in comments / CSS bullet markers /
  the AI seed / disabled wizard).
- Adds `docs/feature/merge_box_plus_ada.md` (design notes for the earlier inline-expand step).

**To re-ship / recover:** the commit is safe on `origin/yash/fixes`. Push to a fresh branch with
`git push origin yash/fixes:<new-branch>`, or re-apply onto production by reverting the revert
(`git revert d1f3d9a7`) — then drop the redeploy marker comment from §12.

---

## 12. Production rollback episode (2026-06-03)

PR #4 (`2be603ca`, chat-first hero) was merged into `review/latest-updates` (merge commit
`18ad6f13`) and auto-deployed to production. It was then rolled back:
1. **`d1f3d9a7`** — `git revert -m 1 18ad6f13` (non-destructive; restores the exact pre-merge tree,
   `a9d262e5`). Pushed to `review/latest-updates`. **Vercel deduped it and did NOT redeploy** (the
   revert's source was identical to the already-deployed `a9d262e5`), so the live site stayed on
   the chat-first build — see the dedup gotcha in §10.
2. **`f63cd25b`** — `chore: force redeploy of rolled-back state`: a one-line HTML comment marker
   (`<!-- redeploy marker… -->` near the top of `index.html`) makes the source unique, forcing a
   fresh production build. This deployed successfully and is the **current live state** (the
   original pre-PR#4 flow). The marker comment is harmless; remove it when the redesign is
   re-shipped.

---

## 13. The `capture_lead` phantom-lead fix (2026-06-03) — `capture-lead` v1.0.34 + v1.0.35

Full writeup: **`docs/fixes/bug_fix.md`**. Summary for context:

**Bug.** After the "extended sheets schema" change (skill **v1.0.29**, the then-live version), the
Google Sheet got a **phantom row before every real lead**: no name, empty title, company `Lua`,
email `rares@heylua.ai`, same role+score as the real lead ~25s later. It also **double-posted to
Slack** and **emailed the report to `rares@heylua.ai`** on every evaluation, and wrote a placeholder
record to the **`evaluations` Data primitive**.

**Root cause.** `capture_lead`'s instruction said *"ALWAYS call immediately after `score_jd`,"* so
the agent called it **at score time** — before the visitor filled the lead form. With no real lead,
it **fabricated** the required `email`/`company` from its own builder identity (name `Lua`, company
`Lua`, email `rares@heylua.ai` — a Lua contact it had in context; **not hardcoded**, confirmed via
`lua logs`). `execute()` then ran all side-effects anyway. (Essentially a re-run of the §8 premature-
`capture_lead` issue.)

**Fix (two versions, both live):**
- **v1.0.34** — added a **real-lead gate** in `execute()` after the flag short-circuit: if
  `!name?.trim() || !title?.trim()` → return `{ skipped, reason:'no_lead_details' }`. Only the
  lead-form submission has both `name` and `title` (required form fields); the score-time call has
  neither. This stopped the phantom **Slack / Sheets / email**.
- **v1.0.35** — moved the `Data.create('evaluations', …)` call from the top of `execute()` (where it
  ran unconditionally) to **below** the real-lead gate, so the score-time/flagged calls no longer
  write placeholder records to the **`evaluations` Data primitive**. The tool description + skill
  `context` were updated to match (score-time/flagged → records nothing; only genuine leads are
  recorded + notified). **Side effect:** flagged evaluations are no longer stored to Data either.

**Discriminator note:** the gate keys on **`title`** (and `name`), not on the email — logs showed the
fabricated calls used name `"Lua"` (non-empty) but **no `title`**, while real leads always have both.

**Deploy.** Shipped via the gated `/lua-deploy` flow. Note `capture-lead` versions 1.0.30–1.0.33
existed on the server but were never deployed; **1.0.29 was the buggy live version**, then
**v1.0.34**, now **v1.0.35** is live. Remember the Lua agent deploy is independent of the Vercel
frontend deploy — and Vercel's dedup (§10) does not apply to `lua deploy`.

**These fixes are committed on `review/latest-updates`** (local commits `043dd176`, `a6b52ff9`, +
follow-ups) and are **already live on the Lua platform** via `lua deploy`, regardless of whether the
git branch has been pushed.

---

## 14. Ada intake-mode questions — the 4 high-leverage dimensions (2026-06-04)

Full writeup / plan: **`docs/fixes/ada_persona.md`**.

**Why.** `score_jd` scores 7 weighted dimensions, but the user only supplied direct signal for 3
of them via the Step-2 MCQs (`task_structure`, `volume_scale`, and a blunt `exposure` answer). The
four hardest-to-infer, highest-leverage dimensions got **no direct signal** and were guessed from
the JD text alone: `judgment_complexity` (weight **2.0**, the single biggest score lever),
`regulatory_burden` (1.5), `relationship_depth` (1.3), `system_integration` (1.0). On a thin JD
those guesses are weakest — yet that path's enrichment chat only asked vague "tasks & volume"
questions (which overlap the MCQs).

**What changed.** The existing **enrichment chat** (`s-enrich`, thin-JD-only `<20` words) was
**repurposed** to ask those four dimensions. No new screen, no control-flow change — it reuses the
`[[ENRICH_DONE]]` token + `ENRICH_MAX_ANSWERS=4` cap + fold-into-JD machinery from §8.
- **Trigger unchanged:** still only the thin-JD path. The 3 Step-2 MCQs are **kept**; the Ada step
  is additive (thin JD → `s-enrich` (4 Qs) → `s-questions` (MCQs) → analysis). Long JDs are untouched.
- **`index.html`:** rewrote the enrichment **seed** (`startEnrichChat`) to present all four questions
  as one **numbered batch** in the first message and re-ask only the gaps. **Conditional 5th question:**
  Ada first checks whether the brief description already names a **job title** (e.g. nurse, software
  engineer); if not, question 1 becomes "What is the job title you are looking to hire for?" and the
  four dimension questions follow as 2–5 (five total) — otherwise just the four. Ada judges this from
  the JD preview (no JS detection). The 4-reply cap is unaffected (it counts turns, not questions).
  `buildEnrichedJd()` now
  prefixes the folded block `Clarifying answers (judgment, regulation, relationships, systems):`
  so the rubric can bind answers to dimensions; refreshed `s-enrich` copy; and `appendEnrichMsg`
  now renders Ada messages with **preserved line breaks** (`white-space:pre-wrap`) and safe
  **`**bold**`** (HTML-escaped, then `**…**` → `<strong>`). No change to `score-role.skill.ts`
  (rubric/schema) — answers reach scoring purely as JD context.
- **`src/index.ts` (persona):** added a scoped **"Intake / clarification mode (the ONE exception)"**
  section legitimizing the questioning; the `score_jd` / `capture_lead` / `submit_cta` hard triggers
  and their "never ask" rules are **unchanged** (the exception applies only to the enrichment prompt,
  which starts with none of those triggers). See §4.

**Deploy.** Two independent paths (as always):
- **Persona → Lua platform, live as v37.** Drift surfaced at the deploy sync gate (local persona ≠
  server); resolved with `lua sync --push` (created server **v36**), then the gated `/lua-deploy`
  staged + promoted **v37**.
- **Frontend → Vercel.** Committed as `c90e4c61` and pushed to `review/latest-updates` (auto-deploy).
  ⚠️ **Process note:** that push was a **direct push to the production branch** and carried **9
  commits** (the branch was 9 ahead of origin — the 8 §13 capture-lead/docs commits had never been
  pushed). Only `c90e4c61` changes site behavior; the other 8 touched `docs/`, `lua.skill.yaml`,
  `.lua/`, and `src/skills/capture-lead.skill.ts` (no `index.html`/`api/`). Going forward, land
  changes via a **PR from a feature branch**, not a direct push — and check
  `git log origin/<branch>..<branch>` before pushing to a production branch.

---

## 15. Chat-first hero re-ship + pill-composer redesign (2026-06-04) — branch `feat/ui_changes`

Full plan: **`docs/fixes/UI_change.md`**. This re-ships the §11 chat-first hero (Ada on the first
screen) but, crucially, **merges it with the current 4-dimension intake brain** (§14) instead of the
older generic enrichment that shipped with `2be603ca`. Branch `feat/ui_changes` (off
`review/latest-updates`); two commits: `fe5b1a5d` (re-ship) + `008d867d` (UI refinements). All
changes are in **`index.html`** — no `api/`, no `src/` (persona/skills) change.

**Why a merge, not a revert-the-revert.** `2be603ca` carried its own *generic* enrichment (an
inline 3-topic seed in `sendHeroMessage`, plain-`textContent` rendering, a "Additional details
provided:" fold). Reverting the revert would have resurrected the hero **and clobbered** the §14
intake work. So the §14 brain **wins**: `startEnrichChat()` (the 4-dimension numbered batch),
`appendEnrichMsg()` (HTML-escape + `**bold**` + pre-wrap), and `buildEnrichedJd()` ("Clarifying
answers (judgment, regulation, relationships, systems):") are the single source of truth.

**What changed (`index.html`):**
- **`s-hero` is the Ada chat; the separate `s-enrich` screen is deleted.** `sendHeroMessage()` is the
  hero composer's Send: first message = the role (sets `state.jdText` **and** the hidden `#jd`);
  **≥ 20 words** → quick ack bubble → `go('s-questions')`; **< 20 words** → `heroStage='enriching'`
  then **calls `startEnrichChat()`** (so the seed stays the §14 single source — preserves the
  `enrichHistory[0] == seed` invariant that `buildEnrichedJd().slice(1)` / `callEnrichApi` rely on).
  Subsequent turns push the answer and call `callEnrichApi(false)`.
- **New JS:** `HERO_GREETING` (minimal paste-or-describe greeting; does **not** pre-ask the 4
  dimensions), `heroStage`, `initHeroChat()` (resets chat to the greeting — called from
  `renderScreen('s-hero')` on Back/restart and once at boot, since the static `active` hero +
  initial `replaceState` don't route through `renderScreen`).
- **Removed dead code:** old `handleScoreClick()` (paste-box `#heroBtn` handler) and
  `sendEnrichMessage()`; `enrichEnterSend()` now calls `sendHeroMessage`. `loadSample()` /
  `handlePdfUpload()` retarget the composer (`#enrichInput`); PDF text lands in the composer
  (not auto-sent) so the user can review.
- **Single-panel "pill" composer (UI redesign).** Messages + input live in **one** bordered
  `.chat-panel` (avatar "A" on the left). The input is a rounded **pill that floats inside** the
  panel near the bottom: round **hover-expand** tool icons (sample / PDF) on the left, the textarea
  in the middle, and a circular **up-arrow (↑)** Send button on the right (replaces the "Send →"
  text button). The reply area is a fixed-height scroll region (currently `.enrich-msgs` `height:
  300px`); the input ~90px below it. **Gotcha fixed:** `.enrich-msgs` must use `flex: none` +
  explicit `height` — `flex: 1` resolves to `flex-basis: 0%` and collapses the reply area in an
  auto-height panel.
- **Auto-grow composer:** `autoGrowComposer(el)` sets the textarea height to `min(scrollHeight,
  COMPOSER_MAX_H=120)` on input — the pill grows line-by-line up to the cap, then scrolls. Reset on
  send / Back / restart; grown to fit PDF-extracted text.
- **Copy/layout:** removed the "Free · No signup" eyebrow, trimmed the sub-headline, shifted the
  whole hero block up (`.hero { margin-top: -40px }`). Dropped the §12 **redeploy marker** comment
  (re-shipping the redesign supersedes it) and the `restart()` `#otherRoles` null-ref (that element
  no longer exists).

**Deploy.** Frontend-only → Vercel. Land via **PR from `feat/ui_changes` into `review/latest-updates`**
(preview deploy on the PR is the real-browser check — no headless browser was available locally;
verification so far is syntax + serve + structural greps). Per §12, once this is live the §11/§12
"reverted, not deployed" framing is obsolete.
