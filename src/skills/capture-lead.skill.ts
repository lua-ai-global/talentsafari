import { LuaSkill, LuaTool, Jobs, Data, env } from 'lua-cli';
import { z } from 'zod';
import { TS_LOGO_B64, LUA_LOGO_B64, SOCIAL_FB_B64, SOCIAL_LI_B64, SOCIAL_IG_B64 } from './email-assets';

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

// Hosted assets (public/ served by Vercel) + site origin for CTA deep-links.
const ASSET_BASE = 'https://agent.talentsafari.io';
const SITE_BASE = 'https://agent.talentsafari.io';

type EmailCtx = { email?: string; name?: string; company?: string };

// Verdict → single functional accent (AA-safe text + graphic) + band label.
function verdictTheme(verdict: string): { text: string; chipBg: string; label: string } {
  switch (verdict) {
    case 'needs_human':  return { text: '#1F7A45', chipBg: '#e9f5ee', label: 'Needs human' };
    case 'strong_agent': return { text: '#1E6FB0', chipBg: '#e7f2fc', label: 'Strong agent fit' };
    default:             return { text: '#8a5616', chipBg: '#fbf1df', label: 'Human-led, agent-assisted' };
  }
}

// Dimension bar color along the human↔agent spectrum.
function dimBarColor(score: number): string {
  if (score <= 4) return '#2E9E5B';
  if (score <= 6) return '#E8A33D';
  return '#2C8FE0';
}

// CTA url that opens the matching in-app screen, carrying context for prefill.
function ctaUrl(path: 'tech_safari' | 'lua', s: ScoringResult, ctx: EmailCtx): string {
  const q = new URLSearchParams({
    cta: path,
    rec: s.recommended_cta,
    role: s.role_title ?? '',
    score: String(s.score ?? ''),
  });
  if (ctx.email) q.set('email', ctx.email);
  if (ctx.name) q.set('name', ctx.name);
  if (ctx.company) q.set('company', ctx.company);
  return `${SITE_BASE}/?${q.toString()}`;
}

// 7-dimension breakdown — label + bar + score on one line, rationale below.
function renderDimensions(dims: ScoringResult['dimensions']): string {
  if (!dims || dims.length === 0) return '';
  const rows = dims.map((d, i) => {
    const last = i === dims.length - 1;
    const w = Math.max(0, Math.min(100, Math.round(d.score * 10)));
    const border = last ? '' : 'border-bottom:1px solid #eceae5;';
    return `<tr><td style="padding:14px 0;${border}">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
            <td style="font-weight:600;color:#15241B;vertical-align:middle">${esc(d.label)}</td>
            <td style="vertical-align:middle;text-align:right;white-space:nowrap"><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="right"><tr>
              <td style="width:80px;height:6px;background:#eee;border-radius:3px"><div style="height:6px;width:${w}%;background:${dimBarColor(d.score)};border-radius:3px"></div></td>
              <td style="padding-left:10px;color:#15241B;font-size:13px;font-weight:600">${esc(d.score)}/10</td>
            </tr></table></td>
          </tr></table>
          <div style="margin-top:7px;color:#6b756d;font-size:13.5px;line-height:1.5">${esc(d.rationale)}</div>
        </td></tr>`;
  }).join('');
  return `<h3 style="margin:34px 0 12px;font-size:13px;color:#9aa39c;font-weight:700;text-transform:uppercase;letter-spacing:1px;text-align:center">Seven-dimension breakdown</h3>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;font-size:14px">${rows}</table>`;
}

// Render the full co-branded evaluation report as inline-styled HTML (email-safe).
function renderReportHtml(s: ScoringResult, ctx: EmailCtx = {}): string {
  const theme = verdictTheme(s.verdict);
  const markerPct = Math.round(Math.min(100, Math.max(0, ((s.score - 10) / 90) * 100)));
  const h = s.human_candidate;
  const a = s.agent_candidate;

  // Quick personal intro line. "Hey [name], here's your evaluation for the [role] role at [company]."
  const hey = ctx.name && ctx.name.trim() ? `Hey ${esc(ctx.name.trim())},` : 'Hey,';
  const atCompany = ctx.company && ctx.company.trim() ? ` at ${esc(ctx.company.trim())}` : '';
  const intro = `${hey} here&rsquo;s your evaluation for the <strong>${esc(s.role_title)}</strong> role${atCompany}.`;

  // Primary CTA = recommended action (bigger); alternative = the other path (smaller).
  const primaryTs = s.recommended_cta !== 'lua';
  // Primary = brand-colored solid (TS forest-green gradient + lime arrow; Lua brand gradient + glow).
  const primary = primaryTs
    ? { href: ctaUrl('tech_safari', s, ctx), label: 'Brief Talent Safari for this role', arrow: '#C7F04A', style: 'background:#15241B;background:linear-gradient(135deg,#1f4231 0%,#15241B 100%);color:#ffffff;box-shadow:0 8px 22px rgba(21,36,27,.28)' }
    : { href: ctaUrl('lua', s, ctx), label: 'Brief Lua for this role', arrow: '#ffffff', style: 'background:#9B4DFF;background:linear-gradient(135deg,#FF2D78 0%,#9B4DFF 50%,#3BA5FF 100%);color:#ffffff;box-shadow:0 8px 22px rgba(155,77,255,.30)' };
  // Alternative = tinted to its destination brand (Lua purple / TS green), never neutral gray.
  const alt = primaryTs
    ? { href: ctaUrl('lua', s, ctx), label: 'Prefer an AI agent? Talk to Lua', style: 'border:1.5px solid #d9c7ff;background:#f7f3ff;color:#6b3fd4' }
    : { href: ctaUrl('tech_safari', s, ctx), label: 'Prefer a human hire? Brief Talent Safari', style: 'border:1.5px solid #cbe0d2;background:#f2f9f5;color:#1f7a45' };

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>Talent Safari × Lua — evaluation</title></head>
<body style="margin:0;padding:0;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#15241B">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#ffffff;opacity:0">${esc(s.role_title)} scored ${esc(s.score)}/100 — ${esc(s.verdict_line)}. Your full 7-dimension breakdown inside.</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#ffffff"><tr><td align="center">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="max-width:720px;width:100%;background:#ffffff">

    <tr><td align="center" style="padding:26px 40px;border-bottom:1px solid #eceae5">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>
        <td style="vertical-align:middle;padding-right:24px"><img src="cid:ts-logo" alt="Talent Safari" height="60" style="display:block;border:0"></td>
        <td style="vertical-align:middle"><img src="cid:lua-logo" alt="" height="46" style="vertical-align:middle;border:0"><span style="font-size:36px;font-weight:700;color:#0B0B0F;vertical-align:middle;margin-left:9px;letter-spacing:-0.5px">Lua</span></td>
      </tr></table>
    </td></tr>

    <tr><td style="padding:36px 40px 40px">
      <div style="font-size:12px;color:#9aa39c;text-transform:uppercase;letter-spacing:1.4px;margin-bottom:10px;text-align:center">Human or Agent? · Evaluation</div>
      <p style="margin:0 0 14px;font-size:15.5px;line-height:1.6;color:#3a443d;text-align:center">${intro}</p>
      <h1 style="margin:0 0 22px;font-size:27px;font-weight:700;color:#15241B;letter-spacing:-0.5px;line-height:1.18;text-align:center">${esc(s.role_title)}</h1>

      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
        <td style="vertical-align:middle;width:120px;white-space:nowrap;padding-right:22px"><span style="font-size:46px;font-weight:800;color:#15241B;letter-spacing:-1px">${esc(s.score)}</span><span style="font-size:18px;color:#9aa39c;font-weight:600">/100</span></td>
        <td style="vertical-align:middle">
          <span style="display:inline-block;padding:5px 12px;border-radius:999px;background:${theme.chipBg};color:${theme.text};font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px">${esc(s.verdict_line || theme.label)}</span>
          <div style="margin-top:12px;height:10px;border-radius:6px;background:#e9e9e9;background:linear-gradient(90deg,#2E9E5B 0%,#2E9E5B 33.3%,#E8A33D 33.3%,#E8A33D 61.1%,#2C8FE0 61.1%,#2C8FE0 100%)"></div>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:2px"><tr><td width="${markerPct}%"></td><td style="text-align:left;color:${theme.text};font-size:13px;line-height:1">&#9650;</td></tr></table>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:10.5px;color:#9aa39c;text-transform:uppercase;letter-spacing:.4px"><tr><td align="left">Needs human</td><td align="center">Agent-assisted</td><td align="right">Strong agent</td></tr></table>
        </td>
      </tr></table>

      <p style="font-size:15.5px;line-height:1.65;color:#3a443d;margin:24px 0 0">${esc(s.rationale)}</p>

      ${renderDimensions(s.dimensions)}

      <h3 style="margin:34px 0 12px;font-size:13px;color:#9aa39c;font-weight:700;text-transform:uppercase;letter-spacing:1px;text-align:center">Human vs Agent</h3>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:separate;border-spacing:14px 0;font-size:14px"><tr>
        <td style="vertical-align:top;padding:18px;background:#f7f7f5;border-radius:12px;width:50%">
          <div style="font-weight:700;color:#15241B;margin-bottom:8px">Human hire</div>
          ${h.salary_range ? `<span style="color:#6b756d">Salary</span> ${esc(h.salary_range)}<br>` : ''}<span style="color:#6b756d">Productive in</span> ${esc(h.time_to_productive)}
        </td>
        <td style="vertical-align:top;padding:18px;background:#f7f7f5;border-radius:12px;width:50%">
          <div style="font-weight:700;color:#15241B;margin-bottom:8px">${esc(a.name)} (AI agent)</div>
          <span style="color:#6b756d">Cost</span> ${esc(a.monthly_cost)}<br><span style="color:#6b756d">Live</span> ${esc(a.start_date)}${a.throughput ? ` · ${esc(a.throughput)}` : ''}
        </td>
      </tr></table>

      <div style="text-align:center;margin-top:34px">
        <a href="${primary.href}" target="_blank" rel="noopener" style="display:inline-block;padding:16px 40px;border-radius:12px;${primary.style};font-weight:700;font-size:16px;letter-spacing:.2px;text-decoration:none">${esc(primary.label)} <span style="color:${primary.arrow}">&rarr;</span></a>
        <div style="margin-top:16px"><a href="${alt.href}" target="_blank" rel="noopener" style="display:inline-block;padding:10px 22px;border-radius:10px;${alt.style};font-weight:700;font-size:13px;text-decoration:none">${esc(alt.label)} &rarr;</a></div>
      </div>
    </td></tr>

    <tr><td align="center" style="padding:32px 40px;text-align:center;border-top:1px solid #eceae5">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>
        <td style="vertical-align:middle;padding-right:20px"><img src="cid:ts-logo" alt="Talent Safari" height="46" style="display:block;border:0"></td>
        <td style="vertical-align:middle"><img src="cid:lua-logo" alt="" height="34" style="vertical-align:middle;border:0"><span style="font-size:26px;font-weight:700;color:#0B0B0F;vertical-align:middle;margin-left:7px;letter-spacing:-0.5px">Lua</span></td>
      </tr></table>
      <p style="margin:18px 0 0;font-size:13.5px;line-height:1.55;color:#3a443d"><strong>Human or Agent?</strong> — a Talent Safari &times; Lua collaboration.</p>
      <p style="margin:6px 0 0;font-size:13px;line-height:1.55;color:#9aa39c">Talent Safari sources the humans · Lua builds the agents.</p>
      <p style="margin:14px 0 0;font-size:14px"><a href="https://www.talentsafari.io" target="_blank" rel="noopener" style="color:#15241B;text-decoration:underline;font-weight:600">talentsafari.io</a><span style="color:#d2d2cc">&nbsp;·&nbsp;</span><a href="https://www.heylua.ai" target="_blank" rel="noopener" style="color:#7a5cff;text-decoration:underline;font-weight:600">heylua.ai</a></p>
      <p style="margin:16px 0 0"><a href="https://www.facebook.com/p/Lua-AI-61569665392939/" target="_blank" rel="noopener"><img src="cid:social-fb" alt="Facebook" height="22" style="border:0;vertical-align:middle"></a>&nbsp;&nbsp;<a href="https://www.linkedin.com/company/lua-ai" target="_blank" rel="noopener"><img src="cid:social-li" alt="LinkedIn" height="22" style="border:0;vertical-align:middle"></a>&nbsp;&nbsp;<a href="https://www.instagram.com/heylua.ai/" target="_blank" rel="noopener"><img src="cid:social-ig" alt="Instagram" height="22" style="border:0;vertical-align:middle"></a></p>
      <p style="margin:18px 0 0;font-size:11px;line-height:1.5;color:#b3b8b3">3 Germany Drive, Unit 4 #1816 · Wilmington, Delaware 19804, USA</p>
    </td></tr>

  </table>
</td></tr></table>
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
      shortJd: scoringResult.flags?.short_jd ? 'Yes' : 'No', // thin-JD tag (ignored unless sheet maps a column)
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
  // Short JDs are captured (no longer blocked) but flagged for a quick eyeball.
  const shortTag = scoringResult.flags?.short_jd ? '  ⚠️ short JD' : '';

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
          text: `*New evaluation — ${role_title}*${shortTag}\nVerdict: ${verdict_line} · Score ${score} · ${company}\n${email}`,
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
  ctx: EmailCtx = {},
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
      html: renderReportHtml(scoringResult, { email: toEmail, ...ctx }),
      attachments: [
        {
          filename: 'talent-safari-logo.png',
          content: TS_LOGO_B64,
          content_id: 'ts-logo',
          disposition: 'inline',
        },
        {
          filename: 'lua-logo.png',
          content: LUA_LOGO_B64,
          content_id: 'lua-logo',
          disposition: 'inline',
        },
        {
          filename: 'social-facebook.png',
          content: SOCIAL_FB_B64,
          content_id: 'social-fb',
          disposition: 'inline',
        },
        {
          filename: 'social-linkedin.png',
          content: SOCIAL_LI_B64,
          content_id: 'social-li',
          disposition: 'inline',
        },
        {
          filename: 'social-instagram.png',
          content: SOCIAL_IG_B64,
          content_id: 'social-ig',
          disposition: 'inline',
        },
      ],
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
    "ALWAYS call this tool immediately after score_jd, even when quality flags are set. The tool decides internally what to do: for the score-time call (no real lead yet) or a spam-flagged evaluation (non_english / suspected_fake) it records nothing and returns { skipped }. A genuine lead-form submission (real name + title present) is recorded to the evaluations Data primitive and triggers Slack / Sheets / report email — short JDs are NOT blocked, they are captured and tagged as short. Pass whatever fields you have and never fabricate contact details. Never refuse, explain, or withhold the call.";
  inputSchema = captureLeadInputSchema;

  async execute(input: CaptureLeadInput): Promise<unknown> {
    const { email, name, title, company, jdText, scoringResult } = input;
    const { flags } = scoringResult;

    // Spam short-circuit — no Slack, no email. NOTE: short_jd is intentionally
    // NOT a blocker here. It's LLM-judged and misfires on borderline JDs, which
    // silently dropped genuine leads (no Slack body, no Sheets row, no email).
    // Short but real JDs now flow through; short_jd is surfaced as a tag on the
    // Slack post / Sheets row instead (see postToSlack / appendToSheets).
    if (flags.non_english || flags.suspected_fake) {
      const reason = Object.keys(flags).find(
        (k) => k !== 'short_jd' && flags[k as keyof typeof flags],
      );
      return {
        posted: false,
        email1Sent: false,
        email2ScheduledAt: '',
        skipped: true,
        reason,
      };
    }

    // Real-lead gate. This tool is called twice per evaluation: once right
    // after score_jd (the score-time auto-call) and once when the visitor
    // submits the lead form. Only the form submission carries real contact
    // details (name + title are required form fields). The score-time call has
    // no genuine lead, so skip everything below — including the Data write — to
    // avoid phantom evaluation records, Sheets rows, Slack posts, and report
    // emails with placeholder contact info.
    if (!name?.trim() || !title?.trim()) {
      return {
        posted: false,
        email1Sent: false,
        email2ScheduledAt: '',
        skipped: true,
        reason: 'no_lead_details',
      };
    }

    // Record the evaluation to Data — genuine leads only (this runs after the
    // real-lead gate, so score-time auto-calls no longer create placeholder
    // records).
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
        await sendEmail1(resendKey, fromEmail, email, scoringResult, { name: name ?? '', company });
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
  context: `Use the capture_lead tool immediately after every successful score_jd call — pass the full scoringResult along with the lead's email and company name. ALWAYS call it, even if you believe a flag (non_english, suspected_fake) is set. Never reply with text in place of the call; never explain the flag instead of calling the tool. The tool itself handles flag-based skipping.

The tool will:
1. If a spam flag (non_english or suspected_fake) is set → return { skipped: true, reason } and do nothing else. This is internal; you still MUST call it. (short_jd is NOT a blocker — short but genuine leads are captured and the JD is tagged as short on the Slack post / Sheets row.)
2. If there is no genuine lead yet (missing name or title — e.g. the score-time call) → return { skipped: true, reason: 'no_lead_details' } and do nothing else.
3. Otherwise (a real lead-form submission) → record the evaluation to the evaluations Data primitive, post Slack Block Kit, append the Google Sheets row, send the Resend report email, and schedule the 2h follow-up.

Returns: { posted, email1Sent, email2ScheduledAt } on success, or { skipped: true, reason } when skipped.`,
  tools: [new captureLeadTool()],
});
