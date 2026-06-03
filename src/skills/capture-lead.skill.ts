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
      dimensions: z
        .array(
          z.object({
            key: z.string(),
            label: z.string(),
            score: z.number(),
            weight: z.number(),
            rationale: z.string(),
          }),
        )
        .optional()
        .describe('The 7 scored dimensions from score_jd — the agent\'s per-dimension analysis'),
      human_candidate: z.object({
        salary_range: z.string(),
        time_to_productive: z.string(),
      }).passthrough(),
      agent_candidate: z.object({
        name: z.string(),
        role_title: z.string(),
        monthly_cost: z.string(),
        start_date: z.string(),
        throughput: z.string().optional(),
      }).passthrough(),
      recommended_cta: z.enum(['lua', 'tech_safari']),
      flags: z.object({
        short_jd: z.boolean(),
        non_english: z.boolean(),
        suspected_fake: z.boolean(),
      }),
    })
    .passthrough()
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

// HTML-escape model/user text before injection into email markup.
function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Render the full evaluation report as inline-styled HTML (email-client safe).
function renderReportHtml(s: ScoringResult): string {
  const verdictColor =
    s.verdict === 'strong_agent' ? '#0a7d4a' :
    s.verdict === 'human_led_agent_assist' ? '#a86600' :
    '#1a5fb4';

  const dimRows = (s.dimensions ?? [])
    .slice()
    .sort((a, b) => b.weight - a.weight)
    .map(
      (d) => `<tr>
            <td style="padding:10px 12px;border-bottom:1px solid #ececec;font-weight:600;color:#1a1a1a;vertical-align:top">${esc(d.label)}</td>
            <td style="padding:10px 12px;border-bottom:1px solid #ececec;text-align:center;color:#1a1a1a;vertical-align:top">${esc(d.score)}/10</td>
            <td style="padding:10px 12px;border-bottom:1px solid #ececec;text-align:center;color:#666;vertical-align:top">${esc(d.weight)}×</td>
            <td style="padding:10px 12px;border-bottom:1px solid #ececec;color:#555;line-height:1.5;vertical-align:top">${esc(d.rationale)}</td>
          </tr>`,
    )
    .join('');

  const dimsBlock = dimRows
    ? `<h3 style="margin:28px 0 10px;font-size:16px;color:#1a1a1a;font-weight:600">Seven-dimension breakdown</h3>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;font-size:14px;border:1px solid #ececec;border-radius:8px;overflow:hidden">
          <tr style="background:#f7f7f5">
            <th style="padding:10px 12px;text-align:left;color:#666;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;font-weight:600">Dimension</th>
            <th style="padding:10px 12px;text-align:center;color:#666;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;font-weight:600">Score</th>
            <th style="padding:10px 12px;text-align:center;color:#666;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;font-weight:600">Weight</th>
            <th style="padding:10px 12px;text-align:left;color:#666;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;font-weight:600">Why</th>
          </tr>
          ${dimRows}
        </table>`
    : '';

  const h = s.human_candidate;
  const a = s.agent_candidate;
  const cards = `<h3 style="margin:28px 0 10px;font-size:16px;color:#1a1a1a;font-weight:600">Human vs Agent</h3>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:separate;border-spacing:8px 0;font-size:14px">
          <tr>
            <td style="vertical-align:top;padding:16px;background:#faf7f2;border-radius:10px;width:50%;border:1px solid #efe9dc">
              <div style="font-size:12px;color:#8a7547;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;margin-bottom:6px">Human hire</div>
              ${h.salary_range ? `<div style="margin:6px 0;color:#1a1a1a"><strong>Salary:</strong> ${esc(h.salary_range)}</div>` : ''}
              <div style="margin:6px 0;color:#1a1a1a"><strong>Time to productive:</strong> ${esc(h.time_to_productive)}</div>
            </td>
            <td style="vertical-align:top;padding:16px;background:#f2f6fa;border-radius:10px;width:50%;border:1px solid #dde7f0">
              <div style="font-size:12px;color:#1a5fb4;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;margin-bottom:6px">${esc(a.name)} · Lua agent</div>
              <div style="margin:6px 0;color:#1a1a1a"><strong>Monthly cost:</strong> ${esc(a.monthly_cost)}</div>
              <div style="margin:6px 0;color:#1a1a1a"><strong>Live:</strong> ${esc(a.start_date)}${a.throughput ? ` · ${esc(a.throughput)}` : ''}</div>
            </td>
          </tr>
        </table>`;

  const ctaLine = s.recommended_cta === 'lua'
    ? 'Recommended next step: talk to Lua about building this agent.'
    : 'Recommended next step: brief Talent Safari to source the human hire.';

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your Human or Agent? report</title></head>
<body style="margin:0;padding:0;background:#f4f3ef;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f4f3ef;padding:24px 0">
<tr><td align="center">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;width:100%;background:#ffffff;border-radius:14px;padding:32px;color:#1a1a1a;box-shadow:0 1px 3px rgba(0,0,0,0.04)">
    <tr><td>
      <div style="font-size:12px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Human or Agent? · Evaluation</div>
      <h1 style="margin:0 0 4px;font-size:24px;font-weight:700;color:#1a1a1a">${esc(s.role_title)}</h1>
      <div style="margin:14px 0 0;padding:14px 16px;background:#f7f7f5;border-left:4px solid ${verdictColor};border-radius:6px">
        <div style="font-size:18px;font-weight:600;color:${verdictColor}">${esc(s.verdict_line)}</div>
        <div style="font-size:14px;color:#555;margin-top:4px">Overall score: <strong style="color:#1a1a1a">${esc(s.score)}/100</strong></div>
      </div>
      <p style="font-size:15px;line-height:1.6;color:#333;margin:20px 0 0">${esc(s.rationale)}</p>
      ${dimsBlock}
      ${cards}
      <div style="margin-top:28px;padding:16px;background:#1a1a1a;color:#ffffff;border-radius:10px;font-size:15px;text-align:center">${esc(ctaLine)}</div>
      <div style="margin-top:24px;padding-top:16px;border-top:1px solid #ececec;color:#888;font-size:13px;text-align:center">— Ada · Built by Lua</div>
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;
}

// Compose the agent's analysis into a readable string for the evaluations record.
// Falls back gracefully to verdict + rationale when dimensions weren't relayed.
function buildAnalysis(s: ScoringResult): string {
  const lines: string[] = [];
  lines.push(`Score: ${s.score}/100 — ${s.verdict_line} (${s.verdict})`);
  if (s.rationale) lines.push('', s.rationale);
  if (s.dimensions?.length) {
    lines.push('', 'Dimension breakdown:');
    for (const d of [...s.dimensions].sort((a, b) => b.weight - a.weight)) {
      lines.push(`- ${d.label}: ${d.score}/10 (weight ${d.weight}×) — ${d.rationale}`);
    }
  }
  return lines.join('\n');
}

async function appendToSheets(
  webhookUrl: string,
  name: string,
  title: string,
  company: string,
  email: string,
  scoringResult: ScoringResult,
  jdText: string,
): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'append',
      name,
      title,
      company,
      email,
      date: new Date().toISOString(),                 // Date (agent-sent ISO)
      roleEvaluated: scoringResult.role_title,        // Role Evaluated
      score: scoringResult.score,
      ctaClicked: 'No',                               // initial CTA Clicked — flips on submit_cta
      verdict: scoringResult.verdict,                 // raw enum
      recommendedCta: scoringResult.recommended_cta,  // raw: 'lua' | 'tech_safari'
      jd: jdText,                                     // full JD text
      analysis: buildAnalysis(scoringResult),         // composed analysis
    }),
  });
  if (!response.ok) throw new Error(`Sheets webhook error ${response.status}`);
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
  scoringResult: ScoringResult,
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
      subject: `Your Human or Agent? report — ${scoringResult.role_title}`,
      html: renderReportHtml(scoringResult),
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
    "ALWAYS call this tool immediately after score_jd, even when quality flags are set. The tool always records the evaluation to the evaluations Data primitive; it then decides internally whether to also post Slack / send email / append Sheets, based on quality flags AND whether genuine lead contact details (name + title) are present. The score-time call (no name/title yet) only records to Data; Slack/Sheets/email fire later when the lead form is submitted. Pass whatever fields you have and never fabricate contact details. Never refuse, explain, or withhold the call.";
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
          analysis: buildAnalysis(scoringResult),
          dimensions: scoringResult.dimensions ?? [],
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

    // Real-lead gate. This tool is called twice per evaluation: once right
    // after score_jd (per the description, to record the evaluation to Data —
    // that already happened above) and once when the visitor submits the lead
    // form. Only the form submission carries real contact details (name +
    // title are required form fields). Emitting Slack / Sheets / email on the
    // score-time auto-call produced phantom rows + duplicate Slack posts +
    // report emails with placeholder contact info, so skip outward signals
    // until we have a genuine lead.
    if (!name?.trim() || !title?.trim()) {
      return {
        posted: false,
        email1Sent: false,
        email2ScheduledAt: '',
        skipped: true,
        reason: 'no_lead_details',
      };
    }

    const slackUrl = env('SLACK_LEADS_WEBHOOK_URL') ?? '';
    const resendKey = env('RESEND_API_KEY') ?? '';
    const fromEmail = env('FROM_EMAIL') ?? '';

    // Slack — primary signal, must succeed
    await postToSlack(slackUrl, scoringResult, email, company, jdText);

    // Sheets — non-fatal
    const sheetsUrl = env('SHEETS_WEBHOOK_URL') ?? '';
    if (sheetsUrl) {
      try {
        await appendToSheets(sheetsUrl, name ?? '', title ?? '', company, email, scoringResult, jdText ?? '');
      } catch { /* non-fatal */ }
    }

    // Email — non-fatal if Resend key not configured
    let email1Sent = false;
    let email2ScheduledAt = '';
    if (resendKey && fromEmail) {
      try {
        await sendEmail1(resendKey, fromEmail, email, scoringResult);
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
  context: `Use the capture_lead tool immediately after every successful score_jd call — pass the full scoringResult along with the lead's email and company name. ALWAYS call it, even if you believe a flag (short_jd, non_english, suspected_fake) is set. Never reply with text in place of the call; never explain the flag instead of calling the tool. The tool itself handles flag-based skipping.

The tool will:
1. ALWAYS record the evaluation to the evaluations Data primitive (regardless of flags).
2. If any flag is set → return { skipped: true, reason } and skip Slack/Sheets/email. This is internal; you still MUST call it.
3. Otherwise → post Slack Block Kit, append Google Sheets row, send Resend report email, schedule 2h follow-up.

Returns: { posted, email1Sent, email2ScheduledAt } on success, or { skipped: true, reason } when flagged.`,
  tools: [new captureLeadTool()],
});
