const { test } = require('node:test');
const assert = require('node:assert/strict');
const indices = require('../lib/indices');
const { toSessionDocs, toPageDocs } = require('../lib/schedule');

// With dynamic: strict, a field missing from the mapping fails the whole
// document at index time. Check every document field is mapped.
function unmapped(doc, properties, prefix = '') {
  const missing = [];
  for (const [key, value] of Object.entries(doc)) {
    const mapping = properties[key];
    if (!mapping) {
      missing.push(prefix + key);
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value) && mapping.properties) {
      missing.push(...unmapped(value, mapping.properties, `${prefix}${key}.`));
    }
    if (Array.isArray(value) && value[0] && typeof value[0] === 'object' && mapping.properties) {
      missing.push(...unmapped(value[0], mapping.properties, `${prefix}${key}.`));
    }
  }
  return missing;
}

const data = {
  sessions: [{
    id: '1', title: 'T', description: '<p>A</p>', startsAt: '2026-11-10T10:00:00', endsAt: '2026-11-10T10:30:00',
    speakers: ['s'], categoryItems: [], questionAnswers: [{ questionId: 7, answerValue: 'https://example.org/s.pdf' }], roomId: 1,
  }],
  speakers: [{ id: 's', fullName: 'S', bio: 'B', tagLine: 'X', questionAnswers: [] }],
  rooms: [{ id: 1, name: 'Salt Palace | Level 1 | Hall DE' }],
  categories: [],
  questions: [{ id: 7, question: 'Presentation Slides' }],
};
const deck = { deck_summary: 'D', estimated_audience: 'beginner', style: 'S', has_topology: true, topology_detail: 'basic', ai_focus: 'none' };

test('aliases match the names the read-only app key may read', () => {
  assert.equal(indices.SESSIONS_ALIAS, 'kccnc-scout-sessions');
  assert.equal(indices.PAGES_ALIAS, 'kccnc-scout-pages');
});

test('every session document field is mapped', () => {
  const [doc] = toSessionDocs(data, { decks: new Map([['1', deck]]), pageCounts: new Map([['1', 1]]) });
  assert.deepEqual(unmapped(doc, indices.sessionsIndex.mappings.properties), []);
});

test('every page document field is mapped', () => {
  const sessions = toSessionDocs(data);
  const { docs } = toPageDocs(
    [{ session_id: '1', page: 1, page_type: 'title', summary: 'S', visible_text: 'V', components: ['K'], relations: 'R', numbers: ['1'], density: 'light', tone: 't' }],
    new Map(sessions.map((s) => [s.id, s])),
  );
  assert.deepEqual(unmapped(docs[0], indices.pagesIndex.mappings.properties), []);
});

test('copy_to targets are semantic_text fields using the Jina endpoint', () => {
  for (const def of [indices.sessionsIndex, indices.pagesIndex]) {
    const props = def.mappings.properties;
    const targets = new Set(Object.values(props).flatMap((p) => (p.copy_to ? [p.copy_to] : [])));
    assert.ok(targets.size > 0);
    for (const target of targets) {
      assert.equal(props[target].type, 'semantic_text', target);
      assert.equal(props[target].inference_id, indices.EMBEDDING_INFERENCE_ID, target);
    }
  }
});

test('search analyzer uses the synonym set; the index analyzer does not', () => {
  const { analyzer, filter } = indices.sessionsIndex.settings.analysis;
  assert.ok(analyzer.en_search.filter.includes('kccnc_synonyms'));
  assert.ok(!analyzer.en_index.filter.includes('kccnc_synonyms'));
  assert.equal(filter.kccnc_synonyms.synonyms_set, indices.SYNONYMS_SET);
  assert.equal(filter.kccnc_synonyms.updateable, true);
});
