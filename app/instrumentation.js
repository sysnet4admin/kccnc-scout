// Starts OpenTelemetry before the app's modules load, so http, fetch (undici),
// the Elasticsearch client and pino get instrumented. The container runs
// `node --require ./instrumentation.js server.js`.
//
// Where data goes comes from the standard OTEL_* environment variables set in
// deploy/deployment.yaml (endpoint, headers, service name, exporters).

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { resourceFromAttributes } = require('@opentelemetry/resources');

// Kubernetes probes these every few seconds; tracing them would bury real requests.
const PROBE_PATHS = new Set(['/healthz', '/readyz']);

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    'service.version': process.env.APP_VERSION || 'dev',
  }),
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-http': {
        ignoreIncomingRequestHook: (req) => PROBE_PATHS.has((req.url || '').split('?')[0]),
      },
      '@opentelemetry/instrumentation-dns': { enabled: false },
      '@opentelemetry/instrumentation-net': { enabled: false },
    }),
  ],
});

sdk.start();

module.exports = { sdk };
