import { LuaSkill, LuaTool, env } from 'lua-cli';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const briefWizardInputSchema = z.object({
  mode: z.enum(['chat', 'generate']).describe('chat = wizard conversation, generate = produce final brief'),
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string(),
      }),
    )
    .optional()
    .describe('Used in chat mode'),
  evaluation: z.object({
    role_title: z.string(),
    score: z.number(),
    verdict_line: z.string(),
    rationale: z.string(),
    agent_candidate: z.object({
      name: z.string(),
      role_title: z.string(),
      avatar_seed: z.string(),
      monthly_cost: z.string(),
      throughput: z.string(),
      coverage: z.string(),
      great_at: z.array(z.string()),
      cant_do: z.array(z.string()),
    }),
  }),
  answers: z
    .array(z.string())
    .optional()
    .describe('Q1-Q5 answers, used in generate mode'),
});

type BriefWizardInput = z.infer<typeof briefWizardInputSchema>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LuaBrief {
  agent_name: string;
  role_summary: string;
  core_capabilities: string[];
  explicit_limits: string[];
  integrations: string[];
  escalation_rules: string;
  success_metrics: string[];
  monthly_budget: string;
  coverage_requirement: string;
  first_milestone: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WIZARD_QUESTIONS = [
  'What tools do you currently use for this work today? (List any apps, platforms, or systems.)',
  'Walk me through the process from start to finish — what triggers it, what happens step by step, and how it ends.',
  'Where do things go wrong? What takes the most time or causes the most frustration?',
  'Describe your perfect week for this role — what would be handled automatically versus escalated to a human?',
  'Which systems would the agent need read or write access to? (E.g. CRM, email, database, API.)',
];

const GENERATE_BRIEF_TOOL = {
  name: 'generate_brief',
  description: 'Generate a structured Lua agent build brief',
  input_schema: {
    type: 'object',
    required: [
      'agent_name',
      'role_summary',
      'core_capabilities',
      'explicit_limits',
      'integrations',
      'escalation_rules',
      'success_metrics',
      'monthly_budget',
      'coverage_requirement',
      'first_milestone',
    ],
    properties: {
      agent_name: { type: 'string' },
      role_summary: { type: 'string', maxLength: 200 },
      core_capabilities: { type: 'array', items: { type: 'string' }, maxItems: 5 },
      explicit_limits: { type: 'array', items: { type: 'string' }, maxItems: 3 },
      integrations: { type: 'array', items: { type: 'string' } },
      escalation_rules: { type: 'string', maxLength: 200 },
      success_metrics: { type: 'array', items: { type: 'string' }, maxItems: 4 },
      monthly_budget: { type: 'string' },
      coverage_requirement: { type: 'string' },
      first_milestone: { type: 'string', maxLength: 150 },
    },
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runChatMode(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  evaluation: BriefWizardInput['evaluation'],
  apiKey: string,
): Promise<string> {
  const { role_title, verdict_line, agent_candidate } = evaluation;

  const systemPrompt = `You are Ada — an AI agent built by Lua. You are interviewing a user to build a precise Lua build brief for the role: "${role_title}" (${verdict_line}).

The proposed agent is: ${agent_candidate.name} (${agent_candidate.role_title}) at ${agent_candidate.monthly_cost}/mo.

Your job is to ask ONE question at a time from this list, in order:
1. ${WIZARD_QUESTIONS[0]}
2. ${WIZARD_QUESTIONS[1]}
3. ${WIZARD_QUESTIONS[2]}
4. ${WIZARD_QUESTIONS[3]}
5. ${WIZARD_QUESTIONS[4]}

Count how many answers have been given so far based on the conversation history.
- If fewer than 5 answers have been given, ask the next unanswered question.
- After all 5 answers have been given, reply exactly: "Perfect — I have everything I need. Generating your Lua build brief now."

Be warm and concise. Do not ask multiple questions at once. Do not explain the process — just ask the question naturally.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: systemPrompt,
      messages,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${errorText}`);
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; text?: string }>;
  };

  return data.content.find((c) => c.type === 'text')?.text ?? '';
}

async function runGenerateMode(
  answers: string[],
  evaluation: BriefWizardInput['evaluation'],
  apiKey: string,
): Promise<LuaBrief> {
  const { role_title, verdict_line, rationale, agent_candidate } = evaluation;

  const answersText = WIZARD_QUESTIONS.map((q, i) => `Q${i + 1}: ${q}\nA: ${answers[i] ?? '(not provided)'}`).join(
    '\n\n',
  );

  const systemPrompt = `You are an expert AI agent implementation consultant at Lua. Generate a precise, actionable Lua build brief based on the evaluation data and user answers below.

EVALUATION:
  Role: ${role_title}
  Verdict: ${verdict_line}
  Rationale: ${rationale}

PROPOSED AGENT:
  Name: ${agent_candidate.name}
  Role: ${agent_candidate.role_title}
  Budget: ${agent_candidate.monthly_cost}/mo
  Throughput: ${agent_candidate.throughput}
  Coverage: ${agent_candidate.coverage}
  Great at: ${agent_candidate.great_at.join(', ')}
  Can't do: ${agent_candidate.cant_do.join(', ')}

USER ANSWERS:
${answersText}

Use the generate_brief tool to return structured output. Be specific and concrete — no generic filler.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: systemPrompt,
      tools: [GENERATE_BRIEF_TOOL],
      tool_choice: { type: 'tool', name: 'generate_brief' },
      messages: [{ role: 'user', content: 'Generate the Lua build brief now.' }],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${errorText}`);
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; name?: string; input?: Record<string, unknown> }>;
  };

  const toolUse = data.content.find((c) => c.type === 'tool_use' && c.name === 'generate_brief');
  if (!toolUse || !toolUse.input) {
    throw new Error('Claude did not return a generate_brief tool call');
  }

  return toolUse.input as LuaBrief;
}

async function postBriefToSlack(
  webhookUrl: string,
  brief: LuaBrief,
  roleTitle: string,
): Promise<void> {
  const payload = {
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `Agent Brief — ${roleTitle}`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${brief.agent_name}* — ${brief.role_summary}`,
        },
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Core Capabilities*\n${brief.core_capabilities.map((c) => `• ${c}`).join('\n')}`,
          },
          {
            type: 'mrkdwn',
            text: `*Integrations*\n${brief.integrations.map((i) => `• ${i}`).join('\n')}`,
          },
        ],
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Monthly Budget*\n${brief.monthly_budget}`,
          },
          {
            type: 'mrkdwn',
            text: `*First Milestone*\n${brief.first_milestone}`,
          },
        ],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Lua takes this' },
            style: 'primary',
            value: `brief_${brief.agent_name.toLowerCase().replace(/\s+/g, '_')}`,
          },
        ],
      },
    ],
  };

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Slack webhook error ${response.status}`);
  }
}

// ---------------------------------------------------------------------------
// Tool — class-based pattern (required for lua-cli AST scanner detection)
// ---------------------------------------------------------------------------

export class briefWizardTool implements LuaTool<typeof briefWizardInputSchema> {
  name = 'brief_wizard';
  description =
    'Two-mode tool: chat mode runs a 5-question wizard interview to gather build brief inputs; generate mode produces a structured Lua agent build brief and posts it to Slack.';
  inputSchema = briefWizardInputSchema;

  async execute(input: BriefWizardInput): Promise<unknown> {
    const { mode, messages, evaluation, answers } = input;
    const apiKey = env('ANTHROPIC_API_KEY') ?? '';

    if (mode === 'chat') {
      const safeMessages = messages ?? [];
      const response = await runChatMode(safeMessages, evaluation, apiKey);
      return { response };
    }

    // generate mode
    const safeAnswers = answers ?? [];
    const brief = await runGenerateMode(safeAnswers, evaluation, apiKey);

    const slackUrl = env('SLACK_LEADS_WEBHOOK_URL') ?? '';
    await postBriefToSlack(slackUrl, brief, evaluation.role_title);

    return { brief };
  }
}

// ---------------------------------------------------------------------------
// Skill
// ---------------------------------------------------------------------------

export const briefWizardSkill = new LuaSkill({
  name: 'brief-wizard',
  description:
    'Guides a user through a 5-question interview to build a structured Lua agent build brief, then generates the brief using Sonnet and posts it to Slack.',
  context: `Use the brief_wizard tool when a user wants to generate a Lua agent build brief after reviewing their evaluation.

Two modes:

chat — Ask ONE question at a time from the 5-wizard questions. Pass the full conversation history as messages. Returns { response: string }. Continue calling in chat mode until Ada says "Perfect — I have everything I need. Generating your Lua build brief now."

generate — Pass the 5 collected answers as the answers array. Ada calls Sonnet with structured tool_choice to produce a LuaBrief JSON, posts it to Slack #leads via Block Kit, and returns { brief: <LuaBrief> }.

Always pass the full evaluation object in both modes for context.`,
  tools: [new briefWizardTool()],
});
