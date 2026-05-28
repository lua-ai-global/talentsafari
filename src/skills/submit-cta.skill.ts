import { LuaSkill, LuaTool, Data, env } from 'lua-cli';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const submitCtaInputSchema = z.object({
  path: z.enum(['tech_safari', 'lua']).describe('Which CTA path the user chose'),
  name: z.string().min(1).describe("Contact's full name"),
  email: z.string().email().describe("Contact's work email"),
  company: z.string().min(1).describe("Contact's company"),
  extraField: z
    .string()
    .optional()
    .describe(
      "'When do you need this seat filled?' for tech_safari, or 'What should this agent own first?' for lua",
    ),
  jdText: z.string().optional().describe('The original job description text'),
  scoringResult: z
    .object({
      role_title: z.string(),
      score: z.number(),
      verdict_line: z.string(),
      recommended_cta: z.enum(['lua', 'tech_safari']),
      agent_candidate: z.object({
        monthly_cost: z.string(),
        start_date: z.string(),
      }),
      human_candidate: z.object({
        salary_range: z.string(),
      }),
    })
    .describe('The scoring result for context in the Slack post'),
});

type SubmitCtaInput = z.infer<typeof submitCtaInputSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function postCtaToSlack(webhookUrl: string, input: SubmitCtaInput): Promise<void> {
  const { path, name, email, company, extraField, jdText, scoringResult } = input;
  const { role_title, score, verdict_line, agent_candidate, human_candidate } = scoringResult;

  const pathLabel = path === 'tech_safari' ? '🧭 Talent Safari' : '⚡ Lua';
  const extraLabel = path === 'tech_safari' ? 'Timeline' : 'Scope';
  const financialLine =
    path === 'tech_safari' && human_candidate.salary_range
      ? `Human option: ${human_candidate.salary_range}`
      : '';

  const jdSnippet = jdText
    ? jdText.length > 2800 ? jdText.slice(0, 2800) + '…' : jdText
    : null;

  const text = [
    `*CTA submitted — ${pathLabel} path*`,
    `Role: ${role_title} · Score ${score} · ${verdict_line}`,
    `Contact: ${name} · ${email} · ${company}`,
    extraField ? `${extraLabel}: ${extraField}` : '',
    financialLine,
    path === 'tech_safari' && jdSnippet ? `\n*Job description:*\n${jdSnippet}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    throw new Error(`Slack webhook error ${response.status}`);
  }
}

async function sendConfirmationEmail(
  resendApiKey: string,
  fromEmail: string,
  input: SubmitCtaInput,
): Promise<void> {
  const { path, name, email, scoringResult } = input;

  let subject: string;
  let html: string;

  if (path === 'tech_safari') {
    subject = 'Your Talent Safari brief has been sent';
    html = `<p>Hi ${name},</p>
<p>Your brief for the <strong>${scoringResult.role_title}</strong> evaluation has been sent to Talent Safari.</p>
<p>A recruiter will review the role scorecard and reply within one business day.</p>
<p>— Ada · Built by Lua</p>`;
  } else {
    subject = 'Your Lua intro is booked';
    html = `<p>Hi ${name},</p>
<p>Thanks for choosing Lua for your <strong>${scoringResult.role_title}</strong> evaluation.</p>
<p>The team will be in touch shortly to book your 15-minute intro call and walk through what Ada can own from day one.</p>
<p>— Ada · Built by Lua</p>`;
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${resendApiKey}`,
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [email],
      subject,
      html,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Resend API error ${response.status}: ${errorText}`);
  }
}

// ---------------------------------------------------------------------------
// Tool — class-based pattern (required for lua-cli AST scanner detection)
// ---------------------------------------------------------------------------

export class submitCtaTool implements LuaTool<typeof submitCtaInputSchema> {
  name = 'submit_cta';
  description =
    'Handle a CTA form submission for either the Talent Safari (human recruiting) or Lua (AI agent) path. Posts to Slack and sends a confirmation email to the contact.';
  inputSchema = submitCtaInputSchema;

  async execute(input: SubmitCtaInput): Promise<unknown> {
    const slackUrl = env('SLACK_LEADS_WEBHOOK_URL') ?? '';
    const resendKey = env('RESEND_API_KEY') ?? '';
    const fromEmail = env('FROM_EMAIL') ?? '';

    // Store CTA submission to Data
    try {
      await Data.create(
        'cta-submissions',
        {
          path,
          name,
          email,
          company,
          extra_field: extraField ?? '',
          role_title: scoringResult.role_title,
          score: scoringResult.score,
          verdict_line: scoringResult.verdict_line,
          recommended_cta: scoringResult.recommended_cta,
          jd_text: jdText ?? '',
          timestamp: new Date().toISOString(),
        },
        `${scoringResult.role_title} ${path} ${company} ${jdText ?? ''}`.slice(0, 2000),
      );
    } catch { /* non-fatal */ }

    await postCtaToSlack(slackUrl, input);
    await sendConfirmationEmail(resendKey, fromEmail, input);

    return {
      posted: true,
      confirmationSent: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Skill
// ---------------------------------------------------------------------------

export const submitCtaSkill = new LuaSkill({
  name: 'submit-cta',
  description:
    'Handles CTA form submissions — routes the contact to Talent Safari (human recruiting) or Lua (AI agent build), posts to Slack, and sends a confirmation email.',
  context: `Use the submit_cta tool when a user completes a CTA form after reviewing their evaluation results.

Two paths are supported:
- tech_safari: The user wants a human hire sourced by Talent Safari. Collect name, email, company, and optionally "When do you need this seat filled?".
- lua: The user wants an AI agent built by Lua. Collect name, email, company, and optionally "What should this agent own first?".

Always pass the scoringResult from the earlier score_jd call so Slack gets the full role context.

The tool posts a plain-text Slack notification and sends a path-appropriate confirmation email. Returns { posted: true, confirmationSent: true } on success.`,
  tools: [new submitCtaTool()],
});
