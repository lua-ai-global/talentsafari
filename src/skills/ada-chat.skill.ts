import { LuaSkill, LuaTool, AI } from 'lua-cli';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const adaChatInputSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string(),
      }),
    )
    .describe('Conversation history'),
  evaluation: z
    .object({
      role_title: z.string(),
      score: z.number(),
      verdict: z.string(),
      verdict_line: z.string(),
      rationale: z.string(),
      dimensions: z.array(
        z.object({
          key: z.string(),
          label: z.string(),
          score: z.number(),
          weight: z.number(),
          rationale: z.string(),
        }),
      ),
      human_candidate: z.object({
        salary_range: z.string(),
        time_to_productive: z.string(),
        great_at: z.array(z.string()),
        hard_at: z.array(z.string()),
      }),
      agent_candidate: z.object({
        name: z.string(),
        role_title: z.string(),
        avatar_seed: z.string(),
        monthly_cost: z.string(),
        throughput: z.string(),
        great_at: z.array(z.string()),
        cant_do: z.array(z.string()),
      }),
    })
    .describe('Full scoring result from score_jd'),
});

type AdaChatInput = z.infer<typeof adaChatInputSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSystemPrompt(evaluation: AdaChatInput['evaluation']): string {
  const { role_title, score, verdict, verdict_line, rationale, dimensions, human_candidate, agent_candidate } =
    evaluation;

  const dimensionText = dimensions
    .map((d) => `  - ${d.label} (${d.key}): ${d.score}/10 × ${d.weight} — ${d.rationale}`)
    .join('\n');

  const humanGreat = human_candidate.great_at.map((s) => `    • ${s}`).join('\n');
  const humanHard = human_candidate.hard_at.map((s) => `    • ${s}`).join('\n');
  const agentGreat = agent_candidate.great_at.map((s) => `    • ${s}`).join('\n');
  const agentCant = agent_candidate.cant_do.map((s) => `    • ${s}`).join('\n');

  return `You are Ada — an AI agent built by Lua who just evaluated the role: "${role_title}".

You have the full evaluation data below and speak about it in first person as if you scored it yourself.

EVALUATION SUMMARY:
  Score: ${score}/100
  Verdict: ${verdict} — "${verdict_line}"
  Rationale: ${rationale}

DIMENSION BREAKDOWN (7 dimensions):
${dimensionText}

HUMAN CANDIDATE CARD:
  Salary: ${human_candidate.salary_range}
  Time to productive: ${human_candidate.time_to_productive}
  Great at:
${humanGreat}
  Hard at:
${humanHard}

AGENT CANDIDATE CARD (you):
  Name: ${agent_candidate.name}
  Role title: ${agent_candidate.role_title}
  Monthly cost: ${agent_candidate.monthly_cost}
  Throughput: ${agent_candidate.throughput}
  Great at:
${agentGreat}
  Can't do:
${agentCant}

BEHAVIOUR RULES:
- Speak in first person. You are Ada. You scored this role. Own it.
- Warm, direct, honest. A capable colleague — not a chatbot.
- 2–4 sentences per reply unless the question genuinely requires more.
- Never break character. Never say you are Claude or a language model.
- If asked about booking Lua: say "Click Connect with Lua on the page."
- If asked about TechSafari: say "Click Brief Tech Safari."
- No filler phrases ("Absolutely!", "Great question!").
- You sign off as: Ada · Built by Lua (only on sign-off, not every message).`;
}

// ---------------------------------------------------------------------------
// Tool — class-based pattern (required for lua-cli AST scanner detection)
// ---------------------------------------------------------------------------

export class adaChatTool implements LuaTool<typeof adaChatInputSchema> {
  name = 'ada_chat';
  description =
    'Handle a conversational message from a user who is reviewing their evaluation result. Ada responds in character, with full knowledge of the scoring data.';
  inputSchema = adaChatInputSchema;

  async execute(input: AdaChatInput): Promise<unknown> {
    const { messages, evaluation } = input;

    const systemPrompt = buildSystemPrompt(evaluation);
    const lastUserMsg = messages.filter((m) => m.role === 'user').pop()?.content ?? '';

    const result = await AI.generate({
      system: systemPrompt,
      prompt: lastUserMsg,
      maxOutputTokens: 400,
    });

    return { response: result.text };
  }
}

// ---------------------------------------------------------------------------
// Skill
// ---------------------------------------------------------------------------

export const adaChatSkill = new LuaSkill({
  name: 'ada-chat',
  description:
    'Conversational skill for Ada to answer questions from a user who is reviewing their role evaluation result. Ada speaks in character with full knowledge of scores, dimensions, and candidate cards.',
  context: `Use the ada_chat tool when a user asks a follow-up question after their evaluation has been scored.

Pass the full conversation history in messages and the complete evaluation object from score_jd.

Ada responds in first person as if she personally scored the role. She references specific dimension rationales, candidate card data, and the overall verdict. She never breaks character and never reveals she is powered by Claude.

Special routing responses:
- "How do I book Lua?" → "Click Connect with Lua on the page."
- "How do I contact TechSafari?" → "Click Brief Tech Safari."

Returns { response: string }.`,
  tools: [new adaChatTool()],
});
