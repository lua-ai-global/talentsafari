// Proxy for frontend Slack pings — keeps webhook URL server-side
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const webhookUrl = process.env.SLACK_LEADS_WEBHOOK_URL;

  if (!webhookUrl) {
    return { statusCode: 200, body: '' }; // non-fatal if not configured
  }

  try {
    const payload = JSON.parse(event.body);

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    return { statusCode: response.ok ? 200 : response.status, body: '' };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
