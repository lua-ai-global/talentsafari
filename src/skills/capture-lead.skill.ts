import { LuaSkill, LuaTool, Jobs, Data, env } from 'lua-cli';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const captureLeadInputSchema = z.object({
  email: z.string().email().describe("Lead's work email address"),
  name: z.string().optional().describe("Lead's full name"),
  title: z.string().optional().describe("Lead's job title"),
  company: z.string().min(1).describe("Lead's company name"),
  jdText: z.string().optional().describe('The full job description text submitted by the lead'),
  scoringResult: z
    .object({
      role_title: z.string(),
      score: z.number(),
      verdict: z.enum(['needs_human', 'human_led_agent_assist', 'strong_agent']),
      verdict_line: z.string(),
      rationale: z.string(),
      human_candidate: z.object({
        salary_range: z.string(),
        time_to_productive: z.string(),
      }),
      agent_candidate: z.object({
        name: z.string(),
        role_title: z.string(),
        monthly_cost: z.string(),
        start_date: z.string(),
        throughput: z.string().optional(),
      }),
      recommended_cta: z.enum(['lua', 'tech_safari']),
      flags: z.object({
        short_jd: z.boolean(),
        non_english: z.boolean(),
        suspected_fake: z.boolean(),
      }),
    })
    .describe('The full scoring result from score_jd'),
});

type CaptureLeadInput = z.infer<typeof captureLeadInputSchema>;
type ScoringResult = CaptureLeadInput['scoringResult'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function postToSlack(
  webhookUrl: string,
  scoringResult: ScoringResult,
  email: string,
  company: string,
  jdText?: string,
): Promise<void> {
  const { role_title, verdict_line, score, human_candidate, agent_candidate } = scoringResult;
  const roleSlug = slugify(role_title);

  const jdSnippet = jdText
    ? jdText.length > 2800
      ? jdText.slice(0, 2800) + '…'
      : jdText
    : null;

  const payload = {
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*New evaluation — ${role_title}*\nVerdict: ${verdict_line} · Score ${score} · ${company}\n${email}`,
        },
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: human_candidate.salary_range
              ? `*Human option:* ${human_candidate.salary_range} · ${human_candidate.time_to_productive} ramp`
              : `*Human option:* ${human_candidate.time_to_productive} ramp`,
          },
          {
            type: 'mrkdwn',
            text: `*Lua option:* Live ${agent_candidate.start_date} · ${agent_candidate.throughput || 'Unmetered'} throughput`,
          },
        ],
      },
      ...(jdSnippet ? [{
        type: 'section',
        text: { type: 'mrkdwn', text: `*Job description:*\n${jdSnippet}` },
      }] : []),
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '🧭 Talent Safari takes this' },
            style: 'primary',
            value: `tech_safari_${roleSlug}`,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '⚡ Lua takes this' },
            style: 'danger',
            value: `lua_${roleSlug}`,
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

async function sendEmail1(
  resendApiKey: string,
  fromEmail: string,
  toEmail: string,
  roleTitle: string,
  verdictLine: string,
  score: number,
): Promise<void> {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${resendApiKey}`,
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [toEmail],
      subject: `Your Human or Agent? report — ${roleTitle}`,
      html: `<p>Here's your full evaluation for <strong>${roleTitle}</strong>.</p><p>Verdict: ${verdictLine} (Score: ${score}/100)</p><p>The full seven-dimension breakdown is attached. Use it to brief Talent Safari or Lua.</p><p>— Ada · Built by Lua</p>`,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Resend API error ${response.status}: ${errorText}`);
  }
}

async function scheduleFollowupEmail(
  scoringResult: ScoringResult,
  email: string,
): Promise<string> {
  const executeAt = new Date(Date.now() + 2 * 60 * 60 * 1000);

  await Jobs.create({
    name: 'ada-followup-email',
    description: 'Ada follow-up email sent ~2 hours after evaluation delivery',
    schedule: { type: 'once', executeAt },
    metadata: {
      email,
      role_title: scoringResult.role_title,
      verdict: scoringResult.verdict,
      verdict_line: scoringResult.verdict_line,
      rationale: scoringResult.rationale,
    },
    execute: async (job) => {
      const meta = job.metadata as {
        email: string;
        role_title: string;
        verdict: string;
        verdict_line: string;
        rationale: string;
      };

      const adaFromEmail = env('ADA_FROM_EMAIL');
      const resendKey = env('RESEND_API_KEY');

      const emailBody = `Hi,

I just finished evaluating the ${meta.role_title} role — verdict: ${meta.verdict_line}.

${meta.rationale}

If you have any questions about the result or want to explore next steps, just reply to this email.

Ada · Built by Lua`;

      const sendResponse = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${resendKey ?? ''}`,
        },
        body: JSON.stringify({
          from: adaFromEmail ?? '',
          to: [meta.email],
          subject: `A follow-up on your ${meta.role_title} evaluation`,
          html: `<p>${emailBody.replace(/\n/g, '</p><p>')}</p>`,
        }),
      });

      if (!sendResponse.ok) {
        throw new Error(`Resend error sending follow-up: ${sendResponse.status}`);
      }

      return { sent: true, email: meta.email };
    },
  });

  return executeAt.toISOString();
}

// ---------------------------------------------------------------------------
// Tool — class-based pattern (required for lua-cli AST scanner detection)
// ---------------------------------------------------------------------------

export class captureLeadTool implements LuaTool<typeof captureLeadInputSchema> {
  name = 'capture_lead';
  description =
    "Post an evaluation result to Slack #leads, send the report delivery email to the lead, and schedule Ada's follow-up note (~2h later). Skips silently if any quality flag is set.";
  inputSchema = captureLeadInputSchema;

  async execute(input: CaptureLeadInput): Promise<unknown> {
    const { email, name, title, company, jdText, scoringResult } = input;
    const { flags } = scoringResult;

    // Always store to Data regardless of flags
    try {
      await Data.create(
        'evaluations',
        {
          email,
          name: name ?? '',
          title: title ?? '',
          company,
          role_title: scoringResult.role_title,
          score: scoringResult.score,
          verdict: scoringResult.verdict,
          recommended_cta: scoringResult.recommended_cta,
          jd_text: jdText ?? '',
          timestamp: new Date().toISOString(),
        },
        `${scoringResult.role_title} ${scoringResult.verdict} ${company} ${jdText ?? ''}`.slice(0, 2000),
      );
    } catch { /* non-fatal */ }

    // Flag short-circuit — no Slack, no email
    if (flags.short_jd || flags.non_english || flags.suspected_fake) {
      const reason = Object.keys(flags).find((k) => flags[k as keyof typeof flags]);
      return {
        posted: false,
        email1Sent: false,
        email2ScheduledAt: '',
        skipped: true,
        reason,
      };
    }

    const slackUrl = env('SLACK_LEADS_WEBHOOK_URL') ?? '';
    const resendKey = env('RESEND_API_KEY') ?? '';
    const fromEmail = env('FROM_EMAIL') ?? '';

    // Slack — primary signal, must succeed
    await postToSlack(slackUrl, scoringResult, email, company, jdText);

    // Email — non-fatal if Resend key not configured
    let email1Sent = false;
    let email2ScheduledAt = '';
    if (resendKey && fromEmail) {
      try {
        await sendEmail1(resendKey, fromEmail, email, scoringResult.role_title, scoringResult.verdict_line, scoringResult.score);
        email1Sent = true;
      } catch { /* non-fatal */ }
      try {
        email2ScheduledAt = await scheduleFollowupEmail(scoringResult, email);
      } catch { /* non-fatal */ }
    }

    return {
      posted: true,
      email1Sent,
      email2ScheduledAt,
    };
  }
}

// ---------------------------------------------------------------------------
// Skill
// ---------------------------------------------------------------------------

export const captureLeadSkill = new LuaSkill({
  name: 'capture-lead',
  description:
    'Captures a qualified lead by posting the evaluation result to Slack and delivering the report and follow-up emails.',
  context: `Use the capture_lead tool immediately after a successful score_jd call — pass the full scoringResult along with the lead's email and company name.

The tool will:
1. Skip silently (skipped: true) if any flag is set (short_jd, non_english, suspected_fake) — do not retry or explain.
2. Post a rich Block Kit notification to Slack #leads with human vs Ada comparison and routing buttons.
3. Send the evaluation report to the lead's email via Resend.
4. Schedule Ada's personalised follow-up email to fire ~2 hours later.

Returns: { posted, email1Sent, email2ScheduledAt } on success, or { skipped: true, reason } when flagged.`,
  tools: [new captureLeadTool()],
});
