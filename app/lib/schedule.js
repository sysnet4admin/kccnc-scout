// Turns the official schedule (Sessionize JSON) and the pre-generated slide
// descriptions into the documents we index in Elasticsearch.
//
// Schedule times have no offset. They are venue-local (America/Denver), which
// is MST, UTC-7, for the whole event (Nov 8-13 2026). CI and the container run
// in UTC, so we attach the offset as text and never parse the bare value.

const VENUE_OFFSET = '-07:00';
const VENUE_TIME_ZONE = 'America/Denver';
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Sessionize question titles we read from questionAnswers.
const QUESTIONS = {
  slides: 'Presentation Slides',
  github: 'GitHub Repository',
  demo: 'Project Demo',
  company: 'Company',
};

// Sessionize category titles and the fields they fill.
const CATEGORY_FIELDS = {
  'All Sessions': 'track',
  'Audience Level': 'level',
  SubTopic: 'subtopics',
  'CNCF Projects': 'projects',
  'End User Programming': 'labels',
  'Solutions Showcase Programming': 'labels',
  'Is Sponsored Keynote': 'labels',
};
const SINGLE_VALUE_FIELDS = new Set(['track', 'level']);

// "2026-11-10T17:30:00" -> "2026-11-10T17:30:00-07:00".
// Values that already carry an offset or Z are returned unchanged.
function toVenueIso(value) {
  if (typeof value !== 'string') throw new TypeError(`expected a time string, got ${typeof value}`);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) return value;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2})?$/.exec(value);
  if (!m) throw new Error(`unexpected schedule time: ${value}`);
  return `${m[1]}T${m[2]}${m[3] || ':00'}${VENUE_OFFSET}`;
}

// Venue-local calendar day and weekday, read from the text, not from a Date in
// the runtime's zone.
function venueDay(value) {
  const day = toVenueIso(value).slice(0, 10);
  const [y, mo, d] = day.split('-').map(Number);
  return { day, weekday: WEEKDAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()] };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function stripHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<(br|\/p|\/li|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code) => {
      if (code[0] === '#') {
        const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
      }
      return ENTITIES[code.toLowerCase()] ?? whole;
    })
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

// "Salt Palace | Level 1 | Hall DE" -> { venue, floor, room }.
function parseRoom(name) {
  const full = (name || '').trim();
  const parts = full.split('|').map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1) {
    const floorIndex = parts.findIndex((p) => /^Level \d+/i.test(p));
    const floor = floorIndex >= 0 ? parts[floorIndex] : null;
    const room = parts.slice(1).filter((_, i) => i + 1 !== floorIndex).join(' | ') || null;
    return { venue: parts[0], floor, room, room_name: full };
  }
  const venue = /^Salt Palace/i.test(full) ? 'Salt Palace' : /^Hyatt Regency/i.test(full) ? 'Hyatt Regency' : null;
  return { venue, floor: null, room: full || null, room_name: full || null };
}

// The official schedule page embeds the Sessionize data as one JSON object
// that starts with {"sessions":[ . Find it and parse only that object.
function extractSessionizeJson(html) {
  const start = html.indexOf('{"sessions":[');
  if (start < 0) throw new Error('no Sessionize data found in the page');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return JSON.parse(html.slice(start, i + 1));
    }
  }
  throw new Error('Sessionize data in the page is not complete');
}

function buildLookups(data) {
  const questionIds = {};
  for (const [key, title] of Object.entries(QUESTIONS)) {
    const q = (data.questions || []).find((x) => x.question === title);
    if (q) questionIds[key] = q.id;
  }
  const categories = new Map();
  for (const category of data.categories || []) {
    const field = CATEGORY_FIELDS[category.title];
    if (!field) continue;
    for (const item of category.items || []) categories.set(item.id, { field, name: item.name });
  }
  return {
    questionIds,
    categories,
    speakers: new Map((data.speakers || []).map((s) => [s.id, s])),
    rooms: new Map((data.rooms || []).map((r) => [r.id, r.name])),
  };
}

function answer(entity, questionId) {
  if (!questionId) return null;
  const a = (entity.questionAnswers || []).find((x) => x.questionId === questionId);
  const value = a && typeof a.answerValue === 'string' ? a.answerValue.trim() : '';
  return value || null;
}

function deckFields(deck) {
  if (!deck) return {};
  return {
    deck_summary: deck.deck_summary || null,
    deck: {
      audience: deck.estimated_audience || null,
      style: deck.style || null,
      has_experience_story: Boolean(deck.has_experience_story),
      has_topology: Boolean(deck.has_topology),
      topology_detail: deck.topology_detail || null,
      has_measured_results: Boolean(deck.has_measured_results),
      has_failure_story: Boolean(deck.has_failure_story),
      has_live_demo: Boolean(deck.has_live_demo),
      ai_focus: deck.ai_focus || null,
    },
  };
}

// decks: deck summaries keyed by session id. pageCounts: described pages per session id.
function toSessionDocs(data, { decks = new Map(), pageCounts = new Map() } = {}) {
  const lookups = buildLookups(data);
  return (data.sessions || []).map((s) => {
    const doc = {
      id: String(s.id),
      title: (s.title || '').trim(),
      abstract: stripHtml(s.description),
      start: toVenueIso(s.startsAt),
      end: toVenueIso(s.endsAt),
      ...venueDay(s.startsAt),
      room_id: s.roomId ?? null,
      ...parseRoom(lookups.rooms.get(s.roomId)),
      track: null,
      level: null,
      subtopics: [],
      projects: [],
      labels: [],
      speakers: [],
      speaker_bios: [],
      slides: answer(s, lookups.questionIds.slides),
      github: answer(s, lookups.questionIds.github),
      demo: answer(s, lookups.questionIds.demo),
      is_service: Boolean(s.isServiceSession),
    };
    for (const itemId of s.categoryItems || []) {
      const c = lookups.categories.get(itemId);
      if (!c) continue;
      if (SINGLE_VALUE_FIELDS.has(c.field)) doc[c.field] = doc[c.field] || c.name;
      else if (!doc[c.field].includes(c.name)) doc[c.field].push(c.name);
    }
    for (const speakerId of s.speakers || []) {
      const sp = lookups.speakers.get(speakerId);
      if (!sp) continue;
      doc.speakers.push({
        name: sp.fullName || [sp.firstName, sp.lastName].filter(Boolean).join(' '),
        company: answer(sp, lookups.questionIds.company),
        tagline: sp.tagLine || null,
      });
      if (sp.bio) doc.speaker_bios.push(stripHtml(sp.bio));
    }
    // Speakers take decks down and put new ones up. Descriptions only count
    // while the session still links its slides.
    doc.has_slides = Boolean(doc.slides);
    doc.page_count = doc.has_slides ? pageCounts.get(doc.id) || 0 : 0;
    if (doc.has_slides) Object.assign(doc, deckFields(decks.get(doc.id)));
    return doc;
  });
}

// Session fields copied onto every page, so page search can filter by time and
// place without a join.
const PAGE_SESSION_FIELDS = ['title', 'start', 'end', 'day', 'weekday', 'venue', 'room', 'track', 'level', 'slides'];

function toPageDocs(pages, sessionsById) {
  const docs = [];
  const skipped = { unknownSession: 0, slidesRemoved: 0 };
  for (const p of pages) {
    const sessionId = String(p.session_id);
    const session = sessionsById.get(sessionId);
    if (!session) {
      skipped.unknownSession++;
      continue;
    }
    if (!session.has_slides) {
      skipped.slidesRemoved++;
      continue;
    }
    const doc = {
      id: `${sessionId}-${p.page}`,
      session_id: sessionId,
      page: p.page,
      page_type: p.page_type || null,
      summary: p.summary || '',
      visible_text: p.visible_text || '',
      components: Array.isArray(p.components) ? p.components : [],
      relations: p.relations || '',
      numbers: Array.isArray(p.numbers) ? p.numbers : [],
      density: p.density || null,
      has_code: Boolean(p.has_code),
      has_diagram: Boolean(p.has_diagram),
      has_demo: Boolean(p.has_demo),
      tone: p.tone || null,
    };
    for (const f of PAGE_SESSION_FIELDS) doc[f] = session[f] ?? null;
    docs.push(doc);
  }
  return { docs, skipped };
}

function parseJsonLines(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, i) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        throw new Error(`line ${i + 1}: ${err.message}`);
      }
    });
}

module.exports = {
  VENUE_OFFSET,
  VENUE_TIME_ZONE,
  toVenueIso,
  venueDay,
  stripHtml,
  parseRoom,
  extractSessionizeJson,
  toSessionDocs,
  toPageDocs,
  parseJsonLines,
};
