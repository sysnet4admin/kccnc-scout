const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  toVenueIso,
  venueDay,
  stripHtml,
  parseRoom,
  extractSessionizeJson,
  toSessionDocs,
  toPageDocs,
  parseJsonLines,
} = require('../lib/schedule');

const fixture = {
  sessions: [
    {
      id: '101',
      title: ' Scaling eBPF Observability ',
      description: '<p>Learn &amp; share.</p><p>Second&nbsp;line &#8212; done.</p>',
      startsAt: '2026-11-10T23:30:00',
      endsAt: '2026-11-11T00:05:00',
      isServiceSession: false,
      speakers: ['s1', 's2'],
      categoryItems: [1, 2, 3, 99],
      questionAnswers: [
        { questionId: 137003, answerValue: 'https://example.org/slides.pdf' },
        { questionId: 137004, answerValue: ' ' },
      ],
      roomId: 10,
    },
    {
      id: '102',
      title: 'Lunch',
      description: null,
      startsAt: '2026-11-11T12:00:00',
      endsAt: '2026-11-11T13:00:00',
      isServiceSession: true,
      speakers: [],
      categoryItems: [],
      questionAnswers: [],
      roomId: 11,
    },
  ],
  speakers: [
    { id: 's1', fullName: 'Ada Lovelace', tagLine: 'Example, Engineer', bio: '<p>Runs clusters.</p>', questionAnswers: [{ questionId: 128829, answerValue: 'Example' }] },
    { id: 's2', firstName: 'Grace', lastName: 'Hopper', tagLine: null, bio: null, questionAnswers: [] },
  ],
  rooms: [
    { id: 10, name: 'Salt Palace | Level 2 | 255 BC' },
    { id: 11, name: 'Hyatt Regency Lobby' },
  ],
  categories: [
    { title: 'All Sessions', items: [{ id: 1, name: 'Observability' }] },
    { title: 'Audience Level', items: [{ id: 2, name: 'Advanced' }] },
    { title: 'CNCF Projects', items: [{ id: 3, name: 'Cilium' }] },
  ],
  questions: [
    { id: 128829, question: 'Company' },
    { id: 137003, question: 'Presentation Slides' },
    { id: 137004, question: 'GitHub Repository' },
  ],
};

test('schedule times get the venue offset and keep their instant in any time zone', () => {
  assert.equal(toVenueIso('2026-11-10T17:30:00'), '2026-11-10T17:30:00-07:00');
  assert.equal(toVenueIso('2026-11-10T17:30'), '2026-11-10T17:30:00-07:00');
  assert.equal(Date.parse(toVenueIso('2026-11-10T17:30:00')), Date.UTC(2026, 10, 11, 0, 30));
  assert.equal(toVenueIso('2026-11-10T17:30:00Z'), '2026-11-10T17:30:00Z');
  assert.equal(toVenueIso('2026-11-10T17:30:00-07:00'), '2026-11-10T17:30:00-07:00');
  assert.throws(() => toVenueIso('Nov 10 5:30 PM'));
  assert.throws(() => toVenueIso(undefined));
});

test('the day comes from the venue date, not the UTC date', () => {
  // 23:30 MST on Nov 10 is already Nov 11 in UTC.
  assert.deepEqual(venueDay('2026-11-10T23:30:00'), { day: '2026-11-10', weekday: 'Tuesday' });
  assert.deepEqual(venueDay('2026-11-09T00:15:00'), { day: '2026-11-09', weekday: 'Monday' });
});

test('stripHtml removes tags and decodes entities', () => {
  assert.equal(stripHtml('<p>Learn &amp; share.</p><p>Second&nbsp;line &#8212; done.</p>'), `Learn & share.\nSecond line ${String.fromCodePoint(0x2014)} done.`);
  assert.equal(stripHtml(null), '');
  assert.equal(stripHtml('a<br/>b &unknown; &#x41;'), 'a\nb &unknown; A');
});

test('parseRoom splits building, floor and room', () => {
  assert.deepEqual(parseRoom('Salt Palace | Level 1 | Hall DE'), {
    venue: 'Salt Palace', floor: 'Level 1', room: 'Hall DE', room_name: 'Salt Palace | Level 1 | Hall DE',
  });
  assert.equal(parseRoom('Salt Palace | Level 1 | Solutions Showcase | Hall 1 | Alpine Overlook Zone | Demo Theater').room,
    'Solutions Showcase | Hall 1 | Alpine Overlook Zone | Demo Theater');
  assert.deepEqual(parseRoom('Salt Palace | 200 South Entrance (South)'), {
    venue: 'Salt Palace', floor: null, room: '200 South Entrance (South)', room_name: 'Salt Palace | 200 South Entrance (South)',
  });
  assert.equal(parseRoom('Hyatt Regency Lobby').venue, 'Hyatt Regency');
  assert.equal(parseRoom('Room TBD').venue, null);
  assert.equal(parseRoom(undefined).room, null);
});

test('extractSessionizeJson finds the embedded object, braces in strings included', () => {
  const data = { sessions: [{ id: '1', title: 'Braces } and ] and "quotes" {' }], speakers: [] };
  const html = `<html><script>var x = {"a":1};</script><script>window.data = ${JSON.stringify(data)};</script></html>`;
  assert.deepEqual(extractSessionizeJson(html), data);
  assert.throws(() => extractSessionizeJson('<html>nothing</html>'), /no Sessionize data/);
  assert.throws(() => extractSessionizeJson('{"sessions":[{"id":"1"'), /not complete/);
});

test('session documents join speakers, categories, rooms and the deck summary', () => {
  const decks = new Map([['101', { deck_summary: 'A deck about eBPF.', estimated_audience: 'advanced', has_live_demo: true, ai_focus: 'none' }]]);
  const [talk, lunch] = toSessionDocs(fixture, { decks, pageCounts: new Map([['101', 12]]) });

  assert.equal(talk.id, '101');
  assert.equal(talk.title, 'Scaling eBPF Observability');
  assert.equal(talk.start, '2026-11-10T23:30:00-07:00');
  assert.equal(talk.end, '2026-11-11T00:05:00-07:00');
  assert.equal(talk.day, '2026-11-10');
  assert.equal(talk.venue, 'Salt Palace');
  assert.equal(talk.room, '255 BC');
  assert.equal(talk.track, 'Observability');
  assert.equal(talk.level, 'Advanced');
  assert.deepEqual(talk.projects, ['Cilium']);
  assert.deepEqual(talk.speakers, [
    { name: 'Ada Lovelace', company: 'Example', tagline: 'Example, Engineer' },
    { name: 'Grace Hopper', company: null, tagline: null },
  ]);
  assert.deepEqual(talk.speaker_bios, ['Runs clusters.']);
  assert.equal(talk.slides, 'https://example.org/slides.pdf');
  assert.equal(talk.github, null);
  assert.equal(talk.has_slides, true);
  assert.equal(talk.page_count, 12);
  assert.equal(talk.deck_summary, 'A deck about eBPF.');
  assert.equal(talk.deck.has_live_demo, true);
  assert.equal(talk.deck.has_failure_story, false);

  assert.equal(lunch.is_service, true);
  assert.equal(lunch.venue, 'Hyatt Regency');
  assert.equal(lunch.has_slides, false);
  assert.equal(lunch.deck_summary, undefined);
});

test('a deck summary is dropped when the session no longer links slides', () => {
  const withoutSlides = structuredClone(fixture);
  withoutSlides.sessions[0].questionAnswers = [];
  const decks = new Map([['101', { deck_summary: 'Old deck.' }]]);
  const [talk] = toSessionDocs(withoutSlides, { decks, pageCounts: new Map([['101', 12]]) });
  assert.equal(talk.has_slides, false);
  assert.equal(talk.page_count, 0);
  assert.equal(talk.deck_summary, undefined);
});

test('page documents carry the session fields used for filtering', () => {
  const sessions = toSessionDocs(fixture);
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const pages = [
    { session_id: '101', page: 3, page_type: 'architecture_diagram', summary: 'Data path', visible_text: 'XDP', components: ['Cilium'], numbers: [], has_diagram: true },
    { session_id: '102', page: 1, summary: 'Lunch has no slides' },
    { session_id: '999', page: 1, summary: 'Unknown session' },
  ];
  const { docs, skipped } = toPageDocs(pages, byId);
  assert.equal(docs.length, 1);
  assert.deepEqual(skipped, { unknownSession: 1, slidesRemoved: 1 });
  const [page] = docs;
  assert.equal(page.id, '101-3');
  assert.equal(page.start, '2026-11-10T23:30:00-07:00');
  assert.equal(page.title, 'Scaling eBPF Observability');
  assert.equal(page.room, '255 BC');
  assert.equal(page.has_diagram, true);
  assert.equal(page.has_code, false);
});

test('parseJsonLines skips blank lines and reports the bad line', () => {
  assert.deepEqual(parseJsonLines('{"a":1}\n\n{"a":2}\n'), [{ a: 1 }, { a: 2 }]);
  assert.throws(() => parseJsonLines('{"a":1}\nnot json'), /line 2/);
});
