// Answers "which talk should I go to" questions from Elasticsearch.
//
// 1. A question that isn't plain ASCII is rewritten as an English keyword query
//    by a small LLM behind an Elasticsearch inference endpoint. Keyword search
//    needs English to match titles and slide text; on timeout or error we search
//    with the original words.
// 2. Sessions and slide pages are searched separately, each with keyword (BM25)
//    and semantic (multilingual embeddings) retrievers merged by RRF.
// 3. The two lists are fused by rank, so talks whose slides match rise.
// 4. Results are grouped by time relative to the moment of the question: on now
//    or starting soon, later, and already over (watch later).
//
// Time windows are decided in code, never by the LLM. Times are compared as
// instants parsed from ISO strings that carry the venue offset.

const { SESSIONS_ALIAS, PAGES_ALIAS } = require('./indices');
const { streamChat } = require('./llm');

const MAX_QUESTION_LENGTH = 300;
// Output cap for the rewrite, reasoning included; a query is a few words.
const TRANSLATE_MAX_TOKENS = 200;
const TRANSLATE_TIMEOUT_MS = 3000;
const SOON_MINUTES = 30;
const RRF_K = 60;
const SESSION_WINDOW = 50;
const PAGE_WINDOW = 100;
const PAGES_PER_SESSION = 2;
const LIMITS = { now: 5, later: 5, past: 3 };
// Schedule entries that are not talks.
const EXCLUDED_TRACKS = ['Registration', 'Breaks'];

const SESSION_FIELDS = ['title^3', 'abstract', 'deck_summary', 'speakers.name^2', 'speakers.tagline', 'speaker_bios'];
const PAGE_FIELDS = ['summary', 'visible_text', 'relations', 'title'];

class InputError extends Error {}

function cleanQuestion(raw) {
  const question = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!question) throw new InputError('ask a question with ?q=');
  if (question.length > MAX_QUESTION_LENGTH) throw new InputError(`questions are limited to ${MAX_QUESTION_LENGTH} characters`);
  return question;
}

// "at" lets a demo ask as if it were another moment. It must carry an offset
// or Z, so it means the same instant in every time zone.
function parseAt(raw, now = Date.now()) {
  if (raw === undefined || raw === null || raw === '') return now;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(raw)) {
    throw new InputError('at must be an ISO time with an offset, like 2026-11-10T14:20:00-07:00');
  }
  return Date.parse(raw);
}

const isPlainAscii = (text) => /^[\x20-\x7e]*$/.test(text);

async function toEnglishQuery(client, endpoint, question, { onCall } = {}) {
  if (isPlainAscii(question) || !endpoint) return { english: question, translated: false };
  try {
    if (onCall) onCall();
    const raw = await streamChat(client, endpoint, [
      {
        role: 'user',
        content: 'Rewrite this KubeCon attendee question as a short English keyword search query. '
          + 'Keep project, product and people names as written. Output only the query.\n\n'
          + `Question: ${question}`,
      },
    ], { timeoutMs: TRANSLATE_TIMEOUT_MS, maxTokens: TRANSLATE_MAX_TOKENS });
    const text = String(raw).replace(/["\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    return text ? { english: text, translated: true } : { english: question, translated: false };
  } catch {
    return { english: question, translated: false };
  }
}

function hybrid(englishQuery, question, fields, semanticField, windowSize) {
  const notExcluded = { bool: { must_not: [{ terms: { track: EXCLUDED_TRACKS } }] } };
  return {
    rrf: {
      retrievers: [
        { standard: { query: { bool: { must: [{ multi_match: { query: englishQuery, fields } }], filter: [notExcluded] } } } },
        { standard: { query: { bool: { must: [{ semantic: { field: semanticField, query: question } }], filter: [notExcluded] } } } },
      ],
      rank_window_size: windowSize,
    },
  };
}

// Reciprocal rank fusion of the session list and the sessions behind the page list.
function fuse(sessionHits, pageHits) {
  const scores = new Map();
  const add = (id, rank) => scores.set(id, (scores.get(id) || 0) + 1 / (RRF_K + rank));
  sessionHits.forEach((h, i) => add(h._id, i + 1));

  const pagesBySession = new Map();
  for (const h of pageHits) {
    const id = h._source.session_id;
    if (!pagesBySession.has(id)) pagesBySession.set(id, []);
    const list = pagesBySession.get(id);
    if (list.length < PAGES_PER_SESSION) list.push(h._source);
  }
  [...pagesBySession.keys()].forEach((id, i) => add(id, i + 1));

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id, score]) => ({ id, score }));
  return { ranked, pagesBySession };
}

function timeStatus(session, at) {
  const start = Date.parse(session.start);
  const end = Date.parse(session.end);
  if (end <= at) return 'past';
  if (start <= at) return 'live';
  if (start - at <= SOON_MINUTES * 60_000) return 'soon';
  return 'later';
}

function toCard(session, score, pages, at) {
  const status = timeStatus(session, at);
  const start = Date.parse(session.start);
  const end = Date.parse(session.end);
  return {
    id: session.id,
    title: session.title,
    start: session.start,
    end: session.end,
    day: session.day,
    weekday: session.weekday,
    venue: session.venue,
    floor: session.floor,
    room: session.room,
    track: session.track,
    level: session.level,
    speakers: (session.speakers || []).map((s) => s.name),
    slides: session.slides || null,
    // AI-read summary of the whole deck and what it contains (demos, topology, results...).
    deckSummary: session.deck_summary || null,
    deck: session.deck || null,
    status,
    startsInMinutes: status === 'soon' || status === 'later' ? Math.round((start - at) / 60_000) : null,
    minutesLeft: status === 'live' ? Math.round((end - at) / 60_000) : null,
    score: Number(score.toFixed(5)),
    // AI-read slide pages that matched, linked to the page in the deck.
    pages: (pages || []).map((p) => ({
      page: p.page,
      type: p.page_type,
      summary: p.summary,
      link: session.slides ? `${session.slides}#page=${p.page}` : null,
    })),
  };
}

function group(cards) {
  const out = { now: [], later: [], past: [] };
  for (const card of cards) {
    const key = card.status === 'past' ? 'past' : card.status === 'later' ? 'later' : 'now';
    if (out[key].length < LIMITS[key]) out[key].push(card);
  }
  return out;
}

async function search(client, { question: rawQuestion, at: rawAt, translateEndpoint, onLlmCall, now = Date.now() }) {
  const question = cleanQuestion(rawQuestion);
  const at = parseAt(rawAt, now);

  let t = Date.now();
  const { english, translated } = await toEnglishQuery(client, translateEndpoint, question, { onCall: onLlmCall });
  const translateMs = Date.now() - t;

  t = Date.now();
  const [sessionRes, pageRes] = await Promise.all([
    client.search({
      index: SESSIONS_ALIAS,
      size: SESSION_WINDOW,
      retriever: hybrid(english, question, SESSION_FIELDS, 'semantic_all', SESSION_WINDOW),
      _source: { excludes: ['speaker_bios', 'abstract', 'semantic_all'] },
    }),
    client.search({
      index: PAGES_ALIAS,
      size: PAGE_WINDOW,
      retriever: hybrid(english, question, PAGE_FIELDS, 'semantic_page', PAGE_WINDOW),
      _source: ['session_id', 'page', 'page_type', 'summary'],
    }),
  ]);
  const sessionHits = sessionRes.hits.hits;
  const { ranked, pagesBySession } = fuse(sessionHits, pageRes.hits.hits);

  // Sessions found only through their pages still need their full document.
  const sessions = new Map(sessionHits.map((h) => [h._id, h._source]));
  const missing = ranked.map((r) => r.id).filter((id) => !sessions.has(id));
  if (missing.length) {
    const res = await client.mget({ index: SESSIONS_ALIAS, ids: missing, _source_excludes: ['speaker_bios', 'abstract', 'semantic_all'] });
    for (const d of res.docs) if (d.found) sessions.set(d._id, d._source);
  }
  const searchMs = Date.now() - t;

  const cards = ranked
    .filter((r) => sessions.has(r.id))
    .map((r) => toCard(sessions.get(r.id), r.score, pagesBySession.get(r.id), at));

  return {
    question,
    searched: { english, translated },
    at: new Date(at).toISOString(),
    ...group(cards),
    timings: { translateMs, searchMs },
  };
}

module.exports = { search, cleanQuestion, parseAt, toEnglishQuery, fuse, timeStatus, group, InputError, MAX_QUESTION_LENGTH, SOON_MINUTES };
