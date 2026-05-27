import { LuaSkill, LuaTool, AI } from 'lua-cli';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Scoring rubric — single source of truth, used as the AI.generate system prompt
// ---------------------------------------------------------------------------

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
Format: icon (single emoji), name ("Lua [Role]"), value_prop (one sentence, specific to this context).`;

// ---------------------------------------------------------------------------
// JSON Schema 7 — drives AI.generate's structuredOutput. The platform converts
// this to AI SDK's Output.object({ schema }) and the model returns a parsed
// object matching the shape.
// ---------------------------------------------------------------------------

const dimensionSchema = {
  type: 'object',
  required: ['key', 'label', 'score', 'weight', 'rationale'],
  properties: {
    key: { type: 'string' },
    label: { type: 'string' },
    score: { type: 'integer', minimum: 1, maximum: 10 },
    weight: { type: 'number' },
    rationale: { type: 'string' },
  },
  additionalProperties: false,
};

const SCORE_ROLE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: [
    'role_title', 'score', 'verdict', 'verdict_line', 'rationale',
    'dimensions', 'human_candidate', 'agent_candidate',
    'recommended_cta', 'flags', 'adjacent_agents',
  ],
  properties: {
    role_title: { type: 'string' },
    score: { type: 'integer', minimum: 10, maximum: 100 },
    verdict: { type: 'string', enum: ['needs_human', 'human_led_agent_assist', 'strong_agent'] },
    verdict_line: { type: 'string' },
    rationale: { type: 'string' },
    dimensions: {
      type: 'array',
      minItems: 7,
      maxItems: 7,
      items: dimensionSchema,
    },
    human_candidate: {
      type: 'object',
      required: ['salary_range', 'time_to_productive', 'scale_ceiling', 'coverage', 'great_at', 'hard_at'],
      properties: {
        salary_range: { type: 'string' },
        time_to_productive: { type: 'string' },
        scale_ceiling: { type: 'string' },
        coverage: { type: 'string' },
        great_at: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 3 },
        hard_at: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 3 },
      },
      additionalProperties: false,
    },
    agent_candidate: {
      type: 'object',
      required: ['name', 'role_title', 'avatar_seed', 'monthly_cost', 'start_date', 'throughput', 'coverage', 'great_at', 'cant_do'],
      properties: {
        name: { type: 'string' },
        role_title: { type: 'string' },
        avatar_seed: { type: 'string' },
        monthly_cost: { type: 'string' },
        start_date: { type: 'string' },
        throughput: { type: 'string' },
        coverage: { type: 'string' },
        great_at: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 3 },
        cant_do: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 3 },
      },
      additionalProperties: false,
    },
    recommended_cta: { type: 'string', enum: ['lua', 'tech_safari'] },
    flags: {
      type: 'object',
      required: ['short_jd', 'non_english', 'suspected_fake'],
      properties: {
        short_jd: { type: 'boolean' },
        non_english: { type: 'boolean' },
        suspected_fake: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    adjacent_agents: {
      type: 'array',
      minItems: 2,
      maxItems: 3,
      items: {
        type: 'object',
        required: ['icon', 'name', 'value_prop'],
        properties: {
          icon: { type: 'string' },
          name: { type: 'string' },
          value_prop: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const scoreJdInputSchema = z.object({
  jd_text: z.string().describe('The full job description text to evaluate'),
  volume: z.string().optional().describe('Task structure context'),
  task_freq: z.string().optional().describe('Task frequency (low/medium/high volume per day)'),
  stakes: z.string().optional().describe('Decision stakes context'),
  exposure: z.string().optional().describe('Exposure type (e.g. customer_unregulated, regulated)'),
});

type ScoreJdInput = z.infer<typeof scoreJdInputSchema>;

// ---------------------------------------------------------------------------
// Local type extension — drops once lua-cli ships the widened types from PR
// #533. Runtime works either way (body forwards verbatim).
// ---------------------------------------------------------------------------

type AiGenerateArgs = Parameters<typeof AI.generate>[0] & {
  structuredOutput?: { schema: Record<string, unknown> };
};

type AiGenerateResponse = Awaited<ReturnType<typeof AI.generate>> & {
  data?: { output?: unknown; text?: string };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeScore(dimensions: Array<{ score: number; weight: number }>): number {
  return Math.round(dimensions.reduce((sum, d) => sum + d.score * d.weight, 0));
}

function verdictForScore(score: number): { verdict: string; recommended_cta: string } {
  if (score < 40) return { verdict: 'needs_human',            recommended_cta: 'tech_safari' };
  if (score < 65) return { verdict: 'human_led_agent_assist', recommended_cta: 'tech_safari' };
  return                  { verdict: 'strong_agent',           recommended_cta: 'lua' };
}

// ---------------------------------------------------------------------------
// Tool — runs the structured scoring call via AI.generate({ structuredOutput })
// ---------------------------------------------------------------------------

export class scoreJdTool implements LuaTool<typeof scoreJdInputSchema> {
  name = 'score_jd';
  description =
    'Score a job description for automation fit. Returns a structured verdict (score, dimensions, candidate cards) via a temperature-0.2 LLM call constrained by JSON Schema.';
  inputSchema = scoreJdInputSchema;

  async execute(input: ScoreJdInput): Promise<unknown> {
    const { jd_text, volume, task_freq, stakes, exposure } = input;

    const contextLines = [
      volume    && `Task structure: ${volume}`,
      task_freq && `Task frequency: ${task_freq} volume per day`,
      stakes    && `Decision stakes: ${stakes}`,
      exposure  && `Exposure type: ${exposure}`,
    ].filter(Boolean);

    const userContent = contextLines.length
      ? `${jd_text}\n\nAdditional context:\n${contextLines.join('\n')}`
      : jd_text;

    let response: AiGenerateResponse;
    try {
      response = (await AI.generate({
        system: SCORING_SYSTEM,
        messages: [{ role: 'user', content: userContent }],
        temperature: 0.2,
        structuredOutput: { schema: SCORE_ROLE_SCHEMA },
      } as AiGenerateArgs)) as AiGenerateResponse;
    } catch (err) {
      return { error: 'generation_failed', detail: (err as Error)?.message };
    }

    if (!response.success) {
      return { error: 'generation_failed', detail: response.error?.message ?? 'Unknown error' };
    }

    const raw = response.data?.output as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== 'object') {
      return { error: 'parse_failed', detail: 'No structured output on AI.generate response' };
    }

    const dims = raw.dimensions as Array<{ score: number; weight: number }> | undefined;
    if (!Array.isArray(dims) || dims.length !== 7) {
      return { error: 'invalid_dimensions', detail: 'Expected exactly 7 dimensions' };
    }

    // Sanity-correct score + verdict band so the two stay in sync
    const reported = raw.score as number;
    const computed = computeScore(dims);
    if (Math.abs(computed - reported) > 1) {
      const v = verdictForScore(computed);
      return { ...raw, score: computed, verdict: v.verdict, recommended_cta: v.recommended_cta };
    }
    const expected = verdictForScore(reported);
    if (raw.verdict !== expected.verdict) {
      return { ...raw, verdict: expected.verdict, recommended_cta: expected.recommended_cta };
    }
    return raw;
  }
}

// ---------------------------------------------------------------------------
// Skill
// ---------------------------------------------------------------------------

export const scoreRoleSkill = new LuaSkill({
  name: 'score-role',
  description:
    'Evaluates a job description for automation fit via a temperature-0.2 structured-output LLM call.',
  context: `When the user asks to score a job description, call score_jd with the raw jd_text and any context (volume, task_freq, stakes, exposure). Pass the returned object straight on — no transformation needed.

If the tool returns { error: ... }, tell the user something went wrong and ask them to try again.`,
  tools: [new scoreJdTool()],
});
