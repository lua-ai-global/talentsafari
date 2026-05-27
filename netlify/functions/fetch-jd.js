// Fetch a job posting URL server-side (browser can't due to CORS) and return plain text.
// No AI involved — fast, well within Netlify's 10s default timeout.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let url;
  try {
    ({ url } = JSON.parse(event.body || '{}'));
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  if (!url || !/^https?:\/\//i.test(url)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Valid URL required' }) };
  }

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

    // Strip HTML tags, scripts, styles → plain text
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, ' ')
      .replace(/\s{3,}/g, '\n\n')
      .trim();

    // Cap at ~8000 chars — LLM doesn't need the whole page
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
