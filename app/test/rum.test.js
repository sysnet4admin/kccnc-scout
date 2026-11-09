const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rumSnippet, SDK_URL, SDK_INTEGRITY } = require('../lib/rum');

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
  assert.ok(SDK_URL.includes('@dash0/sdk-web@0.29.0/'));
  assert.ok(html.includes(`src="${SDK_URL}" integrity="${SDK_INTEGRITY}"`));
});

test('values cannot close the script tag', () => {
  const html = rumSnippet({ token: '</script><script>alert(1)</script>' });
  assert.equal(html.match(/<\/script>/g).length, 2);
  assert.match(html, /\\u003c\/script>/);
});
