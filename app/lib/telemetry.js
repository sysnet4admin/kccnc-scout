// Small helpers for code that runs with or without instrumentation.js preloaded.
const path = require('node:path');
const { context } = require('@opentelemetry/api');
const { getRPCMetadata, RPCType } = require('@opentelemetry/core');

const INSTRUMENTATION = path.join(__dirname, '..', 'instrumentation.js');

// Routes we name in traces. The plain http module only knows the method, so
// without this every server span would be called "GET".
const ROUTES = new Set(['/', '/healthz', '/readyz', '/api/sessions', '/api/search']);

function routeFor(pathname) {
  return ROUTES.has(pathname) ? pathname : null;
}

// Sets http.route (and the span name, "GET /api/sessions") on the current request's span.
function nameRoute(route) {
  if (!route) return;
  const rpc = getRPCMetadata(context.active());
  if (rpc && rpc.type === RPCType.HTTP) rpc.route = route;
}

// Flushes spans, metrics and logs before the process exits. Waits at most
// timeoutMs so a slow exporter cannot hold up a pod shutdown.
async function shutdownTelemetry(timeoutMs = 5000) {
  const preloaded = require.cache[INSTRUMENTATION];
  if (!preloaded) return;
  let timer;
  await Promise.race([
    preloaded.exports.sdk.shutdown().catch(() => {}),
    new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  clearTimeout(timer);
}

module.exports = { routeFor, nameRoute, shutdownTelemetry };
