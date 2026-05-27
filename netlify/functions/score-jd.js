// JD scoring via Lua developer AI endpoint.
// Proven working: /developer/ai/{id}/generate supports text generation.
// Tools + tool_choice are silently dropped by the platform — use JSON text output instead.

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

FLAGS (check before scoring — set flag but still return full result):
  short_jd: fewer than 80 words
  non_english: not written in English
  suspected_fake: test/lorem ipsum/placeholder content

ADJACENT AGENTS: always include 2–3 distinct Lua agent suggestions for OTHER roles/tasks at this company.
Base on company type, industry, and function visible in the JD.
Format: icon (single emoji), name ("Lua [Role]"), value_prop (one sentence, specific to this context).

OUTPUT FORMAT — CRITICAL:
Return ONLY a valid JSON object. No markdown fences, no explanation, nothing before or after the JSON.
The object must have exactly these fields:
{
  "role_title": string,
  "score": number (10–100),
  "verdict": "needs_human" | "human_led_agent_assist" | "strong_agent",
  "verdict_line": string (max 60 chars),
  "rationale": string (max 240 chars),
  "dimensions": [exactly 7: {"key":str,"label":str,"score":1-10,"weight":num,"rationale":str}],
  "human_candidate": {"salary_range":str,"time_to_productive":str,"scale_ceiling":str,"coverage":str,"great_at":[3 strings],"hard_at":[3 strings]},
  "agent_candidate": {"name":"Lua","role_title":str,"avatar_seed":str,"monthly_cost":str,"start_date":"Today","throughput":str,"coverage":str,"great_at":[3 strings],"cant_do":[3 strings]},
  "recommended_cta": "lua" | "tech_safari",
  "flags": {"short_jd":bool,"non_english":bool,"suspected_fake":bool},
  "adjacent_agents": [2–3: {"icon":emoji,"name":str,"value_prop":str}]
}`;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const agentId = process.env.LUA_AGENT_ID;
  const apiKey  = process.env.LUA_API_KEY;
  if (!agentId || !apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error' }) };
  }

  try {
    const { jdText, volume, taskFreq, stakes, exposure } = JSON.parse(event.body || '{}');
    if (!jdText) {
      return { statusCode: 400, body: JSON.stringify({ error: 'jdText is required' }) };
    }

    const contextLines = [
      volume    && `Task structure: ${volume}`,
      taskFreq  && `Task frequency: ${taskFreq} volume per day`,
      stakes    && `Decision stakes: ${stakes}`,
      exposure  && `Exposure type: ${exposure}`,
    ].filter(Boolean);

    const userContent = contextLines.length
      ? `${jdText}\n\nAdditional context:\n${contextLines.join('\n')}`
      : jdText;

    const response = await fetch(
      `https://api.heylua.ai/developer/ai/${agentId}/generate`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          system: SCORING_SYSTEM,
          messages: [{ role: 'user', content: userContent }],
          temperature: 0.2,
        }),
      },
    );

    const data = await response.json();
    console.log('[score-jd] status:', response.status);

    if (!response.ok) {
      return { statusCode: response.status, body: JSON.stringify({ error: data }) };
    }

    // Developer endpoint returns { text, finishReason, usage }
    const rawText = data?.text || data?.data?.text || '';
    console.log('[score-jd] text preview:', rawText.slice(0, 120));

    // Extract JSON from the text — model may wrap in ```json fences
    const jsonMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/) || rawText.match(/(\{[\s\S]*\})/);
    if (!jsonMatch) {
      console.error('[score-jd] no JSON in response:', rawText.slice(0, 300));
      return { statusCode: 500, body: JSON.stringify({ error: 'No JSON in response', raw: rawText.slice(0, 300) }) };
    }

    let result;
    try {
      result = JSON.parse(jsonMatch[1].trim());
    } catch (parseErr) {
      console.error('[score-jd] JSON parse error:', parseErr.message);
      return { statusCode: 500, body: JSON.stringify({ error: 'JSON parse failed', raw: jsonMatch[1].slice(0, 300) }) };
    }

    if (!result.role_title || !Array.isArray(result.dimensions) || result.dimensions.length !== 7) {
      console.error('[score-jd] invalid result shape:', JSON.stringify(result).slice(0, 300));
      return { statusCode: 500, body: JSON.stringify({ error: 'Invalid result shape', raw: result }) };
    }

    // Self-correct weighted sum
    const computed = Math.round(result.dimensions.reduce((s, d) => s + d.score * d.weight, 0));
    if (Math.abs(computed - result.score) > 1) result.score = computed;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ result }),
    };
  } catch (err) {
    console.error('[score-jd] error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
