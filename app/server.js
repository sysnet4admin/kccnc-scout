// A tiny conference schedule service. Replace it with your own app: keep
// listening on $PORT and keep /healthz and /readyz, and the manifests in
// deploy/ keep working.
const http = require('node:http');
const log = require('./lib/log');
const { routeFor, nameRoute, shutdownTelemetry } = require('./lib/telemetry');
const { getClient } = require('./lib/es');
const { search, InputError } = require('./lib/search');

const port = Number(process.env.PORT || 8080);
const team = process.env.TEAM_NAME || 'your-team';
const version = process.env.APP_VERSION || 'dev';

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

const hits = new Map();
function allow(ip, limit = 20, windowMs = 60_000) {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now - entry.t > windowMs) {
    hits.set(ip, { t: now, n: 1 });
    return true;
  }
  return ++entry.n <= limit;
}

// GET /api/search?q=<question>[&at=<ISO time with offset>]
async function handleSearch(res, url, client) {
  if (!client) return sendJson(res, 503, { error: 'search is not configured' });
  try {
    const result = await search(client, {
      question: url.searchParams.get('q'),
      at: url.searchParams.get('at'),
      translateEndpoint: process.env.ES_TRANSLATE_ENDPOINT,
    });
    log.info({ translated: result.searched.translated, ...result.timings, now: result.now.length, later: result.later.length }, 'search');
    return sendJson(res, 200, result);
  } catch (err) {
    if (err instanceof InputError) return sendJson(res, 400, { error: err.message });
    log.error({ err: { name: err.name, status: err.meta?.statusCode, type: err.meta?.body?.error?.type } }, 'search failed');
    return sendJson(res, 502, { error: 'search is unavailable right now, try again in a moment' });
  }
}

function handle(req, res, client) {
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
    if (!allow(req.socket.remoteAddress)) return sendJson(res, 429, { error: 'too many requests' });
    return handleSearch(res, url, client);
  }
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    const rows = sessions.map((s) => `<li>${s.time} · ${s.room} · ${s.title}</li>`).join('');
    return res.end(`<!doctype html><title>${team}</title><h1>${team}</h1><p>version ${version}</p><ul>${rows}</ul>`);
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found\n');
}

// searchClient: an Elasticsearch client, or a stand-in in tests. Defaults to
// the client built from ES_URL and ES_API_KEY (null when they are unset).
function createServer({ searchClient = getClient() } = {}) {
  return http.createServer((req, res) => handle(req, res, searchClient));
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
