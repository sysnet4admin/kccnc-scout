// Questions are free text from attendees and can contain personal details, so
// telemetry never records them. The question travels in the `q` query
// parameter (/api/search, /api/answer, and the page URL the UI keeps for
// sharing); its value is replaced with REDACTED wherever a URL is recorded.

const SENSITIVE_PARAMS = ['q'];
const REDACTED = 'REDACTED';

// Returns the query string (without "?") with sensitive values redacted, or
// null when there is nothing to change.
function redactQuery(query) {
  if (!query) return null;
  const params = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
  let changed = false;
  for (const name of SENSITIVE_PARAMS) {
    if (params.has(name)) {
      params.set(name, REDACTED);
      changed = true;
    }
  }
  return changed ? params.toString() : null;
}

// Same, for a request target such as "/api/answer?q=...".
function redactTargetQuery(target) {
  if (typeof target !== 'string') return null;
  const i = target.indexOf('?');
  return i < 0 ? null : redactQuery(target.slice(i + 1));
}

module.exports = { redactQuery, redactTargetQuery, SENSITIVE_PARAMS, REDACTED };
