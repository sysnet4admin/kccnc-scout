// kccnc-scout: the phone UI at /, the search and answer APIs, and the
// starter's probes and /api/sessions (kept for its version field). Keep
// listening on $PORT and keep /healthz and /readyz so deploy/ keeps working.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const log = require('./lib/log');
const { routeFor, nameRoute, shutdownTelemetry } = require('./lib/telemetry');
const { getClient } = require('./lib/es');
const { search, parseAt, parseZone, cleanQuestion, InputError } = require('./lib/search');
const { writeAnswer } = require('./lib/answer');
const { clientIp, RateLimiter, TtlCache, DailyBudget, cacheKey } = require('./lib/limits');
const { zones } = require('./lib/walk');

const envInt = (name, fallback) => {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const port = Number(process.env.PORT || 8080);
const version = process.env.APP_VERSION || 'dev';

// The phone UI: one static page that calls /api/answer. The footer shows the
// running version, which the deploy checks read; the zone picker lists the
// venue zones from data/venue.json (fixed labels, no user input).
const zoneOptions = zones.map((z) => `<option value="${z.id}">${z.label}</option>`).join('\n      ');
const homePage = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8')
  .replace('__VERSION__', version)
  .replace('__ZONE_OPTIONS__', zoneOptions);

const sessions = [
  { id: 1, time: '10:00', room: 'Main', title: 'Kickoff and sponsor talks' },
  { id: 2, time: '11:00', room: 'Everywhere', title: 'Build' },
  { id: 3, time: '14:00', room: 'Main', title: 'Panel' },
  { id: 4, time: '17:30', room: 'Main', title: 'Submissions close' },
];

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function tooMany(res, retryAfterSeconds) {
  res.writeHead(429, { 'content-type': 'application/json; charset=utf-8', 'retry-after': String(retryAfterSeconds) });
  res.end(JSON.stringify({ error: 'too many requests, try again in a moment' }));
}

const errorInfo = (err) => ({ name: err.name, status: err.meta?.statusCode, type: err.meta?.body?.error?.type });

// Public URL protections, one set per server (per pod). See lib/limits.js.
function createProtections() {
  return {
    searchLimit: new RateLimiter({ limit: envInt('SEARCH_LIMIT_PER_MINUTE', 20), windowMs: 60_000 }),
    answerLimit: new RateLimiter({ limit: envInt('ANSWER_LIMIT_PER_10_MINUTES', 10), windowMs: 600_000 }),
    answerBudget: new DailyBudget({ limit: envInt('DAILY_ANSWER_BUDGET', 125) }),
    translateBudget: new DailyBudget({ limit: envInt('DAILY_TRANSLATE_BUDGET', 1500) }),
    answers: new TtlCache({ ttlMs: 600_000, maxEntries: 500 }),
  };
}

// The question rewrite costs an LLM call, so it stops when today's budget is spent.
function searchOptions(url, p) {
  return {
    question: url.searchParams.get('q'),
    at: url.searchParams.get('at'),
    zone: url.searchParams.get('zone'),
    translateEndpoint: p.translateBudget.remaining() > 0 ? process.env.ES_TRANSLATE_ENDPOINT : undefined,
    onLlmCall: () => p.translateBudget.take(),
  };
}

// GET /api/search?q=<question>[&at=<ISO time with offset>]
async function handleSearch(res, url, client, p) {
  if (!client) return sendJson(res, 503, { error: 'search is not configured' });
  try {
    const result = await search(client, searchOptions(url, p));
    log.info({ translated: result.searched.translated, ...result.timings, now: result.now.length, later: result.later.length }, 'search');
    return sendJson(res, 200, result);
  } catch (err) {
    if (err instanceof InputError) return sendJson(res, 400, { error: err.message });
    log.error({ err: errorInfo(err) }, 'search failed');
    return sendJson(res, 502, { error: 'search is unavailable right now, try again in a moment' });
  }
}

// GET /api/answer?q=<question>[&at=<ISO time with offset>]
// Server-sent events: `results` (the same JSON as /api/search), then `delta`
// events with pieces of the written answer, then `done`. `notice` says when
// the answer was skipped (daily budget spent) and `error` when something failed.
async function handleAnswer(req, res, url, client, p) {
  if (!client) return sendJson(res, 503, { error: 'search is not configured' });
  let key;
  try {
    key = cacheKey(cleanQuestion(url.searchParams.get('q')), parseAt(url.searchParams.get('at')), parseZone(url.searchParams.get('zone')));
  } catch (err) {
    if (err instanceof InputError) return sendJson(res, 400, { error: err.message });
    throw err;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'x-accel-buffering': 'no',
  });
  const send = (event, data) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const gone = new AbortController();
  res.on('close', () => gone.abort());

  const cached = p.answers.get(key);
  if (cached) {
    send('results', cached.result);
    if (cached.answer) send('delta', { text: cached.answer });
    send('done', { cached: true });
    return res.end();
  }

  try {
    const result = await search(client, searchOptions(url, p));
    send('results', result);

    let answer = '';
    const endpoint = process.env.ES_ANSWER_ENDPOINT;
    const hasTalks = result.now.length + result.later.length + result.past.length > 0;
    if (endpoint && hasTalks && p.answerBudget.take()) {
      const t = Date.now();
      answer = await writeAnswer(client, endpoint, result, { onDelta: (text) => send('delta', { text }), signal: gone.signal });
      log.info({ answerMs: Date.now() - t, chars: answer.length, ...result.timings }, 'answer');
      // A stream can end with no visible text (for example when the token cap
      // is spent on reasoning). Say so instead of leaving the box empty.
      if (!answer.trim()) send('notice', { message: "Couldn't write an answer this time; the talks below come straight from search." });
    } else if (endpoint && hasTalks) {
      send('notice', { message: "Today's AI answer budget is used up; the talks below come straight from search." });
    }
    if (answer) p.answers.set(key, { result, answer });
    send('done', { cached: false });
  } catch (err) {
    if (!gone.signal.aborted) {
      log.error({ err: errorInfo(err) }, 'answer failed');
      send('error', { message: 'something went wrong, try again in a moment' });
    }
  }
  return res.end();
}

function handle(req, res, client, p) {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain' });
    return res.end('bad request\n');
  }
  nameRoute(routeFor(url.pathname));
  if (url.pathname === '/healthz' || url.pathname === '/readyz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok\n');
  }
  if (url.pathname === '/api/sessions') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ version, sessions }));
  }
  if (url.pathname === '/api/search' && req.method === 'GET') {
    const gate = p.searchLimit.take(clientIp(req));
    if (!gate.allowed) return tooMany(res, gate.retryAfterSeconds);
    return handleSearch(res, url, client, p);
  }
  if (url.pathname === '/api/answer' && req.method === 'GET') {
    const gate = p.answerLimit.take(clientIp(req));
    if (!gate.allowed) return tooMany(res, gate.retryAfterSeconds);
    return handleAnswer(req, res, url, client, p).catch((err) => {
      log.error({ err: errorInfo(err) }, 'answer handler failed');
      if (!res.headersSent) sendJson(res, 500, { error: 'something went wrong' });
      else res.end();
    });
  }
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(homePage);
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found\n');
}

// searchClient: an Elasticsearch client, or a stand-in in tests. Defaults to
// the client built from ES_URL and ES_API_KEY (null when they are unset).
function createServer({ searchClient = getClient(), protections = createProtections() } = {}) {
  return http.createServer((req, res) => handle(req, res, searchClient, protections));
}

// Listen only when run as the app (`node server.js`), so tests can start
// their own server on a free port.
if (require.main === module) {
  const server = createServer();
  server.listen(port, () => log.info({ port, version }, 'listening'));

  // Exit cleanly when Kubernetes stops the pod, so rollouts don't drop requests,
  // and flush telemetry so the last spans and logs reach Dash0.
  process.on('SIGTERM', () => {
    log.info('SIGTERM received, shutting down');
    server.close(() => shutdownTelemetry().finally(() => process.exit(0)));
  });
}

module.exports = { createServer };
