// JD scoring via Ada's chat API endpoint.
// Ada's persona contains the full scoring rubric and outputs JSON directly.
// Single LLM call (~8-15s) fits within Vercel's 60s budget.
// Each call uses a unique channel — no session contamination from prior calls.

import { isOriginAllowed } from './_lib/origin.js';

function extractJsonObject(text) {
  const stripped = text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  const start = stripped.indexOf('{');
  if (start === -1) return null;

  let depth = 0, inString = false, escape = false;
  for (let i = start; i < stripped.length; i++) {
    const c = stripped[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(stripped.slice(start, i + 1)); }
        catch { return null; }
      }
    }
  }
  return null;
}

function verdictForScore(score) {
  if (score < 40) return { verdict: 'needs_human',             recommended_cta: 'tech_safari' };
  if (score < 65) return { verdict: 'human_led_agent_assist',  recommended_cta: 'tech_safari' };
  return                  { verdict: 'strong_agent',           recommended_cta: 'lua' };
}

function normalizeScoringResult(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!Array.isArray(raw.dimensions) || raw.dimensions.length !== 7) return null;
  if (typeof raw.score !== 'number') return null;

  const computed = Math.round(raw.dimensions.reduce((s, d) => s + (d.score * d.weight), 0));
  let score = raw.score;
  let verdict = raw.verdict;
  let recommended_cta = raw.recommended_cta;

  if (Math.abs(computed - score) > 1) {
    score = computed;
    const v = verdictForScore(computed);
    verdict = v.verdict;
    recommended_cta = v.recommended_cta;
  } else {
    const expected = verdictForScore(score);
    if (verdict !== expected.verdict) {
      verdict = expected.verdict;
      recommended_cta = expected.recommended_cta;
    }
  }

  return { ...raw, score, verdict, recommended_cta };
}

function extractText(data) {
  if (typeof data?.text === 'string' && data.text.trim()) return data.text;
  if (Array.isArray(data?.steps)) {
    for (const step of data.steps) {
      const t = step?.output || step?.result || '';
      if (typeof t === 'string' && t.includes('"score"')) return t;
    }
  }
  return '';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  if (!isOriginAllowed(req.headers.origin, req.headers.host)) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  const agentId = process.env.LUA_AGENT_ID;
  const apiKey  = process.env.LUA_API_KEY;
  if (!agentId || !apiKey) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body;
  if (!body) return res.status(400).json({ error: 'Invalid JSON body' });

  const { jdText, volume, taskFreq, stakes, exposure } = body;
  if (!jdText || typeof jdText !== 'string') {
    return res.status(400).json({ error: 'jdText is required' });
  }

  const contextLines = [
    volume   && `Task structure: ${volume}`,
    taskFreq && `Task frequency: ${taskFreq} volume per day`,
    stakes   && `Decision stakes: ${stakes}`,
    exposure && `Exposure type: ${exposure}`,
  ].filter(Boolean);

  const fullJd = contextLines.length
    ? `${jdText}\n\nAdditional context:\n${contextLines.join('\n')}`
    : jdText;

  // Unique channel per evaluation — no cross-call session contamination
  const channelId = `eval-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  try {
    const response = await fetch(
      `https://api.heylua.ai/chat/generate/${agentId}?channel=${encodeURIComponent(channelId)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          messages: [{ type: 'text', text: `Score this job description:\n\n${fullJd}` }],
          navigate: false,
        }),
      },
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error('[score-jd] non-OK:', response.status, errText.slice(0, 200));
      return res.status(response.status).json({ error: 'Upstream error', detail: errText.slice(0, 200) });
    }

    const data = await response.json();
    const text = extractText(data);
    if (!text) {
      console.error('[score-jd] empty text from Ada:', JSON.stringify(data).slice(0, 300));
      return res.status(500).json({ error: 'Empty response from Ada' });
    }

    const extracted = extractJsonObject(text);
    if (!extracted) {
      console.error('[score-jd] no JSON in Ada response:', text.slice(0, 300));
      return res.status(500).json({ error: 'Could not extract JSON from Ada response' });
    }

    const result = normalizeScoringResult(extracted);
    if (!result) {
      console.error('[score-jd] invalid shape:', JSON.stringify(extracted).slice(0, 300));
      return res.status(500).json({ error: 'Invalid scoring result shape' });
    }

    return res.status(200).json({ result });
  } catch (err) {
    console.error('[score-jd] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

export const config = { maxDuration: 60 };
