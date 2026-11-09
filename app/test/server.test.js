const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server');

let server;
let base;

before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

test('liveness and readiness probes answer ok', async () => {
  for (const path of ['/healthz', '/readyz']) {
    const res = await fetch(base + path);
    assert.equal(res.status, 200, path);
    assert.equal(await res.text(), 'ok\n', path);
  }
});

test('home page shows the running version', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<p>version [^<]+<\/p>/);
});

test('sessions API returns JSON with a sessions list', async () => {
  const res = await fetch(base + '/api/sessions');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  const body = await res.json();
  assert.ok(Array.isArray(body.sessions));
});

test('unknown paths return 404', async () => {
  const res = await fetch(base + '/no-such-page');
  assert.equal(res.status, 404);
});
