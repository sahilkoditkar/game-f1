// Open-world model: terrain, the road network and the things placed on it.
// Exposes the same surface the race `Track` does (samples, nearestIndex,
// lateral, heightAtPos, slopeAtPos, _param, theme...) so the car physics and
// drift effects run unchanged on it. Rendering lives in horizon.js.
import * as THREE from 'three';
import { sampleSpline } from './track.js';
import { THEMES } from './tracks.js';
import {
  ROADS, REGIONS, EVENTS, TRAPS, DRIFTS, SPEEDZONES, BOARD_COUNT, WORLD_HALF, SEA_LEVEL, CITY, CITY_OUTSKIRTS, CITY_PLAZAS, cityNode, COAST, CHAMPIONSHIPS, GARAGES,
} from './worlddef.js';
import { getTrack } from './tracks.js';
import { getSeries } from './data.js';

const SPACING = 2;

// ------------------------------------------------------------------ Noise
function hash2(ix, iz) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function vnoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz), b = hash2(ix + 1, iz), c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  return ((a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v) * 2 - 1;
}
/** Fractal noise in [-1, 1]-ish; `s` is the base wavelength in metres. */
export function fbm(x, z, s, oct = 3, seed = 0) {
  let sum = 0, amp = 0.55, f = 1 / s, norm = 0;
  for (let i = 0; i < oct; i++) { sum += amp * vnoise(x * f + seed * 17.3, z * f - seed * 9.1); norm += amp; amp *= 0.5; f *= 2.05; }
  return sum / norm;
}
export function smoothstep(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

// ------------------------------------------------------------------ Coastline
/** Radius of the plain superellipse coast along direction (c, s) = (cos, sin). */
function coastBase(c, s) {
  const a = c >= 0 ? COAST.east : COAST.west, b = s >= 0 ? COAST.south : COAST.north, p = COAST.power;
  return 1 / Math.pow(Math.abs(c / a) ** p + Math.abs(s / b) ** p, 1 / p);
}
/** Outward push of the coast at angle th: wobble, headlands and bays. */
function coastWobble(th) {
  // noise sampled round a circle so it wraps seamlessly
  const f = fbm(Math.cos(th) * 900, Math.sin(th) * 900, 300, 3, 31);
  let d = Math.max(0, 95 + 125 * f);
  for (const ft of COAST.features) {
    let da = th - ft.a;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    d += ft.d * Math.exp(-((da / ft.w) ** 2));
  }
  return d;
}
/** Signed distance to the coast in metres (roughly): positive on land, negative at sea. */
export function coastDist(x, z) {
  const r = Math.hypot(x, z);
  if (r < 1) return 2600;
  const c = x / r, s = z / r;
  const R = coastBase(c, s);
  if (R - r > 900) return R - r;          // well inland: skip the noise
  return R + coastWobble(Math.atan2(z, x)) - r;
}
/** A point `offset` metres seaward of the coast at angle th. */
export function coastPointAt(th, offset = 0) {
  const c = Math.cos(th), s = Math.sin(th);
  const r = coastBase(c, s) + coastWobble(th) + offset;
  return [c * r, s * r];
}
/** The coastline as a closed list of [x, z] points. */
export function coastline(n = 1440) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const th = -Math.PI + (i / n) * Math.PI * 2;
    const c = Math.cos(th), s = Math.sin(th);
    const r = coastBase(c, s) + coastWobble(th);
    out.push([c * r, s * r]);
  }
  return out;
}

export function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export class World {
  constructor() {
    // A daytime theme for the shared systems (fx, lights). Ground colours per region are in horizon.js.
    this.theme = { ...THEMES.grass, name: 'horizon' };
    this.open = false;
    this.spacing = SPACING;
    this.half = WORLD_HALF;
    this._buildRoads();
    this._buildGrid();
    this._reconcileJunctions();
    this._finishSamples();
    this._buildGraph();
    this._buildCity();
    this._placeItems();
    this._placeProps();
  }

  // ------------------------------------------------------------ Regions & terrain
  /** Blend weights of each region at a point; they sum to 1. */
  regionWeights(x, z) {
    const w = {};
    let sum = 0;
    for (const r of REGIONS) {
      if (!r.r) continue;
      // the city's edge wanders a little so it isn't a perfect circle
      const d = Math.hypot(x - r.cx, z - r.cz) * (r.id === 'city' ? 1 + 0.12 * fbm(x, z, 260, 2, 12) : 1);
      w[r.id] = 1 - smoothstep(r.r, r.r + r.soft, d);
      sum += w[r.id];
    }
    w.coast = smoothstep(1350, 2150, z) * (1 - w.city);
    sum += w.coast;
    if (sum > 1) { for (const k in w) w[k] /= sum; sum = 1; }
    w.grass = 1 - sum;
    return w;
  }

  /** Dominant region at a point. */
  regionAt(x, z) {
    const w = this.regionWeights(x, z);
    let best = 'grass', bw = -1;
    for (const k in w) if (w[k] > bw) { bw = w[k]; best = k; }
    return REGIONS.find(r => r.id === best);
  }

  /** Natural ground height before roads are cut in. */
  baseHeight(x, z) {
    const w = this.regionWeights(x, z);
    let h = 0;
    if (w.grass > 0.001) h += w.grass * (11 * fbm(x, z, 720, 3, 1) + 3 * fbm(x, z, 150, 2, 2));
    if (w.forest > 0.001) h += w.forest * (14 + 34 * fbm(x, z, 640, 3, 3) + 6 * fbm(x, z, 140, 2, 4));
    if (w.desert > 0.001) {
      const m = fbm(x, z, 520, 3, 5);
      h += w.desert * (6 + 8 * fbm(x, z, 320, 2, 6) + 42 * smoothstep(0.12, 0.42, m));
    }
    if (w.alpine > 0.001) h += w.alpine * (60 + 150 * (fbm(x, z, 950, 3, 7) + 0.55) + 35 * fbm(x, z, 260, 2, 8));
    if (w.city > 0.001) h += w.city * (2 + 1.5 * fbm(x, z, 300, 2, 9));
    if (w.coast > 0.001) h += w.coast * (3 + 5 * fbm(x, z, 500, 3, 10));
    // the shore: drop into the sea all round the island
    const sea = 1 - smoothstep(-140, 220, coastDist(x, z));
    h = h * (1 - sea) + (SEA_LEVEL - 7) * sea;
    return h;
  }

  /**
   * Final terrain height: hugs the roads nearby (flat shoulder, then a blend
   * back to the natural ground), natural elsewhere.
   */
  terrainHeight(x, z) {
    const base = this.baseHeight(x, z);
    const near = this.nearestGlobal(x, z, 2);
    if (near.idx < 0) return this._onPads(x, z, base);
    const s = this.samples[near.idx];
    // flat out to 8 m past the edge: the terrain mesh is a 10 m grid, so a hillside
    // vertex any closer would slope up through the asphalt between grid points
    const edge = s.hw + 8;
    const ry = s.yl === undefined ? s.p.y : this.surfaceAt(s, (x - s.p.x) * s.n.x + (z - s.p.z) * s.n.z);
    let h;
    if (near.dist <= edge) h = ry - 0.12;
    else { const k = smoothstep(edge, edge + 45, near.dist); h = (ry - 0.12) * (1 - k) + base * k; }
    h = this._onPads(x, z, h);
    // a levelled pad beside a road must never lift the ground over the road or its verge
    if (near.dist <= s.hw + 4) h = Math.min(h, ry - 0.12);
    return h;
  }

  /** Level ground under buildings with a forecourt (Festival HQ): flat inside, blended out over 30 m. */
  _onPads(x, z, h) {
    for (const p of this.pads || []) {
      const d = Math.hypot(x - p.x, z - p.z);
      if (d < p.r) return p.y - 0.02;
      if (d < p.r + 30) { const k = smoothstep(p.r, p.r + 30, d); h = (p.y - 0.02) * (1 - k) + h * k; }
    }
    return h;
  }

  // ------------------------------------------------------------ Roads
  /**
   * Open roads that end near another road are extended to meet it exactly, so
   * every T-junction lands on the other road's centreline instead of stopping
   * short of it or overshooting.
   */
  _snapEndpoints() {
    const sampled = ROADS.map(def => ({ def, pts: sampleSpline(def.points, SPACING * 2, !def.closed, def.straight) }));
    const SNAP = 230, EDGE = WORLD_HALF - 120;
    const RANK = { highway: 4, road: 3, street: 2, lane: 1, dirt: 0 };
    return sampled.map(({ def, pts }, ri) => {
      if (def.closed) return def;
      const points = def.points.map(p => [p[0], p[1]]);
      for (const end of [0, points.length - 1]) {
        const ex = points[end][0], ez = points[end][1];
        // roads running off the edge of the map are exits, not junctions
        if (Math.abs(ex) > EDGE || Math.abs(ez) > EDGE) continue;
        // an end joined to another road's end stays where it is
        if (def.freeEnds && def.freeEnds.includes(end === 0 ? 'start' : 'end')) continue;
        // Prefer a road of equal or higher standing (so a highway never bends to meet a lane);
        // if there is none in reach, any road will do (a city street ending on a country lane).
        // Only onto its interior, never onto its own ends.
        let best = null;
        for (const anyRank of [false, true]) {
          let bd = SNAP * SNAP;
          sampled.forEach((o, oi) => {
            if (oi === ri) return;
            if (!anyRank && RANK[o.def.kind] < RANK[def.kind]) return;
            const margin = o.def.closed ? 0 : 6;
            for (let k = margin; k < o.pts.length - margin; k++) {
              const d = (o.pts[k][0] - ex) ** 2 + (o.pts[k][1] - ez) ** 2;
              if (d < bd) { bd = d; best = { pts: o.pts, k, def: o.def }; }
            }
          });
          if (best) break;
        }
        if (!best) continue;
        // continue a little past the centreline so the end edge hides under the other road
        const k = best.k, o = best.pts;
        const a = o[Math.max(0, k - 1)], b = o[Math.min(o.length - 1, k + 1)];
        let tx = b[0] - a[0], tz = b[1] - a[1];
        const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
        const nx = tz, nz = -tx;
        const inner = points[end === 0 ? 1 : end - 1];
        const side = Math.sign((o[k][0] - inner[0]) * nx + (o[k][1] - inner[1]) * nz) || 1;
        const over = best.def.width * 0.15;
        points[end] = [o[k][0] + nx * side * over, o[k][1] + nz * side * over];
      }
      return { ...def, points };
    });
  }

  _buildRoads() {
    this.roads = [];
    this.samples = [];
    for (const def of this._snapEndpoints()) {
      const closed = !!def.closed;
      const pts = sampleSpline(def.points, SPACING, !closed, def.straight);
      const N = pts.length;
      const i0 = this.samples.length;
      const road = { def, id: def.id, name: def.name, kind: def.kind, width: def.width, closed, i0, i1: i0 + N - 1, n: N, length: N * SPACING, yOff: 0.10 + this.roads.length * 0.0025 };
      this.roads.push(road);
      const W = (i) => closed ? ((i % N) + N) % N : Math.max(0, Math.min(N - 1, i));
      // Height: natural ground smoothed along the road, with the grade limited.
      const h = new Float32Array(N);
      for (let i = 0; i < N; i++) h[i] = this.baseHeight(pts[i][0], pts[i][1]);
      smoothProfile(h, W, closed, 18); clampGrade(h, W, closed, SPACING * 0.10); smoothProfile(h, W, closed, 12); smoothProfile(h, W, closed, 6);
      const hw = def.width / 2;
      for (let i = 0; i < N; i++) {
        const prev = pts[W(i - 1)], next = pts[W(i + 1)];
        let tx = next[0] - prev[0], tz = next[1] - prev[1];
        const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
        this.samples.push({
          p: new THREE.Vector3(pts[i][0], h[i], pts[i][1]),
          t: new THREE.Vector3(tx, 0, tz),
          n: new THREE.Vector3(tz, 0, -tx),
          heading: Math.atan2(tx, tz),
          curv: 0, slope: 0,
          hw, wall: Infinity,          // no barriers in the open world
          road: this.roads.length - 1,
          li: i,                        // index within the road
        });
      }
    }
  }

  _buildGrid() {
    this.cell = 40;
    this.grid = new Map();
    this.samples.forEach((s, i) => {
      const key = `${Math.floor(s.p.x / this.cell)},${Math.floor(s.p.z / this.cell)}`;
      let list = this.grid.get(key);
      if (!list) { list = []; this.grid.set(key, list); }
      list.push(i);
    });
  }

  /** Where roads cross, pull both to a shared height so there is no step. */
  _reconcileJunctions() {
    const pairs = [];
    const lastHit = new Map();
    const d2 = (a, b) => (a.p.x - b.p.x) ** 2 + (a.p.z - b.p.z) ** 2;
    for (let i = 0; i < this.samples.length; i++) {
      const s = this.samples[i];
      const cx = Math.floor(s.p.x / this.cell), cz = Math.floor(s.p.z / this.cell);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        const list = this.grid.get(`${cx + dx},${cz + dz}`);
        if (!list) continue;
        for (const j of list) {
          const o = this.samples[j];
          if (o.road <= s.road) continue;
          // plan distance only: the heights have not been matched yet, so a road coming
          // off a hillside can meet another several metres above or below it
          if (d2(s, o) > 36) continue;
          const key = `${s.road}:${o.road}`;
          const last = lastHit.get(key);
          if (last !== undefined && Math.abs(last - i) < 60) continue;
          lastHit.set(key, i);
          // the first pair within 6 m is not the crossing itself: walk both roads to the closest pair
          const ra = this.roads[s.road], rb = this.roads[o.road];
          let bi = i, bj = j, bd = d2(s, o);
          for (let a = -8; a <= 8; a++) for (let b = -8; b <= 8; b++) {
            const ii = this.roadWrap(ra, i + a), jj = this.roadWrap(rb, j + b);
            if (ii < 0 || jj < 0) continue;
            const d = d2(this.samples[ii], this.samples[jj]);
            if (d < bd) { bd = d; bi = ii; bj = jj; }
          }
          pairs.push([bi, bj]);
        }
      }
    }
    // The bigger road keeps its height; the smaller one blends onto it. The blend is
    // at least 100 m and long enough to keep the extra grade under about 6%.
    // Several passes: a blend at one junction moves the road under its neighbours too.
    const RANK = { highway: 4, road: 3, street: 2, lane: 1, dirt: 0 };
    for (let pass = 0; pass < 4; pass++) for (const [i, j] of pairs) {
      const ra = this.roads[this.samples[i].road], rb = this.roads[this.samples[j].road];
      const rankA = RANK[ra.kind], rankB = RANK[rb.kind];
      const wA = rankA > rankB ? 1 : rankA < rankB ? 0 : 0.5;   // share of the final height taken from road A
      const target = this.samples[i].p.y * wA + this.samples[j].p.y * (1 - wA);
      for (const c of [i, j]) {
        const road = this.roads[this.samples[c].road];
        const delta = target - this.samples[c].p.y;
        if (Math.abs(delta) < 1e-4) continue;
        const R = Math.min(400, Math.max(50, Math.ceil((Math.abs(delta) * 1.6) / (0.06 * SPACING))));
        for (let k = -R; k <= R; k++) {
          const idx = this.roadWrap(road, c + k);
          if (idx < 0) continue;
          const w = 0.5 + 0.5 * Math.cos((k / R) * Math.PI);
          this.samples[idx].p.y += delta * w;
        }
      }
    }
    this._limitGrades(pairs, 0.10);
    this._levelJunctions(pairs);
    this.junctionPairs = pairs;
    this.junctions = pairs.map(([i]) => i);
    // per-road lists for traffic: [{ li, other }] sorted along the road
    this.roadJunctions = this.roads.map(() => []);
    for (const [i, j] of pairs) {
      this.roadJunctions[this.samples[i].road].push({ li: this.samples[i].li, other: j });
      this.roadJunctions[this.samples[j].road].push({ li: this.samples[j].li, other: i });
    }
    for (const list of this.roadJunctions) list.sort((a, b) => a.li - b.li);
  }

  /**
   * Junction blends can stack up into steep ramps where crossings are close together
   * or a road drops off a hillside onto a highway. Re-limit each road's grade with its
   * junction heights pinned, so the crossings still meet exactly.
   */
  _limitGrades(pairs, grade) {
    const pins = this.roads.map(() => new Map());
    for (const [i, j] of pairs) for (const c of [i, j]) pins[this.samples[c].road].set(c - this.roads[this.samples[c].road].i0, this.samples[c].p.y);
    const m = SPACING * grade;
    this.roads.forEach((road, ri) => {
      const P = pins[ri];
      if (!P.size) return;
      const N = road.n, h = new Float32Array(N);
      for (let k = 0; k < N; k++) h[k] = this.samples[road.i0 + k].p.y;
      const W = (k) => road.closed ? ((k % N) + N) % N : Math.max(0, Math.min(N - 1, k));
      // Between two pins the grade may need to be steeper than the limit (a lane dropping
      // from the mountain ring to the valley): then that stretch climbs at a steady grade.
      const pinList = [...P.entries()].sort((a, b) => a[0] - b[0]);
      const mk = new Float32Array(N).fill(m);
      const cone = (k, y, d, mm) => [y - mm * d, y + mm * d];
      const segs = [];
      for (let q = 0; q < pinList.length - 1; q++) segs.push([pinList[q], pinList[q + 1], pinList[q + 1][0] - pinList[q][0]]);
      if (road.closed) { const a = pinList[pinList.length - 1], b = pinList[0]; segs.push([a, b, b[0] + N - a[0]]); }
      for (const [[ca, ya], [, yb], len] of segs) {
        if (len <= 0) continue;
        const mm = Math.max(m, (1.05 * Math.abs(yb - ya)) / len);
        for (let t = 0; t <= len; t++) {
          const k = W(ca + t);
          mk[k] = Math.max(mk[k], mm);
          const [l1, h1] = cone(k, ya, t, mm), [l2, h2] = cone(k, yb, len - t, mm);
          h[k] = Math.min(Math.min(h1, h2), Math.max(Math.max(l1, l2), h[k]));
        }
      }
      if (!road.closed) {
        const [c0, y0] = pinList[0], [c1, y1] = pinList[pinList.length - 1];
        for (let k = 0; k < c0; k++) { const [l, u] = cone(k, y0, c0 - k, m); h[k] = Math.min(u, Math.max(l, h[k])); }
        for (let k = c1 + 1; k < N; k++) { const [l, u] = cone(k, y1, k - c1, m); h[k] = Math.min(u, Math.max(l, h[k])); }
      }
      // then clamp step by step both ways, never moving a pin
      const passes = road.closed ? N * 2 : N - 1;
      for (let rep = 0; rep < 2; rep++) {
        for (let k = 0; k < passes; k++) {
          const a = W(k), b = W(k + 1);
          if (P.has(b)) continue;
          const mm = Math.max(mk[a], mk[b]);
          h[b] = Math.min(h[a] + mm, Math.max(h[a] - mm, h[b]));
        }
        for (let k = passes; k > 0; k--) {
          const a = W(k), b = W(k - 1);
          if (P.has(b)) continue;
          const mm = Math.max(mk[a], mk[b]);
          h[b] = Math.min(h[a] + mm, Math.max(h[a] - mm, h[b]));
        }
      }
      smoothProfile(h, W, road.closed, 4);
      for (const [c, y] of P) h[c] = y;
      for (let k = 0; k < N; k++) this.samples[road.i0 + k].p.y = h[k];
    });
  }

  /**
   * Shape every junction so the two surfaces match across the whole crossing, not
   * just at its centre. The major road (higher class; on a tie, the one running
   * through rather than ending there, then the flatter one)
   * keeps its profile. The minor road, wherever its surface can overlap the major,
   * takes the major road's surface exactly (tilted across its width if the major
   * is on a slope: per-vertex heights yl / yr), then eases back to its own profile.
   * Samples in a junction area are flagged `jz` (drawn as plain asphalt); shoulders
   * are dropped on whichever side meets the other road (noL / noR).
   */
  _levelJunctions(pairs) {
    const RANK = { highway: 4, road: 3, street: 2, lane: 1, dirt: 0 };
    const d2 = (p, x, z) => (p.x - x) ** 2 + (p.z - z) ** 2;
    const nearOn = (road, hint, x, z, span = 120) => {
      let best = -1, bd = Infinity;
      for (let k = -span; k <= span; k++) { const q = this.roadWrap(road, hint + k); if (q >= 0) { const d = d2(this.samples[q].p, x, z); if (d < bd) { bd = d; best = q; } } }
      return { idx: best, dist: Math.sqrt(bd) };
    };
    const juncs = pairs.map(([i, j]) => {
      const ri = this.roadOf(i), rj = this.roadOf(j);
      const ki = RANK[ri.kind], kj = RANK[rj.kind];
      // a road that ends here (a T) gives way to the one running through
      const ends = (q, r) => !r.closed && (this.samples[q].li < 8 || this.samples[q].li > r.n - 9);
      const ei = ends(i, ri), ej = ends(j, rj);
      const iMajor = ki !== kj ? ki > kj : ei !== ej ? ej : Math.abs(this.samples[i].slope) <= Math.abs(this.samples[j].slope);
      return iMajor ? { M: i, m: j } : { M: j, m: i };
    });
    // the minor road's zone (local index range) and the major's, around each junction
    const zoneOf = (c, o) => {
      const road = this.roadOf(c), other = this.roadOf(o);
      const reach = this.samples[o].hw + this.samples[c].hw + 4;
      const far = (q) => nearOn(other, o, this.samples[q].p.x, this.samples[q].p.z).dist > reach;
      let a = 0, b = 0;
      while (a < 120) { const q = this.roadWrap(road, c - a - 1); if (q < 0 || far(q)) break; a++; }
      while (b < 120) { const q = this.roadWrap(road, c + b + 1); if (q < 0 || far(q)) break; b++; }
      const li = this.samples[c].li;
      return { a: li - a, b: li + b };
    };
    for (const J of juncs) { J.zm = zoneOf(J.m, J.M); J.zM = zoneOf(J.M, J.m); }

    // three passes: a road can be major at one junction and minor at the next
    for (let pass = 0; pass < 3; pass++) {
      const perRoad = this.roads.map(() => []);
      for (const J of juncs) {
        const minor = this.roadOf(J.m), major = this.roadOf(J.M);
        const ys = new Map();
        let hint = J.M;
        for (let k = J.zm.a; k <= J.zm.b; k++) {
          const q = this.roadWrap(minor, minor.i0 + k);
          if (q < 0) continue;
          const s = this.samples[q];
          const at = (x, z) => { const r = this.majorSurfaceY(major, hint, x, z); hint = r.idx; return r.y; };
          ys.set(q - minor.i0, { y: at(s.p.x, s.p.z), yl: at(s.p.x + s.n.x * s.hw, s.p.z + s.n.z * s.hw), yr: at(s.p.x - s.n.x * s.hw, s.p.z - s.n.z * s.hw), major: this.roads.indexOf(major), hint });
        }
        perRoad[this.roads.indexOf(minor)].push({ a: J.zm.a, b: J.zm.b, ys });
      }
      this.roads.forEach((road, ri) => this._applyJunctionZones(road, perRoad[ri]));
    }
    // flags for the renderer: plain surface, and which shoulders to drop
    for (const J of juncs) {
      for (const [c, o, z] of [[J.m, J.M, J.zm], [J.M, J.m, J.zM]]) {
        const road = this.roadOf(c), other = this.roadOf(o);
        for (let k = z.a; k <= z.b; k++) {
          const q = this.roadWrap(road, road.i0 + k);
          if (q < 0) continue;
          const s = this.samples[q];
          s.jz = true;
          for (const side of [1, -1]) {
            const x = s.p.x + s.n.x * side * (s.hw + 1.4), zz = s.p.z + s.n.z * side * (s.hw + 1.4);
            const hit = nearOn(other, o, x, zz);
            if (hit.dist < this.samples[hit.idx].hw + 3) { if (side > 0) s.noL = true; else s.noR = true; }
          }
        }
      }
    }
  }

  /** Set a minor road's junction-zone heights and ease its profile back outside them. */
  _applyJunctionZones(road, Z) {
    if (!Z.length) return;
    const N = road.n;
    const W = (k) => road.closed ? ((k % N) + N) % N : k;
    const orig = new Float32Array(N);
    for (let k = 0; k < N; k++) orig[k] = this.samples[road.i0 + k].p.y;
    const corr = new Float32Array(N), inZone = new Uint8Array(N);
    const edge = Z.map(z => ({ a: null, b: null }));
    Z.forEach((z, zi) => {
      for (const [k, v] of z.ys) {
        const s = this.samples[road.i0 + k];
        corr[k] = v.y - orig[k]; inZone[k] = 1;
        s.yl = v.yl; s.yr = v.yr; s.jroad = v.major; s.jhint = v.hint;
      }
      const ka = W(z.a), kb = W(z.b);
      if (ka >= 0 && ka < N && z.ys.has(ka)) edge[zi].a = z.ys.get(ka).y - orig[ka];
      if (kb >= 0 && kb < N && z.ys.has(kb)) edge[zi].b = z.ys.get(kb).y - orig[kb];
    });
    const ramp = edge.map(e => Math.min(240, Math.max(20, Math.ceil((Math.max(Math.abs(e.a || 0), Math.abs(e.b || 0)) * 1.6) / (0.02 * SPACING)))));
    for (let k = 0; k < N; k++) {
      if (inZone[k]) continue;
      let num = 0, den = 0, fmax = 0;
      Z.forEach((z, zi) => {
        let dA = z.a - k, dB = k - z.b;
        if (road.closed) { dA = ((dA % N) + N) % N; dB = ((dB % N) + N) % N; }
        else if (dA < 0 && dB < 0) return;
        const useA = road.closed ? dA <= dB : dA > 0;
        const m = useA ? dA : dB;
        const e = useA ? edge[zi].a : edge[zi].b;
        if (e === null || m <= 0 || m >= ramp[zi]) return;
        const f = 0.5 + 0.5 * Math.cos(Math.PI * m / ramp[zi]);
        num += (f / m) * e; den += f / m; fmax = Math.max(fmax, f);
      });
      if (den > 0) corr[k] = (num / den) * fmax;
    }
    for (let k = 0; k < N; k++) this.samples[road.i0 + k].p.y = orig[k] + corr[k];
  }

  /**
   * Height of a road's surface at any point near it: its profile at the point's
   * projection onto the centreline, flat across. Returns { y, idx } (idx = nearest
   * sample, a good hint for the next call).
   */
  majorSurfaceY(road, hint, x, z) {
    let best = hint, bd = Infinity;
    for (let k = -60; k <= 60; k++) {
      const q = this.roadWrap(road, hint + k);
      if (q < 0) continue;
      const p = this.samples[q].p, d = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d < bd) { bd = d; best = q; }
    }
    const s = this.samples[best];
    const f = Math.max(-1, Math.min(1, ((x - s.p.x) * s.t.x + (z - s.p.z) * s.t.z) / SPACING));
    const o = this.samples[this.roadWrap(road, best + (f >= 0 ? 1 : -1), true)];
    return { y: s.p.y + (o.p.y - s.p.y) * Math.abs(f), idx: best };
  }

  /** A sample's surface height at lateral offset `lat` (tilted inside junctions). */
  surfaceAt(s, lat) {
    if (s.yl === undefined) return s.p.y;
    const t = Math.max(-1, Math.min(1, lat / s.hw));
    return t >= 0 ? s.p.y + (s.yl - s.p.y) * t : s.p.y + (s.yr - s.p.y) * -t;
  }

  _finishSamples() {
    for (const road of this.roads) {
      for (let i = road.i0; i <= road.i1; i++) {
        const s = this.samples[i];
        const a = this.samples[this.roadWrap(road, i - 1, true)], b = this.samples[this.roadWrap(road, i + 1, true)];
        s.slope = (b.p.y - a.p.y) / (SPACING * ((a === s || b === s) ? 1 : 2));
        const ha = this.samples[this.roadWrap(road, i - 2, true)].heading, hb = this.samples[this.roadWrap(road, i + 2, true)].heading;
        let d = hb - ha;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        s.curv = d / (SPACING * 4);
      }
    }
    this.count = this.samples.length;
  }

  /** Index wrap within a road: loops wrap, open roads clamp (or return -1 when `clamp` is false). */
  roadWrap(road, i, clamp = false) {
    const N = road.n;
    let li = i - road.i0;
    if (road.closed) li = ((li % N) + N) % N;
    else if (li < 0 || li >= N) { if (!clamp) return -1; li = Math.max(0, Math.min(N - 1, li)); }
    return road.i0 + li;
  }

  roadOf(idx) { return this.roads[this.samples[idx].road]; }
  getRoad(id) { return this.roads.find(r => r.id === id); }

  /** Sample index at fraction t along a named road. */
  indexAt(roadId, t) {
    const r = this.getRoad(roadId);
    return r.i0 + Math.max(0, Math.min(r.n - 1, Math.round(t * (r.n - 1))));
  }

  /** Sample index on a named road closest to a point. */
  indexNear(roadId, x, z) {
    const r = this.getRoad(roadId);
    let best = r.i0, bd = Infinity;
    for (let i = r.i0; i <= r.i1; i++) {
      const p = this.samples[i].p, d = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  /** Where a placed item sits: by `at` point if given, else by fraction `t`. */
  _itemIndex(it, which = '') {
    const at = it['at' + which];
    return at ? this.indexNear(it.road, at[0], at[1]) : this.indexAt(it.road, it['t' + which]);
  }

  /** Track-compatible: clamp a global sample index. */
  wrap(i) { return Math.max(0, Math.min(this.count - 1, i)); }
  sample(i) { return this.samples[this.wrap(i)]; }

  // ------------------------------------------------------------ Queries
  /** Nearest sample to any world point using the grid. */
  nearestGlobal(x, z, maxRing = 4) {
    const cx = Math.floor(x / this.cell), cz = Math.floor(z / this.cell);
    let best = -1, bestD = Infinity;
    for (let ring = 0; ring <= maxRing; ring++) {
      for (let dx = -ring; dx <= ring; dx++) for (let dz = -ring; dz <= ring; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
        const list = this.grid.get(`${cx + dx},${cz + dz}`);
        if (!list) continue;
        for (const i of list) {
          const s = this.samples[i];
          const d = (s.p.x - x) * (s.p.x - x) + (s.p.z - z) * (s.p.z - z);
          if (d < bestD) { bestD = d; best = i; }
        }
      }
      if (best >= 0 && Math.sqrt(bestD) < ring * this.cell) break;
    }
    return { idx: best, dist: best >= 0 ? Math.sqrt(bestD) : Infinity };
  }

  /**
   * Track-compatible nearest sample. Sticky: while the car is still within the
   * width of the road it was on, stay on that road (so crossing a junction does
   * not flip to the other road for a few frames); otherwise look up the grid.
   */
  nearestIndex(pos, hint = null) {
    if (hint !== null && hint !== undefined && hint >= 0 && hint < this.count) {
      const road = this.roadOf(hint);
      let best = -1, bd = Infinity;
      for (let k = -30; k <= 30; k++) {
        const i = this.roadWrap(road, hint + k);
        if (i < 0) continue;
        const s = this.samples[i];
        const d = (s.p.x - pos.x) * (s.p.x - pos.x) + (s.p.z - pos.z) * (s.p.z - pos.z);
        if (d < bd) { bd = d; best = i; }
      }
      if (best >= 0) {
        const hw = this.samples[best].hw;
        if (Math.abs(this.lateral(pos, best)) <= hw + 1.5 && bd < (hw + 4) * (hw + 4)) return best;
      }
    }
    const r = this.nearestGlobal(pos.x, pos.z, 3);
    if (r.idx >= 0) return r.idx;
    return hint === null || hint === undefined ? 0 : hint;
  }

  lateral(pos, idx) {
    const s = this.samples[idx];
    return (pos.x - s.p.x) * s.n.x + (pos.z - s.p.z) * s.n.z;
  }

  _param(pos, idx) {
    const s = this.samples[idx];
    const dx = pos.x - s.p.x, dz = pos.z - s.p.z;
    let f = (dx * s.t.x + dz * s.t.z) / SPACING;
    const lat = dx * s.n.x + dz * s.n.z;
    const k = 1 - s.curv * lat;
    if (k > 0.3) f /= k;
    return f;
  }

  progressAt(pos, idx) { return idx + Math.max(-0.5, Math.min(0.5, this._param(pos, idx))); }

  /** Road height between samples (Catmull-Rom), or terrain height once off the road. */
  heightAtPos(pos, idx) {
    const s = this.samples[idx];
    const lat = Math.abs(this.lateral(pos, idx));
    const road = this.roads[s.road];
    const dist = Math.hypot(pos.x - s.p.x, pos.z - s.p.z);
    const onRoad = lat <= s.hw + 1.2 && dist < s.hw + 6;
    let roadY;
    if (onRoad || lat < s.hw + 3) {
      let f = Math.max(-1, Math.min(1, this._param(pos, idx)));
      let i1 = idx, u = f;
      if (f < 0) { i1 = this.roadWrap(road, idx - 1, true); u = f + 1; }
      const h0 = this.samples[this.roadWrap(road, i1 - 1, true)].p.y, h1 = this.samples[i1].p.y;
      const h2 = this.samples[this.roadWrap(road, i1 + 1, true)].p.y, h3 = this.samples[this.roadWrap(road, i1 + 2, true)].p.y;
      const u2 = u * u, u3 = u2 * u;
      roadY = 0.5 * ((2 * h1) + (-h0 + h2) * u + (2 * h0 - 5 * h1 + 4 * h2 - h3) * u2 + (-h0 + 3 * h1 - 3 * h2 + h3) * u3);
      // inside a junction the minor road lies on the major road's surface
      if (s.jroad !== undefined) roadY = this.majorSurfaceY(this.roads[s.jroad], s.jhint, pos.x, pos.z).y;
      if (onRoad) return roadY;
    }
    const ground = this.terrainHeight(pos.x, pos.z) + 0.06;
    if (roadY === undefined) return ground;
    const k = smoothstep(s.hw + 1.2, s.hw + 3, lat);
    return roadY * (1 - k) + ground * k;
  }

  /** Slope along the road tangent at a point (used for hill gravity). */
  slopeAtPos(pos, idx) {
    const s = this.samples[idx];
    const lat = Math.abs(this.lateral(pos, idx));
    if (lat <= s.hw + 1.2) {
      const road = this.roads[s.road];
      const f = Math.max(-1, Math.min(1, this._param(pos, idx)));
      const j = this.roadWrap(road, f >= 0 ? idx + 1 : idx - 1, true);
      const w = Math.abs(f);
      return s.slope * (1 - w) + this.samples[j].slope * w;
    }
    // off-road: finite difference of the terrain along the road tangent
    const d = 3;
    const a = this.terrainHeight(pos.x - s.t.x * d, pos.z - s.t.z * d), b = this.terrainHeight(pos.x + s.t.x * d, pos.z + s.t.z * d);
    return (b - a) / (2 * d);
  }

  /** Max absolute curvature in the next `metres` (AI helper). */
  maxCurvatureAhead(idx, metres) {
    const road = this.roads[this.samples[idx].road];
    const n = Math.ceil(metres / SPACING);
    let m = 0;
    for (let k = 0; k < n; k++) m = Math.max(m, Math.abs(this.samples[this.roadWrap(road, idx + k, true)].curv));
    return m;
  }

  /** Is `idx` inside the sample range [i0, i1] of its road (ranges never wrap). */
  inRange(idx, i0, i1) { return idx >= i0 && idx <= i1; }

  // ------------------------------------------------------------ Garages & championship venues
  /**
   * The garages (GARAGES). Festival HQ sits just past the festival start on the outside
   * of the ring; the others go to a quiet stretch of their road with clear ground for
   * the building on one side. Each marker sits on the forecourt in front of the door
   * (drive onto it and press Enter); `idx` is the road sample beside it (fast travel
   * puts you there). The forecourt and building stand on a levelled pad.
   */
  _placeGarages() {
    // metres from the road edge: forecourt pad marker, building centre, levelled pad centre and radius
    const LAYOUT = { hq: { fore: 10, bld: 30, pad: 18, r: 26 }, dealer: { fore: 9, bld: 24, pad: 15, r: 22 }, tuning: { fore: 8, bld: 20, pad: 13, r: 19 } };
    const SIZE = { hq: 22, dealer: 24, tuning: 18 };    // building depth away from the road
    this.pads = [];
    this.garages = [];
    const jpts = this.junctionPairs.map(([a]) => this.samples[a].p);
    const taken = [this.hub, ...this.events, ...this.traps, ...[...this.drifts, ...this.zones].flatMap(z => [this.samples[z.i0].p, this.samples[z.i1].p])];
    const make = (def, idx, side) => {
      const L = LAYOUT[def.type], s = this.samples[idx];
      const at = (off) => ({ x: s.p.x + s.n.x * side * (s.hw + off), z: s.p.z + s.n.z * side * (s.hw + off) });
      const fore = at(L.fore), bld = at(L.bld), pad = at(L.pad);
      const rot = s.heading + (side > 0 ? Math.PI : 0);           // the building's +x (door side) faces the road
      this.pads.push({ x: pad.x, z: pad.z, r: L.r, y: s.p.y });
      const g = { id: def.id, kind: 'garage', type: def.type, name: def.name, idx, x: fore.x, z: fore.z, y: s.p.y, rot, building: { x: bld.x, z: bld.z, rot, reach: L.bld } };
      this.garages.push(g);
      taken.push(g, bld);
      return g;
    };
    /** Room for the building on this side: no other road, city block, sea or marker nearby. */
    const roomFor = (def, idx, side) => {
      const L = LAYOUT[def.type], s = this.samples[idx];
      const far = L.bld + SIZE[def.type] / 2 + 6;
      for (let off = 2; off <= far; off += 4) for (const along of [-18, 0, 18]) {
        const x = s.p.x + s.n.x * side * (s.hw + off) + s.t.x * along, z = s.p.z + s.n.z * side * (s.hw + off) + s.t.z * along;
        if (coastDist(x, z) < 50) return false;
        const near = this.nearestGlobal(x, z, 2);
        if (near.idx >= 0 && this.samples[near.idx].road !== s.road && near.dist < this.samples[near.idx].hw + 10) return false;
        if (this.buildings.some(b => Math.hypot(b.x - x, b.z - z) < b.r + 8)) return false;
      }
      const c = { x: s.p.x + s.n.x * side * (s.hw + L.bld), z: s.p.z + s.n.z * side * (s.hw + L.bld) };
      return taken.every(q => Math.hypot(q.x - c.x, q.z - c.z) > 120);
    };
    // a flat stretch (under 2% for 40 m either way), so the forecourt meets the road all along
    const flat = (road, i) => { for (let k = -20; k <= 20; k++) { const q = this.roadWrap(road, i + k); if (q < 0 || Math.abs(this.samples[q].slope) > 0.02) return false; } return true; };
    for (const def of GARAGES) {
      if (def.type === 'hq') {
        const ring = this.getRoad('ring');
        const want = this.hub.idx + 75;
        let idx = this.roadWrap(ring, want, true);
        for (let k = 0; k < 60; k++) { const q = this.roadWrap(ring, want + k, true); if (flat(ring, q)) { idx = q; break; } }
        const s = this.samples[idx];
        make(def, idx, Math.sign(s.n.x * s.p.x + s.n.z * s.p.z) || 1);   // away from the island's centre
        continue;
      }
      const road = this.getRoad(def.road);
      const start = this.indexNear(def.road, def.at[0], def.at[1]);
      const quiet = (i) => !this.samples[i].jz && flat(road, i) && jpts.every(q => Math.hypot(q.x - this.samples[i].p.x, q.z - this.samples[i].p.z) > 70);
      let placed = false;
      for (let k = 0; k < road.n && !placed; k += 2) {
        for (const i of [this.roadWrap(road, start + k), this.roadWrap(road, start - k)]) {
          if (i < 0 || !quiet(i)) continue;
          const side = (def.side ? [def.side] : [1, -1]).find(sd => roomFor(def, i, sd));
          if (side) { make(def, i, side); placed = true; break; }
        }
      }
    }
  }

  /** A venue per championship on a quiet stretch of its road, with a gantry across it like an event. */
  _placeChampionships(roadside) {
    const taken = [this.hub, ...this.garages, ...this.events, ...this.traps,
      ...[...this.drifts, ...this.zones].flatMap(z => [this.samples[z.i0].p, this.samples[z.i1].p])];
    const jpts = this.junctionPairs.map(([a]) => this.samples[a].p);
    this.championships = CHAMPIONSHIPS.map(c => {
      const road = this.getRoad(c.road);
      const start = this.indexNear(c.road, c.at[0], c.at[1]);
      const ok = (i) => {
        const p = this.samples[i].p;
        return !this.samples[i].jz && jpts.every(q => Math.hypot(q.x - p.x, q.z - p.z) > 110) && taken.every(q => Math.hypot(q.x - p.x, q.z - p.z) > 160);
      };
      let idx = start;
      for (let k = 0; k < road.n; k++) {
        const a = this.roadWrap(road, start + k), b = this.roadWrap(road, start - k);
        if (a >= 0 && ok(a)) { idx = a; break; }
        if (b >= 0 && ok(b)) { idx = b; break; }
      }
      const series = getSeries(c.series);
      const m = { id: `champ-${c.series}`, kind: 'series', series: c.series, name: series.name, idx, ...roadside(idx, 1, 6), heading: this.samples[idx].heading };
      taken.push(m);
      return m;
    });
  }

  // ------------------------------------------------------------ Route finding (GPS)
  /**
   * Road graph for the GPS: a node at every junction and open road end, an edge for
   * each stretch of road between two of them.
   */
  _buildGraph() {
    const stops = this.roads.map(() => []);   // per road: [{ li, node }]
    let nodes = 0;
    for (const [i, j] of this.junctionPairs) {
      const node = nodes++;
      stops[this.samples[i].road].push({ li: this.samples[i].li, node });
      stops[this.samples[j].road].push({ li: this.samples[j].li, node });
    }
    this.roads.forEach((road, ri) => {
      if (road.closed) return;
      const list = stops[ri];
      if (!list.some(s => s.li <= 3)) list.push({ li: 0, node: nodes++ });
      if (!list.some(s => s.li >= road.n - 4)) list.push({ li: road.n - 1, node: nodes++ });
    });
    this.adj = Array.from({ length: nodes }, () => []);
    this.roadStops = stops.map(l => l.sort((a, b) => a.li - b.li));
    this.roadStops.forEach((list, ri) => {
      const road = this.roads[ri];
      const link = (a, b, len) => {
        this.adj[a.node].push({ to: b.node, cost: len * SPACING, road: ri, from: a.li, dir: 1, len });
        this.adj[b.node].push({ to: a.node, cost: len * SPACING, road: ri, from: b.li, dir: -1, len });
      };
      for (let k = 0; k < list.length - 1; k++) link(list[k], list[k + 1], list[k + 1].li - list[k].li);
      if (road.closed && list.length) link(list[list.length - 1], list[0], list[0].li + road.n - list[list.length - 1].li);
    });
  }

  /** Stops either side of a point on a road, as [{ node, steps, dir }]. */
  _neighbourStops(ri, li) {
    const road = this.roads[ri], list = this.roadStops[ri];
    if (!list.length) return [];
    let k = list.findIndex(s => s.li > li);
    if (road.closed) {
      const after = list[k < 0 ? 0 : k], before = list[k < 0 ? list.length - 1 : (k - 1 + list.length) % list.length];
      const fwd = ((after.li - li) % road.n + road.n) % road.n, back = ((li - before.li) % road.n + road.n) % road.n;
      return [{ node: after.node, steps: fwd, dir: 1, li: after.li }, { node: before.node, steps: back, dir: -1, li: before.li }];
    }
    const out = [];
    if (k < 0) k = list.length;
    if (k < list.length) out.push({ node: list[k].node, steps: list[k].li - li, dir: 1, li: list[k].li });
    if (k > 0) out.push({ node: list[k - 1].node, steps: li - list[k - 1].li, dir: -1, li: list[k - 1].li });
    return out;
  }

  /**
   * Shortest drive along the roads between two sample indices. Returns
   * { length (m), legs: [{ road, from, dir, len }] } or null. A leg runs `len`
   * samples from local index `from` in direction `dir` along `road`.
   */
  route(fromIdx, toIdx) {
    const A = this.samples[fromIdx], B = this.samples[toIdx];
    const ra = A.road, rb = B.road;
    let best = null;
    // the same road, straight there (either way round on a loop)
    if (ra === rb) {
      const road = this.roads[ra];
      let d = B.li - A.li;
      if (road.closed) { const f = ((d % road.n) + road.n) % road.n; d = f <= road.n - f ? f : f - road.n; }
      best = { length: Math.abs(d) * SPACING, legs: [{ road: ra, from: A.li, dir: Math.sign(d) || 1, len: Math.abs(d) }] };
    }
    const starts = this._neighbourStops(ra, A.li), ends = this._neighbourStops(rb, B.li);
    if (!starts.length || !ends.length) return best;
    const n = this.adj.length;
    const dist = new Float64Array(n).fill(Infinity), prev = new Array(n).fill(null);
    const open = new Set();
    for (const s of starts) {
      const c = s.steps * SPACING;
      if (c < dist[s.node]) { dist[s.node] = c; prev[s.node] = { start: s }; open.add(s.node); }
    }
    const endCost = new Map();
    for (const e of ends) { const c = e.steps * SPACING; if (!endCost.has(e.node) || c < endCost.get(e.node).c) endCost.set(e.node, { c, e }); }
    const done = new Uint8Array(n);
    while (open.size) {
      let u = -1, du = Infinity;
      for (const v of open) if (dist[v] < du) { du = dist[v]; u = v; }
      open.delete(u); done[u] = 1;
      if (best && du >= best.length) break;
      const end = endCost.get(u);
      if (end && du + end.c < (best ? best.length : Infinity)) best = { length: du + end.c, node: u, end: end.e };
      for (const ed of this.adj[u]) {
        if (done[ed.to]) continue;
        const nd = du + ed.cost;
        if (nd < dist[ed.to]) { dist[ed.to] = nd; prev[ed.to] = { from: u, edge: ed }; open.add(ed.to); }
      }
    }
    if (!best || best.legs) return best;
    // walk back from the final node to the start
    const legs = [{ road: rb, from: best.end.li, dir: -best.end.dir, len: best.end.steps }];
    let v = best.node;
    while (prev[v] && !prev[v].start) { const { from, edge } = prev[v]; legs.push({ road: edge.road, from: edge.from, dir: edge.dir, len: edge.len }); v = from; }
    const s = prev[v].start;
    legs.push({ road: ra, from: A.li, dir: s.dir, len: s.steps });
    legs.reverse();
    // passing straight through a junction splits a road into two legs; join them back up
    const merged = [];
    for (const l of legs) {
      if (l.len <= 0) continue;
      const p = merged[merged.length - 1];
      if (p && p.road === l.road && p.dir === l.dir) p.len += l.len;
      else merged.push({ ...l });
    }
    return { length: best.length, legs: merged };
  }

  /** Sample indices along a route, every `stride` samples. */
  routeIndices(route, stride = 2) {
    const out = [];
    if (!route) return out;
    for (const leg of route.legs) {
      const road = this.roads[leg.road];
      for (let k = 0; k <= leg.len; k += stride) out.push(this.roadWrap(road, road.i0 + leg.from + leg.dir * k, true));
      out.push(this.roadWrap(road, road.i0 + leg.from + leg.dir * leg.len, true));
    }
    return out;
  }

  // ------------------------------------------------------------ City
  /**
   * Buildings on whatever land the city's streets leave free, each turned to face its
   * nearest street and kept a pavement's width off every road. A loose grid sets the
   * general layout, then an infill sweep puts a building (a smaller one if need be) in
   * every spot still big enough for one, so blocks are packed with an even gap between
   * buildings, except for a few small tree-lined squares (CITY_PLAZAS). Taller towards
   * the centre; the outskirts, one row along the outside of the outer streets, are low
   * warehouses (all along the coast side) and shops. Shared by the 3D world and the maps.
   */
  _buildCity() {
    this.buildings = [];
    this.plazas = CITY_PLAZAS.map(([i, j]) => {
      const c = [cityNode(i, j), cityNode(i + 1, j), cityNode(i, j + 1), cityNode(i + 1, j + 1)];
      return { x: c.reduce((a, p) => a + p[0], 0) / 4, z: c.reduce((a, p) => a + p[1], 0) / 4, r: 30 };
    });
    const SCALE = 1.9;                  // footprint size (the grid spreads out to match)
    const GAP = 5;                      // clear ground between neighbouring buildings
    const M = CITY_OUTSKIRTS;
    /** Put a building here if it fits; true if it did. */
    const tryPlace = (x, z, w, d, hr, mat) => {
      const near = this.nearestGlobal(x, z, 3);
      if (near.idx < 0) return false;
      const s = this.samples[near.idx];
      const half = Math.hypot(w, d) / 2;
      if (near.dist - s.hw - 4.5 < half * 0.78) return false;          // keep a pavement's width off the road
      // the outskirts are one row along each side: none diagonally past the rounded corners
      const outX = x < CITY.x0 || x > CITY.x1, outZ = z < CITY.z0 || z > CITY.z1, outskirts = outX || outZ;
      if ((outX && outZ) || (outskirts && near.dist - s.hw > M)) return false;
      if (this.buildings.some(b => Math.hypot(b.x - x, b.z - z) < (b.r + half) * 0.8 + GAP)) return false;
      if (this.plazas.some(q => Math.hypot(q.x - x, q.z - z) < q.r + half * 0.7)) return false;
      // leave room for the garages placed later (Turbo Motors stands on the outskirts)
      if (GARAGES.some(g => g.at && Math.hypot(g.at[0] - x, g.at[1] - z) < 80 + half)) return false;
      const dc = Math.hypot(x - CITY.cx, z - CITY.cz);
      const style = !outskirts ? 'office' : z > CITY.z1 || hr < 0.4 ? 'warehouse' : 'shop';
      const h = style === 'warehouse' ? 7 + hr * 6 : style === 'shop' ? 6 + hr * 10
        : dc < 230 ? 45 + hr * 90 : dc < 420 ? 18 + hr * 42 : 9 + hr * 18;
      this.buildings.push({ x, z, w, d, h, hw: w / 2, hd: d / 2, r: half, rot: s.heading, mat, style });
      return true;
    };
    // 1. A loose grid, centred on the city, with a few gaps left for plazas
    const rand = mulberry32(777), STEP = 28 * SCALE;
    const KX = Math.floor(((CITY.x1 - CITY.x0) / 2 + M) / STEP), KZ = Math.floor(((CITY.z1 - CITY.z0) / 2 + M) / STEP);
    for (let kx = -KX; kx <= KX; kx++) for (let kz = -KZ; kz <= KZ; kz++) {
      const x = CITY.cx + kx * STEP + (rand() - 0.5) * 7 * SCALE, z = CITY.cz + kz * STEP + (rand() - 0.5) * 7 * SCALE;
      const w = (14 + rand() * 14) * SCALE, d = (14 + rand() * 14) * SCALE;
      const plaza = rand() < 0.08, hr = rand(), mat = rand();
      if (!plaza) tryPlace(x, z, w, d, hr, mat);
    }
    // 2. Infill wherever a building still fits (streets moved, blocks merged, the outskirts):
    //    big buildings everywhere first, then medium, and small ones only in what is left
    const fill = mulberry32(4242);
    for (const [lo, hi, FILL] of [[24, 28, 12], [18, 24, 10], [14, 18, 8], [14, 14, 6]]) {
      for (let x = CITY.x0 - M; x <= CITY.x1 + M; x += FILL) for (let z = CITY.z0 - M; z <= CITY.z1 + M; z += FILL) {
        const hr = fill(), mat = fill(), w = (lo + fill() * (hi - lo)) * SCALE, d = (lo + fill() * (hi - lo)) * SCALE;
        tryPlace(x, z, w, d, hr, mat);
      }
    }
  }

  // ------------------------------------------------------------ Placed items
  _placeItems() {
    const roadside = (idx, side, off) => {
      const s = this.samples[idx];
      return { x: s.p.x + s.n.x * side * (s.hw + off), z: s.p.z + s.n.z * side * (s.hw + off), y: s.p.y };
    };
    this.events = EVENTS.map(e => {
      const idx = this._itemIndex(e);
      const track = getTrack(e.id);
      const pos = roadside(idx, e.side, 6);
      return { ...e, kind: 'event', idx, track, name: track.name, ...pos, heading: this.samples[idx].heading };
    });
    this.hub = { id: 'hub', kind: 'hub', name: 'Horizon Festival', idx: this.indexAt('ring', 0), ...roadside(this.indexAt('ring', 0), 1, 8) };
    this.traps = TRAPS.map(t => { const idx = this._itemIndex(t); const s = this.samples[idx]; return { ...t, kind: 'trap', name: 'Speed Trap', idx, x: s.p.x, z: s.p.z, y: s.p.y }; });
    const span = (z) => {
      const r = this.getRoad(z.road);
      let i0 = this._itemIndex(z, '0'), i1 = this._itemIndex(z, '1');
      if (i0 > i1) [i0, i1] = [i1, i0];
      const m = this.samples[Math.round((i0 + i1) / 2)];
      const lengthM = (i1 - i0) * SPACING;
      // drift zone thresholds are given per 100 m of zone and scale with its length
      const stars = z.perHundred ? z.stars.map(v => Math.round((v * lengthM) / 100 / 100) * 100) : z.stars;
      // idx (for the GPS and fast travel) is the start gantry; the marker sits mid-zone
      return { ...z, stars, i0, i1, idx: i0, road: r.id, x: m.p.x, z: m.p.z, y: m.p.y, lengthM };
    };
    this.drifts = DRIFTS.map(z => ({ ...span(z), kind: 'drift', name: 'Drift Zone' }));
    this.zones = SPEEDZONES.map(z => ({ ...span(z), kind: 'zone', name: 'Speed Zone' }));
    this._placeGarages();
    this._placeChampionships(roadside);
    // Bonus boards: deterministic positions beside roads, never in the sea or on a road.
    const rand = mulberry32(90210);
    this.boards = [];
    let tries = 0;
    while (this.boards.length < BOARD_COUNT && tries < 4000) {
      tries++;
      const idx = Math.floor(rand() * this.count);
      const s = this.samples[idx];
      const side = rand() < 0.5 ? -1 : 1;
      const off = s.hw + 9 + rand() * 26;
      const x = s.p.x + s.n.x * side * off, z = s.p.z + s.n.z * side * off;
      if (coastDist(x, z) < 70) continue;
      if (this.nearestGlobal(x, z, 1).dist < s.hw + 6) continue;
      if (x > CITY.x0 - 60 && x < CITY.x1 + 60 && z > CITY.z0 - 60 && z < CITY.z1 + 60) continue;
      if (this.boards.some(b => Math.hypot(b.x - x, b.z - z) < 250)) continue;
      this.boards.push({ id: `board-${this.boards.length}`, kind: 'board', name: 'Bonus Board', x, z, y: this.terrainHeight(x, z), heading: s.heading + Math.PI / 2 * side, idx });
    }
    this.markers = [this.hub, ...this.garages, ...this.championships, ...this.events, ...this.traps, ...this.drifts, ...this.zones];
  }
}

// ------------------------------------------------------------ Roadside props
const BILLBOARDS = [
  { text: 'TURBO TOUR FESTIVAL', bg: '#ff5a1f', fg: '#fff' }, { text: 'DRIFT KINGS · RED MESA', bg: '#2a1440', fg: '#e3a7ff' },
  { text: 'NEON NIGHTS · TURBO CITY', bg: '#0d1b3d', fg: '#3df2ff' }, { text: 'FROSTPEAK SKI LODGE', bg: '#e9f1f7', fg: '#1d3f66' },
  { text: 'AZURE SHORE RESORT', bg: '#1d7fc4', fg: '#fff' }, { text: 'TURBO COLA', bg: '#c8102e', fg: '#fff' },
  { text: 'GRIP TYRES', bg: '#111', fg: '#ffd23f' }, { text: 'MESA MOTORS', bg: '#d4ab6e', fg: '#3a2410' },
];
/** Footprint, height and look of each building-like prop (w across, d along its facing). */
const KINDS = {
  house: { w: [9, 12], d: [8, 10], h: [4.2, 5.6], solid: true, map: true },
  barn: { w: [11, 13], d: [16, 20], h: [6, 7.5], solid: true, map: true },
  silo: { w: [6, 6], d: [6, 6], h: [12, 15], solid: true, map: true },
  cabin: { w: [6, 8], d: [6, 7], h: [3, 3.8], solid: true, map: true },
  shack: { w: [7, 9], d: [6, 8], h: [3.2, 4], solid: true, map: true },
  watertower: { w: [8, 8], d: [8, 8], h: [15, 17], solid: true, map: true },
  lodge: { w: [12, 15], d: [9, 11], h: [5.5, 6.5], solid: true, map: true },
  hut: { w: [3.6, 4.4], d: [3.6, 4.4], h: [2.6, 3], solid: true, map: true },
  lifeguard: { w: [3.2, 3.2], d: [3.2, 3.2], h: [5, 5], solid: true, map: true },
  gas: { w: [28, 28], d: [18, 18], h: [5.5, 5.5], solid: false, map: true },
  hq: { w: [22, 22], d: [36, 36], h: [9, 9], solid: true, map: true },
  dealer: { w: [24, 24], d: [34, 34], h: [8, 8], solid: true, map: true },
  tuning: { w: [18, 18], d: [24, 24], h: [7, 7], solid: true, map: true },
  billboard: { w: [2, 2], d: [11, 11], h: [9, 9], solid: false },
  sign: { w: [1, 1], d: [5.4, 5.4], h: [4.6, 4.6], solid: false },
  pole: { w: [0.5, 0.5], d: [0.5, 0.5], h: [9, 9], solid: true },
  rock: { w: [1.5, 5], d: [1.5, 5], h: [1, 3.5], solid: true },
  hay: { w: [1.6, 1.6], d: [1.6, 1.6], h: [1.5, 1.5], solid: true },
};

Object.assign(World.prototype, {
  /**
   * Things beside the roads outside the city: villages, farms with barns and silos,
   * forest cabins, desert shacks and water towers, mountain lodges, beach huts and
   * lifeguard towers, gas stations, billboards, utility poles, rocks, hay bales and
   * direction signs before junctions. All deterministic. Each prop: { kind, x, z, rot,
   * w, d, h, y, variant, colliders: [{ x, z, hw, hd, r, rot }] }.
   */
  _placeProps() {
    const rand = mulberry32(4711);
    const R = (a, b) => a + (b - a) * rand();
    this.props = [];
    const grid = new Map();
    const cellOf = (x, z) => `${Math.floor(x / 30)},${Math.floor(z / 30)}`;
    const avoid = [this.hub, ...this.events, ...this.traps, ...this.boards, ...this.championships,
      ...this.garages.flatMap(g => [{ x: g.x, z: g.z, avoidR: 12 }, { x: g.building.x, z: g.building.z, avoidR: 22 }]),
      ...this.drifts.flatMap(z => [this.samples[z.i0].p, this.samples[z.i1].p]), ...this.zones.flatMap(z => [this.samples[z.i0].p, this.samples[z.i1].p])];
    const cityPad = 90;
    const free = (x, z, r, roadGap, coastGap = 35) => {
      if (coastDist(x, z) < coastGap + r) return false;
      if (x > CITY.x0 - cityPad && x < CITY.x1 + cityPad && z > CITY.z0 - cityPad && z < CITY.z1 + cityPad) return false;
      const near = this.nearestGlobal(x, z, 2);
      if (near.idx >= 0 && near.dist - this.samples[near.idx].hw < r + roadGap) return false;
      for (const a of avoid) if (Math.hypot(a.x - x, a.z - z) < r + 26 + (a.avoidR || 0)) return false;
      const cx = Math.floor(x / 30), cz = Math.floor(z / 30);
      for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
        for (const p of grid.get(`${cx + dx},${cz + dz}`) || []) if (Math.hypot(p.x - x, p.z - z) < p.r + r + 1.5) return false;
      }
      return true;
    };
    const add = (kind, x, z, rot, extra = {}) => {
      const K = KINDS[kind];
      const w = extra.w || R(K.w[0], K.w[1]), d = extra.d || R(K.d[0], K.d[1]), h = extra.h || R(K.h[0], K.h[1]);
      const r = Math.hypot(w, d) / 2;
      // sit on the lowest ground under the footprint so nothing floats on a slope
      const cs = Math.cos(rot), sn = Math.sin(rot);
      let y = this.terrainHeight(x, z);
      for (const [lx, lz] of [[-w / 2, -d / 2], [w / 2, -d / 2], [-w / 2, d / 2], [w / 2, d / 2]]) y = Math.min(y, this.terrainHeight(x + lx * cs + lz * sn, z - lx * sn + lz * cs));
      const p = { kind, x, z, rot, w, d, h, y, r, variant: Math.floor(rand() * 6), map: !!K.map, colliders: [], ...extra };
      if (K.solid) p.colliders.push({ x, z, hw: w / 2, hd: d / 2, r, rot });
      this.props.push(p);
      const key = cellOf(x, z);
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(p);
      return p;
    };
    /** Spot beside a road sample: side ±1, `off` metres past the edge; its +x faces the road. */
    const beside = (idx, side, off) => {
      const s = this.samples[idx];
      return { x: s.p.x + s.n.x * side * (s.hw + off), z: s.p.z + s.n.z * side * (s.hw + off), rot: s.heading + (side > 0 ? Math.PI : 0), s };
    };
    const roadsNear = (x, z, rad) => {
      const out = [];
      for (let i = 0; i < this.count; i += 6) { const p = this.samples[i].p; if (Math.abs(p.x - x) < rad && Math.abs(p.z - z) < rad && Math.hypot(p.x - x, p.z - z) < rad) out.push(i); }
      return out;
    };

    // 0. The garage buildings (each model includes its forecourt out to the road)
    for (const g of this.garages) add(g.type, g.building.x, g.building.z, g.building.rot, { reach: g.building.reach, name: g.name });

    // 1. Direction signs before junctions (placed first: they matter most)
    this.signs = [];
    for (const [i, j] of this.junctionPairs) {
      for (const [c, o] of [[i, j], [j, i]]) {
        const road = this.roadOf(c), other = this.roadOf(o);
        if (road.kind === 'street' && other.kind === 'street') continue;
        const arms = [12, -12].map(k => this.roadWrap(other, o + k)).filter(q => q >= 0 && this.roadWrap(other, o + Math.sign(q - o) * 40) >= 0);
        if (!arms.length) continue;
        const sc = this.samples[c];
        for (const dir of [1, -1]) {
          const k = this.roadWrap(road, c - dir * 30);
          if (k < 0 || this.roadWrap(road, c - dir * 45) < 0) continue;
          if (this.samples[k].jz) continue;
          const crowded = (this.roadJunctions[this.samples[c].road] || []).some(J => J.li !== sc.li && Math.abs(J.li - this.samples[k].li) < 22);
          if (crowded) continue;
          let left = false, right = false;
          for (const q of arms) {
            const lat = (this.samples[q].p.x - sc.p.x) * sc.n.x + (this.samples[q].p.z - sc.p.z) * sc.n.z;
            if (lat * dir > 0) left = true; else right = true;
          }
          const s = this.samples[k];
          const side = -dir;                        // drivers keep right: the sign stands on their right
          // the board is 5.4 m wide and stands across the verge, its inner edge 3 m off the road
          const x = s.p.x + s.n.x * side * (s.hw + 6), z = s.p.z + s.n.z * side * (s.hw + 6);
          if (!free(x, z, 2.8, 0.2, 10)) continue;
          const face = Math.atan2(-dir * s.t.x, -dir * s.t.z);   // board faces the oncoming driver
          const p = add('sign', x, z, face, { text: other.name, left, right, kindOf: other.kind });
          p.colliders.push(...[-2.1, 2.1].map(l => ({ x: x + Math.cos(face) * l, z: z - Math.sin(face) * l, hw: 0.2, hd: 0.2, r: 0.3, rot: face })));
          this.signs.push(p);
        }
      }
    }

    // 2. Gas stations at a few busy spots
    for (const [road, ax, az] of [['coast', -1000, 2290], ['ring', -1500, -900], ['ew', 650, 150], ['coast', 2700, 1250], ['spine', 60, -1200]]) {
      const i = this.indexNear(road, ax, az);
      for (const side of [1, -1]) {
        const b = beside(i, side, 17);
        if (!free(b.x, b.z, 14, 2)) continue;
        const p = add('gas', b.x, b.z, b.rot);
        const cs = Math.cos(b.rot), sn = Math.sin(b.rot);
        const at = (lx, lz) => ({ x: b.x + lx * cs + lz * sn, z: b.z - lx * sn + lz * cs });
        // the kiosk at the back and two pump islands under the canopy are solid
        // (in a prop's own frame +x points at the road, +z along it)
        for (const [lx, lz, hw, hd] of [[-8, 0, 4.5, 3.5], [2, -4, 0.8, 2.2], [2, 4, 0.8, 2.2]]) {
          const q = at(lx, lz);
          p.colliders.push({ x: q.x, z: q.z, hw, hd, r: Math.hypot(hw, hd), rot: b.rot });
        }
        break;
      }
    }

    // 3. Villages: houses along the roads near a few crossroads
    const VILLAGES = [[-1150, 1000], [-800, 2050], [600, 1150], [-2420, 760], [2470, 160], [-1350, -500], [1250, -650]];
    for (const [vx, vz] of VILLAGES) {
      for (const i of roadsNear(vx, vz, 260)) {
        const s = this.samples[i];
        if (s.jz || rand() > 0.55) continue;
        const side = rand() < 0.5 ? 1 : -1;
        const b = beside(i, side, R(9, 14));
        const region = this.regionAt(b.x, b.z).id;
        const kind = region === 'desert' ? 'shack' : region === 'forest' ? 'cabin' : region === 'alpine' ? 'lodge' : 'house';
        if (free(b.x, b.z, kind === 'lodge' ? 7.5 : 6.5, 3)) add(kind, b.x, b.z, b.rot);
      }
    }

    // 4. Along every road outside the city: farms, cabins, shacks, lodges, billboards, poles
    for (const road of this.roads) {
      if (road.kind === 'street') continue;
      const big = road.kind === 'highway' || road.kind === 'road';
      // utility poles along a few long stretches of the country roads
      const poles = road.kind !== 'dirt' && rand() < 0.75;
      let poleSide = rand() < 0.5 ? 1 : -1, poleRun = 0;
      for (let li = 10; li < road.n - 10; li += 20) {
        const idx = road.i0 + li, s = this.samples[idx];
        if (s.jz) continue;
        const region = this.regionAt(s.p.x, s.p.z).id;
        if (region === 'city') continue;
        if (poles && region !== 'forest' && region !== 'alpine') {
          if (poleRun <= 0 && rand() < 0.02) { poleRun = 30 + Math.floor(rand() * 40); poleSide = -poleSide; }
          if (poleRun-- > 0) { const b = beside(idx, poleSide, 4.5); if (free(b.x, b.z, 0.4, 3, 20)) add('pole', b.x, b.z, b.rot); }
        }
        if (li % 60 !== 10) continue;
        const r = rand(), side = rand() < 0.5 ? 1 : -1;
        if (big && r < 0.07) {
          const b = beside(idx, side, 12);
          const ad = BILLBOARDS[Math.floor(rand() * BILLBOARDS.length)];
          if (free(b.x, b.z, 5.5, 4)) {
            const p = add('billboard', b.x, b.z, b.rot, ad);
            const cs = Math.cos(b.rot), sn = Math.sin(b.rot);
            p.colliders.push(...[-3.5, 3.5].map(l => ({ x: b.x + l * sn, z: b.z + l * cs, hw: 0.3, hd: 0.3, r: 0.4, rot: b.rot })));
          }
          continue;
        }
        if (r > 0.16) continue;
        if (region === 'grass' || region === 'coast') {
          // a farm: house by the road, barn and silo behind, hay bales in the field
          const b = beside(idx, side, R(10, 14));
          if (!free(b.x, b.z, 6.5, 3)) continue;
          add('house', b.x, b.z, b.rot);
          if (region === 'grass' && rand() < 0.7) {
            const back = beside(idx, side, 38), bx = back.x + s.t.x * R(-12, 12), bz = back.z + s.t.z * R(-12, 12);
            if (free(bx, bz, 12, 20)) add('barn', bx, bz, back.rot + R(-0.2, 0.2));
            const sx = bx + s.t.x * 16, sz = bz + s.t.z * 16;
            if (free(sx, sz, 4, 20)) add('silo', sx, sz, 0);
            const fx = back.x + s.n.x * side * 35, fz = back.z + s.n.z * side * 35;
            for (let h = 0; h < 8; h++) { const hx = fx + R(-30, 30), hz = fz + R(-30, 30); if (free(hx, hz, 1.2, 10)) add('hay', hx, hz, rand() * Math.PI); }
          }
        } else if (region === 'forest') {
          const b = beside(idx, side, R(9, 16));
          if (free(b.x, b.z, 6, 4)) add('cabin', b.x, b.z, b.rot + R(-0.3, 0.3));
        } else if (region === 'desert') {
          const b = beside(idx, side, R(10, 18));
          if (rand() < 0.2) { if (free(b.x, b.z, 6, 6)) add('watertower', b.x, b.z, 0); }
          else if (free(b.x, b.z, 6, 4)) add('shack', b.x, b.z, b.rot + R(-0.3, 0.3));
        } else if (region === 'alpine') {
          const b = beside(idx, side, R(12, 18));
          if (free(b.x, b.z, 7.5, 4)) add('lodge', b.x, b.z, b.rot);
        }
      }
    }

    // 5. Beach huts and lifeguard towers along the south shore
    for (let th = 0.35; th < 2.75; th += 0.035) {
      if (rand() > 0.45) continue;
      const [x, z] = coastPointAt(th, -R(30, 55));
      const kind = rand() < 0.25 ? 'lifeguard' : 'hut';
      if (free(x, z, 3, 8, 12)) add(kind, x, z, -th);   // +x faces the sea
    }

    // 6. Rocks: boulders on the mountains and in the desert, a few in the forest
    for (let t = 0; t < 5000; t++) {
      const x = R(-WORLD_HALF, WORLD_HALF), z = R(-WORLD_HALF, WORLD_HALF);
      const w = this.regionWeights(x, z);
      const p = w.alpine * 0.5 + w.desert * 0.35 + w.forest * 0.12;
      if (rand() > p) continue;
      const size = R(1.6, w.alpine > 0.5 ? 5 : 3.5);
      if (free(x, z, size / 2, 5)) add('rock', x, z, rand() * Math.PI * 2, { w: size, d: size * R(0.7, 1), h: size * R(0.5, 0.8), tint: w.desert > 0.5 ? 1 : 0 });
    }
  },
});

// ------------------------------------------------------------ Profile helpers
function smoothProfile(out, W, closed, half) {
  const copy = Float32Array.from(out);
  const N = out.length, w = half * 2 + 1;
  for (let i = 0; i < N; i++) {
    let acc = 0;
    for (let k = -half; k <= half; k++) acc += copy[W(i + k)];
    out[i] = acc / w;
  }
}
function clampGrade(out, W, closed, maxStep) {
  const N = out.length;
  const passes = closed ? N * 2 : N - 1;
  for (let i = 0; i < passes; i++) {
    const a = W(i), b = W(i + 1);
    const d = out[b] - out[a];
    if (d > maxStep) out[b] = out[a] + maxStep;
    else if (d < -maxStep) out[b] = out[a] - maxStep;
  }
  if (!closed) for (let i = N - 1; i > 0; i--) {
    const d = out[i - 1] - out[i];
    if (d > maxStep) out[i - 1] = out[i] + maxStep;
    else if (d < -maxStep) out[i - 1] = out[i] - maxStep;
  }
}
