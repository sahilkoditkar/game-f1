// Open-world ("Horizon") definition: regions, the road network, and everything
// placed along it. Coordinates are metres; +x is east, +z is south (so the map
// draws z downward). The world is a 6 km square centred on the origin.
//
// Roads are Catmull-Rom control-point lists. Items on roads are placed by
// `t`, the fraction of the road's length from its first point.

export const WORLD_HALF = 3000;   // half-size of the drivable square
export const SEA_Z = 2600;        // coastline: terrain drops into the sea south of here
export const SEA_LEVEL = -7;

/** Regions blend by distance from a centre; `grass` is whatever is left over. */
export const REGIONS = [
  { id: 'alpine', name: 'Frostpeak Pass', cx: 0, cz: -2700, r: 1000, soft: 800 },
  { id: 'forest', name: 'Pinewood Hills', cx: -1900, cz: -1200, r: 950, soft: 650 },
  { id: 'desert', name: 'Red Mesa Flats', cx: 2250, cz: -600, r: 950, soft: 650 },
  { id: 'city', name: 'Apex City', cx: 1900, cz: 1900, r: 560, soft: 260 },
  { id: 'coast', name: 'Azure Shore' },   // z-based, see World.regionWeights
  { id: 'grass', name: 'Meadowvale' },
];

const RING_R = 1750;
function ring(n = 20) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = Math.PI / 2 + (i / n) * Math.PI * 2;  // start at the south point (0, +R)
    const r = RING_R + 140 * Math.sin(a * 3 + 0.6) + 70 * Math.sin(a * 5 - 1.1);
    pts.push([Math.round(Math.cos(a) * r), Math.round(Math.sin(a) * r)]);
  }
  return pts;
}

// City grid helpers
const CITY_X0 = 1500, CITY_Z0 = 1450, CITY_STEP = 165, CITY_N = 6;
const CITY_X1 = CITY_X0 + CITY_STEP * (CITY_N - 1), CITY_Z1 = CITY_Z0 + CITY_STEP * (CITY_N - 1);
export const CITY = { x0: CITY_X0, z0: CITY_Z0, x1: CITY_X1, z1: CITY_Z1, step: CITY_STEP };

function cityStreets() {
  const out = [];
  for (let i = 0; i < CITY_N; i++) {
    const x = CITY_X0 + i * CITY_STEP;
    const z = CITY_Z0 + i * CITY_STEP;
    // north-south street i (the middle one runs on south to the coast highway)
    const ns = [[x, CITY_Z0 - 30], [x, CITY_Z0], [x, (CITY_Z0 + CITY_Z1) / 2], [x, CITY_Z1]];
    if (i === 2) ns.push([x, CITY_Z1 + 200], [x - 40, 2290]);   // on to the coast highway
    else ns.push([x, CITY_Z1 + 30]);
    if (i === 0) ns.unshift([1500, 1150], [1430, 1000]);       // up to the ring road
    out.push({ id: `st-ns${i}`, name: ['Harbour St', 'Festival Ave', 'Apex Blvd', 'Neon Row', 'Dock Lane', 'Skyline Dr'][i], kind: 'street', width: 13, points: ns });
    // east-west street i (the first one is the avenue in from the ring road)
    const ew = [[CITY_X0 - 30, z], [CITY_X0, z], [(CITY_X0 + CITY_X1) / 2, z], [CITY_X1, z], [CITY_X1 + 30, z]];
    if (i === 0) ew.unshift([1150, 1320], [1330, 1420]);
    out.push({ id: `st-ew${i}`, name: ['Grand Avenue', 'Market St', 'Union St', 'Pier Rd', 'Beacon St', 'Cannery Row'][i], kind: 'street', width: 13, points: ew });
  }
  return out;
}

/**
 * kind: highway (wide, dual carriageway look) | road (two-lane) | lane (narrow
 * country road) | dirt (gravel trail, no markings) | street (city, kerbs).
 */
export const ROADS = [
  { id: 'ring', name: 'Horizon Ring', kind: 'highway', width: 20, closed: true, points: ring() },
  { id: 'coast', name: 'Shoreline Highway', kind: 'highway', width: 18,
    points: [[-2950, 2330], [-2400, 2260], [-1800, 2340], [-1200, 2250], [-600, 2320], [0, 2270], [600, 2330], [1200, 2280], [1800, 2310], [2400, 2250], [2950, 2300]] },
  { id: 'spine', name: 'Meridian Road', kind: 'road', width: 14,
    points: [[40, 2275], [230, 1690], [120, 900], [-120, 0], [-60, -900], [150, -1760], [0, -2400], [-200, -2950]] },
  { id: 'ew', name: 'Old Valley Road', kind: 'road', width: 14,
    points: [[-2950, 150], [-2300, 320], [-1750, 180], [-1200, 100], [-400, -100], [400, 200], [1200, 50], [1750, -150], [2300, -250], [2950, -50]] },
  { id: 'trail', name: 'Pinewood Trail', kind: 'dirt', width: 9,
    points: [[-2500, -2300], [-2250, -2050], [-2000, -1700], [-1700, -1900], [-1500, -1550], [-1250, -1350], [-1400, -950], [-1100, -650], [-900, -350], [-760, -120], [-700, 180]] },
  { id: 'pass', name: 'Frostpeak Pass', kind: 'lane', width: 10,
    points: [[-700, -1800], [-420, -2050], [-800, -2250], [-380, -2450], [-760, -2650], [-350, -2780], [-120, -2700]] },
  { id: 'canyon', name: 'Canyon Loop', kind: 'road', width: 14, closed: true,
    points: [[1750, -200], [2200, -600], [2650, -450], [2850, -950], [2550, -1350], [2050, -1500], [1800, -1150], [1600, -700]] },
  { id: 'farm1', name: 'Orchard Lane', kind: 'lane', width: 11,
    points: [[-1400, 1060], [-1200, 980], [-800, 1120], [-300, 820], [100, 900]] },
  { id: 'farm2', name: 'Millbrook Lane', kind: 'lane', width: 11,
    points: [[-1760, -20], [-1420, 560], [-1120, 1280], [-900, 1800], [-700, 2320]] },
  { id: 'hilltop', name: 'Ridge Road', kind: 'lane', width: 10,
    points: [[880, -1520], [620, -1120], [900, -720], [1300, -520], [1750, -200]] },
  { id: 'dunes', name: 'Dune Track', kind: 'dirt', width: 10,
    points: [[2300, -250], [2500, 200], [2850, 450], [2700, 850], [2350, 1100], [2500, 1500], [2750, 1900], [2800, 2260]] },
  ...cityStreets(),
];

/** Event markers: each existing circuit/stage lives somewhere in the world. */
export const EVENTS = [
  { id: 'sunrise', road: 'ring', t: 0.06, side: 1, laps: 2, ai: 6 },
  { id: 'coastal', road: 'coast', t: 0.22, side: -1, laps: 2, ai: 6 },
  { id: 'harbor', road: 'coast', t: 0.72, side: -1, laps: 3, ai: 6 },
  { id: 'desert', road: 'canyon', t: 0.3, side: 1, laps: 2, ai: 6 },
  { id: 'canyon', road: 'canyon', t: 0.68, side: -1, laps: 2, ai: 6 },
  { id: 'alpine', road: 'pass', t: 0.12, side: 1, laps: 2, ai: 6 },
  { id: 'pinecrest', road: 'trail', t: 0.33, side: 1, laps: 2, ai: 6 },
  { id: 'neon', road: 'st-ns3', t: 0.5, side: 1, laps: 3, ai: 6 },
  { id: 'silverstone', road: 'ew', t: 0.33, side: -1, laps: 2, ai: 8 },
  { id: 'monza', road: 'ring', t: 0.62, side: 1, laps: 2, ai: 8 },
  { id: 'spa', road: 'trail', t: 0.62, side: -1, laps: 2, ai: 8 },
  { id: 'interlagos', road: 'farm1', t: 0.5, side: 1, laps: 2, ai: 8 },
  { id: 'redbull', road: 'spine', t: 0.86, side: -1, laps: 2, ai: 8 },
  { id: 'bahrain', road: 'ew', t: 0.84, side: 1, laps: 2, ai: 8 },
  { id: 'cota', road: 'hilltop', t: 0.5, side: 1, laps: 2, ai: 8 },
  { id: 'zandvoort', road: 'coast', t: 0.06, side: -1, laps: 2, ai: 8 },
  { id: 'summit', road: 'pass', t: 0.94, side: 1, laps: 1, ai: 5 },
  { id: 'coastroad', road: 'coast', t: 0.5, side: -1, laps: 1, ai: 5 },
  { id: 'dunes', road: 'dunes', t: 0.45, side: 1, laps: 1, ai: 5 },
  { id: 'forestrally', road: 'trail', t: 0.1, side: -1, laps: 1, ai: 5 },
];

/** Prize money by finishing position for an event, scaled by the field size. */
export const EVENT_PRIZE = [6000, 4200, 3000, 2200, 1600, 1200, 900, 700, 500, 400, 300, 200];

/** Speed traps: a camera gantry; the star rating is by the speed through it. Thresholds are km/h for 1/2/3 stars. */
export const TRAPS = [
  { id: 'trap-ring-s', road: 'ring', t: 0.15, stars: [130, 180, 220] },
  { id: 'trap-ring-w', road: 'ring', t: 0.4, stars: [130, 180, 220] },
  { id: 'trap-ring-n', road: 'ring', t: 0.7, stars: [130, 180, 220] },
  { id: 'trap-ring-e', road: 'ring', t: 0.9, stars: [130, 180, 220] },
  { id: 'trap-coast-w', road: 'coast', t: 0.36, stars: [130, 180, 220] },
  { id: 'trap-coast-e', road: 'coast', t: 0.62, stars: [130, 180, 220] },
  { id: 'trap-spine', road: 'spine', t: 0.3, stars: [110, 150, 190] },
  { id: 'trap-valley', road: 'ew', t: 0.6, stars: [110, 150, 190] },
  { id: 'trap-canyon', road: 'canyon', t: 0.15, stars: [110, 150, 190] },
  { id: 'trap-city', road: 'st-ew2', t: 0.55, stars: [85, 115, 150] },
];

/** Drift zones: score accumulates while sliding between the two signs. Star thresholds are per 100 m of zone. */
const DRIFT_STARS = [700, 2000, 4000];
export const DRIFTS = [
  { id: 'drift-pass', road: 'pass', t0: 0.3, t1: 0.5, stars: DRIFT_STARS, perHundred: true },
  { id: 'drift-trail', road: 'trail', t0: 0.4, t1: 0.55, stars: DRIFT_STARS, perHundred: true },
  { id: 'drift-canyon', road: 'canyon', t0: 0.78, t1: 0.92, stars: DRIFT_STARS, perHundred: true },
  { id: 'drift-mill', road: 'farm2', t0: 0.3, t1: 0.45, stars: DRIFT_STARS, perHundred: true },
  { id: 'drift-ridge', road: 'hilltop', t0: 0.2, t1: 0.36, stars: DRIFT_STARS, perHundred: true },
  { id: 'drift-dunes', road: 'dunes', t0: 0.55, t1: 0.72, stars: DRIFT_STARS, perHundred: true },
];

/** Speed zones: average speed between the two signs. Thresholds in km/h. */
export const SPEEDZONES = [
  { id: 'zone-coast', road: 'coast', t0: 0.8, t1: 0.92, stars: [110, 150, 185] },
  { id: 'zone-ring', road: 'ring', t0: 0.25, t1: 0.32, stars: [110, 150, 185] },
  { id: 'zone-valley', road: 'ew', t0: 0.1, t1: 0.2, stars: [95, 130, 165] },
  { id: 'zone-spine', road: 'spine', t0: 0.55, t1: 0.65, stars: [95, 130, 165] },
];

export const BOARD_COUNT = 40;
export const BOARD_XP = 250;

/** XP needed to reach each level; beyond the table it grows by the last step. */
export function levelForXp(xp) {
  let lvl = 1, need = 1500;
  while (xp >= need) { xp -= need; lvl++; need = Math.round(need * 1.18); }
  return { level: lvl, into: xp, need };
}
