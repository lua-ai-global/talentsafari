// Proxy for Ada chat calls (enrichment + capture_lead + submit_cta).
// Forwards the ?channel= query param so the frontend's per-call session pattern
// (eval-<uuid>, enrich-<uuid>, lead-<uuid>, cta-<uuid>) reaches Lua intact.
// Keeps LUA_API_KEY in process.env, never on the wire to the browser.

import { isOriginAllowed } from './_lib/origin.js';

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

  // Sanity-limit so a client can't smuggle path traversal or huge headers via the channel.
  const rawChannel = (req.query?.channel || 'production').toString();
  const safeChannel = rawChannel.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'production';

  try {
    const response = await fetch(
      `https://api.heylua.ai/chat/generate/${agentId}?channel=${encodeURIComponent(safeChannel)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      },
    );

    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

export const config = { maxDuration: 60 };
