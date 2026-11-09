// JSON logs on stdout. When instrumentation.js is loaded, the pino
// instrumentation adds trace and span ids and sends each record over OTLP too.
const pino = require('pino');

module.exports = pino({ level: process.env.LOG_LEVEL || 'info' });
