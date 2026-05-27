// Direct JD scoring — bypasses Ada's chat routing, calls Lua developer AI
// endpoint in one LLM call. Avoids the Ada→score_jd 2-call chain that causes
// 504 timeouts on Netlify's 26s function limit.

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

Call score_role with your complete structured assessment.`;

const SCORE_ROLE_TOOL = {
  name: 'score_role',
  description: 'Return the complete structured scoring result for the job description.',
  input_schema: {
    type: 'object',
    required: [
      'role_title', 'score', 'verdict', 'verdict_line', 'rationale',
      'dimensions', 'human_candidate', 'agent_candidate',
      'recommended_cta', 'flags', 'adjacent_agents',
    ],
    properties: {
      role_title: { type: 'string' },
      score: { type: 'number', minimum: 10, maximum: 100 },
      verdict: { type: 'string', enum: ['needs_human', 'human_led_agent_assist', 'strong_agent'] },
      verdict_line: { type: 'string' },
      rationale: { type: 'string' },
      dimensions: {
        type: 'array', minItems: 7, maxItems: 7,
        items: {
          type: 'object',
          required: ['key', 'label', 'score', 'weight', 'rationale'],
          properties: {
            key: { type: 'string' }, label: { type: 'string' },
            score: { type: 'number', minimum: 1, maximum: 10 },
            weight: { type: 'number' }, rationale: { type: 'string' },
          },
        },
      },
      human_candidate: {
        type: 'object',
        required: ['salary_range', 'time_to_productive', 'scale_ceiling', 'coverage', 'great_at', 'hard_at'],
        properties: {
          salary_range: { type: 'string' }, time_to_productive: { type: 'string' },
          scale_ceiling: { type: 'string' }, coverage: { type: 'string' },
          great_at: { type: 'array', items: { type: 'string' }, maxItems: 3 },
          hard_at:  { type: 'array', items: { type: 'string' }, maxItems: 3 },
        },
      },
      agent_candidate: {
        type: 'object',
        required: ['name', 'role_title', 'avatar_seed', 'monthly_cost', 'start_date', 'throughput', 'coverage', 'great_at', 'cant_do'],
        properties: {
          name: { type: 'string' }, role_title: { type: 'string' },
          avatar_seed: { type: 'string' }, monthly_cost: { type: 'string' },
          start_date: { type: 'string' }, throughput: { type: 'string' },
          coverage: { type: 'string' },
          great_at: { type: 'array', items: { type: 'string' }, maxItems: 3 },
          cant_do:  { type: 'array', items: { type: 'string' }, maxItems: 3 },
        },
      },
      recommended_cta: { type: 'string', enum: ['lua', 'tech_safari'] },
      flags: {
        type: 'object',
        required: ['short_jd', 'non_english', 'suspected_fake'],
        properties: {
          short_jd: { type: 'boolean' }, non_english: { type: 'boolean' },
          suspected_fake: { type: 'boolean' },
        },
      },
      adjacent_agents: {
        type: 'array', minItems: 2, maxItems: 3,
        items: {
          type: 'object',
          required: ['icon', 'name', 'value_prop'],
          properties: {
            icon: { type: 'string' }, name: { type: 'string' },
            value_prop: { type: 'string' },
          },
        },
      },
    },
  },
};

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
          tools: [SCORE_ROLE_TOOL],
          tool_choice: { type: 'tool', name: 'score_role' },
        }),
      },
    );

    const data = await response.json();
    console.log('[score-jd] status:', response.status, '| success:', data?.success);

    if (!response.ok) {
      return { statusCode: response.status, body: JSON.stringify({ error: data }) };
    }

    // Lua developer endpoint returns { success, data: { content: [...] } }
    // content[0] should be type=tool_use, name=score_role, input={...scoring result}
    const content = data?.data?.content || data?.content || [];
    const toolUse = content.find(c => c.type === 'tool_use' && c.name === 'score_role');

    if (!toolUse?.input) {
      console.error('[score-jd] unexpected response:', JSON.stringify(data).slice(0, 400));
      return { statusCode: 500, body: JSON.stringify({ error: 'No scoring result', raw: data }) };
    }

    const result = toolUse.input;

    // Validate + self-correct weighted sum
    if (Array.isArray(result.dimensions) && result.dimensions.length === 7) {
      const computed = Math.round(result.dimensions.reduce((s, d) => s + d.score * d.weight, 0));
      if (Math.abs(computed - result.score) > 1) result.score = computed;
    }

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
