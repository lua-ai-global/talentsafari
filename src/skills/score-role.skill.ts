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
    'regulatory_burden',
    'relationship_depth',
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
  adjacent_agents: z.array(z.object({
    icon: z.string().describe('Single emoji for this agent type'),
    name: z.string().describe('Short agent name e.g. "Lua Scheduler"'),
    value_prop: z.string().max(120).describe('One sentence on what this agent does for this specific company/role context'),
  })).min(2).max(3).describe('2–3 complementary Lua agents that could help this company regardless of the main verdict'),
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
  1 = strongly human-suited
  10 = strongly agent-suited

Modern AI agents (built on models like Claude) are NOT simple if/then workflow tools. They reason,
handle nuance, manage emotional conversations well, and operate autonomously in complex environments.
Score based on whether the STRUCTURE of the role suits an agent — not outdated assumptions about AI limits.

DIMENSIONS & WEIGHTS:
  task_structure      (weight 1.8) — highly novel/ambiguous ↔ structured/repeatable
  judgment_complexity (weight 2.0) — requires genuine human expertise & judgment ↔ rule-based/learnable pattern
  volume_scale        (weight 1.5) — one-off strategic ↔ high-throughput repeated
  regulatory_burden   (weight 1.5) — legally requires human sign-off (healthcare, legal, finance) ↔ unregulated / agent can act autonomously
  relationship_depth  (weight 1.3) — long-term strategic relationship ownership (C-suite, key accounts) ↔ episodic or transactional interactions
  system_integration  (weight 1.0) — heavy cross-functional human coordination ↔ tool/API-heavy, automatable
  data_sensitivity    (weight 0.9) — highly regulated PII / constrained ↔ open / standard business data

NOTE on relationship_depth: modern agents handle emotional, frustrated, and distressed customers extremely well.
Score LOW (human) only when the role requires SUSTAINED RELATIONSHIP OWNERSHIP — e.g. managing a key account for 12 months,
not just handling an emotional support ticket. Emotional + episodic = agent-suited.

NOTE on regulatory_burden: high stakes alone does NOT mean human-required. Score based on REGULATORY SIGN-OFF requirements,
not perceived risk. A $10M contract agent assistant is fine; a licensed financial advisor signing off on advice is not.

FINAL SCORE = Σ(score × weight), range 10–100. Round to nearest integer.

VERDICT BANDS:
  10–39  → needs_human            recommended_cta: tech_safari
  40–64  → human_led_agent_assist  recommended_cta: tech_safari
  65–100 → strong_agent            recommended_cta: lua

CALIBRATION (non-negotiable):
  - Head of Sales JDs MUST score 30–45 (needs_human) — strategic relationship ownership
  - Tier-1 support / triage JDs MUST score 82–92 (strong_agent) — high volume, episodic, no regulatory burden
  - Roughly 40% of real JDs should score human — be honest, not optimistic

CANDIDATE CARDS:
  human_candidate: salary_range = exact salary/budget from JD if explicitly stated (keep original wording); set to "" if JD does not mention salary or budget. scale ceiling, coverage.
  agent_candidate: name is always "Lua", role_title adapts to role, monthly_cost $800–$3,000/mo,
                   avatar_seed is a short slug derived from role_title (e.g. "lua-support", "lua-ops"),
                   start_date is "Today", throughput and coverage reflect agent advantages

FLAGS (check before scoring):
  short_jd: fewer than 80 words → call score_jd with flagged:true, skip deep scoring
  non_english: not in English → flag and return
  suspected_fake: test/lorem ipsum content → flag and return

If score_jd returns a score_mismatch error (status 422), recompute your dimension scores and retry once.

ADJACENT AGENTS (always include — ignore verdict, every company benefits from more automation):
  Generate 2–3 Lua agent suggestions for OTHER roles/tasks at this company beyond the evaluated role.
  Base suggestions on the company type, industry, and function visible in the JD.
  Each should be distinct and realistic. Format: icon (emoji), name ("Lua [Role]"), value_prop (one sentence, specific to context).
  Examples: Lua Scheduler (calendar/coordination), Lua Prospector (lead research), Lua Onboarder (HR/new hire),
  Lua Analyst (reporting/metrics), Lua QA Agent (quality auditing), Lua Invoice Agent (finance ops).`,
  tools: [new scoreJdTool()],
});
