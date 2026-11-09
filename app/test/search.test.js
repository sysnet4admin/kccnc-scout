const { test } = require('node:test');
const assert = require('node:assert/strict');
const { search, cleanQuestion, parseAt, toEnglishQuery, fuse, timeStatus, InputError } = require('../lib/search');
const { createServer } = require('../server');

const AT = Date.parse('2026-11-10T14:20:00-07:00');

function session(id, start, end, extra = {}) {
  return { id, title: `Talk ${id}`, start, end, day: start.slice(0, 10), venue: 'Salt Palace', room: '255 BC', speakers: [{ name: 'Ada' }], slides: `https://example.org/${id}.pdf`, ...extra };
}

const LIVE = session('1', '2026-11-10T14:00:00-07:00', '2026-11-10T14:30:00-07:00');
const SOON = session('2', '2026-11-10T14:41:00-07:00', '2026-11-10T15:10:00-07:00');
const LATER = session('3', '2026-11-10T16:00:00-07:00', '2026-11-10T16:30:00-07:00');
const PAST = session('4', '2026-11-10T11:00:00-07:00', '2026-11-10T11:30:00-07:00');
const PAGE_ONLY = session('5', '2026-11-10T14:45:00-07:00', '2026-11-10T15:15:00-07:00');

// The chat endpoint streams server-sent events in the OpenAI chunk format.
function sseStream(text) {
  const pieces = text ? [text.slice(0, 5), text.slice(5)] : [];
  const lines = [
    '﻿event: message\ndata: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
    ...pieces.map((p) => `﻿event: message\ndata: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`),
    'data: [DONE]\n\n',
  ];
  return (async function* gen() {
    for (const l of lines) yield Buffer.from(l);
  })();
}

function fakeClient({ translation = 'ebpf security case study', translateError, failSearch } = {}) {
  const calls = { completion: [], search: [], mget: [] };
  return {
    calls,
    inference: {
      chatCompletionUnified: async (params, options) => {
        calls.completion.push({ params, options });
        if (translateError) throw translateError;
        return sseStream(translation);
      },
    },
    search: async (params) => {
      calls.search.push(params);
      if (failSearch) throw Object.assign(new Error('boom at https://secret.example'), { meta: { statusCode: 500 } });
      if (params.index === 'kccnc-scout-sessions') {
        return { hits: { hits: [LIVE, SOON, LATER, PAST].map((s) => ({ _id: s.id, _source: s })) } };
      }
      return {
        hits: {
          hits: [
            { _source: { session_id: '2', page: 7, page_type: 'architecture_diagram', summary: 'Data path' } },
            { _source: { session_id: '5', page: 3, page_type: 'demo_marker', summary: 'Live demo' } },
            { _source: { session_id: '2', page: 9, page_type: 'code_or_config', summary: 'Policy' } },
            { _source: { session_id: '2', page: 12, page_type: 'title', summary: 'Third page, dropped' } },
          ],
        },
      };
    },
    mget: async (params) => {
      calls.mget.push(params);
      return { docs: params.ids.map((id) => (id === '5' ? { _id: id, found: true, _source: PAGE_ONLY } : { _id: id, found: false })) };
    },
  };
}

test('questions are trimmed, required and length-limited', () => {
  assert.equal(cleanQuestion('  what   about eBPF? '), 'what about eBPF?');
  assert.throws(() => cleanQuestion(''), InputError);
  assert.throws(() => cleanQuestion(null), InputError);
  assert.throws(() => cleanQuestion('x'.repeat(301)), InputError);
});

test('"at" must carry an offset; without it the current time is used', () => {
  assert.equal(parseAt('2026-11-10T14:20:00-07:00'), AT);
  assert.equal(parseAt('2026-11-10T21:20:00Z'), AT);
  assert.equal(parseAt(undefined, 123), 123);
  assert.throws(() => parseAt('2026-11-10T14:20:00'), InputError);
  assert.throws(() => parseAt('tomorrow'), InputError);
});

test('plain English questions skip the LLM', async () => {
  const client = fakeClient();
  assert.deepEqual(await toEnglishQuery(client, 'ep', 'eBPF security talks'), { english: 'eBPF security talks', translated: false });
  assert.equal(client.calls.completion.length, 0);
});

test('other languages are rewritten in English with a short timeout and no retries', async () => {
  const client = fakeClient({ translation: '"ebpf security\ncase study"' });
  let llmCalls = 0;
  const out = await toEnglishQuery(client, 'ep', 'eBPF 보안 사례 발표', { onCall: () => { llmCalls++; } });
  assert.deepEqual(out, { english: 'ebpf security case study', translated: true });
  assert.equal(llmCalls, 1);
  const [call] = client.calls.completion;
  assert.equal(call.params.inference_id, 'ep');
  assert.match(call.params.chat_completion_request.messages[0].content, /eBPF 보안 사례 발표/);
  assert.equal(call.params.chat_completion_request.max_completion_tokens, 60);
  assert.equal(call.options.asStream, true);
  assert.equal(call.options.maxRetries, 0);
  assert.equal(call.options.requestTimeout, 3000);
  assert.ok(call.options.signal);
});

test('a failed or empty rewrite falls back to the original words', async () => {
  assert.deepEqual(await toEnglishQuery(fakeClient({ translateError: new Error('timeout') }), 'ep', '보안'), { english: '보안', translated: false });
  assert.deepEqual(await toEnglishQuery(fakeClient({ translation: '  ' }), 'ep', '보안'), { english: '보안', translated: false });
});

test('fusion ranks a talk found by both lists first and keeps two pages per talk', () => {
  const sessionHits = [{ _id: '1' }, { _id: '2' }];
  const pageHits = [
    { _source: { session_id: '2', page: 7 } },
    { _source: { session_id: '5', page: 3 } },
    { _source: { session_id: '2', page: 9 } },
    { _source: { session_id: '2', page: 12 } },
  ];
  const { ranked, pagesBySession } = fuse(sessionHits, pageHits);
  assert.deepEqual(ranked.map((r) => r.id), ['2', '1', '5']);
  assert.deepEqual(pagesBySession.get('2').map((p) => p.page), [7, 9]);
});

test('time status compares instants, so it holds in any time zone', () => {
  assert.equal(timeStatus(LIVE, AT), 'live');
  assert.equal(timeStatus(SOON, AT), 'soon');
  assert.equal(timeStatus(LATER, AT), 'later');
  assert.equal(timeStatus(PAST, AT), 'past');
  // A talk that ends exactly now is over.
  assert.equal(timeStatus(session('9', '2026-11-10T13:50:00-07:00', '2026-11-10T14:20:00-07:00'), AT), 'past');
});

test('search groups talks by time and links the matching slide pages', async () => {
  const client = fakeClient();
  const out = await search(client, { question: 'eBPF 보안 사례', at: '2026-11-10T14:20:00-07:00', translateEndpoint: 'ep' });

  assert.equal(out.searched.english, 'ebpf security case study');
  assert.equal(out.at, '2026-11-10T21:20:00.000Z');
  assert.deepEqual(out.now.map((c) => [c.id, c.status]), [['2', 'soon'], ['1', 'live'], ['5', 'soon']]);
  assert.deepEqual(out.later.map((c) => c.id), ['3']);
  assert.deepEqual(out.past.map((c) => c.id), ['4']);

  const soon = out.now[0];
  assert.equal(soon.startsInMinutes, 21);
  assert.deepEqual(soon.pages.map((p) => p.link), ['https://example.org/2.pdf#page=7', 'https://example.org/2.pdf#page=9']);
  assert.equal(out.now[1].minutesLeft, 10);

  // The page-only talk was fetched by id; both searches filter out non-talk tracks.
  assert.deepEqual(client.calls.mget[0].ids, ['5']);
  for (const call of client.calls.search) {
    assert.ok(JSON.stringify(call.retriever).includes('"Registration"'));
  }
});

async function get(server, path) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.json() };
}

async function withServer(searchClient, fn) {
  const server = createServer({ searchClient });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(server);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('GET /api/search answers 200 with grouped results', async () => {
  await withServer(fakeClient(), async (server) => {
    const { status, body } = await get(server, `/api/search?q=${encodeURIComponent('eBPF security')}&at=${encodeURIComponent('2026-11-10T14:20:00-07:00')}`);
    assert.equal(status, 200);
    assert.equal(body.searched.translated, false);
    assert.ok(body.now.length > 0);
  });
});

test('GET /api/search rejects bad input with 400', async () => {
  await withServer(fakeClient(), async (server) => {
    assert.equal((await get(server, '/api/search')).status, 400);
    assert.equal((await get(server, '/api/search?q=hi&at=2026-11-10T14:20:00')).status, 400);
  });
});

test('GET /api/search hides internal errors behind a 502', async () => {
  await withServer(fakeClient({ failSearch: true }), async (server) => {
    const { status, body } = await get(server, '/api/search?q=hi');
    assert.equal(status, 502);
    assert.doesNotMatch(JSON.stringify(body), /secret\.example|boom/);
  });
});

test('GET /api/search answers 503 when Elasticsearch is not configured', async () => {
  await withServer(null, async (server) => {
    assert.equal((await get(server, '/api/search?q=hi')).status, 503);
  });
});
