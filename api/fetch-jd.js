// Fetch a job posting URL server-side (CORS workaround) and return plain text.
// Includes SSRF protection: blocks loopback, private IP ranges, and AWS metadata.

import { isOriginAllowed } from './_lib/origin.js';
import { checkRateLimit, pickStricter, send429 } from './_lib/rate-limit.js';

function isSafeUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return false;

  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host === '0.0.0.0' || host.endsWith('.localhost')) return false;
  if (/^127\./.test(host)) return false;                          // loopback
  if (/^10\./.test(host)) return false;                           // RFC1918
  if (/^192\.168\./.test(host)) return false;                     // RFC1918
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;      // RFC1918
  if (/^169\.254\./.test(host)) return false;                     // link-local / AWS metadata
  if (host === '::1' || host === '[::1]') return false;           // IPv6 loopback
  if (/^fe80:/i.test(host)) return false;                         // IPv6 link-local
  if (/^fc00:|^fd00:/i.test(host)) return false;                  // IPv6 unique local
  return true;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  if (!isOriginAllowed(req.headers.origin, req.headers.host)) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  const [rlMin, rlHr] = await Promise.all([
    checkRateLimit(req, { route: 'fetch-jd', limit: 5,  windowSeconds: 60 }),
    checkRateLimit(req, { route: 'fetch-jd', limit: 30, windowSeconds: 3600 }),
  ]);
  const rl = pickStricter(rlMin, rlHr);
  if (!rl.allowed) return send429(res, { route: 'fetch-jd', result: rl });

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body;
  if (!body) return res.status(400).json({ error: 'Invalid JSON body' });

  const { url } = body;
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'Valid URL required' });
  if (!isSafeUrl(url)) return res.status(400).json({ error: 'URL blocked (must be public https/http)' });

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TalentSafariBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml,*/*',
      },
      redirect: 'follow',
    });

    if (!response.ok) {
      return res.status(502).json({ error: `Upstream ${response.status}` });
    }

    const html = await response.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, ' ')
      .replace(/\s{3,}/g, '\n\n')
      .trim();

    const trimmed = text.length > 8000 ? text.slice(0, 8000) + '\n[truncated]' : text;
    return res.status(200).json({ text: trimmed });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
