const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseLine, streamChat } = require('../lib/llm');
const { clientIp, RateLimiter, TtlCache, DailyBudget, cacheKey } = require('../lib/limits');
const { buildMessages, ANSWER_MAX_TOKENS } = require('../lib/answer');

process.env.ES_TRANSLATE_ENDPOINT = 'translate-ep';
process.env.ES_ANSWER_ENDPOINT = 'answer-ep';
const { createServer } = require('../server');

function sse(pieces) {
  const chunks = [
    '﻿event: message\ndata: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
    '﻿event: message\ndata: {"choices":[{"delta":{"reasoning":"thinking..."}}]}\n\n',
    ...pieces.map((p) => `﻿event: message\ndata: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`),
    'data: [DONE]\n\n',
  ];
  return (async function* gen() {
    for (const c of chunks) yield Buffer.from(c);
  })();
}

const TALK = {
  id: '2', title: 'Your Quickstart is Broken', start: '2026-11-10T14:41:00-07:00', end: '2026-11-10T15:10:00-07:00',
  day: '2026-11-10', venue: 'Hyatt Regency', floor: 'Level 4', room: 'Regency Ballroom CD', track: 'Cloud Native Novice', level: 'Beginner',
  speakers: [{ name: 'Ada' }], slides: 'https://example.org/2.pdf', deck_summary: 'Big titles, simple drawings, little code.',
  deck: { has_live_demo: false, has_experience_story: true, topology_detail: 'basic', audience: 'beginner' },
};

function fakeClient() {
  const calls = { chat: [] };
  return {
    calls,
    inference: {
      chatCompletionUnified: async (params, options) => {
        calls.chat.push({ params, options });
        return params.inference_id === 'answer-ep' ? sse(['Go to ', 'Your Quickstart is Broken (p.16).']) : sse(['quickstart beginner talk']);
      },
    },
    search: async (params) => (params.index === 'kccnc-scout-sessions'
      ? { hits: { hits: [{ _id: '2', _source: TALK }] } }
      : { hits: { hits: [{ _source: { session_id: '2', page: 16, page_type: 'concept_explanation', summary: 'Simple drawing of a cluster' } }] } }),
    mget: async () => ({ docs: [] }),
  };
}

test('parseLine keeps visible text only', () => {
  assert.equal(parseLine('﻿data: {"choices":[{"delta":{"content":"hi"}}]}'), 'hi');
  assert.equal(parseLine('data: {"choices":[{"delta":{"reasoning":"x"}}]}'), '');
  assert.equal(parseLine('data: [DONE]'), '');
  assert.equal(parseLine('event: message'), '');
  assert.equal(parseLine('data: not json'), '');
});

test('streamChat collects the answer, reports each piece, and forwards a token cap', async () => {
  let request;
  const client = { inference: { chatCompletionUnified: async (params) => { request = params; return sse(['a', 'b', 'c']); } } };
  const pieces = [];
  const text = await streamChat(client, 'ep', [], { timeoutMs: 1000, maxTokens: 23, onDelta: (d) => pieces.push(d) });
  assert.equal(text, 'abc');
  assert.deepEqual(pieces, ['a', 'b', 'c']);
  assert.equal(request.chat_completion_request.max_completion_tokens, 23);
});

test('clientIp takes the first X-Forwarded-For address', () => {
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }, socket: { remoteAddress: '10.0.0.1' } }), '203.0.113.7');
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '10.0.0.9' } }), '10.0.0.9');
});

test('RateLimiter allows `limit` calls per window, then says when to retry', () => {
  let t = 0;
  const limiter = new RateLimiter({ limit: 2, windowMs: 60_000, now: () => t });
  assert.equal(limiter.take('a').allowed, true);
  assert.equal(limiter.take('a').allowed, true);
  t = 15_000;
  assert.deepEqual(limiter.take('a'), { allowed: false, retryAfterSeconds: 45 });
  assert.equal(limiter.take('b').allowed, true);
  t = 60_000;
  assert.equal(limiter.take('a').allowed, true);
});

test('TtlCache expires entries and keeps at most maxEntries', () => {
  let t = 0;
  const cache = new TtlCache({ ttlMs: 1000, maxEntries: 2, now: () => t });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('c'), 3);
  t = 1000;
  assert.equal(cache.get('c'), undefined);
});

test('DailyBudget resets at midnight venue time (UTC-7)', () => {
  let t = Date.parse('2026-11-10T23:59:00-07:00');
  const budget = new DailyBudget({ limit: 1, now: () => t });
  assert.equal(budget.take(), true);
  assert.equal(budget.take(), false);
  assert.equal(budget.remaining(), 0);
  t = Date.parse('2026-11-11T00:01:00-07:00');
  assert.equal(budget.remaining(), 1);
  assert.equal(budget.take(), true);
});

test('cacheKey groups the same question within a 5-minute slot', () => {
  const at = Date.parse('2026-11-10T14:20:00-07:00');
  assert.equal(cacheKey('Hello', at), cacheKey('hello', at + 60_000));
  assert.notEqual(cacheKey('hello', at), cacheKey('hello', at + 300_000));
});

test('the prompt lists talks in venue time with their slide evidence', () => {
  const card = {
    ...TALK, speakers: ['Ada'], deckSummary: TALK.deck_summary, status: 'soon', startsInMinutes: 21,
    pages: [{ page: 16, type: 'concept_explanation', summary: 'Simple drawing of a cluster' }],
  };
  const noSlides = { ...card, id: '9', title: 'No deck', slides: null, deckSummary: null, deck: null, pages: [], status: 'past' };
  const [system, user] = buildMessages({ question: '초보자용 발표', at: '2026-11-10T21:20:00.000Z', now: [card], later: [], past: [noSlides] });
  assert.equal(system.role, 'system');
  assert.match(system.content, /language of the question/);
  assert.match(user.content, /Asked at: Tue 14:20 MST/);
  assert.match(user.content, /Tue 14:41-15:10 \(starts in 21 min\), Regency Ballroom CD, Level 4, Hyatt Regency/);
  assert.match(user.content, /Matching slide p\.16 \(concept_explanation\): Simple drawing/);
  assert.match(user.content, /Slides show: real-world experience, basic architecture diagrams, slides read as beginner/);
  assert.match(user.content, /LATER:\n\(none\)/);
  assert.match(user.content, /No slides uploaded\./);
});

function parseEvents(text) {
  return text.trim().split('\n\n').map((block) => {
    const event = block.match(/^event: (.+)$/m)[1];
    const data = JSON.parse(block.match(/^data: (.+)$/m)[1]);
    return { event, data };
  });
}

async function withServer(options, fn) {
  const server = createServer(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

const Q = `/api/answer?q=${encodeURIComponent('초보자용 발표 있어?')}&at=${encodeURIComponent('2026-11-10T14:20:00-07:00')}`;

test('/api/answer streams results, then the answer, and caches it', async () => {
  const client = fakeClient();
  await withServer({ searchClient: client }, async (base) => {
    const res = await fetch(base + Q);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const events = parseEvents(await res.text());
    assert.deepEqual(events.map((e) => e.event), ['results', 'delta', 'delta', 'done']);
    assert.equal(events[0].data.now[0].title, 'Your Quickstart is Broken');
    assert.equal(events[1].data.text + events[2].data.text, 'Go to Your Quickstart is Broken (p.16).');
    const answerCall = client.calls.chat.find(({ params }) => params.inference_id === 'answer-ep');
    assert.equal(answerCall.params.chat_completion_request.max_completion_tokens, ANSWER_MAX_TOKENS);
    // The cap also has to cover reasoning; 400 left real answers empty or cut.
    assert.ok(ANSWER_MAX_TOKENS >= 1000);
    assert.deepEqual(events[3].data, { cached: false });
    const llmCalls = client.calls.chat.length;

    const again = parseEvents(await (await fetch(base + Q)).text());
    assert.deepEqual(again.map((e) => e.event), ['results', 'delta', 'done']);
    assert.deepEqual(again[2].data, { cached: true });
    assert.equal(client.calls.chat.length, llmCalls);
  });
});

test('/api/answer skips the LLM answer once the daily budget is spent', async () => {
  const client = fakeClient();
  const protections = {
    searchLimit: new RateLimiter({ limit: 100, windowMs: 60_000 }),
    answerLimit: new RateLimiter({ limit: 100, windowMs: 60_000 }),
    answerBudget: new DailyBudget({ limit: 0 }),
    translateBudget: new DailyBudget({ limit: 0 }),
    answers: new TtlCache({ ttlMs: 60_000 }),
  };
  await withServer({ searchClient: client, protections }, async (base) => {
    const events = parseEvents(await (await fetch(base + Q)).text());
    assert.deepEqual(events.map((e) => e.event), ['results', 'notice', 'done']);
    assert.equal(events[0].data.searched.translated, false);
    assert.equal(client.calls.chat.length, 0);
  });
});

test('/api/answer rejects bad input before streaming and limits each IP', async () => {
  const protections = {
    searchLimit: new RateLimiter({ limit: 100, windowMs: 60_000 }),
    answerLimit: new RateLimiter({ limit: 2, windowMs: 600_000 }),
    answerBudget: new DailyBudget({ limit: 10 }),
    translateBudget: new DailyBudget({ limit: 10 }),
    answers: new TtlCache({ ttlMs: 60_000 }),
  };
  await withServer({ searchClient: fakeClient(), protections }, async (base) => {
    const bad = await fetch(base + '/api/answer');
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /ask a question/);
    await (await fetch(base + Q)).text();
    const limited = await fetch(base + Q);
    assert.equal(limited.status, 429);
  });
});

test('/api/answer says so when the model returns no visible text', async () => {
  const client = fakeClient();
  const original = client.inference.chatCompletionUnified;
  client.inference.chatCompletionUnified = async (params, options) => (params.inference_id === 'answer-ep' ? sse([]) : original(params, options));
  await withServer({ searchClient: client }, async (base) => {
    const events = parseEvents(await (await fetch(base + Q.replace('at=', 'x=1&at='))).text());
    assert.deepEqual(events.map((e) => e.event), ['results', 'notice', 'done']);
    assert.match(events[1].data.message, /Couldn't write an answer/);
  });
});
