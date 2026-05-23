import { LuaSkill, LuaTool } from 'lua-cli';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Input schema — Ada passes the full scored result; tool validates & returns
// ---------------------------------------------------------------------------

const dimensionSchema = z.object({
  key: z.enum([
    'task_structure',
    'judgment_complexity',
    'volume_scale',
    'stakes_per_decision',
    'empathy_load',
    'system_integration',
    'data_sensitivity',
  ]),
  label: z.string(),
  score: z.number().int().min(1).max(10),
  weight: z.number(),
  rationale: z.string().max(120),
});

const scoreJdInputSchema = z.object({
  role_title: z.string(),
  score: z.number().int().min(10).max(100),
  verdict: z.enum(['needs_human', 'human_led_agent_assist', 'strong_agent']),
  verdict_line: z.string().max(60),
  rationale: z.string().max(240),
  dimensions: z.array(dimensionSchema).length(7),
  human_candidate: z.object({
    salary_range: z.string(),
    time_to_productive: z.string(),
    scale_ceiling: z.string(),
    coverage: z.string(),
    great_at: z.array(z.string()).max(3),
    hard_at: z.array(z.string()).max(3),
  }),
  agent_candidate: z.object({
    name: z.string(),
    role_title: z.string(),
    avatar_seed: z.string(),
    monthly_cost: z.string(),
    start_date: z.string(),
    throughput: z.string(),
    coverage: z.string(),
    great_at: z.array(z.string()).max(3),
    cant_do: z.array(z.string()).max(3),
  }),
  recommended_cta: z.enum(['lua', 'tech_safari']),
  flags: z.object({
    short_jd: z.boolean(),
    non_english: z.boolean(),
    suspected_fake: z.boolean(),
  }),
});

type ScoreJdInput = z.infer<typeof scoreJdInputSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeScore(dimensions: Array<{ score: number; weight: number }>): number {
  return Math.round(dimensions.reduce((sum, d) => sum + d.score * d.weight, 0));
}

// ---------------------------------------------------------------------------
// Tool — Ada scores the JD herself; this tool validates the weighted sum
// ---------------------------------------------------------------------------

export class scoreJdTool implements LuaTool<typeof scoreJdInputSchema> {
  name = 'score_jd';
  description =
    'Validate and record a completed JD scoring. Call this after you have scored the role across all 7 dimensions. The tool checks your weighted sum is internally consistent and returns the structured result.';
  inputSchema = scoreJdInputSchema;

  async execute(input: ScoreJdInput): Promise<unknown> {
    const { dimensions, score, flags } = input;

    // Validate weighted sum (±1 tolerance)
    const computed = computeScore(dimensions);
    if (Math.abs(computed - score) > 1) {
      return {
        error: 'score_mismatch',
        status: 422,
        detail: `Reported score ${score} does not match computed weighted sum ${computed}. Recompute: Σ(dimension.score × dimension.weight) = ${computed}.`,
      };
    }

    // Flag check — return early; no Slack/email side effects here
    if (flags.short_jd || flags.non_english || flags.suspected_fake) {
      const reason = Object.keys(flags).find((k) => flags[k as keyof typeof flags]);
      return { ...input, flagged: true, flagReason: reason };
    }

    return input;
  }
}

// ---------------------------------------------------------------------------
// Skill
// ---------------------------------------------------------------------------

export const scoreRoleSkill = new LuaSkill({
  name: 'score-role',
  description:
    'Evaluates a job description for automation fit across 7 weighted dimensions and returns a structured verdict with candidate cards.',
  context: `When the user provides a job description (or text scraped from a URL), score it yourself using this rubric, then call score_jd to validate and record the result.

SCORING RUBRIC — evaluate across 7 dimensions, each scored 1–10:
  1 = strongly human-suited (novel, relational, high-stakes, regulated)
  10 = strongly agent-suited (repeatable, rule-based, high-volume, low-stakes)

DIMENSIONS & WEIGHTS:
  task_structure       (weight 1.8) — novel ↔ repeatable
  judgment_complexity  (weight 2.0) — genuine reasoning ↔ rule-based
  volume_scale         (weight 1.5) — one-off ↔ high-throughput
  stakes_per_decision  (weight 1.5) — high-impact errors ↔ low-impact
  empathy_load         (weight 1.3) — relational ↔ transactional
  system_integration   (weight 1.0) — people-coordination ↔ tool/API-heavy
  data_sensitivity     (weight 0.9) — regulated/constrained ↔ open

FINAL SCORE = Σ(score × weight), range 10–100. Round to nearest integer.

VERDICT BANDS:
  10–39  → needs_human            recommended_cta: tech_safari
  40–64  → human_led_agent_assist  recommended_cta: tech_safari
  65–100 → strong_agent            recommended_cta: lua

CALIBRATION (non-negotiable):
  - Head of Sales JDs MUST score 30–45 (needs_human)
  - Tier-1 support / triage JDs MUST score 70–85 (strong_agent)
  - Roughly 40% of real JDs should score human — be honest, not optimistic

CANDIDATE CARDS:
  human_candidate: realistic salary (specify currency if detectable), scale ceiling, coverage
  agent_candidate: name is always "Lua", role_title adapts to role, monthly_cost $800–$3,000/mo,
                   avatar_seed is a short slug derived from role_title (e.g. "lua-support", "lua-ops"),
                   start_date is "Today", throughput and coverage reflect agent advantages

FLAGS (check before scoring):
  short_jd: fewer than 80 words → call score_jd with flagged:true, skip deep scoring
  non_english: not in English → flag and return
  suspected_fake: test/lorem ipsum content → flag and return

If score_jd returns a score_mismatch error (status 422), recompute your dimension scores and retry once.`,
  tools: [new scoreJdTool()],
});
