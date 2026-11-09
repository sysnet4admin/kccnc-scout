const { test } = require('node:test');
const assert = require('node:assert/strict');
const { walkMinutes, walkTo, keynoteSurge, isZone, zones } = require('../lib/walk');
const { search, InputError } = require('../lib/search');
const { cacheKey } = require('../lib/limits');
const { buildMessages } = require('../lib/answer');

const ROOM = { hallDE: 82947, gbH: 82950, l250: 87421, regencyCD: 92181, b255: 82953, slbC: 82955, expo: 87451 };

// Values from the venue model's five-origin matrix (minutes, normal flow).
const MATRIX = [
  ['hallDE', 'gbH', 1.7], ['hallDE', 'l250', 3.8], ['hallDE', 'b255', 7.1], ['hallDE', 'regencyCD', 6.3],
  ['hallDE', 'slbC', 4.6], ['hallDE', 'expo', 5.8], ['expo', 'gbH', 5.0], ['expo', 'regencyCD', 10.2],
  ['expo', 'b255', 3.9], ['gbH', 'b255', 6.3], ['gbH', 'regencyCD', 5.4], ['b255', 'regencyCD', 11.5], ['regencyCD', 'slbC', 2.6],
];

test('walking minutes match the venue model within 0.2 min', () => {
  for (const [a, b, want] of MATRIX) {
    const got = walkMinutes(ROOM[a], ROOM[b]);
    assert.ok(Math.abs(got - want) <= 0.2, `${a} to ${b}: want ${want}, got ${got.toFixed(2)}`);
    assert.ok(Math.abs(walkMinutes(ROOM[b], ROOM[a]) - got) < 1e-9, `${a} and ${b} should be symmetric`);
  }
  assert.equal(walkMinutes(ROOM.gbH, ROOM.gbH), 0);
  assert.equal(walkMinutes(ROOM.gbH, 999999), null);
});

test('leaving Hall DE right after a keynote adds the crowd delay', () => {
  const justAfter = Date.parse('2026-11-11T10:50:00-07:00');
  assert.equal(keynoteSurge(ROOM.hallDE, ROOM.gbH, justAfter), 5);
  assert.equal(keynoteSurge(ROOM.hallDE, ROOM.l250, justAfter), 8);
  assert.equal(keynoteSurge(ROOM.hallDE, ROOM.regencyCD, justAfter), 8);
  assert.equal(keynoteSurge(ROOM.gbH, ROOM.l250, justAfter), 0);
  assert.equal(keynoteSurge(ROOM.hallDE, ROOM.gbH, Date.parse('2026-11-11T11:10:00-07:00')), 0);
});

test('walkTo rounds up and reports arrival and lateness', () => {
  const at = Date.parse('2026-11-11T10:50:00-07:00');
  const start = Date.parse('2026-11-11T11:00:00-07:00');
  // Keynote hall to Hyatt Level 4 right after the 11/11 keynote: 6.3 + 8 = 14.3, so 15 min, 5 min late.
  const w = walkTo('keynote', ROOM.regencyCD, { atMs: at, startMs: start });
  assert.deepEqual(w, { minutes: 15, afterKeynote: true, arrive: '2026-11-11T18:05:00.000Z', minutesLate: 5 });
  const onTime = walkTo('ballroom', ROOM.l250, { atMs: at, startMs: start });
  assert.equal(onTime.minutes, 3);
  assert.equal(onTime.minutesLate, 0);
  assert.equal(walkTo('ballroom', null, { atMs: at, startMs: start }), null);
});

test('the seven zones are known; anything else is not', () => {
  assert.equal(zones.length, 7);
  assert.ok(zones.every((z) => isZone(z.id) && z.label));
  assert.equal(isZone('rooftop'), false);
});

const TALK = (id, start, end, roomId) => ({ id, title: `Talk ${id}`, start, end, room_id: roomId, room: 'R', venue: 'Salt Palace', speakers: [], slides: null });
const client = {
  inference: {},
  search: async (params) => (params.index === 'kccnc-scout-sessions'
    ? { hits: { hits: [
      { _id: '1', _source: TALK('1', '2026-11-10T14:41:00-07:00', '2026-11-10T15:10:00-07:00', ROOM.regencyCD) },
      { _id: '2', _source: TALK('2', '2026-11-10T11:00:00-07:00', '2026-11-10T11:30:00-07:00', ROOM.l250) },
      { _id: '3', _source: TALK('3', '2026-11-10T14:30:00-07:00', '2026-11-10T15:00:00-07:00', null) },
    ] } }
    : { hits: { hits: [] } }),
  mget: async () => ({ docs: [] }),
};

test('search adds walking times from the zone to upcoming talks only', async () => {
  const out = await search(client, { question: 'talks', at: '2026-11-10T14:20:00-07:00', zone: 'expo' });
  assert.equal(out.zone, 'expo');
  const [regency, noRoom] = out.now;
  assert.equal(regency.walk.minutes, 11);
  assert.equal(regency.walk.minutesLate, 0);
  assert.equal(noRoom.walk, null);
  assert.equal(out.past[0].walk, null);

  const without = await search(client, { question: 'talks', at: '2026-11-10T14:20:00-07:00' });
  assert.equal(without.zone, null);
  assert.equal(without.now[0].walk, null);
  await assert.rejects(search(client, { question: 'talks', zone: 'rooftop' }), InputError);
});

test('answers are cached per zone', () => {
  const at = Date.parse('2026-11-10T14:20:00-07:00');
  assert.notEqual(cacheKey('q', at, 'expo'), cacheKey('q', at, 'keynote'));
  assert.notEqual(cacheKey('q', at, 'expo'), cacheKey('q', at));
});

test('the prompt gives the attendee zone and each walk', async () => {
  const result = await search(client, { question: 'talks', at: '2026-11-10T14:20:00-07:00', zone: 'expo' });
  const [, user] = buildMessages(result);
  assert.match(user.content, /Attendee is at: Expo halls/);
  assert.match(user.content, /Walk: 11 min, arriving 14:31, before it starts/);
});
