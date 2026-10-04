// Open-world model: terrain, the road network and the things placed on it.
// Exposes the same surface the race `Track` does (samples, nearestIndex,
// lateral, heightAtPos, slopeAtPos, _param, theme...) so the car physics and
// drift effects run unchanged on it. Rendering lives in horizon.js.
import * as THREE from 'three';
import { sampleSpline } from './track.js';
import { THEMES } from './tracks.js';
import {
  ROADS, REGIONS, EVENTS, TRAPS, DRIFTS, SPEEDZONES, BOARD_COUNT, WORLD_HALF, SEA_Z, SEA_LEVEL, CITY,
} from './worlddef.js';
import { getTrack } from './tracks.js';

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
  }

  // ------------------------------------------------------------ Regions & terrain
  /** Blend weights of each region at a point; they sum to 1. */
  regionWeights(x, z) {
    const w = {};
    let sum = 0;
    for (const r of REGIONS) {
      if (!r.r) continue;
      const d = r.id === 'city' ? Math.max(Math.abs(x - r.cx), Math.abs(z - r.cz)) : Math.hypot(x - r.cx, z - r.cz);
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
    // the shore: drop into the sea
    const sea = smoothstep(SEA_Z - 220, SEA_Z + 140, z);
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
    if (near.idx < 0) return base;
    const s = this.samples[near.idx];
    const edge = s.hw + 3.5;
    if (near.dist <= edge) return s.p.y - 0.08;
    const k = smoothstep(edge, edge + 45, near.dist);
    return (s.p.y - 0.08) * (1 - k) + base * k;
  }

  // ------------------------------------------------------------ Roads
  /**
   * Open roads that end near another road are extended to meet it exactly, so
   * every T-junction lands on the other road's centreline instead of stopping
   * short of it or overshooting.
   */
  _snapEndpoints() {
    const sampled = ROADS.map(def => ({ def, pts: sampleSpline(def.points, SPACING * 2, !def.closed) }));
    const SNAP = 230, EDGE = WORLD_HALF - 120;
    const RANK = { highway: 4, road: 3, street: 2, lane: 1, dirt: 0 };
    return sampled.map(({ def, pts }, ri) => {
      if (def.closed) return def;
      const points = def.points.map(p => [p[0], p[1]]);
      for (const end of [0, points.length - 1]) {
        const ex = points[end][0], ez = points[end][1];
        // roads running off the edge of the map are exits, not junctions
        if (Math.abs(ex) > EDGE || Math.abs(ez) > EDGE) continue;
        let best = null, bd = SNAP * SNAP;
        sampled.forEach((o, oi) => {
          if (oi === ri) return;
          // only onto a road of equal or higher standing (so a highway never bends to meet a lane),
          // and only onto its interior, never onto its own ends
          if (RANK[o.def.kind] < RANK[def.kind]) return;
          const margin = o.def.closed ? 0 : 6;
          for (let k = margin; k < o.pts.length - margin; k++) {
            const d = (o.pts[k][0] - ex) ** 2 + (o.pts[k][1] - ez) ** 2;
            if (d < bd) { bd = d; best = { pts: o.pts, k, def: o.def }; }
          }
        });
        if (!best) continue;
        // continue a little past the centreline so the end edge hides under the other road
        const k = best.k, o = best.pts;
        const a = o[Math.max(0, k - 1)], b = o[Math.min(o.length - 1, k + 1)];
        let tx = b[0] - a[0], tz = b[1] - a[1];
        const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
        const nx = tz, nz = -tx;
        const inner = points[end === 0 ? 1 : end - 1];
        const side = Math.sign((o[k][0] - inner[0]) * nx + (o[k][1] - inner[1]) * nz) || 1;
        const over = best.def.width * 0.3;
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
      const pts = sampleSpline(def.points, SPACING, !closed);
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
  /** Building footprints on the lots between the city streets (shared by the 3D world and the map). */
  _buildCity() {
    const lots = 3, pad = 13;
    const lotW = (CITY.step - pad * 2) / lots;
    this.buildings = [];
    for (let bi = 0; bi < 5; bi++) for (let bj = 0; bj < 5; bj++) {
      const bx0 = CITY.x0 + bi * CITY.step + pad, bz0 = CITY.z0 + bj * CITY.step + pad;
      for (let li = 0; li < lots; li++) for (let lj = 0; lj < lots; lj++) {
        const lx = bx0 + (li + 0.5) * lotW, lz = bz0 + (lj + 0.5) * lotW;
        const rand = mulberry32((bi * 5 + bj) * 9 + li * 3 + lj + 777);
        if (rand() < 0.14) continue;   // a car park / plaza
        const w = lotW * (0.55 + rand() * 0.35), d = lotW * (0.55 + rand() * 0.35);
        const dc = Math.hypot(lx - CITY.cx, lz - CITY.cz);
        const h = dc < 230 ? 45 + rand() * 90 : dc < 420 ? 18 + rand() * 42 : 9 + rand() * 18;
        this.buildings.push({ x: lx, z: lz, w, d, h, hw: w / 2, hd: d / 2, mat: rand() });
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
      const idx = this.indexAt(e.road, e.t);
      const track = getTrack(e.id);
      const pos = roadside(idx, e.side, 6);
      return { ...e, kind: 'event', idx, track, name: track.name, ...pos, heading: this.samples[idx].heading };
    });
    this.hub = { id: 'hub', kind: 'hub', name: 'Horizon Festival', idx: this.indexAt('ring', 0), ...roadside(this.indexAt('ring', 0), 1, 8) };
    this.traps = TRAPS.map(t => { const idx = this.indexAt(t.road, t.t); const s = this.samples[idx]; return { ...t, kind: 'trap', name: 'Speed Trap', idx, x: s.p.x, z: s.p.z, y: s.p.y }; });
    const span = (z) => {
      const r = this.getRoad(z.road);
      let i0 = this.indexAt(z.road, z.t0), i1 = this.indexAt(z.road, z.t1);
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
      if (z > SEA_Z - 60 || Math.abs(x) > WORLD_HALF - 60 || Math.abs(z) > WORLD_HALF - 60) continue;
      if (this.nearestGlobal(x, z, 1).dist < s.hw + 6) continue;
      if (x > CITY.x0 - 60 && x < CITY.x1 + 60 && z > CITY.z0 - 60 && z < CITY.z1 + 60) continue;
      if (this.boards.some(b => Math.hypot(b.x - x, b.z - z) < 250)) continue;
      this.boards.push({ id: `board-${this.boards.length}`, kind: 'board', name: 'Bonus Board', x, z, y: this.terrainHeight(x, z), heading: s.heading + Math.PI / 2 * side, idx });
    }
    this.markers = [this.hub, ...this.events, ...this.traps, ...this.drifts, ...this.zones];
  }
}

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
