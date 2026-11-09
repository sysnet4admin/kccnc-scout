const { test } = require('node:test');
const assert = require('node:assert/strict');
const { redactQuery, redactTargetQuery } = require('../lib/redact');

test('the question parameter is redacted, everything else is kept', () => {
  assert.equal(redactQuery('q=hello%20world&at=2026-11-10T14%3A20%3A00-07%3A00&zone=expo'), 'q=REDACTED&at=2026-11-10T14%3A20%3A00-07%3A00&zone=expo');
  assert.equal(redactQuery('?q=x'), 'q=REDACTED');
  assert.equal(redactQuery('zone=expo'), null);
  assert.equal(redactQuery(''), null);
  assert.equal(redactTargetQuery('/api/answer?q=secret'), 'q=REDACTED');
  assert.equal(redactTargetQuery('/healthz'), null);
  assert.equal(redactTargetQuery(undefined), null);
});
