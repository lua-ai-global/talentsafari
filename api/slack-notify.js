// Proxy for frontend Slack pings — keeps webhook URL server-side.

import { isOriginAllowed } from './_lib/origin.js';
import { checkRateLimit, pickStricter, send429 } from './_lib/rate-limit.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  if (!isOriginAllowed(req.headers.origin, req.headers.host)) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  const [rlMin, rlHr] = await Promise.all([
    checkRateLimit(req, { route: 'slack-notify', limit: 10, windowSeconds: 60 }),
    checkRateLimit(req, { route: 'slack-notify', limit: 60, windowSeconds: 3600 }),
  ]);
  const rl = pickStricter(rlMin, rlHr);
  if (!rl.allowed) return send429(res, { route: 'slack-notify', result: rl });

  const webhookUrl = process.env.SLACK_LEADS_WEBHOOK_URL;
  if (!webhookUrl) {
    return res.status(200).send(''); // non-fatal if not configured
  }

  const payload = typeof req.body === 'string' ? safeParse(req.body) : req.body;
  if (!payload) return res.status(400).json({ error: 'Invalid JSON body' });

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.status(response.ok ? 200 : response.status).send('');
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
