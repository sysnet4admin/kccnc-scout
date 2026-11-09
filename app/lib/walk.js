// Walking minutes between places in the Salt Palace and the Hyatt Regency.
//
// minutes = metres / 70 + 0.75 per level change + 0.5 when changing building
//
// Distances are Manhattan (north + east): both buildings sit on the Salt Lake
// City street grid and their corridors run north-south and east-west. A path
// goes through fixed points where a straight line would cut through walls:
// Hall DE and the expo halls are left and entered through their doors, a level
// change in the Salt Palace takes the nearest of three escalator banks, and
// every trip between the buildings passes the connection door (and the Hyatt
// escalators when the Hyatt end is above the lobby). Positions come from
// data/venue.json; nothing here was surveyed on site.

const venue = require('../data/venue.json');

const METRES_PER_MINUTE = 70;
const LEVEL_CHANGE_MIN = 0.75;
const BUILDING_CHANGE_MIN = 0.5;
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LNG = 111_320 * Math.cos((40.767 * Math.PI) / 180);

const P = (lat, lng, building, level) => ({ lat, lng, building, level });
const POINTS = {
  connectionDoor: P(40.7658, -111.89502, 'salt-palace', 1),
  hyattEscalators: P(40.76567, -111.89434, 'hyatt', 1),
  spEscalators: [P(40.76703, -111.89502), P(40.76786, -111.89542), P(40.7687, -111.89626)],
  hallDeDoors: [P(40.76638, -111.89528, 'salt-palace', 1), P(40.7656, -111.89528, 'salt-palace', 1)],
  expoDoors: [P(40.76701, -111.89528, 'salt-palace', 1), P(40.7686, -111.89625, 'salt-palace', 1)],
};

// After a keynote, Hall DE empties into one concourse at once. For trips that
// leave Hall DE within 15 minutes of the end: +5 min on Salt Palace Level 1,
// +8 min when the trip changes level or goes to the Hyatt.
const KEYNOTE_ENDS = ['2026-11-10T10:45:00-07:00', '2026-11-11T10:48:00-07:00', '2026-11-12T10:30:00-07:00'].map(Date.parse);
const SURGE_WINDOW_MS = 15 * 60_000;

const metres = (a, b) => Math.abs(a.lat - b.lat) * M_PER_DEG_LAT + Math.abs(a.lng - b.lng) * M_PER_DEG_LNG;
const pathMetres = (points) => points.slice(1).reduce((sum, p, i) => sum + metres(points[i], p), 0);

// Ways out of (or into) a place: its doors for the big halls, itself otherwise.
function gates(room) {
  if (room.kind === 'hall-de') return POINTS.hallDeDoors;
  if (room.kind === 'expo') return POINTS.expoDoors;
  return [room];
}

// Shortest walk between two points in the Salt Palace, through an escalator bank if the level differs.
function insideSaltPalace(a, b) {
  if (a.level === b.level) return metres(a, b);
  return Math.min(...POINTS.spEscalators.map((e) => metres(a, e) + metres(e, b)));
}

// Walk from a Salt Palace point to a Hyatt point (or back; distance is symmetric).
function acrossBuildings(sp, hy) {
  const toDoor = insideSaltPalace(sp, POINTS.connectionDoor);
  const inHyatt = hy.level > 1 ? pathMetres([POINTS.connectionDoor, POINTS.hyattEscalators, hy]) : metres(POINTS.connectionDoor, hy);
  return toDoor + inHyatt;
}

function walkMetres(a, b) {
  if (a.building === 'hyatt' && b.building === 'hyatt') {
    return a.level === b.level ? metres(a, b) : pathMetres([a, POINTS.hyattEscalators, b]);
  }
  if (a.building === 'salt-palace' && b.building === 'salt-palace') return insideSaltPalace(a, b);
  return a.building === 'salt-palace' ? acrossBuildings(a, b) : acrossBuildings(b, a);
}

function levelChanges(a, b) {
  if (a.building === b.building) return Math.abs(a.level - b.level);
  return Math.abs(a.level - 1) + Math.abs(b.level - 1);
}

// Unrounded walking minutes between two rooms from data/venue.json, or null.
function walkMinutes(fromRoomId, toRoomId) {
  const from = venue.rooms[String(fromRoomId)];
  const to = venue.rooms[String(toRoomId)];
  if (!from || !to) return null;
  if (String(fromRoomId) === String(toRoomId)) return 0;
  let best = Infinity;
  for (const out of gates(from)) {
    for (const into of gates(to)) {
      const m = metres(from, out) + walkMetres({ ...out, building: from.building, level: from.level }, { ...into, building: to.building, level: to.level }) + metres(into, to);
      best = Math.min(best, m);
    }
  }
  return best / METRES_PER_MINUTE + LEVEL_CHANGE_MIN * levelChanges(from, to) + (from.building !== to.building ? BUILDING_CHANGE_MIN : 0);
}

function keynoteSurge(fromRoomId, toRoomId, atMs) {
  const from = venue.rooms[String(fromRoomId)];
  const to = venue.rooms[String(toRoomId)];
  if (!from || !to || from.kind !== 'hall-de') return 0;
  const justEnded = KEYNOTE_ENDS.some((end) => atMs >= end && atMs - end <= SURGE_WINDOW_MS);
  if (!justEnded) return 0;
  return to.building === 'salt-palace' && to.level === 1 ? 5 : 8;
}

const zones = venue.zones.map((z) => ({ id: z.id, label: z.label }));
const zoneRoom = new Map(venue.zones.map((z) => [z.id, z.room]));

function isZone(id) {
  return zoneRoom.has(id);
}

// Walk from a zone to a talk's room at a given moment: whole minutes (rounded
// up, as the app shows them), arrival time, and how late that is.
function walkTo(zoneId, toRoomId, { atMs, startMs }) {
  const fromRoomId = zoneRoom.get(zoneId);
  const base = fromRoomId ? walkMinutes(fromRoomId, toRoomId) : null;
  if (base === null) return null;
  const surge = keynoteSurge(fromRoomId, toRoomId, atMs);
  const minutes = Math.ceil(base + surge);
  const arriveMs = atMs + minutes * 60_000;
  return {
    minutes,
    afterKeynote: surge > 0,
    arrive: new Date(arriveMs).toISOString(),
    minutesLate: Math.max(0, Math.ceil((arriveMs - startMs) / 60_000)),
  };
}

module.exports = { walkMinutes, walkTo, keynoteSurge, isZone, zones };
