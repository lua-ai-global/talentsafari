// JD scoring via Ada's chat API.
// Ada's persona has the full scoring rubric; she outputs JSON directly.
// Single LLM call fits within Netlify's 26s timeout for the free tier.

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

  const { jdText, volume, taskFreq, stakes, exposure } = body;
  if (!jdText) {
    return { statusCode: 400, body: JSON.stringify({ error: 'jdText is required' }) };
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

  const channelId = `eval-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  try {
    const response = await fetch(
      `https://api.heylua.ai/chat/generate/${agentId}?channel=${encodeURIComponent(channelId)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          messages: [{ type: 'text', text: `Score this job description:\n\n${fullJd}` }],
          navigate: false,
        }),
      },
    );

    const data = await response.json();
    console.log('[score-jd] status:', response.status, 'channel:', channelId);

    if (!response.ok) {
      return { statusCode: response.status, body: JSON.stringify({ error: data }) };
    }

    const rawText = extractText(data);
    const jsonMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/) || rawText.match(/(\{[\s\S]*\})/);
    if (!jsonMatch) {
      console.error('[score-jd] no JSON:', rawText.slice(0, 300));
      return { statusCode: 500, body: JSON.stringify({ error: 'No JSON in Ada response', raw: rawText.slice(0, 300) }) };
    }

    let result;
    try { result = JSON.parse(jsonMatch[1].trim()); }
    catch (e) {
      return { statusCode: 500, body: JSON.stringify({ error: 'JSON parse failed', raw: jsonMatch[1].slice(0, 300) }) };
    }

    if (!result.role_title || !Array.isArray(result.dimensions) || result.dimensions.length !== 7) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Invalid result shape', raw: result }) };
    }

    const computed = Math.round(result.dimensions.reduce((s, d) => s + d.score * d.weight, 0));
    if (Math.abs(computed - result.score) > 1) {
      result.score = computed;
      result.verdict = computed < 40 ? 'needs_human' : computed < 65 ? 'human_led_agent_assist' : 'strong_agent';
      result.recommended_cta = computed >= 65 ? 'lua' : 'tech_safari';
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ result }),
    };
  } catch (err) {
    console.error('[score-jd] error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

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
