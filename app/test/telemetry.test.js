const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { routeFor, shutdownTelemetry } = require('../lib/telemetry');

const APP_DIR = path.join(__dirname, '..');

test('known paths get a route name, others do not', () => {
  assert.equal(routeFor('/api/sessions'), '/api/sessions');
  assert.equal(routeFor('/'), '/');
  assert.equal(routeFor('/api/sessions/123'), null);
  assert.equal(routeFor('/wp-login.php'), null);
});

test('shutdownTelemetry is a no-op without instrumentation.js', async () => {
  await shutdownTelemetry(100);
});

// Runs the server in a child process with instrumentation.js preloaded and the
// console span exporter, then reads the exported spans from its stdout.
// Requests go over a raw socket so no client spans are created.
const CHILD = `
const net = require('node:net');
const { createServer } = require('./server');
const { shutdownTelemetry } = require('./lib/telemetry');
function get(port, path) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => s.write('GET ' + path + ' HTTP/1.1\\r\\nHost: t\\r\\nConnection: close\\r\\n\\r\\n'));
    let data = '';
    s.on('data', (c) => { data += c; });
    s.on('end', () => resolve(data));
    s.on('error', reject);
  });
}
(async () => {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  await get(port, '/healthz');
  await get(port, '/api/sessions');
  // Built from parts so the value is not in the command line the resource echoes.
  await get(port, '/api/search?q=' + 'priv' + 'ate42' + '&zone=expo');
  await new Promise((r) => server.close(r));
  await shutdownTelemetry();
})();
`;

test('instrumented server names routes, skips probes and reports its version', async () => {
  const env = {
    ...process.env,
    OTEL_TRACES_EXPORTER: 'console',
    OTEL_METRICS_EXPORTER: 'none',
    OTEL_LOGS_EXPORTER: 'none',
    OTEL_SERVICE_NAME: 'kccnc-scout-test',
    APP_VERSION: 'test123',
  };
  delete env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const stdout = await new Promise((resolve, reject) => {
    execFile(process.execPath, ['--require', './instrumentation.js', '-e', CHILD], { cwd: APP_DIR, env, timeout: 20000 },
      (err, out, errOut) => (err ? reject(new Error(`${err.message}\n${errOut}`)) : resolve(out)));
  });
  // Span names only; the resource attributes echo the child's command line.
  const spanNames = [...stdout.matchAll(/^\s*name: '([^']*)'/gm)].map((m) => m[1]).filter((n) => !n.startsWith('@opentelemetry/'));
  assert.deepEqual(spanNames, ['GET /api/sessions', 'GET /api/search']);
  // The question in ?q= never reaches telemetry.
  assert.match(stdout, /'url\.query': 'q=REDACTED&zone=expo'/);
  assert.doesNotMatch(stdout, /private42/);
  assert.match(stdout, /'http\.route': '\/api\/sessions'/);
  assert.match(stdout, /'service\.version': 'test123'/);
});
