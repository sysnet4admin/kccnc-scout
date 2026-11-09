// Chat completions through an Elasticsearch inference endpoint, streamed.
// The endpoint answers with server-sent events in the OpenAI chunk format;
// we keep only the visible text (choices[0].delta.content) and skip reasoning.

// Calls `onDelta(text)` for each piece of the answer and resolves with the
// whole text. `timeoutMs` bounds the entire call, not just the first byte.
// `signal` (optional) cancels the call early, for example when the browser goes away.
async function streamChat(client, endpoint, messages, { timeoutMs, onDelta, signal } = {}) {
  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const cancel = () => controller.abort();
  if (signal) {
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
  }
  try {
    const stream = await client.inference.chatCompletionUnified(
      { inference_id: endpoint, chat_completion_request: { messages } },
      { asStream: true, signal: controller.signal, maxRetries: 0, ...(timeoutMs ? { requestTimeout: timeoutMs } : {}) },
    );
    let buffer = '';
    let text = '';
    for await (const chunk of stream) {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const delta = parseLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (delta) {
          text += delta;
          if (onDelta) onDelta(delta);
        }
      }
    }
    const last = parseLine(buffer);
    if (last) {
      text += last;
      if (onDelta) onDelta(last);
    }
    return text;
  } finally {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', cancel);
  }
}

function parseLine(raw) {
  const line = raw.replace(/^﻿/, '').trim();
  if (!line.startsWith('data:')) return '';
  const data = line.slice(5).trim();
  if (!data || data === '[DONE]') return '';
  try {
    const content = JSON.parse(data).choices?.[0]?.delta?.content;
    return typeof content === 'string' ? content : '';
  } catch {
    return '';
  }
}

module.exports = { streamChat, parseLine };
