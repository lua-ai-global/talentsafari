// Proxy for all Lua agent API calls — keeps API key server-side.
// Client passes { channel, messages, ... }; channel is extracted and used in the URL.
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const agentId = process.env.LUA_AGENT_ID;
  const apiKey  = process.env.LUA_API_KEY;

  if (!agentId || !apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error' }) };
  }

  try {
    const body = JSON.parse(event.body);

    // Extract channel from body — client generates unique IDs for session isolation
    const { channel, ...forwardBody } = body;
    const safeChannel = typeof channel === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(channel)
      ? channel
      : 'production';

    const response = await fetch(
      `https://api.heylua.ai/chat/generate/${agentId}?channel=${safeChannel}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(forwardBody),
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
