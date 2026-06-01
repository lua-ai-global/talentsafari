// Proxy for Ada chat calls (scoring + enrichment + capture_lead + submit_cta).
// Forwards the ?channel= query param so the frontend's per-call session pattern
// (eval-<uuid>, enrich-<uuid>, lead-<uuid>, cta-<uuid>) reaches Lua intact.
// Keeps LUA_API_KEY in process.env, never on the wire to the browser.
//
// PRIMARY PATH: /chat/stream (SSE). A synchronous /chat/generate call holds the
// connection open with no bytes until the agent run finishes; long runs (>60s)
// trip an upstream gateway timeout that returns an HTML error page, which the
// browser then fails to JSON.parse. Streaming emits events continuously, so the
// connection stays alive and the run completes (~45-50s). We aggregate the stream
// server-side back into the exact { text, steps:[{toolResults}] } shape /generate
// returned — so the frontend is unchanged.
//
// FALLBACK PATH: if the stream endpoint can't be reached (non-2xx / throws before
// data), we fall back to the original /chat/generate call. This guarantees the
// proxy is never worse than before this change.

import { isOriginAllowed } from './_lib/origin.js';
import { checkRateLimit, pickStricter, send429 } from './_lib/rate-limit.js';
import { aggregateStreamResponse } from './_lib/stream-aggregate.js';

const UPSTREAM = 'https://api.heylua.ai';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  if (!isOriginAllowed(req.headers.origin, req.headers.host)) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  const [rlMin, rlHr] = await Promise.all([
    checkRateLimit(req, { route: 'lua-chat', limit: 10, windowSeconds: 60 }),
    checkRateLimit(req, { route: 'lua-chat', limit: 60, windowSeconds: 3600 }),
  ]);
  const rl = pickStricter(rlMin, rlHr);
  if (!rl.allowed) return send429(res, { route: 'lua-chat', result: rl });

  const agentId = process.env.LUA_AGENT_ID;
  const apiKey  = process.env.LUA_API_KEY;
  if (!agentId || !apiKey) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body;
  if (!body) return res.status(400).json({ error: 'Invalid JSON body' });

  // Sanity-limit so a client can't smuggle path traversal or huge headers via the channel.
  const rawChannel = (req.query?.channel || 'production').toString();
  const safeChannel = rawChannel.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'production';
  const channelQs = `?channel=${encodeURIComponent(safeChannel)}`;

  const authHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
  const payload = JSON.stringify(body);

  const controller = new AbortController();
  const fetchTimeout = setTimeout(() => controller.abort(), 115_000);

  try {
    // ── Primary: streaming, aggregated server-side ──────────────────────────
    try {
      const streamRes = await fetch(`${UPSTREAM}/chat/stream/${agentId}${channelQs}`, {
        method: 'POST',
        headers: { ...authHeaders, Accept: 'text/event-stream' },
        body: payload,
        signal: controller.signal,
      });

      if (streamRes.ok && streamRes.body) {
        const data = await aggregateStreamResponse(streamRes);
        clearTimeout(fetchTimeout);
        return res.status(200).json(data);
      }
      // Non-2xx from the stream endpoint → fall through to /generate.
    } catch (streamErr) {
      // Abort means we're out of time — don't burn the rest on a fallback.
      if (streamErr?.name === 'AbortError') throw streamErr;
      // Otherwise fall through to the non-streaming path.
    }

    // ── Fallback: original non-streaming /generate ──────────────────────────
    const genRes = await fetch(`${UPSTREAM}/chat/generate/${agentId}${channelQs}`, {
      method: 'POST',
      headers: authHeaders,
      body: payload,
      signal: controller.signal,
    });
    const data = await genRes.json();
    clearTimeout(fetchTimeout);
    return res.status(genRes.status).json(data);
  } catch (err) {
    clearTimeout(fetchTimeout);
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'scoring_timeout', detail: 'Evaluation took too long. Please try again.' });
    }
    return res.status(500).json({ error: err.message });
  }
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

export const config = { maxDuration: 120 };
