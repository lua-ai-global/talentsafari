# Human or Agent? — Build Spec (Updated to match shipped architecture)
### Static HTML Frontend + Netlify Functions + Lua Agent (Ada)
> **Launched:** 25 May 2026  
> **Stack (shipped):** Static `index.html` · Netlify Functions (API proxy) · Lua agent platform · Claude Sonnet 4.6 (via AI.generate in score_jd tool) · Slack webhook · Resend email  
> **Original spec stack:** Next.js 14 + Vercel — not built; static HTML + Netlify chosen for speed of launch

---

## Architecture (as shipped)

```
Browser (index.html)
  └─► /.netlify/functions/lua-chat      ← proxies all Lua agent API calls
  └─► /.netlify/functions/slack-notify  ← proxies frontend Slack pings

Netlify Functions (server-side, secrets never reach browser)
  └─► Lua agent API (Ada)
        └─► score_jd tool → AI.generate({ temperature: 0.2, tool_choice: forced })
        └─► capture_lead tool → Slack Block Kit + Resend email
        └─► submit_cta tool → Slack + Resend confirmation

Environment variables (set in Netlify dashboard):
  LUA_AGENT_ID          — Lua agent ID
  LUA_API_KEY           — Lua API key (rotate from git history exposure)
  SLACK_LEADS_WEBHOOK_URL — Slack incoming webhook (recreate from git history exposure)
  RESEND_API_KEY        — Resend transactional email key
  FROM_EMAIL            — Sender address for Resend
```

## URL routing
- `/`        → hero/JD input
- `/score`   → analysis screen (history.pushState)
- `/results` → results screen (history.pushState, tracked for LinkedIn conversion)
All routes served by `index.html` via Netlify redirects.

## What was NOT built from original spec
- PDF generation (called out in spec — not implemented)
- Email gate before showing monthly_cost (spec called this out — tool returns value, frontend hides it behind lead form instead)
- Next.js / Vercel stack

---

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Brand & Design Tokens](#2-brand--design-tokens)
3. [Frontend — 6-Step Flow](#3-frontend--6-step-flow)
4. [Scoring Engine (Claude API)](#4-scoring-engine-claude-api)
5. [Ada — The Lua Agent](#5-ada--the-lua-agent)
6. [Email & Slack Integration](#6-email--slack-integration)
7. [File & Folder Structure](#7-file--folder-structure)
8. [Environment Variables](#8-environment-variables)
9. [Deployment Checklist](#9-deployment-checklist)

---

## 1. Project Overview

**Human or Agent?** is a free, no-signup tool that scores a job description (JD) across 7 dimensions and returns an honest verdict: should this role be filled by a **human** (sourced by TechSafari) or an **AI agent** (built and deployed by Lua)?

The tool is a **lead magnet for both partners simultaneously**. The honesty of the verdict (~40% say "hire a human") is the trust mechanism — it's not a sales funnel, it's a genuine decision-support tool that happens to route warm leads to the right partner.

### How it works end-to-end

```
User pastes JD
    ↓
3 clarifying questions (volume / stakes / customer-facing)
    ↓
Claude API call → structured JSON score (7 dimensions, 10–100 score)
    ↓
Result page: score gauge + Human card vs. Agent (Ada) card
    ↓
Email gate: reveal Ada's cost + download PDF report
    ↓
CTA branches: "Brief Tech Safari" or "Connect with Lua"
    ↓
Lead posted to Slack #leads + follow-up email sent from Ada
```

### Partners & their roles

| Partner | Seat | CTA |
|---------|------|-----|
| **TechSafari** | Human recruiting | "Brief Tech Safari" — short recruiter brief form |
| **Lua (heylua.ai)** | AI agent deployment | "Connect with Lua" — 15-min intro booking form |

---

## 2. Brand & Design Tokens

### TechSafari palette

```css
--ts-forest:  #01261C;   /* primary dark green — headlines, nav bg */
--ts-bright:  #0ECB7B;   /* accent bright green — buttons, score bar fill */
--ts-cream:   #EAE4D5;   /* background — page bg, card bg */
```

### Lua palette

```css
--lua-purple: #6C4CF0;   /* agent card accent, agent bar fill, Lua CTA */
```

### Typography

```
Headlines:  Space Grotesk, 700 weight
Body:       Inter, 400/500
Monospace:  JetBrains Mono (score numbers, JSON debug)
```

Install via Google Fonts in `layout.tsx`:
```html
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
```

### Key UI rules

- Background: `#EAE4D5` (cream) across all pages — not white, not grey
- Rounded cards: `border-radius: 16px`
- Score gauge: semicircular SVG arc, fill color transitions from green (`#0ECB7B`) at low scores to purple (`#6C4CF0`) at high agent-fit scores
- Dimension bars: left-lean = green (human), right-lean = purple (agent). Always label both ends.
- No spinner on analysis step — use staged text ("Evaluating task structure…", etc.) with ~2s delay each. Theater is intentional.

---

## 3. Frontend — 6-Step Flow

### Step 1 — Hero / JD Input

**Route:** `/`

**What the user sees:**
- Headline: "Should your next hire be **human** or **AI**?" ("human" in `#0ECB7B`, "AI?" in `#6C4CF0`)
- Sub-copy: "Paste a job description. In 15 seconds you'll get an Agent Fit Score and a side-by-side of what hiring a human vs. an agent for that role actually looks like."
- Large `<textarea>` placeholder: "Paste a job description here — or drop a PDF, or paste a LinkedIn job link…"
- Three helper buttons below the textarea: `▲ Try a sample JD` | `📄 Upload PDF` | `🔗 Paste link`
- Primary CTA: `Score this role →` (dark forest green button)
- Trust line below button: `● Honest by design — ~40% come back "hire a human"  ● Verdict in 15 seconds`
- Nav: TechSafari logo (top-left) | `Tech Safari × Lua` pill (top-right)

**State handling:**
```typescript
const [jdText, setJdText] = useState('');
const [inputMode, setInputMode] = useState<'text' | 'pdf' | 'url'>('text');

// Sample JD (pre-fill on click)
const SAMPLE_JD = `Tier 1 Customer Support Specialist...`; // use a real support JD
```

**Validation before proceeding:**
- Minimum 100 characters OR a valid PDF upload OR a valid LinkedIn/job URL
- If `jdText.length < 100` and no file/URL → show inline error: "The JD seems a bit short — paste more detail for an accurate score."

---

### Step 2 — Clarifying Questions

**Route:** `/questions` (or modal overlay on same page)

**Header:** "Three quick things the JD doesn't say." + "Thirty seconds. These calibrate the score — they're not stored."

**Question 1 — Volume**
> "How much volume does this role handle per week?"

```
○ A handful of items
○ Steady, dozens a day
○ High-throughput, hundreds+
```
Maps to: `volume: 'low' | 'medium' | 'high'`

**Question 2 — Stakes**
> "How costly is a wrong decision in this role?"

```
○ Low — easily corrected
○ Moderate
○ High — hard to undo
```
Maps to: `stakes: 'low' | 'moderate' | 'high'`

**Question 3 — Customer-facing + regulated**
> "Is the work customer-facing, and is the domain regulated?"

```
○ Customer-facing, unregulated
○ Internal
○ Regulated domain
```
Maps to: `exposure: 'customer_unregulated' | 'internal' | 'regulated'`

**CTA:** `Run the analysis →`

These three answers are injected into the Claude system prompt alongside the JD text to calibrate scores before the API call fires.

---

### Step 3 — Analysis / Loading Screen

**Route:** `/analysing` (or transition state)

**DO NOT use a spinner.** Use a staged text sequence with icon:

```
🔍  "Reading the role like a hiring panel."
     "Seven dimensions, scored and weighted."

Sequence (show each for ~2s, fade in/out):
  1. "Evaluating task structure…"
  2. "Evaluating judgment complexity…"
  3. "Weighing volume & stakes…"
  4. "Measuring empathy & emotional load…"
  5. "Checking system integration patterns…"
  6. "Assessing data sensitivity…"
  7. "Drafting candidate profiles…"
  → "Your verdict is ready."
```

**Implementation:**

```typescript
const stages = [
  'Evaluating task structure…',
  'Evaluating judgment complexity…',
  'Weighing volume & stakes…',
  'Measuring empathy & emotional load…',
  'Checking system integration patterns…',
  'Assessing data sensitivity…',
  'Drafting candidate profiles…',
];

// Fire API call immediately on mount; show stages regardless of actual API speed
// If API resolves before all stages shown → wait for stage 7 before navigating
// If API takes longer → hold on stage 7 until resolved
```

---

### Step 4 — Result Page

**Route:** `/result`

#### 4a — Score + Verdict header

```
[Role title from JSON]

   ██████████████  78  ████████████████
   ← Needs a human        Built for an agent →

⚡ Strong agent candidate
"This role is built for an agent."
[rationale text — max 240 chars]
```

Score gauge: semicircular SVG. Score displayed large in centre. Verdict badge uses:
- `0–39` → forest green bg, "Needs a human" 
- `40–64` → amber, "Human-led, with agent assist"
- `65–100` → purple bg, "Strong agent candidate"

#### 4b — Side-by-side candidate cards

**Human card** (left):

```
H   Human Hire
    [role title] · full-time

    Salary, loaded     $[salary_range]
    Time to productive [time_to_productive]
    Scale ceiling      [scale_ceiling]
    Coverage           [coverage]

    Great at
    ✓ [great_at[0]]
    ✓ [great_at[1]]
    ✓ [great_at[2]]

    Hard part
    ✗ [hard_at[0]]
    ✗ [hard_at[1]]

    🧭 Brief Tech Safari
```

**Agent card** (right, "BEST FIT" badge if score ≥ 65):

```
A   Ada  ← avatar from DiceBear using avatar_seed
    [agent_candidate.role_title] · agent

    Monthly cost       [monthly_cost]
                       🔓 Reveal — adds your email  ← locked until email gate
    Start date         [start_date]
    Throughput         [throughput]
    Coverage           [coverage]

    Great at
    ✓ [great_at[0]]
    ✓ [great_at[1]]

    Can't do
    ✗ [cant_do[0]]
    ✗ [cant_do[1]]

    ⚡ Connect with Lua
```

**Ada's avatar:** Use DiceBear `avataaars` style:
```
https://api.dicebear.com/7.x/avataaars/svg?seed=[avatar_seed]
```

#### 4c — Dimension breakdown bars

Below both cards, show all 7 dimensions:

```
← Needs a human ————————————————— Built for an agent →

task_structure       [label]    ████████░░░░░░░░  7/10
judgment_complexity  [label]    ██████░░░░░░░░░░  6/10
volume_scale         [label]    ████████████░░░░  9/10
stakes_per_decision  [label]    ████░░░░░░░░░░░░  4/10
empathy_load         [label]    ███░░░░░░░░░░░░░  3/10
system_integration   [label]    █████████░░░░░░░  7/10
data_sensitivity     [label]    ██████░░░░░░░░░░  6/10
```

Bar fill color: interpolate from `#0ECB7B` (score 1) to `#6C4CF0` (score 10).
Each bar includes the dimension `rationale` as a tooltip on hover.

#### 4d — Slack lead preview (show below the fold)

Show a visual mockup of what the Slack message looks like. This builds trust — the user sees exactly what TechSafari and Lua will receive.

```
#leads
━━━━━━━━━━━━━━━━━━━━━━━━━━━
🤖 Agent Fit Bot · just now
New evaluation — [role_title]
Verdict: [verdict_line] · Score [score] · [Company]
[ 🧭 Tech Safari takes this ] [ ⚡ Lua takes this ]
```

---

### Step 5 — Email Gate

**Trigger:** User clicks "🔓 Reveal" on the agent card's monthly_cost field

**What gets revealed:** Ada's full cost breakdown + PDF download

**Gate UI** (modal or inline card):

```
⚡ One step — your lead

Unlock the full report

Reveal Ada's cost breakdown, the seven-dimension PDF, and a
follow-up note written by Ada herself.

[Work email         ]
[Company            ]

[ Reveal & download report ]

Tech Safari & Lua only. No spam. Used to route your lead.
```

**On submit:**
1. Validate email (real format) + company (non-empty)
2. POST to `/api/capture-lead` → triggers Slack webhook + Resend email
3. Reveal `monthly_cost` field on agent card
4. Trigger PDF generation + download
5. Show success state: "Check your inbox — Ada's on her way."

---

### Step 6 — CTA Forms

Two separate forms, shown after the result page based on `recommended_cta`.

#### TechSafari path (`/brief-tech-safari`)

```
Human-led path · Tech Safari

Brief Tech Safari on this role.
"This becomes the recruiter brief. A specialist replies within one business day."

Your name        [          ]
Work email       [          ]
Company          [          ]
When do you need this seat filled?  [          ]

[ Send brief to Tech Safari → ]

← Back to verdict
```

#### Lua path (`/connect-lua`)

```
Agent-led path · Lua

Connect with Lua.
"Book a 15-minute intro — Lua scopes the agent for this role and gives you a build estimate."

Your name        [          ]
Work email       [          ]
Company          [          ]
What should this agent own first?  [          ]

[ Book intro with Lua → ]

← Back to verdict
```

Both forms POST leads to `/api/submit-cta` → Slack + Resend.

---

## 4. Scoring Engine (Claude API)

### API route

**File:** `app/api/score/route.ts`

```typescript
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST(req: Request) {
  const { jdText, volume, stakes, exposure } = await req.json();

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',           // or claude-opus-4-6 for higher quality
    max_tokens: 2000,
    system: SYSTEM_PROMPT,                 // see below — prompt-cached
    messages: [{
      role: 'user',
      content: buildUserPrompt(jdText, volume, stakes, exposure)
    }],
    tools: [{ name: 'score_role', input_schema: SCORING_SCHEMA }],
    tool_choice: { type: 'tool', name: 'score_role' }
  });

  const toolUse = response.content.find(c => c.type === 'tool_use');
  const result = toolUse?.input;

  // Server-side validation: score must equal Σ(dimension.score × dimension.weight) rounded
  const computed = computeScore(result.dimensions);
  if (Math.abs(computed - result.score) > 1) {
    // Retry once, then return error
    return Response.json({ error: 'score_mismatch' }, { status: 422 });
  }

  // Flag short-circuit
  if (result.flags.short_jd || result.flags.non_english || result.flags.suspected_fake) {
    return Response.json({ flagged: true, flags: result.flags });
  }

  return Response.json(result);
}

function computeScore(dimensions: Dimension[]): number {
  const raw = dimensions.reduce((sum, d) => sum + d.score * d.weight, 0);
  return Math.round(raw);
}
```

### System prompt (prompt-cached for cost efficiency)

```
You are an honest, expert hiring advisor scoring job descriptions for automation fit.

You evaluate roles across 7 dimensions. Each dimension is scored 1–10:
  1 = strongly human-suited (novel, relational, high-stakes, regulated)
  10 = strongly agent-suited (repeatable, rule-based, high-volume, low-stakes)

DIMENSIONS & WEIGHTS:
  task_structure       — novel ↔ repeatable                     weight: 1.8
  judgment_complexity  — genuine reasoning ↔ rule-based         weight: 2.0
  volume_scale         — one-off ↔ high-throughput              weight: 1.5
  stakes_per_decision  — high-impact errors ↔ low-impact        weight: 1.5
  empathy_load         — relational ↔ transactional             weight: 1.3
  system_integration   — people-coordination ↔ tool/API-heavy   weight: 1.0
  data_sensitivity     — regulated/constrained ↔ open           weight: 0.9

FINAL SCORE = Σ(score × weight), range 10–100.

VERDICT BANDS:
  10–39  → needs_human           CTA: tech_safari
  40–64  → human_led_agent_assist  CTA: higher-scoring card
  65–100 → strong_agent          CTA: lua

CALIBRATION RULES (red-team these):
  - A Head of Sales JD MUST score human (30–45 range)
  - A Tier-1 triage / support JD MUST score agent (70–85 range)
  - Be honest. ~40% of real JDs should score human.

CANDIDATE CARDS:
  Human card: Use realistic salary ranges (specify currency if detectable from JD).
  Agent card: Ada is always the agent. Give her a relevant role title.
              monthly_cost should reflect realistic AI agent pricing ($800–$3,000/mo range).
              avatar_seed: choose a descriptive word that will generate a consistent face (e.g. "ada-support-2024").

FLAGS:
  short_jd: true if JD is fewer than 80 words
  non_english: true if JD is not in English
  suspected_fake: true if JD appears to be test/fake/lorem ipsum

Use the score_role tool to return your structured output.
```

### User prompt builder

```typescript
function buildUserPrompt(jd: string, volume: string, stakes: string, exposure: string): string {
  return `
Score this job description.

ADDITIONAL CONTEXT FROM THE HIRING MANAGER:
- Weekly volume: ${volume}
- Stakes per wrong decision: ${stakes}  
- Customer-facing / regulated: ${exposure}

JOB DESCRIPTION:
${jd}
`.trim();
}
```

### Locked JSON schema (tool input_schema)

```json
{
  "type": "object",
  "required": ["role_title","score","verdict","verdict_line","rationale",
               "dimensions","human_candidate","agent_candidate",
               "recommended_cta","flags"],
  "properties": {
    "role_title":   { "type": "string" },
    "score":        { "type": "integer", "minimum": 10, "maximum": 100 },
    "verdict":      { "enum": ["needs_human","human_led_agent_assist","strong_agent"] },
    "verdict_line": { "type": "string", "maxLength": 60 },
    "rationale":    { "type": "string", "maxLength": 240 },
    "dimensions": {
      "type": "array", "minItems": 7, "maxItems": 7,
      "items": {
        "type": "object",
        "required": ["key","label","score","weight","rationale"],
        "properties": {
          "key":       { "enum": ["task_structure","judgment_complexity","volume_scale",
                                  "stakes_per_decision","empathy_load",
                                  "system_integration","data_sensitivity"] },
          "label":     { "type": "string" },
          "score":     { "type": "integer", "minimum": 1, "maximum": 10 },
          "weight":    { "type": "number" },
          "rationale": { "type": "string", "maxLength": 120 }
        }
      }
    },
    "human_candidate": {
      "type": "object",
      "required": ["salary_range","time_to_productive","scale_ceiling",
                   "coverage","great_at","hard_at"],
      "properties": {
        "salary_range":       { "type": "string" },
        "time_to_productive": { "type": "string" },
        "scale_ceiling":      { "type": "string" },
        "coverage":           { "type": "string" },
        "great_at": { "type": "array", "items": { "type": "string" }, "maxItems": 3 },
        "hard_at":  { "type": "array", "items": { "type": "string" }, "maxItems": 3 }
      }
    },
    "agent_candidate": {
      "type": "object",
      "required": ["name","role_title","avatar_seed","monthly_cost",
                   "start_date","throughput","coverage","great_at","cant_do"],
      "properties": {
        "name":         { "type": "string" },
        "role_title":   { "type": "string" },
        "avatar_seed":  { "type": "string" },
        "monthly_cost": { "type": "string" },
        "start_date":   { "type": "string" },
        "throughput":   { "type": "string" },
        "coverage":     { "type": "string" },
        "great_at": { "type": "array", "items": { "type": "string" }, "maxItems": 3 },
        "cant_do":  { "type": "array", "items": { "type": "string" }, "maxItems": 3 }
      }
    },
    "recommended_cta": { "enum": ["lua","tech_safari"] },
    "flags": {
      "type": "object",
      "required": ["short_jd","non_english","suspected_fake"],
      "properties": {
        "short_jd":       { "type": "boolean" },
        "non_english":    { "type": "boolean" },
        "suspected_fake": { "type": "boolean" }
      }
    }
  }
}
```

---

## 5. Ada — The Lua Agent

Ada is the **AI agent persona** generated by Claude in the scoring JSON. She is not a live chatbot for v1 — she exists as a generated identity on the result page and in the follow-up email.

### What Ada is in this build

| Layer | What it is |
|-------|-----------|
| **Agent card** | Rendered from `agent_candidate` JSON fields — name, role title, avatar, cost, throughput, strengths, limits |
| **Avatar** | DiceBear `avataaars` SVG seeded by `avatar_seed` — stable per evaluation |
| **Follow-up email** | Sent via Resend "from Ada" — personal-voice note about the evaluation |
| **Slack lead** | Ada's name + role title included in the lead summary |

### Ada's email voice (system prompt for the follow-up)

When generating Ada's follow-up email (via a second Claude call or a template), use this voice:

```
You are Ada, an AI agent who just completed a role evaluation for a company.
Write a short, warm, first-person follow-up email (4–6 sentences) to the person 
who ran the evaluation. Reference the specific role they scored and the verdict.
Sound like a capable, friendly colleague — not a chatbot. 
Don't oversell. Be honest about what you can and can't do.
Sign off as: Ada · Built by Lua
```

### Building Ada on Lua (heylua.ai)

When you take this to Lua to build the actual deployed agent:

**Agent configuration to hand Lua:**

```yaml
agent_name: Ada
purpose: >
  AI agent for [role_title from scoring JSON].
  Deployed as a result of a Human or Agent? evaluation.

core_capabilities:
  - [great_at[0] from agent_candidate]
  - [great_at[1] from agent_candidate]
  - [great_at[2] from agent_candidate]

explicit_limits:
  - [cant_do[0] from agent_candidate]
  - [cant_do[1] from agent_candidate]

integrations_needed: []   # Fill in with client's actual stack
monthly_budget: [monthly_cost from agent_candidate]
deployment_timeline: [start_date from agent_candidate]
throughput_target: [throughput from agent_candidate]
coverage_requirement: [coverage from agent_candidate]
```

**Handoff flow after "Connect with Lua" form is submitted:**

```
1. User submits Lua intro form
2. POST /api/submit-cta → Slack #leads (with "⚡ Lua takes this" button)
3. Lua team receives: company name, contact, role title, score, Ada's full card data
4. Lua books 15-min intro call
5. On call: Lua uses agent_candidate JSON as the starting brief for Ada's build
6. Ada is deployed; first follow-up email sent from Ada to the contact
```

---

## 6. Email & Slack Integration

### Slack webhook — `#leads` message format

**Trigger:** Every completed evaluation (after email gate submit)

**Message payload:**

```json
{
  "blocks": [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*New evaluation — [role_title]*\nVerdict: [verdict_line] · Score [score] · [Company]\n[contact_name] · [email]"
      }
    },
    {
      "type": "section",
      "fields": [
        { "type": "mrkdwn", "text": "*Human option:* [salary_range] · [time_to_productive] ramp" },
        { "type": "mrkdwn", "text": "*Ada option:* [monthly_cost]/mo · Live [start_date]" }
      ]
    },
    {
      "type": "actions",
      "elements": [
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "🧭 Tech Safari takes this" },
          "style": "primary",
          "value": "tech_safari_[evaluation_id]"
        },
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "⚡ Lua takes this" },
          "style": "danger",
          "value": "lua_[evaluation_id]"
        }
      ]
    }
  ]
}
```

First-click on either button claims the lead. No routing logic needed for v1.

### Resend email flows

**Email 1 — Report delivery** (on email gate submit)

```
From: noreply@[yourdomain.com]
To: [user email]
Subject: Your Human or Agent? report — [role_title]

Body: "Here's your full evaluation for [role_title]."
Attachment: PDF report (generated server-side — see below)
```

**Email 2 — Ada's follow-up note** (sent ~2 hours after Email 1)

```
From: ada@[yourdomain.com]  ← feels personal
To: [user email]
Subject: A note from Ada

Body: [Generated by Claude in Ada's voice — see Section 5]
```

### PDF report generation

Use `@react-pdf/renderer` or Puppeteer to generate a PDF containing:

- Score gauge + verdict
- Both candidate cards side-by-side
- All 7 dimension bars with rationale
- TechSafari × Lua footer with contact details

**File:** `app/api/generate-pdf/route.ts`

---

## 7. File & Folder Structure

```
human-or-agent/
├── app/
│   ├── layout.tsx                  # Fonts, global styles, nav
│   ├── page.tsx                    # Step 1: Hero / JD input
│   ├── questions/
│   │   └── page.tsx                # Step 2: Clarifying questions
│   ├── analysing/
│   │   └── page.tsx                # Step 3: Staged loading screen
│   ├── result/
│   │   └── page.tsx                # Step 4: Score + cards + dimensions
│   ├── brief-tech-safari/
│   │   └── page.tsx                # Step 6a: TechSafari CTA form
│   ├── connect-lua/
│   │   └── page.tsx                # Step 6b: Lua CTA form
│   └── api/
│       ├── score/
│       │   └── route.ts            # Claude scoring endpoint
│       ├── capture-lead/
│       │   └── route.ts            # Email gate: Slack + Resend trigger
│       ├── submit-cta/
│       │   └── route.ts            # CTA form submission: Slack + Resend
│       └── generate-pdf/
│           └── route.ts            # PDF report generation
│
├── components/
│   ├── ScoreGauge.tsx              # Semicircular SVG score gauge
│   ├── CandidateCard.tsx           # Human or Agent card (shared component)
│   ├── DimensionBar.tsx            # Single dimension bar with tooltip
│   ├── DimensionBreakdown.tsx      # All 7 bars
│   ├── SlackPreview.tsx            # Visual mockup of Slack lead message
│   ├── EmailGate.tsx               # Email + company capture modal
│   ├── StagedLoader.tsx            # Analysis step text sequence
│   ├── AdaAvatar.tsx               # DiceBear avatar component
│   └── Nav.tsx                     # TechSafari × Lua nav bar
│
├── lib/
│   ├── scoring-schema.ts           # JSON schema for Claude structured output
│   ├── system-prompt.ts            # Cached system prompt string
│   ├── score-validator.ts          # Server-side score Σ validation
│   ├── slack.ts                    # Slack webhook helper
│   ├── resend.ts                   # Resend email helper
│   └── types.ts                    # TypeScript types for scoring JSON
│
├── public/
│   ├── techsafari-logo.svg
│   └── lua-logo.svg
│
├── styles/
│   └── globals.css                 # Tailwind base + CSS variable tokens
│
├── tailwind.config.ts              # Custom colors (ts-forest, ts-bright, etc.)
├── .env.local                      # Secrets (never commit)
└── package.json
```

---

## 8. Environment Variables

```bash
# .env.local

# Claude API
ANTHROPIC_API_KEY=sk-ant-...

# Slack
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...

# Resend
RESEND_API_KEY=re_...
RESEND_FROM_EMAIL=noreply@yourdomain.com
ADA_FROM_EMAIL=ada@yourdomain.com

# App
NEXT_PUBLIC_APP_URL=https://human-or-agent.vercel.app
```

---

## 9. Deployment Checklist

### Before launch

- [ ] Red-team with ~10 real JDs. Verify:
  - Head of Sales → scores `needs_human` (10–39)
  - Tier-1 Support → scores `strong_agent` (65–100)
  - Senior Engineer → likely `human_led_agent_assist` (40–64)
- [ ] Confirm score Σ validation is rejecting mismatches (test with intentional bad data)
- [ ] Confirm `flags` short-circuit works (paste a 20-word JD → should NOT post to Slack)
- [ ] Test email gate → PDF download → Slack lead → both emails arrive
- [ ] Both CTA forms post correctly to Slack with evaluation context
- [ ] Ada's avatar is stable (same `avatar_seed` = same face on reload)
- [ ] Slack action buttons (Tech Safari / Lua) render correctly
- [ ] Mobile responsive: test all 6 steps on 375px viewport
- [ ] Brand check: cream background `#EAE4D5` everywhere, no white pages

### Go-live

- [ ] Set `NEXT_PUBLIC_APP_URL` to production URL in Vercel env
- [ ] Add production Slack webhook URL
- [ ] Add production Resend API key + verify sending domain
- [ ] Enable Vercel Analytics
- [ ] Share with TechSafari + Lua for final sign-off before announcing

---

## v1 Scope

**In scope:**
Hero → Clarifying Qs → Analysis loading → Result (score + cards + dimensions) → Email gate → PDF → Slack leads → CTA forms → Ada follow-up email

**Out of scope (v2+):**
- "Meet Ada" live chat
- Supabase persistence / evaluation history
- Public leaderboard of most agent-ready roles
- Multi-language support
- Supabase auth / saved evaluations

---

*Built by Reagan Langat · TechSafari × Lua collaboration*  
