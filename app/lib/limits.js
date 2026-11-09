// Protections for the public URL: per-IP rate limits, a cache for repeated
// questions, and a daily cap on LLM calls. All state is in memory per pod, so
// with 2 replicas the real totals are up to twice the configured numbers.

const MAX_TRACKED_KEYS = 10_000;

// The platform's gateway puts the caller's address first in X-Forwarded-For.
// Fall back to the socket address when the header is missing.
function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const first = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : '';
  return first || req.socket?.remoteAddress || 'unknown';
}

// Fixed-window counter per key: at most `limit` calls per `windowMs`.
class RateLimiter {
  constructor({ limit, windowMs, now = () => Date.now() }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.windows = new Map();
  }

  // Returns { allowed, retryAfterSeconds }.
  take(key) {
    const t = this.now();
    let w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) {
      if (this.windows.size >= MAX_TRACKED_KEYS) this.prune(t);
      w = { start: t, count: 0 };
      this.windows.set(key, w);
    }
    w.count++;
    if (w.count <= this.limit) return { allowed: true, retryAfterSeconds: 0 };
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((w.start + this.windowMs - t) / 1000)) };
  }

  prune(t) {
    for (const [key, w] of this.windows) if (t - w.start >= this.windowMs) this.windows.delete(key);
    // Still full of live windows: drop the oldest rather than grow without bound.
    while (this.windows.size >= MAX_TRACKED_KEYS) this.windows.delete(this.windows.keys().next().value);
  }
}

// Small TTL cache with a size cap (oldest entries go first).
class TtlCache {
  constructor({ ttlMs, maxEntries = 500, now = () => Date.now() }) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
  }

  get(key) {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (this.now() - e.at >= this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key, value) {
    this.entries.delete(key);
    this.entries.set(key, { at: this.now(), value });
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
  }
}

// Counts LLM calls per venue day (UTC-7) and refuses more than `limit`.
class DailyBudget {
  constructor({ limit, now = () => Date.now() }) {
    this.limit = limit;
    this.now = now;
    this.day = null;
    this.used = 0;
  }

  currentDay() {
    return new Date(this.now() - 7 * 3_600_000).toISOString().slice(0, 10);
  }

  // Reserves one call; returns false when today's budget is spent.
  take() {
    const day = this.currentDay();
    if (day !== this.day) {
      this.day = day;
      this.used = 0;
    }
    if (this.used >= this.limit) return false;
    this.used++;
    return true;
  }

  remaining() {
    return this.currentDay() === this.day ? Math.max(0, this.limit - this.used) : this.limit;
  }
}

// Same question, same 5-minute slot: same answer.
function cacheKey(question, atMs) {
  const slot = Math.floor(atMs / 300_000);
  return `${slot}|${question.toLowerCase()}`;
}

module.exports = { clientIp, RateLimiter, TtlCache, DailyBudget, cacheKey };
