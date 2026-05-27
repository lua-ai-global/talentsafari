// Proxy for Ada chat calls. Channel comes from the query string (?channel=...)
// to match the frontend's adaSessionUrl() pattern and the Vercel api/lua-chat.js contract.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const agentId = process.env.LUA_AGENT_ID;
  const apiKey  = process.env.LUA_API_KEY;
  if (!agentId || !apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const rawChannel = (event.queryStringParameters?.channel || 'production').toString();
  const safeChannel = rawChannel.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'production';

  try {
    const response = await fetch(
      `https://api.heylua.ai/chat/generate/${agentId}?channel=${encodeURIComponent(safeChannel)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      },
    );

    const data = await response.json();
    return {
      statusCode: response.status,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
