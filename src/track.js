import * as THREE from 'three';
import { THEMES } from './tracks.js';

const SPACING = 2; // metres between samples along the centreline

function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return [
    0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
    0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
  ];
}

/** Sample a Catmull-Rom spline (closed loop, or open point-to-point) into uniformly spaced 2D points. */
export function sampleSpline(points, spacing = SPACING, open = false) {
  const n = points.length;
  const raw = [];
  if (open) {
    const g = (i) => points[Math.max(0, Math.min(n - 1, i))];
    for (let i = 0; i < n - 1; i++) for (let k = 0; k < 24; k++) raw.push(catmullRom(g(i - 1), g(i), g(i + 1), g(i + 2), k / 24));
    raw.push(points[n - 1]);
    const out = [raw[0]];
    let carry = 0;
    for (let i = 0; i < raw.length - 1; i++) {
      const a = raw[i], b = raw[i + 1];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const segLen = Math.hypot(dx, dz);
      let t = spacing - carry;
      while (t <= segLen) { out.push([a[0] + dx * (t / segLen), a[1] + dz * (t / segLen)]); t += spacing; }
      carry = segLen - (t - spacing);
    }
    return out;
  }
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n], p1 = points[i], p2 = points[(i + 1) % n], p3 = points[(i + 2) % n];
    for (let k = 0; k < 24; k++) raw.push(catmullRom(p0, p1, p2, p3, k / 24));
  }
  // Resample by arc length: walk the polyline placing a point every `spacing`
  // metres, carrying the leftover distance across polyline segments so the
  // samples are uniformly spaced (everything downstream assumes they are).
  const out = [raw[0]];
  let carry = 0; // distance travelled since the last placed point
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i], b = raw[(i + 1) % raw.length];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const segLen = Math.hypot(dx, dz);
    let t = spacing - carry;
    while (t <= segLen) {
      const f = t / segLen;
      out.push([a[0] + dx * f, a[1] + dz * f]);
      t += spacing;
    }
    carry = segLen - (t - spacing);
  }
  // The loop closes back onto raw[0]; drop a final point that sits on top of the first.
  const last = out[out.length - 1];
  if (Math.hypot(last[0] - out[0][0], last[1] - out[0][1]) < spacing * 0.5) out.pop();
  return out;
}

export class Track {
  constructor(def, quality = 'high') {
    this.def = def;
    this.theme = THEMES[def.theme];
    this.halfWidth = def.width / 2;   // nominal; per-sample values live in samples[i].hw / .wall
    this.wallOffset = this.halfWidth + 3.2; // replaced by the maximum once samples are built
    this.spacing = SPACING;
    this.group = new THREE.Group();
    this.quality = quality;
    this.open = !!def.open; // point-to-point stage instead of a loop
    this._buildSamples();
    this.seaLevel = Math.min(0, this.minHeight) - 6;
    if (this.theme.water !== null) this.coastZ = this.bounds.maxZ + 50;
    this._buildMeshes();
    this.sectorCount = 8;
    this.sectorSize = Math.ceil(this.samples.length / this.sectorCount);
  }

  /** Index wrap for loops, clamp for open stages. */
  wrap(i) { const N = this.samples.length; return this.open ? Math.max(0, Math.min(N - 1, i)) : ((i % N) + N) % N; }

  _buildSamples() {
    const pts = sampleSpline(this.def.points, SPACING, this.open);
    const N = pts.length;
    const W = (i) => this.open ? Math.max(0, Math.min(N - 1, i)) : ((i % N) + N) % N;
    // Stages: the start line sits after a run-up straight and the finish line before a run-off.
    this.startIdx = this.open ? Math.min(80, Math.floor(N * 0.1)) : 0;
    this.finishIdx = this.open ? N - Math.min(100, Math.floor(N * 0.1)) : 0;
    const heights = this._elevationProfile(N);
    const widths = this._widthProfile(N);
    this.samples = [];
    for (let i = 0; i < N; i++) {
      const prev = pts[W(i - 1)], next = pts[W(i + 1)];
      let tx = next[0] - prev[0], tz = next[1] - prev[1];
      const l = Math.hypot(tx, tz) || 1;
      tx /= l; tz /= l;
      this.samples.push({
        p: new THREE.Vector3(pts[i][0], heights[i], pts[i][1]),
        t: new THREE.Vector3(tx, 0, tz),
        n: new THREE.Vector3(tz, 0, -tx), // left-hand normal
        curv: 0,
        slope: (heights[W(i + 1)] - heights[W(i - 1)]) / ((W(i + 1) - W(i - 1)) * SPACING || SPACING),
        heading: Math.atan2(tx, tz),
        hw: (this.def.width / 2) * widths[i],
        wall: (this.def.width / 2) * widths[i] + 3.2,
      });
    }
    this.maxHalfWidth = Math.max(...this.samples.map(q => q.hw));
    this.wallOffset = this.maxHalfWidth + 3.2;
    this.minHeight = Math.min(...heights);
    this.maxHeight = Math.max(...heights);
    this._buildGrid();
    // signed curvature via heading change
    for (let i = 0; i < N; i++) {
      const a = this.samples[W(i - 2)].heading, b = this.samples[W(i + 2)].heading;
      let d = b - a;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.samples[i].curv = d / (SPACING * 4);
    }
    this.length = N * SPACING;
    // bounds for minimap
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const s of this.samples) {
      minX = Math.min(minX, s.p.x); maxX = Math.max(maxX, s.p.x);
      minZ = Math.min(minZ, s.p.z); maxZ = Math.max(maxZ, s.p.z);
    }
    this.bounds = { minX, maxX, minZ, maxZ };
  }

  get count() { return this.samples.length; }

  /** Width multiplier around the lap: the road breathes between ~0.82x and ~1.18x. */
  _widthProfile(N) {
    let seed = 7;
    for (const ch of this.def.id) seed = (seed * 33 + ch.charCodeAt(0)) >>> 0;
    const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const a1 = 1 + Math.floor(rand() * 3), a2 = 3 + Math.floor(rand() * 4), a3 = 6 + Math.floor(rand() * 5);
    const p1 = rand() * 6.28, p2 = rand() * 6.28, p3 = rand() * 6.28;
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const t = (i / N) * Math.PI * 2;
      let w = 1 + 0.10 * Math.sin(a1 * t + p1) + 0.06 * Math.sin(a2 * t + p2) + 0.03 * Math.sin(a3 * t + p3);
      // the start straight stays at the nominal width so the grid always fits
      const dStart = (this.open ? Math.min(Math.max(0, i - 40), Math.max(0, N - 1 - i)) : Math.min(i, N - i)) / N;
      const k = Math.min(1, dStart / 0.04);
      out[i] = 1 + (w - 1) * k;
    }
    return out;
  }

  /** Height profile around the lap, one value per sample. */
  _elevationProfile(N) {
    let keys = this.def.elevation;
    if (!keys) {
      // Seeded rolling profile for tracks without an authored one.
      const amp = this.def.elevationAmp ?? 6;
      let seed = 0;
      for (const ch of this.def.id) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
      const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      const K = 5 + Math.floor((N * SPACING) / 350);
      keys = [[0, 0]];
      for (let k = 1; k < K; k++) keys.push([k / K + (rand() - 0.5) * (0.4 / K), (rand() * 2 - 1) * amp]);
    }
    keys = [...keys].sort((a, b) => a[0] - b[0]);
    const M = keys.length;
    const out = new Float32Array(N);
    const open = this.open;
    const K = (j) => open ? keys[Math.max(0, Math.min(M - 1, j))] : keys[((j % M) + M) % M];
    for (let i = 0; i < N; i++) {
      const t = open ? i / (N - 1) : i / N;
      // find segment
      let k = 0;
      while (k < M - 1 && keys[k + 1][0] <= t) k++;
      if (open && k >= M - 1) { out[i] = keys[M - 1][1]; continue; }
      const t0 = keys[k][0], t1 = k + 1 < M ? keys[k + 1][0] : keys[0][0] + 1;
      const u = (t - t0) / Math.max(1e-6, t1 - t0);
      const p0 = K(k - 1)[1], p1 = K(k)[1], p2 = K(k + 1)[1], p3 = K(k + 2)[1];
      const u2 = u * u, u3 = u2 * u;
      out[i] = 0.5 * ((2 * p1) + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
    }
    // Limit the gradient so the road never gets absurdly steep, then smooth.
    // Smoothing always runs last: the clamp creates kinks, and kinks feel like
    // bumps at speed.
    const maxStep = SPACING * 0.14;
    const WI = (i) => open ? Math.max(0, Math.min(N - 1, i)) : ((i % N) + N) % N;
    const clampGrade = () => {
      const passes = open ? N - 1 : N * 2;
      for (let i = 0; i < passes; i++) {
        const a = WI(i), b = WI(i + 1);
        const d = out[b] - out[a];
        if (d > maxStep) out[b] = out[a] + maxStep;
        else if (d < -maxStep) out[b] = out[a] - maxStep;
      }
    };
    const smooth = (half) => {
      const copy = Float32Array.from(out);
      const w = half * 2 + 1;
      for (let i = 0; i < N; i++) {
        let acc = 0;
        for (let k = -half; k <= half; k++) acc += copy[WI(i + k)];
        out[i] = acc / w;
      }
    };
    clampGrade(); smooth(10); clampGrade(); smooth(8); smooth(6); smooth(4);
    // make the start line sit exactly at height 0
    const off = out[this.startIdx || 0];
    for (let i = 0; i < N; i++) out[i] -= off;
    return out;
  }

  _buildGrid() {
    this.cell = 40;
    this.grid = new Map();
    this.samples.forEach((s, i) => {
      const key = `${Math.floor(s.p.x / this.cell)},${Math.floor(s.p.z / this.cell)}`;
      if (!this.grid.has(key)) this.grid.set(key, []);
      this.grid.get(key).push(i);
    });
  }

  /** Nearest sample to any world point using the spatial grid. Returns { idx, dist }. */
  nearestGlobal(x, z) {
    const cx = Math.floor(x / this.cell), cz = Math.floor(z / this.cell);
    let best = -1, bestD = Infinity;
    for (let ring = 0; ring <= 4; ring++) {
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

  /** Road height under a world position (uses the nearest-sample hint for speed). */
  heightAtPos(pos, idx) {
    const N = this.samples.length;
    let f = Math.max(-1, Math.min(1, this._param(pos, idx)));
    // Catmull-Rom through the four surrounding samples so the height is C1-continuous
    let i1 = idx, u = f;
    if (f < 0) { i1 = this.wrap(idx - 1); u = f + 1; }
    const h0 = this.samples[this.wrap(i1 - 1)].p.y, h1 = this.samples[i1].p.y;
    const h2 = this.samples[this.wrap(i1 + 1)].p.y, h3 = this.samples[this.wrap(i1 + 2)].p.y;
    const u2 = u * u, u3 = u2 * u;
    return 0.5 * ((2 * h1) + (-h0 + h2) * u + (2 * h0 - 5 * h1 + 4 * h2 - h3) * u2 + (-h0 + 3 * h1 - 3 * h2 + h3) * u3);
  }

  /** Road slope (dy/ds) under a world position, interpolated between samples. */
  slopeAtPos(pos, idx) {
    const N = this.samples.length;
    const s = this.samples[idx];
    const f = Math.max(-1, Math.min(1, this._param(pos, idx)));
    const j = f >= 0 ? this.wrap(idx + 1) : this.wrap(idx - 1);
    const w = Math.abs(f);
    return s.slope * (1 - w) + this.samples[j].slope * w;
  }

  /** Terrain height for scenery / ground mesh. Hugs the road nearby, rolls freely far away. */
  terrainHeight(x, z) {
    const { idx, dist } = this.nearestGlobal(x, z);
    const th = this.theme;
    const A = th.hills || 8;
    let noise = A * (0.5 * Math.sin(x * 0.011 + 1.3) * Math.cos(z * 0.009 - 0.4) + 0.3 * Math.sin(x * 0.027 - z * 0.021) + 0.2 * Math.sin(z * 0.043 + x * 0.017)) - A * 0.15;
    let h;
    if (idx < 0 || dist > 140) h = noise;
    else {
      const road = this.samples[idx].p.y;
      const corridor = this.wallOffset + 3;
      if (dist < corridor) h = road - 2.5;                       // trench hidden under the road
      else {
        const w = smoothstep(30, 90, dist);
        h = (road - 0.35) * (1 - w) + noise * w;
      }
    }
    if (th.water !== null && this.coastZ !== undefined) {
      const w = smoothstep(this.coastZ, this.coastZ + 90, z);
      h = h * (1 - w) + (this.seaLevel - 3) * w;
    }
    return h;
  }

  /** Nearest sample index, searching around `hint` if provided. */
  nearestIndex(pos, hint = null, window = 40) {
    const N = this.samples.length;
    let best = -1, bestD = Infinity;
    if (hint === null || hint === undefined) {
      for (let i = 0; i < N; i++) {
        const s = this.samples[i];
        const dx = s.p.x - pos.x, dz = s.p.z - pos.z;
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = i; }
      }
      return best;
    }
    for (let k = -window; k <= window; k++) {
      const i = this.open ? hint + k : (hint + k + N * 4) % N;
      if (i < 0 || i >= N) continue;
      const s = this.samples[i];
      const dx = s.p.x - pos.x, dz = s.p.z - pos.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  /** Signed lateral offset from centreline (positive = left). */
  lateral(pos, idx) {
    const s = this.samples[idx];
    return (pos.x - s.p.x) * s.n.x + (pos.z - s.p.z) * s.n.z;
  }

  /**
   * Longitudinal parameter (in samples) of a point relative to sample idx.
   * Points off the centreline on a curve sweep less (inside) or more (outside)
   * distance per metre of track, so the raw tangent projection is corrected by
   * the local curvature; without this the height/progress jump at each sample.
   */
  _param(pos, idx) {
    const s = this.samples[idx];
    const dx = pos.x - s.p.x, dz = pos.z - s.p.z;
    let f = (dx * s.t.x + dz * s.t.z) / SPACING;
    const lat = dx * s.n.x + dz * s.n.z;
    const k = 1 - s.curv * lat;
    if (k > 0.3) f /= k;
    return f;
  }

  /** Continuous progress along the track in sample units. */
  progressAt(pos, idx) {
    return idx + Math.max(-0.5, Math.min(0.5, this._param(pos, idx)));
  }

  sample(i) { return this.samples[this.wrap(i)]; }

  /** Max absolute curvature in the next `metres`. */
  maxCurvatureAhead(idx, metres) {
    const n = Math.ceil(metres / SPACING);
    let m = 0;
    for (let k = 0; k < n; k++) m = Math.max(m, Math.abs(this.sample(idx + k).curv));
    return m;
  }

  sectorOf(idx) { return Math.min(this.sectorCount - 1, Math.floor(idx / this.sectorSize)); }

  /** World position/heading of a grid slot behind the start line. */
  gridSlot(slot) {
    const row = Math.floor(slot / 2), side = slot % 2 === 0 ? 1 : -1;
    const back = 6 + row * 7 + (slot % 2) * 3.5;
    const idx = this.wrap(this.startIdx - Math.round(back / SPACING));
    const s = this.samples[idx];
    const lateral = side * s.hw * 0.42;
    return {
      x: s.p.x + s.n.x * lateral, y: s.p.y, z: s.p.z + s.n.z * lateral, heading: s.heading, idx,
    };
  }

  // ------------------------------------------------------------------ Meshes
  _buildMeshes() {
    const th = this.theme;
    const N = this.samples.length;
    const highQ = this.quality !== 'low';
    const HW = (q) => q.hw, NHW = (q) => -q.hw, WALL = (q) => q.wall, NWALL = (q) => -q.wall;

    // Road surface
    const roadTex = makeRoadTexture(th);
    roadTex.wrapT = THREE.RepeatWrapping;
    roadTex.wrapS = THREE.ClampToEdgeWrapping;
    const road = this._strip(N, HW, NHW, 0.12, (i, side) => [side === 0 ? 0 : 1, (i * SPACING) / 12]);
    const roadMat = new THREE.MeshStandardMaterial({ map: roadTex, roughness: 0.92, metalness: 0.02, color: 0xffffff });
    const roadMesh = new THREE.Mesh(road, roadMat);
    roadMesh.receiveShadow = true;
    this.group.add(roadMesh);

    // Runoff (gravel/grass verge between road and wall)
    const runoffMat = new THREE.MeshStandardMaterial({ color: th.night ? 0x333540 : lerpColor(th.ground, 0x8a8a80, 0.55), roughness: 1 });
    const runoffL = this._strip(N, (q) => q.wall + 0.5, (q) => q.hw + 1.1, 0.1);
    const runoffR = this._strip(N, (q) => -q.hw - 1.1, (q) => -q.wall - 0.5, 0.1);
    for (const g of [runoffL, runoffR]) { const m = new THREE.Mesh(g, runoffMat); m.receiveShadow = true; this.group.add(m); }

    // Curbs (red/white) at corners, plain grey elsewhere
    const curbL = this._strip(N, (q) => q.hw + 1.1, HW, 0.13, null, (i) => curbColor(this.samples[i].curv, i));
    const curbR = this._strip(N, NHW, (q) => -q.hw - 1.1, 0.13, null, (i) => curbColor(this.samples[i].curv, i));
    const curbMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
    for (const g of [curbL, curbR]) { const m = new THREE.Mesh(g, curbMat); m.receiveShadow = true; this.group.add(m); }

    // Barriers
    const wallH = 1.1;
    const wallMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.1, side: THREE.DoubleSide });
    for (const side of [1, -1]) {
      const g = this._wall(N, (q) => side * q.wall, wallH, (i) => {
        const band = Math.floor(i / 6) % 2;
        if (th.night) return band ? 0x2f80ff : 0xf5f5f5;
        return band ? 0xe53935 : 0xf4f4f4;
      });
      const m = new THREE.Mesh(g, wallMat);
      m.castShadow = highQ; m.receiveShadow = true;
      this.group.add(m);
      // top rail
      const rail = this._strip(N, (q) => side * q.wall + 0.35, (q) => side * q.wall - 0.35, wallH, null, () => 0x6d7078);
      this.group.add(new THREE.Mesh(rail, wallMat));
    }

    // Start / finish line
    const s0 = this.samples[this.startIdx];
    const lineGeo = new THREE.PlaneGeometry(s0.hw * 2, 3);
    const lineTex = makeCheckerTexture();
    lineTex.repeat.set(8, 2); lineTex.wrapS = lineTex.wrapT = THREE.RepeatWrapping;
    const line = new THREE.Mesh(lineGeo, new THREE.MeshStandardMaterial({ map: lineTex, roughness: 0.9 }));
    line.rotation.set(-Math.PI / 2, 0, 0);
    line.position.y = 0.14;
    const pivot = new THREE.Group();
    pivot.position.set(s0.p.x, s0.p.y + 0.04, s0.p.z);
    pivot.rotation.y = s0.heading;
    line.position.set(0, 0, 0);
    pivot.add(line);
    this.group.add(pivot);

    // Start gantry
    const gantry = new THREE.Group();
    const postMat = new THREE.MeshStandardMaterial({ color: 0x8a8f99, metalness: 0.5, roughness: 0.4 });
    const postGeo = new THREE.BoxGeometry(0.5, 7, 0.5);
    for (const sd of [1, -1]) {
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(sd * (s0.wall + 1.2), 3.5, 0);
      post.castShadow = highQ; gantry.add(post);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(s0.wall * 2 + 3, 1.6, 1), new THREE.MeshStandardMaterial({ map: makeBannerTexture(this.def.name, th), roughness: 0.6 }));
    beam.position.set(0, 6.4, 0); beam.castShadow = highQ; gantry.add(beam);
    // start lights
    const lightGeo = new THREE.SphereGeometry(0.28, 12, 12);
    this.startLights = [];
    for (let i = 0; i < 5; i++) {
      const m = new THREE.Mesh(lightGeo, new THREE.MeshStandardMaterial({ color: 0x330000, emissive: 0x000000 }));
      m.position.set((i - 2) * 1.2, 5.3, 0.6); gantry.add(m); this.startLights.push(m);
    }
    gantry.position.set(s0.p.x, s0.p.y, s0.p.z);
    gantry.rotation.y = s0.heading;
    this.group.add(gantry);

    if (this.open) {
      // Finish line and gantry
      const sf = this.samples[this.finishIdx];
      const fpivot = new THREE.Group();
      fpivot.position.set(sf.p.x, sf.p.y + 0.04, sf.p.z);
      fpivot.rotation.y = sf.heading;
      const fline = new THREE.Mesh(new THREE.PlaneGeometry(sf.hw * 2, 3), new THREE.MeshStandardMaterial({ map: lineTex, roughness: 0.9 }));
      fline.rotation.set(-Math.PI / 2, 0, 0); fline.position.y = 0.14;
      fpivot.add(fline);
      const fg = new THREE.Group();
      for (const sd of [1, -1]) { const post = new THREE.Mesh(postGeo, postMat); post.position.set(sd * (sf.wall + 1.2), 3.5, 0); fg.add(post); }
      const fbeam = new THREE.Mesh(new THREE.BoxGeometry(sf.wall * 2 + 3, 1.6, 1), new THREE.MeshStandardMaterial({ map: makeBannerTexture('FINISH', th), roughness: 0.6 }));
      fbeam.position.set(0, 6.4, 0); fg.add(fbeam);
      fg.rotation.y = sf.heading; fg.position.set(sf.p.x, sf.p.y, sf.p.z);
      this.group.add(fpivot, fg);
      // Barriers across both ends of the stage
      for (const i of [0, N - 1]) {
        const s = this.samples[i];
        const bar = new THREE.Mesh(new THREE.BoxGeometry(s.wall * 2 + 1, 1.4, 0.6), new THREE.MeshStandardMaterial({ vertexColors: false, color: 0xe53935, roughness: 0.6 }));
        bar.position.set(s.p.x, s.p.y + 0.7, s.p.z); bar.rotation.y = s.heading;
        this.group.add(bar);
      }
    }
  }

  setStartLights(count, go) {
    this.startLights.forEach((m, i) => {
      if (go) { m.material.color.set(0x00ff55); m.material.emissive.set(0x00ff55); }
      else if (i < count) { m.material.color.set(0xff2020); m.material.emissive.set(0xff2020); }
      else { m.material.color.set(0x330000); m.material.emissive.set(0x000000); }
    });
  }

  /** Closed triangle strip between lateral offsets a (left) and b (right). */
  _strip(N, a, b, y, uvFn = null, colorFn = null) {
    const pos = new Float32Array(N * 2 * 3);
    const uv = new Float32Array(N * 2 * 2);
    const col = colorFn ? new Float32Array(N * 2 * 3) : null;
    const c = new THREE.Color();
    for (let i = 0; i < N; i++) {
      const s = this.samples[i];
      const A = typeof a === 'function' ? a(s, i) : a, Bv = typeof b === 'function' ? b(s, i) : b;
      const ax = s.p.x + s.n.x * A, az = s.p.z + s.n.z * A;
      const bx = s.p.x + s.n.x * Bv, bz = s.p.z + s.n.z * Bv;
      const yy = s.p.y + y;
      pos.set([ax, yy, az, bx, yy, bz], i * 6);
      const ua = uvFn ? uvFn(i, 0) : [0, i * SPACING / 8], ub = uvFn ? uvFn(i, 1) : [1, i * SPACING / 8];
      uv.set([ua[0], ua[1], ub[0], ub[1]], i * 4);
      if (col) { c.set(colorFn(i)); col.set([c.r, c.g, c.b, c.r, c.g, c.b], i * 6); }
    }
    const idx = [];
    for (let i = 0; i < (this.open ? N - 1 : N); i++) {
      const j = (i + 1) % N;
      const a0 = i * 2, b0 = i * 2 + 1, a1 = j * 2, b1 = j * 2 + 1;
      idx.push(a0, b0, a1, b0, b1, a1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    if (col) g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  _wall(N, offset, h, colorFn) {
    const pos = new Float32Array(N * 2 * 3);
    const col = new Float32Array(N * 2 * 3);
    const uv = new Float32Array(N * 2 * 2);
    const c = new THREE.Color();
    for (let i = 0; i < N; i++) {
      const s = this.samples[i];
      const off = typeof offset === 'function' ? offset(s, i) : offset;
      const x = s.p.x + s.n.x * off, z = s.p.z + s.n.z * off;
      pos.set([x, s.p.y - 3, z, x, s.p.y + h, z], i * 6);
      c.set(colorFn(i)); col.set([c.r, c.g, c.b, c.r, c.g, c.b], i * 6);
      uv.set([i / N, 0, i / N, 1], i * 4);
    }
    const idx = [];
    for (let i = 0; i < (this.open ? N - 1 : N); i++) {
      const j = (i + 1) % N;
      idx.push(i * 2, j * 2, i * 2 + 1, i * 2 + 1, j * 2, j * 2 + 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }
}

function smoothstep(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

function curbColor(curv, i) {
  if (Math.abs(curv) < 0.006) return 0x8c8f96;
  return Math.floor(i / 3) % 2 ? 0xe53935 : 0xf4f4f4;
}

function lerpColor(a, b, t) {
  const ca = new THREE.Color(a), cb = new THREE.Color(b);
  return ca.lerp(cb, t).getHex();
}

function makeRoadTexture(theme) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const ctx = c.getContext('2d');
  const base = new THREE.Color(theme.road);
  ctx.fillStyle = `rgb(${base.r * 255 | 0},${base.g * 255 | 0},${base.b * 255 | 0})`;
  ctx.fillRect(0, 0, 256, 256);
  // asphalt noise
  const img = ctx.getImageData(0, 0, 256, 256);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 26;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
  // edge lines
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillRect(6, 0, 5, 256);
  ctx.fillRect(245, 0, 5, 256);
  // dashed centre line
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.fillRect(126, 0, 4, 100);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export function makeCheckerTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = '#111'; ctx.fillRect(0, 0, 32, 32); ctx.fillRect(32, 32, 32, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function makeBannerTexture(name, theme) {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 96;
  const ctx = c.getContext('2d');
  ctx.fillStyle = theme.night ? '#12142a' : '#1a1c22';
  ctx.fillRect(0, 0, 1024, 96);
  ctx.fillStyle = '#ff5a1f'; ctx.fillRect(0, 0, 1024, 10); ctx.fillRect(0, 86, 1024, 10);
  ctx.fillStyle = '#fff';
  ctx.font = 'italic 900 52px Arial';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(name.toUpperCase(), 512, 50);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
