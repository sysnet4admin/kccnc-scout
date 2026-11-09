// Elasticsearch client for the app, built from the environment. ES_URL and
// ES_API_KEY come from Secret `elastic` (read-only key). Returns null when
// they are not set, so the app still starts without search (local runs, tests).
const { Client } = require('@elastic/elasticsearch');

const REQUEST_TIMEOUT_MS = 8000;
// The client retries only connection errors and 502/503/504, never other 4xx/5xx.
const MAX_RETRIES = 2;

let client;

function getClient() {
  if (client !== undefined) return client;
  const node = process.env.ES_URL;
  const apiKey = process.env.ES_API_KEY;
  client = node && apiKey
    ? new Client({ node, auth: { apiKey }, requestTimeout: REQUEST_TIMEOUT_MS, maxRetries: MAX_RETRIES })
    : null;
  return client;
}

module.exports = { getClient };
