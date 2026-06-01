// Aggregates a Lua `/chat/stream/:agentId` SSE response into the SAME
// `{ text, steps: [{ toolResults }] }` shape that `/chat/generate` returns —
// so every existing caller of the /api/lua-chat proxy keeps working unchanged.
//
// Why we stream instead of calling /generate: a synchronous /generate call holds
// the connection open with zero bytes until the (sometimes >60s) agent run finishes,
// which trips an upstream ~60s gateway timeout and returns an HTML error page.
// /stream emits events continuously (heartbeats, text-deltas, tool events), keeping
// the connection alive, so the run completes (~45-50s observed) without timing out.
//
// Observed stream event shapes (newline-delimited JSON, occasionally `data:`-prefixed):
//   { "type": "text-delta", "textDelta": "..." }                      -> agent reply text
//   { "type": "tool-result", "toolResult": "<stringified JSON>" }     -> tool output
//        where JSON.parse(toolResult) = { args, toolCallId, toolName, result }
//   { "type": "tool" | "system" | "heartbeat", ... }                  -> ignored here
//
// The frontend reads result.steps[].toolResults[].{toolName,result} and data.text,
// so we emit exactly those.

export function makeStreamAggregator() {
  let buffer = '';
  let text = '';
  const toolResults = [];

  function handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    const payload = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
    if (!payload || payload === '[DONE]') return;

    let evt;
    try { evt = JSON.parse(payload); } catch { return; }

    if (evt.type === 'text-delta') {
      text += evt.textDelta ?? evt.delta ?? '';
      return;
    }

    if (evt.type === 'tool-result' && typeof evt.toolResult === 'string') {
      try {
        const tr = JSON.parse(evt.toolResult);
        toolResults.push({
          toolName: tr.toolName,
          result: tr.result,
          args: tr.args,
          toolCallId: tr.toolCallId,
        });
      } catch { /* skip malformed tool-result payload */ }
    }
  }

  return {
    /** Feed a decoded text chunk; splits on newlines and processes complete lines. */
    push(textChunk) {
      buffer += textChunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        handleLine(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
    },
    /** Flush any trailing partial line and return the aggregated response object. */
    finish() {
      if (buffer.trim()) handleLine(buffer);
      buffer = '';
      return { text, steps: [{ toolResults }] };
    },
  };
}

/**
 * Consume a whole `fetch` Response body (web ReadableStream) and return the
 * aggregated `{ text, steps: [{ toolResults }] }` object. Uses getReader() for
 * broad runtime compatibility (Node/undici on Vercel + local dev server).
 */
export async function aggregateStreamResponse(response) {
  if (!response.body) throw new Error('stream response has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const agg = makeStreamAggregator();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    agg.push(decoder.decode(value, { stream: true }));
  }
  return agg.finish();
}
