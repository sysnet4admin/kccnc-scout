const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rumSnippet, scrubUrlAttributes, SDK_URL, SDK_INTEGRITY } = require('../lib/rum');

test('no token, no RUM', () => {
  assert.equal(rumSnippet({}), '');
  assert.equal(rumSnippet({ token: '' }), '');
});

test('the snippet queues init and loads the pinned SDK with an integrity hash', () => {
  const html = rumSnippet({ token: 'auth_test', version: 'abc1234' });
  assert.match(html, /dash0\("init", /);
  assert.match(html, /"serviceName":"kccnc-scout-web"/);
  assert.match(html, /"serviceVersion":"abc1234"/);
  assert.match(html, /"url":"https:\/\/ingress\.us-west-2\.aws\.dash0\.com"/);
  assert.match(html, /"dataset":"default"/);
  assert.match(html, /urlAttributeScrubber:/);
  assert.ok(SDK_URL.includes('@dash0/sdk-web@0.29.0/'));
  assert.ok(html.includes(`src="${SDK_URL}" integrity="${SDK_INTEGRITY}"`));
});

test('RUM URL attributes redact the question from page and fetch URLs', () => {
  assert.deepEqual(scrubUrlAttributes({
    'url.full': 'https://example.org/api/answer?q=secret&zone=expo',
    'url.query': 'q=secret&zone=expo',
    'page.url.full': 'https://example.org/?q=secret&at=2026-11-10',
    'page.url.query': '?q=secret&at=2026-11-10',
    'url.path': '/api/answer',
  }), {
    'url.full': 'https://example.org/api/answer?q=REDACTED&zone=expo',
    'url.query': 'q=REDACTED&zone=expo',
    'page.url.full': 'https://example.org/?q=REDACTED&at=2026-11-10',
    'page.url.query': '?q=REDACTED&at=2026-11-10',
    'url.path': '/api/answer',
  });
});

test('values cannot close the script tag', () => {
  const html = rumSnippet({ token: '</script><script>alert(1)</script>' });
  assert.equal(html.match(/<\/script>/g).length, 2);
  assert.match(html, /\\u003c\/script>/);
});
