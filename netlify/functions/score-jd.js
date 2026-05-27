// JD scoring via Ada's chat API endpoint.
// Ada's persona contains the full scoring rubric and outputs JSON directly.
// Single LLM call (~8-15s) fits within Netlify's 26s timeout.
// Each call uses a unique channel — no session contamination from prior calls.

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
    const { jdText, volume, taskFreq, stakes, exposure } = JSON.parse(event.body || '{}');
    if (!jdText) {
      return { statusCode: 400, body: JSON.stringify({ error: 'jdText is required' }) };
    }

    const contextLines = [
      volume    && `Task structure: ${volume}`,
      taskFreq  && `Task frequency: ${taskFreq} volume per day`,
      stakes    && `Decision stakes: ${stakes}`,
      exposure  && `Exposure type: ${exposure}`,
    ].filter(Boolean);

    const fullJd = contextLines.length
      ? `${jdText}\n\nAdditional context:\n${contextLines.join('\n')}`
      : jdText;

    // Unique channel per evaluation prevents cross-call session contamination
    const channelId = `eval-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    const response = await fetch(
      `https://api.heylua.ai/chat/generate/${agentId}?channel=${channelId}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
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

    // Chat API: Ada's JSON reply is in data.text (direct response, no tool call)
    const rawText = extractText(data);
    console.log('[score-jd] text preview:', rawText.slice(0, 120));

    // Extract JSON — Ada should return raw JSON but handle fences as fallback
    const jsonMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/) || rawText.match(/(\{[\s\S]*\})/);
    if (!jsonMatch) {
      console.error('[score-jd] no JSON in response:', rawText.slice(0, 300));
      return { statusCode: 500, body: JSON.stringify({ error: 'No JSON in response', raw: rawText.slice(0, 300) }) };
    }

    let result;
    try {
      result = JSON.parse(jsonMatch[1].trim());
    } catch (parseErr) {
      console.error('[score-jd] JSON parse error:', parseErr.message);
      return { statusCode: 500, body: JSON.stringify({ error: 'JSON parse failed', raw: jsonMatch[1].slice(0, 300) }) };
    }

    if (!result.role_title || !Array.isArray(result.dimensions) || result.dimensions.length !== 7) {
      console.error('[score-jd] invalid result shape:', JSON.stringify(result).slice(0, 300));
      return { statusCode: 500, body: JSON.stringify({ error: 'Invalid result shape', raw: result }) };
    }

    // Self-correct weighted sum
    const computed = Math.round(result.dimensions.reduce((s, d) => s + d.score * d.weight, 0));
    if (Math.abs(computed - result.score) > 1) result.score = computed;

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
  // Direct text field (Ada's chat response when no tool is called)
  if (typeof data?.text === 'string' && data.text.trim()) return data.text;
  // Walk steps — Ada may emit text via a step output
  if (Array.isArray(data?.steps)) {
    for (const step of data.steps) {
      const t = step?.output || step?.result || '';
      if (typeof t === 'string' && t.includes('"score"')) return t;
    }
  }
  return '';
}
