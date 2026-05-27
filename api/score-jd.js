// Direct JD scoring — one server-side LLM call to Lua's developer/ai endpoint.
// Bypasses Ada's chat routing (avoids the 504 timeout from the 2-call Ada→score_jd chain).
//
// Returns the parsed scoring result as JSON. The Lua runtime ignores `tools`/`tool_choice`
// fields, so we use plain JSON-via-text and parse the response ourselves.

import { isOriginAllowed } from './_lib/origin.js';

const SCORING_SYSTEM = `You are an honest expert evaluator scoring job descriptions for automation fit.
Score each role across 7 dimensions (1–10, where 1 = strongly human-suited, 10 = strongly agent-suited).

Modern AI agents reason, handle nuance, manage emotional conversations well, and operate autonomously
in complex environments. Score based on whether the STRUCTURE of the role suits an agent — not
outdated assumptions about AI limits.

DIMENSIONS & WEIGHTS:
  task_structure      (weight 1.8) — highly novel/ambiguous ↔ structured/repeatable
  judgment_complexity (weight 2.0) — requires genuine human expertise & judgment ↔ rule-based/learnable
  volume_scale        (weight 1.5) — one-off strategic ↔ high-throughput repeated
  regulatory_burden   (weight 1.5) — legally requires human sign-off ↔ agent can act autonomously
  relationship_depth  (weight 1.3) — long-term strategic relationship ownership ↔ episodic/transactional
  system_integration  (weight 1.0) — heavy cross-functional human coordination ↔ tool/API-heavy
  data_sensitivity    (weight 0.9) — highly regulated PII/constrained ↔ open/standard business data

NOTE on relationship_depth: score LOW (human) only for SUSTAINED RELATIONSHIP OWNERSHIP (e.g. managing
a key account for 12 months). Emotional + episodic = agent-suited.

NOTE on regulatory_burden: high stakes alone does NOT mean human-required. Score based on REGULATORY
SIGN-OFF requirements only. A $10M contract agent assistant is fine; a licensed financial advisor
signing off on advice is not.

FINAL SCORE = Σ(dimension.score × dimension.weight), range 10–100. Round to nearest integer.

VERDICT BANDS:
  10–39  → needs_human             recommended_cta: tech_safari
  40–64  → human_led_agent_assist  recommended_cta: tech_safari
  65–100 → strong_agent            recommended_cta: lua

CALIBRATION (non-negotiable):
  - Head of Sales JDs MUST score 30–45 (needs_human)
  - Tier-1 support / triage JDs MUST score 82–92 (strong_agent)
  - ~40% of real JDs should score human — be honest, not optimistic

CANDIDATE CARDS:
  human_candidate: salary_range = exact salary/budget text from JD if explicitly stated, "" if not mentioned
  agent_candidate: name always "Lua", role_title adapts to role, monthly_cost $800–$3,000/mo,
                   avatar_seed short slug from role (e.g. "lua-support", "lua-ops"),
                   start_date "Today", throughput and coverage reflect agent advantages

FLAGS (set true if applicable, but still return full result):
  short_jd: fewer than 80 words
  non_english: not written in English
  suspected_fake: test/lorem ipsum/placeholder content

ADJACENT AGENTS: always include 2–3 distinct Lua agent suggestions for OTHER roles/tasks at this company.
Base on company type, industry, and function visible in the JD.
Format: icon (single emoji), name ("Lua [Role]"), value_prop (one sentence, specific to this context).

OUTPUT FORMAT — return ONLY a single JSON object matching this exact shape. No prose before or after.
No markdown code fences. All fields required.

{
  "role_title": "string",
  "score": 10-100 integer,
  "verdict": "needs_human" | "human_led_agent_assist" | "strong_agent",
  "verdict_line": "string ≤60 chars",
  "rationale": "string ≤240 chars",
  "dimensions": [
    { "key": "task_structure",      "label": "Task structure",      "score": 1-10, "weight": 1.8, "rationale": "string ≤120 chars" },
    { "key": "judgment_complexity", "label": "Judgment complexity", "score": 1-10, "weight": 2.0, "rationale": "string ≤120 chars" },
    { "key": "volume_scale",        "label": "Volume & scale",      "score": 1-10, "weight": 1.5, "rationale": "string ≤120 chars" },
    { "key": "regulatory_burden",   "label": "Regulatory burden",   "score": 1-10, "weight": 1.5, "rationale": "string ≤120 chars" },
    { "key": "relationship_depth",  "label": "Relationship depth",  "score": 1-10, "weight": 1.3, "rationale": "string ≤120 chars" },
    { "key": "system_integration",  "label": "System integration",  "score": 1-10, "weight": 1.0, "rationale": "string ≤120 chars" },
    { "key": "data_sensitivity",    "label": "Data sensitivity",    "score": 1-10, "weight": 0.9, "rationale": "string ≤120 chars" }
  ],
  "human_candidate": {
    "salary_range": "string",
    "time_to_productive": "string",
    "scale_ceiling": "string",
    "coverage": "string",
    "great_at": ["≤3 strings"],
    "hard_at": ["≤3 strings"]
  },
  "agent_candidate": {
    "name": "Lua",
    "role_title": "string",
    "avatar_seed": "string slug",
    "monthly_cost": "string",
    "start_date": "Today",
    "throughput": "string",
    "coverage": "string",
    "great_at": ["≤3 strings"],
    "cant_do": ["≤3 strings"]
  },
  "recommended_cta": "lua" | "tech_safari",
  "flags": { "short_jd": boolean, "non_english": boolean, "suspected_fake": boolean },
  "adjacent_agents": [
    { "icon": "single emoji", "name": "Lua [Role]", "value_prop": "string ≤120 chars" }
  ]
}`;

function extractJsonObject(text) {
  const stripped = text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  const start = stripped.indexOf('{');
  if (start === -1) return null;

  let depth = 0, inString = false, escape = false;
  for (let i = start; i < stripped.length; i++) {
    const c = stripped[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(stripped.slice(start, i + 1)); }
        catch { return null; }
      }
    }
  }
  return null;
}

function verdictForScore(score) {
  if (score < 40) return { verdict: 'needs_human',             recommended_cta: 'tech_safari' };
  if (score < 65) return { verdict: 'human_led_agent_assist',  recommended_cta: 'tech_safari' };
  return                  { verdict: 'strong_agent',           recommended_cta: 'lua' };
}

function normalizeScoringResult(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!Array.isArray(raw.dimensions) || raw.dimensions.length !== 7) return null;
  if (typeof raw.score !== 'number') return null;

  const computed = Math.round(raw.dimensions.reduce((s, d) => s + (d.score * d.weight), 0));
  let score = raw.score;
  let verdict = raw.verdict;
  let recommended_cta = raw.recommended_cta;

  if (Math.abs(computed - score) > 1) {
    score = computed;
    const v = verdictForScore(computed);
    verdict = v.verdict;
    recommended_cta = v.recommended_cta;
  } else {
    const expected = verdictForScore(score);
    if (verdict !== expected.verdict) {
      verdict = expected.verdict;
      recommended_cta = expected.recommended_cta;
    }
  }

  return { ...raw, score, verdict, recommended_cta };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  if (!isOriginAllowed(req.headers.origin, req.headers.host)) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  const agentId = process.env.LUA_AGENT_ID;
  const apiKey  = process.env.LUA_API_KEY;
  if (!agentId || !apiKey) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body;
  if (!body) return res.status(400).json({ error: 'Invalid JSON body' });

  const { jdText, volume, taskFreq, stakes, exposure } = body;
  if (!jdText || typeof jdText !== 'string') {
    return res.status(400).json({ error: 'jdText is required' });
  }

  const contextLines = [
    volume   && `Task structure: ${volume}`,
    taskFreq && `Task frequency: ${taskFreq} volume per day`,
    stakes   && `Decision stakes: ${stakes}`,
    exposure && `Exposure type: ${exposure}`,
  ].filter(Boolean);

  const userContent = contextLines.length
    ? `${jdText}\n\nAdditional context:\n${contextLines.join('\n')}`
    : jdText;

  try {
    const response = await fetch(
      `https://api.heylua.ai/developer/ai/${agentId}/generate`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'anthropic/claude-sonnet-4-6',
          system: SCORING_SYSTEM,
          messages: [{ role: 'user', content: userContent }],
          temperature: 0.2,
        }),
      },
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error('[score-jd] non-OK:', response.status, errText.slice(0, 200));
      return res.status(response.status).json({ error: 'Upstream error', detail: errText.slice(0, 200) });
    }

    const data = await response.json();
    const text = data?.data?.text ?? data?.text ?? '';
    if (!text) {
      console.error('[score-jd] empty text:', JSON.stringify(data).slice(0, 300));
      return res.status(500).json({ error: 'Empty response from model' });
    }

    const extracted = extractJsonObject(text);
    if (!extracted) {
      console.error('[score-jd] no JSON in text:', text.slice(0, 300));
      return res.status(500).json({ error: 'Could not extract JSON from model response' });
    }

    const result = normalizeScoringResult(extracted);
    if (!result) {
      console.error('[score-jd] invalid shape:', JSON.stringify(extracted).slice(0, 300));
      return res.status(500).json({ error: 'Invalid scoring result shape' });
    }

    return res.status(200).json({ result });
  } catch (err) {
    console.error('[score-jd] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

// Vercel function config: raise wall-clock budget for the LLM call.
export const config = { maxDuration: 60 };
