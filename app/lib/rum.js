// Dash0 real-user monitoring for the phone UI: page views, navigation timing,
// fetch calls (same-origin calls carry trace headers, so browser and server
// spans join up) and errors, plus the app's own "kccnc.answer" events.
// The question in ?q= is redacted from every URL the SDK records.
//
// The token is a separate, ingest-only token for one dataset. It ends up in
// the page anyway, but it comes from the environment (Secret `dash0`, key
// `rum-token`) rather than the repository. Without it the page has no RUM.

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@dash0/sdk-web@0.29.0/dist/dash0.iife.js';
// sha384 of dist/dash0.iife.js in the @dash0/sdk-web 0.29.0 npm package.
const SDK_INTEGRITY = 'sha384-B6en+sgbt5GMWdNeuTt0hlSr/xgxkZariMLuQ+zwcbFwBLyyggeeIN7EkkYUKyI9';
const DEFAULT_ENDPOINT = 'https://ingress.us-west-2.aws.dash0.com';

// JSON that is safe inside an inline <script>.
const scriptJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

function scrubUrlAttributes(attributes) {
  const scrubbed = { ...attributes };
  for (const key of ['url.full', 'page.url.full']) {
    const value = scrubbed[key];
    if (typeof value !== 'string') continue;
    try {
      const url = new URL(value);
      if (url.searchParams.has('q')) {
        url.searchParams.set('q', 'REDACTED');
        scrubbed[key] = url.toString();
      }
    } catch {}
  }
  for (const key of ['url.query', 'page.url.query']) {
    const value = scrubbed[key];
    if (typeof value !== 'string') continue;
    const prefix = value.startsWith('?') ? '?' : '';
    const query = new URLSearchParams(prefix ? value.slice(1) : value);
    if (query.has('q')) {
      query.set('q', 'REDACTED');
      scrubbed[key] = prefix + query.toString();
    }
  }
  return scrubbed;
}

// Serialize the self-contained callback for the browser SDK.
const URL_SCRUBBER = scrubUrlAttributes.toString();

function rumSnippet({ token, endpoint = DEFAULT_ENDPOINT, dataset = 'default', version = 'dev' } = {}) {
  if (!token) return '';
  const config = {
    serviceName: 'kccnc-scout-web',
    serviceVersion: version,
    environment: 'hackathon',
    endpoint: { url: endpoint, authToken: token, dataset },
  };
  return [
    '<script>',
    '(function (w, n) { if (w[n]) return; var q = []; var f = w[n] = function () { q.push(arguments); }; f._t = new Date(); f._v = 1; f._q = q; })(window, "dash0");',
    `dash0("init", Object.assign(${scriptJson(config)}, { urlAttributeScrubber: ${URL_SCRUBBER} }));`,
    '</script>',
    `<script defer crossorigin="anonymous" src="${SDK_URL}" integrity="${SDK_INTEGRITY}"></script>`,
  ].join('\n');
}

module.exports = { rumSnippet, scrubUrlAttributes, SDK_URL, SDK_INTEGRITY, URL_SCRUBBER };
