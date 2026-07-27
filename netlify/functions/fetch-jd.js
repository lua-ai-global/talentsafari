// Fetch a job posting URL server-side (browser CORS) → return plain text.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let url;
  try { ({ url } = JSON.parse(event.body || '{}')); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  if (!url || !/^https?:\/\//i.test(url)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Valid URL required' }) };
  }

  // SSRF guard — block RFC1918, loopback, link-local, metadata
  try { assertSafeUrl(url); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'URL not allowed' }) }; }

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TalentSafariBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml,*/*',
      },
      redirect: 'follow',
    });

    if (!res.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: `Upstream ${res.status}` }) };
    }

    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, ' ')
      .replace(/\s{3,}/g, '\n\n')
      .trim();

    const trimmed = text.length > 8000 ? text.slice(0, 8000) + '\n[truncated]' : text;
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: trimmed }),
    };
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};

const BLOCKED = [
  /^localhost$/i, /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
  /^169\.254\./, /^::1$/, /^fc00:/i, /^fe80:/i, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

function assertSafeUrl(raw) {
  const p = new URL(raw);
  if (p.protocol !== 'https:') throw new Error('https only');
  const h = p.hostname.toLowerCase();
  for (const pat of BLOCKED) if (pat.test(h)) throw new Error('blocked');
}
