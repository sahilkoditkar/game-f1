// Open-world ("Horizon") definition: regions, the road network, and everything
// placed along it. Coordinates are metres; +x is east, +z is south (so the map
// draws z downward). The world is an island about 6 km across, centred on the origin.
//
// Roads are Catmull-Rom control-point lists. Items on roads are placed by `t`,
// the fraction of the road's length from its first point, or by `at`, a point
// the item snaps to on its road (sturdier when a road's shape changes).

export const WORLD_HALF = 3000;   // half-size of the square the island sits in
export const SEA_Z = 2600;        // the south coast (the island's other coasts: see COAST)
export const SEA_LEVEL = -7;

/**
 * The coastline: a rounded square (superellipse) with these half-sizes, pushed out
 * by low-frequency wobble, a few headlands and pulled in by one bay. See coastDist
 * in world.js. Headlands/bays are { a: angle (atan2(z, x)), w: angular width, d: metres }.
 */
export const COAST = {
  east: 2960, west: 2960, north: 2985, south: SEA_Z, power: 4.6,
  features: [
    { name: 'Lighthouse Point', a: 2.29, w: 0.11, d: 300 },    // south-west headland
    { name: 'Driftwood Head', a: -2.72, w: 0.12, d: 200 },     // west-north-west
    { name: 'Sunset Cape', a: 0.26, w: 0.09, d: 230 },         // east
    { name: 'Crescent Bay', a: -0.79, w: 0.13, d: -330 },      // north-east corner, cut into the land
    { name: 'Gull Spit', a: 1.32, w: 0.05, d: 170 },           // a narrow spit on the south coast
    { name: 'Frost Point', a: -1.78, w: 0.1, d: 240 },         // under the mountains in the north
    { name: 'Seal Cove', a: 2.97, w: 0.07, d: -170 },          // a small cove on the west coast
  ],
};

/** Regions blend by distance from a centre; `grass` is whatever is left over. */
export const REGIONS = [
  { id: 'alpine', name: 'Frostpeak Pass', cx: 0, cz: -2700, r: 1000, soft: 800, lx: 750, lz: -2560 },
  { id: 'forest', name: 'Pinewood Hills', cx: -1900, cz: -1200, r: 950, soft: 650 },
  { id: 'desert', name: 'Red Mesa Flats', cx: 2250, cz: -600, r: 950, soft: 650, lx: 2330, lz: -960 },
  { id: 'city', name: 'Apex City', cx: 1912, cz: 1712, r: 520, soft: 280, lx: 1912, lz: 1170 },
  { id: 'coast', name: 'Azure Shore', lx: -1500, lz: 2700 },   // z-based, see World.regionWeights
  { id: 'grass', name: 'Meadowvale', lx: -700, lz: 1450 },
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

// ------------------------------------------------------------------ Apex City
// Six north-south and six east-west streets on uneven spacing, every crossing
// nudged a little so blocks are not perfect squares, two streets that stop short
// at a T, and seven ways in and out. Deterministic, so the map never changes.
const CITY_COLS = [1500, 1655, 1830, 1990, 2170, 2325];   // x of the north-south streets
const CITY_ROWS = [1300, 1462, 1630, 1790, 1962, 2125];   // z of the east-west streets
export const CITY = {
  x0: CITY_COLS[0], z0: CITY_ROWS[0], x1: CITY_COLS[5], z1: CITY_ROWS[5],
  cx: (CITY_COLS[0] + CITY_COLS[5]) / 2, cz: (CITY_ROWS[0] + CITY_ROWS[5]) / 2,
};

function cityRand(i, j, k) {
  let h = Math.imul(i * 73856093 ^ j * 19349663 ^ k * 83492791, 0x5bd1e995);
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return ((h >>> 0) / 4294967296) * 2 - 1;
}
/** A street crossing, nudged up to ~24 m (less on the outer streets so the city keeps its shape). */
function node(i, j) {
  const edge = i === 0 || i === 5 || j === 0 || j === 5;
  const k = edge ? 12 : 24;
  return [Math.round(CITY_COLS[i] + cityRand(i, j, 1) * k), Math.round(CITY_ROWS[j] + cityRand(i, j, 2) * k)];
}
const off = (p, dx, dz) => [p[0] + dx, p[1] + dz];

function cityStreets() {
  const NS = ['Harbour St', 'Festival Ave', 'Apex Blvd', 'North Gate Rd', 'Dock Lane', 'Skyline Dr'];
  const EW = ['Grand Avenue', 'Market St', 'Union St', 'Harbour Road', 'Beacon St', 'Cannery Row'];
  // which rows / columns each street spans (two stop short at a T-junction)
  const nsSpan = [[0, 5], [0, 3], [0, 5], [0, 5], [1, 5], [0, 5]];
  const ewSpan = [[0, 5], [0, 5], [0, 5], [0, 5], [2, 5], [0, 5]];
  const out = [];
  for (let i = 0; i < 6; i++) {
    const [a, b] = nsSpan[i];
    const pts = [];
    for (let j = a; j <= b; j++) pts.push(node(i, j));
    // the outer streets carry on a little past the corners so the corners meet cleanly
    if (a === 0) pts.unshift(off(pts[0], 0, -26)); else pts.unshift(off(pts[0], 0, -8));
    if (b === 5) pts.push(off(pts[pts.length - 1], 0, 26)); else pts.push(off(pts[pts.length - 1], 0, 8));
    if (i === 2) pts.splice(pts.length - 1, 1, off(node(2, 5), -4, 90), [node(2, 5)[0] - 12, 2300]);   // south to the coast highway
    if (i === 5) pts.splice(pts.length - 1, 1, off(node(5, 5), 6, 70), [node(5, 5)[0] + 10, 2262]);    // south to the coast highway
    if (i === 3) pts.splice(0, 1, [1822, 718], [1905, 960], off(node(3, 0), -22, -160));                 // north out to the ring road
    out.push({ id: `st-ns${i}`, name: NS[i], kind: 'street', width: 13, points: pts });
  }
  for (let j = 0; j < 6; j++) {
    const [a, b] = ewSpan[j];
    const pts = [];
    for (let i = a; i <= b; i++) pts.push(node(i, j));
    if (a === 0) pts.unshift(off(pts[0], -26, 0)); else pts.unshift(off(pts[0], -8, 0));
    pts.push(off(pts[pts.length - 1], 26, 0));
    if (j === 0) pts.splice(0, 1, [1262, 1290], off(node(0, 0), -110, -4));        // west to the ring road
    if (j === 2) pts.splice(pts.length - 1, 1, off(node(5, 2), 170, 10), [2726, node(5, 2)[1] + 6]);   // east to the coast highway
    if (j === 4) pts.splice(pts.length - 1, 1, off(node(5, 4), 160, -6), [2694, node(5, 4)[1] - 4]);  // east to the coast highway
    if (j === 3) pts.splice(0, 1, [180, 1958], [430, 1965], [820, 1935], [1250, 1830]);                   // west across the farms to Meridian Road
    out.push({ id: `st-ew${j}`, name: EW[j], kind: 'street', width: 13, points: pts });
  }
  return out;
}

/**
 * kind: highway (wide, dual carriageway look) | road (two-lane) | lane (narrow
 * country road) | dirt (gravel trail, no markings) | street (city, kerbs).
 */
export const ROADS = [
  { id: 'ring', name: 'Horizon Ring', kind: 'highway', width: 20, closed: true, points: ring() },
  // leaves the ring in the west, runs down the west coast, along the south shore
  // past the city and back up the east side to the ring
  { id: 'coast', name: 'Shoreline Highway', kind: 'highway', width: 18,
    points: [[-1730, 595], [-2150, 720], [-2560, 980], [-2740, 1450], [-2680, 1960], [-2380, 2250], [-1800, 2340], [-1200, 2250],
      [-600, 2320], [0, 2270], [600, 2330], [1200, 2280], [1800, 2310], [2380, 2240], [2690, 1960], [2730, 1420], [2560, 920], [2220, 560], [1840, 420]] },
  { id: 'spine', name: 'Meridian Road', kind: 'road', width: 14,
    points: [[40, 2275], [230, 1690], [120, 900], [-120, 0], [-60, -900], [150, -1760], [0, -2400], [-150, -2715]] },
  { id: 'ew', name: 'Old Valley Road', kind: 'road', width: 14,
    points: [[-2560, 255], [-2300, 320], [-1750, 180], [-1200, 100], [-400, -100], [400, 200], [1200, 50], [1750, -150], [2300, -250], [2560, -430]] },
  { id: 'trail', name: 'Pinewood Trail', kind: 'dirt', width: 9,
    points: [[-2500, -2300], [-2250, -2050], [-2000, -1700], [-1700, -1900], [-1500, -1550], [-1250, -1350], [-1400, -950], [-1100, -650], [-900, -350], [-760, -120], [-700, 180]] },
  { id: 'canyongate', name: 'Canyon Gate Road', kind: 'road', width: 14,
    points: [[2000, -195], [2045, -310], [2080, -420]] },
  { id: 'pass', name: 'Frostpeak Pass', kind: 'lane', width: 10,
    points: [[-700, -1800], [-760, -2020], [-430, -2090], [-800, -2250], [-380, -2450], [-760, -2650], [-350, -2780], [-120, -2700], [150, -2620], [420, -2420], [600, -2250]] },
  { id: 'canyon', name: 'Canyon Loop', kind: 'road', width: 14, closed: true,
    points: [[2080, -420], [2350, -650], [2620, -470], [2720, -960], [2550, -1350], [2050, -1500], [1950, -1150], [1900, -700]] },
  { id: 'farm1', name: 'Orchard Lane', kind: 'lane', width: 11,
    points: [[-1400, 1060], [-1200, 980], [-800, 1120], [-300, 820], [100, 900]] },
  { id: 'farm2', name: 'Millbrook Lane', kind: 'lane', width: 11,
    points: [[-1760, -20], [-1420, 560], [-1120, 1280], [-900, 1800], [-700, 2320]] },
  { id: 'hilltop', name: 'Ridge Road', kind: 'lane', width: 10,
    points: [[880, -1520], [620, -1120], [900, -720], [1250, -450], [1450, -45]] },
  { id: 'dunes', name: 'Dune Track', kind: 'dirt', width: 10,
    points: [[2300, -250], [2500, 200], [2700, 450], [2640, 760], [2560, 905]] },
  // a long country lane up the west side: coast highway → forest → over to the pass
  { id: 'timber', name: 'Timberline Road', kind: 'lane', width: 10,
    points: [[-2525, 985], [-2500, 650], [-2580, 250], [-2650, -400], [-2550, -1100], [-2720, -1700],
      [-2500, -2300], [-2150, -2560], [-1650, -2620], [-1250, -2420], [-800, -2250]] },
  // over the top of the map from the mountains to the desert
  { id: 'mesa', name: 'Mesa Road', kind: 'road', width: 14,
    points: [[100, -2150], [600, -2250], [1200, -2150], [1800, -1950], [2300, -1700], [2550, -1350]] },
  { id: 'sunflower', name: 'Sunflower Lane', kind: 'lane', width: 11,
    points: [[180, 1300], [600, 1150], [950, 800], [1250, 700], [1500, 840]] },
  { id: 'quarry', name: 'Quarry Track', kind: 'dirt', width: 9,
    points: [[-85, -500], [-450, -650], [-800, -1000], [-1250, -1350]] },
  ...cityStreets(),
];

/** Event markers: each existing circuit/stage lives somewhere in the world. */
export const EVENTS = [
  { id: 'sunrise', road: 'ring', t: 0.06, side: 1, laps: 2, ai: 6 },
  { id: 'coastal', road: 'coast', at: [-1650, 2310], side: -1, laps: 2, ai: 6 },
  { id: 'harbor', road: 'coast', at: [1300, 2285], side: -1, laps: 3, ai: 6 },
  { id: 'desert', road: 'canyon', t: 0.3, side: 1, laps: 2, ai: 6 },
  { id: 'canyon', road: 'canyon', t: 0.68, side: -1, laps: 2, ai: 6 },
  { id: 'alpine', road: 'pass', t: 0.12, side: 1, laps: 2, ai: 6 },
  { id: 'pinecrest', road: 'trail', t: 0.33, side: 1, laps: 2, ai: 6 },
  { id: 'neon', road: 'st-ns3', at: [1990, 1710], side: 1, laps: 3, ai: 6 },
  { id: 'silverstone', road: 'ew', at: [-1450, 140], side: -1, laps: 2, ai: 8 },
  { id: 'monza', road: 'ring', t: 0.62, side: 1, laps: 2, ai: 8 },
  { id: 'spa', road: 'trail', t: 0.62, side: -1, laps: 2, ai: 8 },
  { id: 'interlagos', road: 'farm1', t: 0.5, side: 1, laps: 2, ai: 8 },
  { id: 'redbull', road: 'spine', at: [190, 1500], side: -1, laps: 2, ai: 8 },
  { id: 'bahrain', road: 'ew', at: [1100, 75], side: 1, laps: 2, ai: 8 },
  { id: 'cota', road: 'hilltop', t: 0.5, side: 1, laps: 2, ai: 8 },
  { id: 'zandvoort', road: 'coast', at: [-2725, 1700], side: -1, laps: 2, ai: 8 },
  { id: 'summit', road: 'pass', at: [-560, -2700], side: 1, laps: 1, ai: 5 },
  { id: 'coastroad', road: 'coast', at: [-330, 2290], side: -1, laps: 1, ai: 5 },
  { id: 'dunes', road: 'dunes', at: [2560, 260], side: 1, laps: 1, ai: 5 },
  { id: 'forestrally', road: 'trail', t: 0.1, side: -1, laps: 1, ai: 5 },
];

/**
 * Championships live in the world: each series (data.js SERIES) has a venue on a road.
 * `at` is where to look; the venue moves along the road to a quiet stretch (clear of
 * junctions and other markers).
 */
export const CHAMPIONSHIPS = [
  { series: 'rookie', road: 'farm2', at: [-1000, 1550] },
  { series: 'pro', road: 'canyon', at: [2700, -760] },
  { series: 'gp', road: 'coast', at: [-2700, 1250] },
  { series: 'legends', road: 'mesa', at: [1500, -2050] },
];

/** Prize money by finishing position for an event, scaled by the field size. */
export const EVENT_PRIZE = [6000, 4200, 3000, 2200, 1600, 1200, 900, 700, 500, 400, 300, 200];

/** Speed traps: a camera gantry; the star rating is by the speed through it. Thresholds are km/h for 1/2/3 stars. */
export const TRAPS = [
  { id: 'trap-ring-s', road: 'ring', t: 0.18, stars: [130, 180, 220] },
  { id: 'trap-ring-w', road: 'ring', t: 0.4, stars: [130, 180, 220] },
  { id: 'trap-ring-n', road: 'ring', t: 0.7, stars: [130, 180, 220] },
  { id: 'trap-ring-e', road: 'ring', t: 0.9, stars: [130, 180, 220] },
  { id: 'trap-coast-w', road: 'coast', at: [-830, 2300], stars: [130, 180, 220] },
  { id: 'trap-coast-e', road: 'coast', at: [700, 2320], stars: [130, 180, 220] },
  { id: 'trap-spine', road: 'spine', at: [160, 1100], stars: [110, 150, 190] },
  { id: 'trap-valley', road: 'ew', at: [0, 30], stars: [110, 150, 190] },
  { id: 'trap-canyon', road: 'canyon', t: 0.15, stars: [110, 150, 190] },
  { id: 'trap-city', road: 'st-ew2', at: [1745, 1630], stars: [85, 115, 150] },
];

/** Drift zones: score accumulates while sliding between the two signs. Star thresholds are per 100 m of zone. */
const DRIFT_STARS = [700, 2000, 4000];
export const DRIFTS = [
  { id: 'drift-pass', road: 'pass', at0: [-600, -2330], at1: [-650, -2600], stars: DRIFT_STARS, perHundred: true },
  { id: 'drift-trail', road: 'trail', at0: [-1700, -1900], at1: [-1460, -1510], stars: DRIFT_STARS, perHundred: true },
  { id: 'drift-canyon', road: 'canyon', t0: 0.78, t1: 0.92, stars: DRIFT_STARS, perHundred: true },
  { id: 'drift-mill', road: 'farm2', at0: [-1560, 320], at1: [-1330, 780], stars: DRIFT_STARS, perHundred: true },
  { id: 'drift-ridge', road: 'hilltop', t0: 0.2, t1: 0.36, stars: DRIFT_STARS, perHundred: true },
  { id: 'drift-dunes', road: 'dunes', at0: [2620, 380], at1: [2650, 700], stars: DRIFT_STARS, perHundred: true },
];

/** Speed zones: average speed between the two signs. Thresholds in km/h. */
export const SPEEDZONES = [
  { id: 'zone-coast', road: 'coast', at0: [2725, 1800], at1: [2650, 1100], stars: [110, 150, 185] },
  { id: 'zone-ring', road: 'ring', t0: 0.25, t1: 0.32, stars: [110, 150, 185] },
  { id: 'zone-valley', road: 'ew', at0: [-2250, 310], at1: [-1850, 210], stars: [95, 130, 165] },
  { id: 'zone-spine', road: 'spine', at0: [-75, -580], at1: [-20, -1050], stars: [95, 130, 165] },
];

export const BOARD_COUNT = 40;
export const BOARD_XP = 250;

/** XP needed to reach each level; beyond the table it grows by the last step. */
export function levelForXp(xp) {
  let lvl = 1, need = 1500;
  while (xp >= need) { xp -= need; lvl++; need = Math.round(need * 1.18); }
  return { level: lvl, into: xp, need };
}
