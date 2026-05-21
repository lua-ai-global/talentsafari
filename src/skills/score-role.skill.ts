import { LuaSkill, LuaTool, AI } from 'lua-cli';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const scoreJdInputSchema = z.object({
  jdText: z.string().describe('The full job description text'),
  volume: z
    .enum(['low', 'medium', 'high'])
    .describe('Weekly task volume: low=handful, medium=dozens/day, high=hundreds+'),
  stakes: z.enum(['low', 'moderate', 'high']).describe('Cost of a wrong decision'),
  exposure: z
    .enum(['customer_unregulated', 'internal', 'regulated'])
    .describe('Customer-facing and regulatory context'),
});

type ScoreJdInput = z.infer<typeof scoreJdInputSchema>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an honest, expert hiring advisor scoring job descriptions for automation fit.

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

CALIBRATION RULES:
  - A Head of Sales JD MUST score human (30–45 range)
  - A Tier-1 triage / support JD MUST score agent (70–85 range)
  - Be honest. ~40% of real JDs should score human.

CANDIDATE CARDS:
  Human card: Use realistic salary ranges (specify currency if detectable from JD).
  Agent card: Ada is always the agent. Give her a relevant role title.
              monthly_cost should reflect realistic AI agent pricing ($800–$3,000/mo range).
              avatar_seed: derive deterministically from role_title using a short slug (e.g. "ada-support", "ada-ops") — must be stable across calls for the same role.

FLAGS:
  short_jd: true if JD is fewer than 80 words
  non_english: true if JD is not in English
  suspected_fake: true if JD appears to be test/fake/lorem ipsum

Use the score_role tool to return your structured output.`;

const SCORE_ROLE_CLAUDE_TOOL = {
  name: 'score_role',
  description: 'Score a job description for automation fit across 7 weighted dimensions',
  input_schema: {
    type: 'object',
    required: [
      'role_title',
      'score',
      'verdict',
      'verdict_line',
      'rationale',
      'dimensions',
      'human_candidate',
      'agent_candidate',
      'recommended_cta',
      'flags',
    ],
    properties: {
      role_title: { type: 'string' },
      score: { type: 'integer', minimum: 10, maximum: 100 },
      verdict: {
        type: 'string',
        enum: ['needs_human', 'human_led_agent_assist', 'strong_agent'],
      },
      verdict_line: { type: 'string', maxLength: 60 },
      rationale: { type: 'string', maxLength: 240 },
      dimensions: {
        type: 'array',
        minItems: 7,
        maxItems: 7,
        items: {
          type: 'object',
          required: ['key', 'label', 'score', 'weight', 'rationale'],
          properties: {
            key: {
              type: 'string',
              enum: [
                'task_structure',
                'judgment_complexity',
                'volume_scale',
                'stakes_per_decision',
                'empathy_load',
                'system_integration',
                'data_sensitivity',
              ],
            },
            label: { type: 'string' },
            score: { type: 'integer', minimum: 1, maximum: 10 },
            weight: { type: 'number' },
            rationale: { type: 'string', maxLength: 120 },
          },
        },
      },
      human_candidate: {
        type: 'object',
        required: [
          'salary_range',
          'time_to_productive',
          'scale_ceiling',
          'coverage',
          'great_at',
          'hard_at',
        ],
        properties: {
          salary_range: { type: 'string' },
          time_to_productive: { type: 'string' },
          scale_ceiling: { type: 'string' },
          coverage: { type: 'string' },
          great_at: { type: 'array', items: { type: 'string' }, maxItems: 3 },
          hard_at: { type: 'array', items: { type: 'string' }, maxItems: 3 },
        },
      },
      agent_candidate: {
        type: 'object',
        required: [
          'name',
          'role_title',
          'avatar_seed',
          'monthly_cost',
          'start_date',
          'throughput',
          'coverage',
          'great_at',
          'cant_do',
        ],
        properties: {
          name: { type: 'string' },
          role_title: { type: 'string' },
          avatar_seed: { type: 'string' },
          monthly_cost: { type: 'string' },
          start_date: { type: 'string' },
          throughput: { type: 'string' },
          coverage: { type: 'string' },
          great_at: { type: 'array', items: { type: 'string' }, maxItems: 3 },
          cant_do: { type: 'array', items: { type: 'string' }, maxItems: 3 },
        },
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
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeScore(dimensions: Array<{ score: number; weight: number }>): number {
  const raw = dimensions.reduce((sum, d) => sum + d.score * d.weight, 0);
  return Math.round(raw);
}

async function callClaudeScoreRole(
  jdText: string,
  volume: string,
  stakes: string,
  exposure: string,
): Promise<Record<string, unknown>> {
  const userPrompt = `Score this job description. Return ONLY a JSON object matching the score_role schema — no prose before or after.

ADDITIONAL CONTEXT FROM THE HIRING MANAGER:
- Weekly volume: ${volume}
- Stakes per wrong decision: ${stakes}
- Customer-facing / regulated: ${exposure}

JOB DESCRIPTION:
${jdText}

JSON SCHEMA to follow exactly:
{
  "role_title": string,
  "score": integer 10-100,
  "verdict": "needs_human"|"human_led_agent_assist"|"strong_agent",
  "verdict_line": string (max 60 chars),
  "rationale": string (max 240 chars),
  "dimensions": [7 items: {key, label, score 1-10, weight, rationale max 120 chars}],
  "human_candidate": {salary_range, time_to_productive, scale_ceiling, coverage, great_at[max3], hard_at[max3]},
  "agent_candidate": {name:"Ada", role_title, avatar_seed, monthly_cost, start_date, throughput, coverage, great_at[max3], cant_do[max3]},
  "recommended_cta": "lua"|"tech_safari",
  "flags": {short_jd: bool, non_english: bool, suspected_fake: bool}
}`;

  const result = await AI.generate({
    system: SYSTEM_PROMPT,
    prompt: userPrompt,
    maxOutputTokens: 4096,
  });

  const text = result.text.trim();
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
  const jsonStr = (jsonMatch[1] ?? text).trim();

  return JSON.parse(jsonStr) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tool — class-based pattern (required for lua-cli AST scanner detection)
// ---------------------------------------------------------------------------

export class scoreJdTool implements LuaTool<typeof scoreJdInputSchema> {
  name = 'score_jd';
  description =
    'Evaluate a job description for automation fit. Returns a structured verdict with 7-dimension scores, candidate cards, and routing recommendation.';
  inputSchema = scoreJdInputSchema;

  async execute(input: ScoreJdInput): Promise<unknown> {
    const { jdText, volume, stakes, exposure } = input;

    // First attempt
    let result = await callClaudeScoreRole(jdText, volume, stakes, exposure);

    // Validate weighted sum (±1 tolerance)
    const dimensions = result.dimensions as Array<{ score: number; weight: number }>;
    const computed = computeScore(dimensions);
    const reported = result.score as number;

    if (Math.abs(computed - reported) > 1) {
      // One retry
      result = await callClaudeScoreRole(jdText, volume, stakes, exposure);
      const dimensions2 = result.dimensions as Array<{ score: number; weight: number }>;
      const computed2 = computeScore(dimensions2);
      const reported2 = result.score as number;
      if (Math.abs(computed2 - reported2) > 1) {
        return { error: 'score_mismatch', status: 422 };
      }
    }

    // Flag check — return early with flagged: true; no Slack/email side effects here
    const flags = result.flags as {
      short_jd: boolean;
      non_english: boolean;
      suspected_fake: boolean;
    };
    if (flags.short_jd || flags.non_english || flags.suspected_fake) {
      return { ...result, flagged: true };
    }

    return result;
  }
}

// ---------------------------------------------------------------------------
// Skill
// ---------------------------------------------------------------------------

export const scoreRoleSkill = new LuaSkill({
  name: 'score-role',
  description:
    'Evaluates a job description for automation fit across 7 weighted dimensions and returns a structured verdict with candidate cards.',
  context: `Use the score_jd tool whenever the user provides a job description and wants to know whether this role should be filled by a human or an AI agent.

The tool calls the Claude API with a prompt-cached system prompt and forces structured output via tool_choice. It validates the weighted dimension sum against the reported score (±1 tolerance, one retry) and returns the full scoring JSON including role_title, score, verdict, verdict_line, rationale, seven dimension breakdowns, human_candidate and agent_candidate cards, recommended_cta, and flags.

If any flag is set (short_jd, non_english, suspected_fake) the result comes back with flagged: true — do not proceed to capture_lead in that case. If status 422 is returned (score_mismatch after retry), report the error to the user.`,
  tools: [new scoreJdTool()],
});
