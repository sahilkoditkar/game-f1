// Free Roam ("Horizon") mode: an open world streamed in 200 m chunks around the
// player, with the circuits as drive-up events, speed traps, drift zones, speed
// zones and bonus boards. Progress lives in profile.horizon.
import * as THREE from 'three';
import { World, fbm, smoothstep, mulberry32 } from './world.js';
import { Car } from './car.js';
import { DriftFx } from './fx.js';
import { buildSun, aimSun, buildEnvironment, updateChaseCamera, snapChaseCamera } from './scenekit.js';
import { addTrees } from './scenery.js';
import { HorizonHUD } from './horizonhud.js';
import { Traffic } from './traffic.js';
import { getCar, PLAYER_COLORS } from './data.js';
import { playerStats } from './career.js';
import { getControl } from './input.js';
import { WORLD_HALF, SEA_Z, SEA_LEVEL, CITY, BOARD_XP, REGIONS, levelForXp } from './worlddef.js';

const CHUNK = 200;        // metres
const SEG = 20;           // terrain cells per chunk side (10 m)
const VIEW_R = 1150;      // chunks are kept within this radius of the player
const clamp = THREE.MathUtils.clamp;

const ROAD_COLORS = { highway: 0x3a3a40, road: 0x3c3c42, lane: 0x45444a, dirt: 0x8a7352, street: 0x36363c, pad: 0x3b3b41 };

export class Horizon {
  /**
   * @param {object} o { renderer, input, audio, profile, quality, onEvent(marker), onSave(), onLevel(level) }
   */
  constructor(o) {
    this.renderer = o.renderer; this.input = o.input; this.audio = o.audio; this.profile = o.profile;
    this.quality = o.quality || 'high';
    this.onEvent = o.onEvent; this.onSave = o.onSave; this.onLevel = o.onLevel || (() => {});
    this.prog = this.profile.horizon;
    this.highQ = this.quality !== 'low';

    this.world = new World();
    this.scene = new THREE.Scene();
    const th = this.world.theme;
    this.scene.background = new THREE.Color(th.sky);
    this.scene.fog = new THREE.Fog(th.fog, 300, 1900);
    this.sun = buildSun(this.scene, th, this.highQ, 100);
    this.envTex = buildEnvironment(this.renderer, th);
    this.scene.environment = this.envTex;
    this.scene.environmentIntensity = 0.9;

    this.tmp = new THREE.Vector3(); this.tmp2 = new THREE.Vector3();
    this.chunks = new Map();
    this.boardMeshes = new Map();
    this.time = 0;
    this.paused = false; this.suspended = false;
    this.waypoint = null;
    this.prompt = null;
    this.promptCooldown = 0;
    this.requestMap = false;
    this.drift = null;    // active drift zone run
    this.zone = null;     // active speed zone run
    this.saveTimer = 0;
    this.toasts = [];

    this._buildRoads();
    this._buildStatic();
    this._buildProps();
    this._setupPlayer();
    this.traffic = new Traffic(this, this.highQ ? 26 : 14);
    this.fx = new DriftFx(this.scene, this.world, this.quality);
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.5, 6000);
    this.camera.userData.shake = 0;
    this.hud = new HorizonHUD(this);
    this.resize();
    this._streamChunks(true);
    snapChaseCamera(this.camera, this.car, this.tmp2);
    this._setupAudio();
    this.input.setTouchVisible(true);
  }

  // ------------------------------------------------------------ Setup
  _setupPlayer() {
    const p = this.profile;
    const carDef = getCar(p.selected);
    this.car = new Car({ name: p.name, color: PLAYER_COLORS[p.colorIndex || 0], stats: playerStats(p), shape: carDef.shape, isPlayer: true, playerIndex: 0, quality: this.quality });
    this.scene.add(this.car.mesh);
    const saved = this.prog.pos;
    if (saved && Math.abs(saved[0]) < WORLD_HALF && Math.abs(saved[1]) < WORLD_HALF) {
      const idx = this.world.nearestGlobal(saved[0], saved[1]).idx;
      this.car.trackIdx = Math.max(0, idx);
      this.tmp.set(saved[0], 0, saved[1]);
      this.car.place(saved[0], saved[1], saved[2], this.world.heightAtPos(this.tmp, this.car.trackIdx));
    } else this.placeAt(this.world.hub.idx);
  }

  _setupAudio() { this.audio.init(); this.engine = this.audio.createEngine(); }

  /** Put the car on the road at a sample index, stopped and facing along it. */
  placeAt(idx, back = 0) {
    const s = this.world.samples[this.world.roadWrap(this.world.roadOf(idx), idx - back, true)];
    this.car.trackIdx = idx;
    this.car.place(s.p.x, s.p.z, s.heading, s.p.y);
    this.car.slide = 0;
    this.prompt = null;
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.viewport = { x: 0, y: 0, w, h };
    this.hud.layout();
  }

  // ------------------------------------------------------------ Roads
  _buildRoads() {
    const g = new THREE.Group();
    const texByKind = {};
    for (const road of this.world.roads) {
      if (!texByKind[road.kind]) texByKind[road.kind] = makeWorldRoadTexture(road.kind, road.width);
      const tex = texByKind[road.kind];
      const yo = road.yOff;
      const reps = road.closed ? Math.max(1, Math.round(road.length / 14)) : road.length / 14;
      const surf = this._strip(road, (s) => s.hw, (s) => -s.hw, yo, yo, (li, side) => [side === 0 ? 0 : 1, (li / road.n) * reps]);
      const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: road.kind === 'dirt' ? 1 : 0.9, metalness: 0.02 });
      const m = new THREE.Mesh(surf, mat); m.receiveShadow = true; g.add(m);
      // shoulders: a pavement kerb in the city, a sloping gravel verge elsewhere
      const street = road.kind === 'street';
      const shW = street ? 2.4 : 2.8;
      const shColor = street ? 0x9a9ca2 : (road.kind === 'dirt' ? 0x7f6b4e : 0x8e8a7c);
      const shMat = new THREE.MeshStandardMaterial({ color: shColor, roughness: 1 });
      const yOuter = street ? yo + 0.14 : yo - 0.1;
      const L = this._strip(road, (s) => s.hw + shW, (s) => s.hw, yOuter, street ? yo + 0.14 : yo);
      const R = this._strip(road, (s) => -s.hw, (s) => -s.hw - shW, street ? yo + 0.14 : yo, yOuter);
      for (const sg of [L, R]) { const sm = new THREE.Mesh(sg, shMat); sm.receiveShadow = true; g.add(sm); }
    }
    // Junction pads: a plain asphalt disc over every crossing and T-junction so the
    // two roads' edges, kerbs and markings don't collide where they meet.
    const padTex = makeWorldRoadTexture('pad', 0);
    const padMat = new THREE.MeshStandardMaterial({ map: padTex, roughness: 0.9, metalness: 0.02, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    for (const [i, j] of this.world.junctionPairs) {
      const a = this.world.samples[i], b = this.world.samples[j];
      const r = Math.max(a.hw, b.hw) + 2.2;
      const pad = new THREE.Mesh(new THREE.CircleGeometry(r, 28), padMat);
      pad.rotation.x = -Math.PI / 2;
      pad.position.set((a.p.x + b.p.x) / 2, Math.max(a.p.y, b.p.y) + Math.max(this.world.roadOf(i).yOff, this.world.roadOf(j).yOff) + 0.02, (a.p.z + b.p.z) / 2);
      pad.receiveShadow = true;
      g.add(pad);
    }
    this.roadGroup = g;
    this.scene.add(g);
  }

  /**
   * Triangle strip along a road between lateral offsets a (left) and b (right), with
   * per-side height offsets. Loops get the first vertex pair duplicated at the end so
   * the texture coordinate keeps running across the seam instead of snapping back to 0.
   */
  _strip(road, a, b, ya, yb, uvFn = null) {
    const W = this.world, N = road.n;
    const M = road.closed ? N + 1 : N;
    const pos = new Float32Array(M * 6), uv = new Float32Array(M * 4);
    for (let li = 0; li < M; li++) {
      const s = W.samples[road.i0 + (li % N)];
      const A = a(s), B = b(s);
      pos.set([s.p.x + s.n.x * A, s.p.y + ya, s.p.z + s.n.z * A, s.p.x + s.n.x * B, s.p.y + yb, s.p.z + s.n.z * B], li * 6);
      const ua = uvFn ? uvFn(li, 0) : [0, li / 4], ub = uvFn ? uvFn(li, 1) : [1, li / 4];
      uv.set([ua[0], ua[1], ub[0], ub[1]], li * 4);
    }
    const idx = [];
    for (let li = 0; li < M - 1; li++) {
      const j = li + 1;
      idx.push(li * 2, li * 2 + 1, j * 2, li * 2 + 1, j * 2 + 1, j * 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  }

  // ------------------------------------------------------------ Static scenery
  _buildStatic() {
    const W = this.world;
    // Far ground: a coarse mesh of the natural terrain so nothing beyond the chunk radius shows the void.
    const far = new THREE.PlaneGeometry(WORLD_HALF * 3, WORLD_HALF * 3, 72, 72);
    far.rotateX(-Math.PI / 2);
    const fp = far.attributes.position, fc = new Float32Array(fp.count * 3);
    const col = new THREE.Color();
    for (let i = 0; i < fp.count; i++) {
      const x = fp.getX(i), z = fp.getZ(i);
      // Roads are smoothed and grade-limited, so they can sit well below the natural ground;
      // keep the far mesh under any road within reach so it never pokes through a cutting.
      let h = W.baseHeight(x, z);
      const near = W.nearestGlobal(x, z, 5);
      if (near.idx >= 0) h = Math.min(h, W.samples[near.idx].p.y);
      fp.setY(i, h - 4);
      groundColor(W, x, z, fp.getY(i), col);
      fc.set([col.r, col.g, col.b], i * 3);
    }
    far.setAttribute('color', new THREE.BufferAttribute(fc, 3));
    far.computeVertexNormals();
    this.scene.add(new THREE.Mesh(far, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 })));

    // Sea
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(WORLD_HALF * 4, 3200), new THREE.MeshStandardMaterial({ color: 0x2277cc, roughness: 0.2, metalness: 0.35, transparent: true, opacity: 0.9 }));
    sea.rotation.x = -Math.PI / 2;
    sea.position.set(0, SEA_LEVEL, SEA_Z + 1500);
    this.scene.add(sea);

    // Mountain backdrop along the north, east and west horizons
    const rand = mulberry32(4242);
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x7d8da0, roughness: 1, flatShading: true });
    const snowMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, flatShading: true });
    for (let i = 0; i < 34; i++) {
      const a = Math.PI + (i / 33) * Math.PI;          // from west (π) through north to east (2π)
      const r = 3500 + rand() * 500;
      const coneR = 320 + rand() * 260, h = 380 + rand() * 420;
      const m = new THREE.Mesh(new THREE.ConeGeometry(coneR, h, 6 + Math.floor(rand() * 3)), rockMat);
      m.position.set(Math.cos(a) * r, -60 + h / 2, Math.sin(a) * r);
      m.rotation.y = rand() * Math.PI;
      this.scene.add(m);
      const cap = new THREE.Mesh(new THREE.ConeGeometry(coneR * 0.42, h * 0.3, 6), snowMat);
      cap.position.set(m.position.x, -60 + h - h * 0.15, m.position.z); cap.rotation.y = m.rotation.y;
      this.scene.add(cap);
    }
    // Shared terrain material with a subtle noise detail map
    const detail = makeDetailTexture();
    detail.wrapS = detail.wrapT = THREE.RepeatWrapping;
    detail.repeat.set(CHUNK / 24, CHUNK / 24);
    this.terrainMat = new THREE.MeshStandardMaterial({ vertexColors: true, map: detail, roughness: 1 });
  }

  // ------------------------------------------------------------ Props (markers, gantries, boards)
  _buildProps() {
    const W = this.world, g = new THREE.Group();
    this.props = g;
    const hub = W.hub;
    const hs = W.samples[hub.idx];
    const hubG = makeGantry(hs.hw * 2 + 10, 'HORIZON FESTIVAL', '#ff5a1f', '#fff', 7.5);
    hubG.position.set(hs.p.x, hs.p.y, hs.p.z); hubG.rotation.y = hs.heading; g.add(hubG);
    const flagColors = [0xff5a1f, 0x2f7bff, 0x3ddc84, 0xffd23f, 0xb04cff, 0xff4d9d];
    for (let i = 0; i < 12; i++) {
      const side = i % 2 ? 1 : -1, s = W.samples[W.roadWrap(W.roadOf(hub.idx), hub.idx + (i - 6) * 9, true)];
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 9, 5), new THREE.MeshStandardMaterial({ color: 0xdddddd }));
      const x = s.p.x + s.n.x * side * (s.hw + 5), z = s.p.z + s.n.z * side * (s.hw + 5);
      pole.position.set(x, s.p.y + 4.5, z); g.add(pole);
      const flag = new THREE.Mesh(new THREE.BoxGeometry(0.1, 3.2, 1.6), new THREE.MeshStandardMaterial({ color: flagColors[i % flagColors.length], side: THREE.DoubleSide }));
      flag.position.set(x, s.p.y + 7.4, z + 0.8); g.add(flag);
    }
    g.add(makeBeam(0xff5a1f, hub.x, hub.y, hub.z, 90));

    // Events: roadside sign, light beam and a glowing start ring on the road
    this.eventRings = [];
    for (const e of W.events) {
      const s = W.samples[e.idx];
      g.add(makeSign(e.name, e.track.kind === 'stage' ? '#3ddc84' : '#ff5a1f', e.x, e.y, e.z, s.heading + Math.PI / 2 * e.side));
      g.add(makeBeam(e.track.kind === 'stage' ? 0x3ddc84 : 0xff8a3d, e.x, e.y, e.z, 70));
      const ring = new THREE.Mesh(new THREE.RingGeometry(Math.max(6, s.hw + 1) - 1.4, Math.max(6, s.hw + 1), 48), new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2; ring.position.set(s.p.x, s.p.y + W.roadOf(e.idx).yOff + 0.06, s.p.z);
      g.add(ring); this.eventRings.push(ring);
    }
    // Speed traps: a camera gantry across the road
    for (const t of W.traps) {
      const s = W.samples[t.idx];
      const gt = makeGantry(s.hw * 2 + 6, 'SPEED TRAP', '#1d3f7a', '#8fd0ff', 6.4, true);
      gt.position.set(s.p.x, s.p.y, s.p.z); gt.rotation.y = s.heading; g.add(gt);
    }
    // Drift and speed zones: start and finish gantries
    for (const z of [...W.drifts, ...W.zones]) {
      const drift = z.kind === 'drift';
      for (const [i, label] of [[z.i0, drift ? 'DRIFT ZONE' : 'SPEED ZONE'], [z.i1, 'END']]) {
        const s = W.samples[i];
        const gz = makeGantry(s.hw * 2 + 6, label, drift ? '#4a1d7a' : '#135a66', drift ? '#e3a7ff' : '#9df3ff', 5.8);
        gz.position.set(s.p.x, s.p.y, s.p.z); gz.rotation.y = s.heading; g.add(gz);
      }
    }
    // Bonus boards
    const boardTex = makeBoardTexture();
    for (const b of W.boards) {
      if (this.prog.boards.includes(b.id)) continue;
      const bm = new THREE.Group();
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 2.2, 6), new THREE.MeshStandardMaterial({ color: 0x5a5e66 }));
      post.position.y = 1.1; bm.add(post);
      const panel = new THREE.Mesh(new THREE.BoxGeometry(3.4, 2.1, 0.16), new THREE.MeshStandardMaterial({ map: boardTex, roughness: 0.6, emissive: 0x3ddc84, emissiveIntensity: 0.25 }));
      panel.position.y = 3.1; panel.castShadow = this.highQ; bm.add(panel);
      bm.position.set(b.x, b.y, b.z); bm.rotation.y = b.heading;
      g.add(bm); this.boardMeshes.set(b.id, bm);
    }
    this.scene.add(g);
  }

  // ------------------------------------------------------------ Chunk streaming
  _chunkKey(cx, cz) { return `${cx},${cz}`; }

  /** Build missing chunks near the player (all of them when `all`, else a couple per frame) and drop far ones. */
  _streamChunks(all = false) {
    const px = this.car.pos.x, pz = this.car.pos.z;
    const ccx = Math.floor(px / CHUNK), ccz = Math.floor(pz / CHUNK);
    const R = Math.ceil(VIEW_R / CHUNK);
    const want = [];
    for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) {
      const cx = ccx + dx, cz = ccz + dz;
      const wx = (cx + 0.5) * CHUNK, wz = (cz + 0.5) * CHUNK;
      if (Math.abs(wx) > WORLD_HALF + CHUNK || wz > SEA_Z + CHUNK || wz < -WORLD_HALF - CHUNK) continue;
      const d = Math.hypot(wx - px, wz - pz);
      if (d > VIEW_R) continue;
      const key = this._chunkKey(cx, cz);
      if (!this.chunks.has(key)) want.push({ cx, cz, key, d });
    }
    want.sort((a, b) => a.d - b.d);
    const budget = all ? want.length : 2;
    for (let i = 0; i < Math.min(budget, want.length); i++) {
      const w = want[i];
      const c = this._buildChunk(w.cx, w.cz);
      this.chunks.set(w.key, c);
      this.scene.add(c.group);
    }
    if (!all && (this.time % 1) < 0.02) {
      for (const [key, c] of this.chunks) {
        if (Math.hypot(c.x - px, c.z - pz) > VIEW_R + 320) {
          this.scene.remove(c.group);
          disposeGroup(c.group);
          this.chunks.delete(key);
        }
      }
    }
  }

  _buildChunk(cx, cz) {
    const W = this.world;
    const x0 = (cx + 0.5) * CHUNK, z0 = (cz + 0.5) * CHUNK;
    const group = new THREE.Group();
    const geo = new THREE.PlaneGeometry(CHUNK, CHUNK, SEG, SEG);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const n = pos.count;
    const colors = new Float32Array(n * 3), normals = new Float32Array(n * 3);
    const col = new THREE.Color();
    const d = 3;
    for (let i = 0; i < n; i++) {
      const x = x0 + pos.getX(i), z = z0 + pos.getZ(i);
      const h = W.terrainHeight(x, z);
      pos.setY(i, h);
      const hx = W.terrainHeight(x + d, z) - W.terrainHeight(x - d, z);
      const hz = W.terrainHeight(x, z + d) - W.terrainHeight(x, z - d);
      const nx = -hx / (2 * d), nz = -hz / (2 * d);
      const l = Math.hypot(nx, 1, nz);
      normals.set([nx / l, 1 / l, nz / l], i * 3);
      groundColor(W, x, z, h, col);
      colors.set([col.r, col.g, col.b], i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    const mesh = new THREE.Mesh(geo, this.terrainMat);
    mesh.position.set(x0, 0, z0);
    mesh.receiveShadow = true;
    group.add(mesh);

    const chunk = { group, x: x0, z: z0, buildings: [] };
    const rand = mulberry32(cx * 73856093 ^ cz * 19349663 ^ 0x5bd1e995);
    const inCity = x0 > CITY.x0 - 150 && x0 < CITY.x1 + 150 && z0 > CITY.z0 - 150 && z0 < CITY.z1 + 150;

    // Trees
    const region = W.regionAt(x0, z0).id;
    const density = { forest: 0.0011, grass: 0.00016, alpine: 0.00035, coast: 0.00022, desert: 0.00014, city: 0 }[region] || 0;
    const kind = { forest: 'pine', grass: 'round', alpine: 'pine', coast: 'palm', desert: 'cactus' }[region];
    if (density > 0 && kind && z0 < SEA_Z) {
      const count = Math.round(density * CHUNK * CHUNK * (this.highQ ? 1 : 0.55));
      const positions = [];
      for (let t = 0; t < count * 3 && positions.length < count; t++) {
        const x = x0 + (rand() - 0.5) * CHUNK, z = z0 + (rand() - 0.5) * CHUNK;
        if (z > SEA_Z - 60 || Math.abs(x) > WORLD_HALF) continue;
        if (x > CITY.x0 - 90 && x < CITY.x1 + 90 && z > CITY.z0 - 90 && z < CITY.z1 + 90) continue;
        const near = W.nearestGlobal(x, z, 1);
        if (near.idx >= 0 && near.dist < W.samples[near.idx].hw + 5.5) continue;
        const h = W.terrainHeight(x, z);
        if (region === 'alpine' && h > 190) continue;  // above the tree line
        positions.push([x, z, 0.7 + rand() * 0.8, rand() * Math.PI * 2, h]);
      }
      if (positions.length) addTrees(group, kind, positions, this.highQ);
    }

    // City blocks: buildings on lots between the streets
    if (inCity) this._buildCityLots(chunk, x0, z0);
    return chunk;
  }

  _buildCityLots(chunk, x0, z0) {
    const W = this.world;
    const lots = 3, pad = 13;
    const lotW = (CITY.step - pad * 2) / lots;
    if (!this.facadeMats) {
      this.facadeMats = [0x9aa4b4, 0x6f8aa8, 0xb9ad98, 0x7c7f88].map(c => new THREE.MeshStandardMaterial({ map: makeFacadeTexture(c), roughness: 0.55, metalness: 0.15 }));
      this.roofMat = new THREE.MeshStandardMaterial({ color: 0x4a4d55, roughness: 1 });
    }
    for (let bi = 0; bi < 5; bi++) for (let bj = 0; bj < 5; bj++) {
      const bx0 = CITY.x0 + bi * CITY.step + pad, bz0 = CITY.z0 + bj * CITY.step + pad;
      for (let li = 0; li < lots; li++) for (let lj = 0; lj < lots; lj++) {
        const lx = bx0 + (li + 0.5) * lotW, lz = bz0 + (lj + 0.5) * lotW;
        if (Math.abs(lx - x0) > CHUNK / 2 || Math.abs(lz - z0) > CHUNK / 2) continue;
        const rand = mulberry32((bi * 5 + bj) * 9 + li * 3 + lj + 777);
        if (rand() < 0.14) continue;   // a car park / plaza
        const w = lotW * (0.55 + rand() * 0.35), d = lotW * (0.55 + rand() * 0.35);
        const dc = Math.hypot(lx - 1900, lz - 1900);
        const h = dc < 230 ? 45 + rand() * 90 : dc < 420 ? 18 + rand() * 42 : 9 + rand() * 18;
        const geo = new THREE.BoxGeometry(w, h, d);
        const uv = geo.attributes.uv;
        for (let v = 0; v < uv.count; v++) {
          const face = Math.floor(v / 4);
          const su = face < 2 ? d : face < 4 ? w : w, sv = face < 2 ? h : face < 4 ? d : h;
          uv.setXY(v, uv.getX(v) * su / 4, uv.getY(v) * sv / 3.6);
        }
        const facade = this.facadeMats[Math.floor(rand() * this.facadeMats.length)];
        const m = new THREE.Mesh(geo, [facade, facade, this.roofMat, this.roofMat, facade, facade]);
        const gy = W.terrainHeight(lx, lz);
        m.position.set(lx, gy + h / 2 - 0.4, lz);
        m.receiveShadow = true;
        chunk.group.add(m);
        chunk.buildings.push({ x: lx, z: lz, hw: w / 2, hd: d / 2 });
      }
    }
  }

  // ------------------------------------------------------------ Game loop
  setPaused(p) { this.paused = p; if (p) this.audio.stopEngines(); else this._setupAudio(); }

  /** Hide the world while a circuit event runs. */
  suspend() {
    this.suspended = true;
    this.audio.stopEngines();
    this.hud.hide();
    this.input.setTouchVisible(false);
    this.endDrift(true); this.zone = null;
  }

  /** Back from an event: car parked at the event marker. */
  resume(marker) {
    this.suspended = false;
    if (marker) this.placeAt(marker.idx, 4);
    this.car.input.throttle = 0; this.car.input.brake = 0;
    this.hud.show();
    this._streamChunks(true);
    snapChaseCamera(this.camera, this.car, this.tmp2);
    this._setupAudio();
    this.input.setTouchVisible(true);
    this.prompt = null; this.promptCooldown = 2;
  }

  /** Fast travel to a marker. */
  teleportTo(marker) {
    this.placeAt(marker.idx, 4);
    this.endDrift(true); this.zone = null;
    this._streamChunks(true);
    snapChaseCamera(this.camera, this.car, this.tmp2);
    this.promptCooldown = 2;
    this.hud.popup(marker.name.toUpperCase(), 'fast travel');
  }

  resetCar() {
    const idx = this.world.nearestGlobal(this.car.pos.x, this.car.pos.z).idx;
    if (idx >= 0) this.placeAt(idx);
    this.endDrift(true); this.zone = null;
  }

  update(dt) {
    if (this.paused || this.suspended) return;
    dt = Math.min(dt, 1 / 20);
    this.time += dt;
    const car = this.car;
    const p = this.profile;
    const ctl = getControl(p.settings.p1Control);
    const r = this.input.read(ctl.scheme === 'none' ? 'wasd' : ctl.scheme, this.padIndex(), 0);
    car.input.throttle = r.throttle; car.input.brake = r.brake; car.input.steer = r.steer; car.input.handbrake = r.handbrake;
    if (r.reset) this.resetCar();
    const accept = this.input.justPressed('Enter') || this.input.justPressed('NumpadEnter') || this.input.justPressed('KeyE') || this._padJust(0);
    if ((this.input.justPressed('KeyM') || this.input.justPressed('Tab') || this._padJust(8))) this.requestMap = true;
    if (this.promptCooldown > 0) this.promptCooldown -= dt;
    if (accept && this.prompt && this.promptCooldown <= 0) { this.onEvent(this.prompt); return; }

    const prevIdx = car.trackIdx;
    const prevPos = this.tmp.copy(car.pos);
    const steps = 2, sdt = dt / steps;
    for (let s = 0; s < steps; s++) {
      car.update(sdt, { track: this.world, live: true });
      this._collideWorld(car);
    }
    this.traffic.update(dt);
    if (car.carHit > 3) { this.camera.userData.shake = Math.max(this.camera.userData.shake, 0.25); this.audio.impact(car.carHit * 0.6); car.carHit = 0; }
    const moved = Math.hypot(car.pos.x - prevPos.x, car.pos.z - prevPos.z);
    this.prog.stats.distance = (this.prog.stats.distance || 0) + moved / 1000;

    this._updateZones(car, prevIdx, dt);
    this._updateBoards(car);
    this._updateMarkers(car);

    // Effects, camera, sound
    this.fx.setViewport(this.viewport.h, this.camera.fov);
    this.fx.update([car], dt);
    if (car.wallHit > 4) { this.camera.userData.shake = Math.min(0.6, car.wallHit * 0.05); this.audio.impact(car.wallHit); }
    updateChaseCamera(this.camera, car, dt, this.tmp2);
    aimSun(this.sun, this.tmp2.copy(car.pos));
    if (this.engine) this.audio.updateEngine(this.engine, clamp(car.speed / car.stats.maxSpeed, 0, 1), car.input.throttle, car.drifting || (car.input.handbrake && car.speed > 5), 1);
    for (const ring of this.eventRings) ring.material.opacity = 0.45 + 0.3 * Math.sin(this.time * 3);

    this._streamChunks(false);
    this.hud.update(dt);

    this.saveTimer += dt;
    if (this.saveTimer > 6) { this.saveTimer = 0; this.saveState(); }
  }

  padIndex() {
    const m = /^pad(\d+)$/.exec(this.profile.settings.p1Control || '');
    return m ? +m[1] : (this.input.gamepad(0) ? 0 : -1);
  }

  _padJust(button) {
    const pi = this.padIndex();
    if (pi < 0) return false;
    const gp = this.input.gamepad(pi);
    const down = !!(gp && gp.buttons[button] && gp.buttons[button].pressed);
    const key = `hz:${pi}:${button}`;
    const was = this.input.padPressed.get(key);
    this.input.padPressed.set(key, down);
    return down && !was;
  }

  /** World edges, the shoreline and city buildings are solid. */
  _collideWorld(car) {
    const lim = WORLD_HALF - 25;
    let hit = 0;
    const bounce = (axis, sign) => {
      const v = axis === 'x' ? car.vel.x : car.vel.z;
      if (v * sign > 0) { hit = Math.max(hit, Math.abs(v)); if (axis === 'x') car.vel.x = -v * 0.3; else car.vel.z = -v * 0.3; }
    };
    if (car.pos.x > lim) { car.pos.x = lim; bounce('x', 1); }
    if (car.pos.x < -lim) { car.pos.x = -lim; bounce('x', -1); }
    if (car.pos.z < -lim) { car.pos.z = -lim; bounce('z', -1); }
    if (car.pos.z > SEA_Z + 45) { car.pos.z = SEA_Z + 45; bounce('z', 1); }
    // buildings in the surrounding chunks
    const ccx = Math.floor(car.pos.x / CHUNK), ccz = Math.floor(car.pos.z / CHUNK);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const c = this.chunks.get(this._chunkKey(ccx + dx, ccz + dz));
      if (!c || !c.buildings.length) continue;
      for (const b of c.buildings) {
        const ox = car.pos.x - b.x, oz = car.pos.z - b.z;
        const px = b.hw + 1.1 - Math.abs(ox), pz = b.hd + 1.1 - Math.abs(oz);
        if (px <= 0 || pz <= 0) continue;
        if (px < pz) { car.pos.x += Math.sign(ox || 1) * px; bounce('x', -Math.sign(ox || 1)); }
        else { car.pos.z += Math.sign(oz || 1) * pz; bounce('z', -Math.sign(oz || 1)); }
      }
    }
    if (hit > 0) {
      const fx = Math.sin(car.heading), fz = Math.cos(car.heading);
      car.vf = car.vel.x * fx + car.vel.z * fz;
      car.vr = car.vel.x * -fz + car.vel.z * fx;
      car.wallHit = Math.max(car.wallHit, hit);
    }
  }

  // ------------------------------------------------------------ Skills: traps, drift & speed zones, boards
  _updateZones(car, prevIdx, dt) {
    const W = this.world;
    const idx = car.trackIdx;
    const s = W.samples[idx];
    const onRoad = Math.abs(W.lateral(car.pos, idx)) < s.hw + 3;
    const sameRoad = W.samples[prevIdx].road === s.road && Math.abs(idx - prevIdx) < 60;
    const lo = Math.min(prevIdx, idx), hi = Math.max(prevIdx, idx);
    const crossed = (i) => sameRoad && onRoad && i > lo && i <= hi && car.speed > 2;

    // Speed traps
    for (const t of W.traps) if (crossed(t.idx)) this._trap(t, car.speed * 3.6);

    // Drift zones
    if (this.drift) {
      const z = this.drift.zone;
      const inside = W.roadOf(idx).id === z.road && W.inRange(idx, z.i0 - 2, z.i1 + 2);
      if (car.drifting && onRoad) this.drift.score += Math.abs(car.vr) * car.speed * dt * 2.2 * (1 + car.speed / 60);
      if (car.speed < 1.5) this.drift.stopped += dt; else this.drift.stopped = 0;
      if (!inside || this.drift.stopped > 2) this.endDrift(this.drift.stopped > 2 || !sameRoad);
    } else if (onRoad) {
      for (const z of W.drifts) if ((crossed(z.i0) && idx > prevIdx) || (crossed(z.i1) && idx < prevIdx)) {
        this.drift = { zone: z, score: 0, stopped: 0 };
        this.hud.popup('DRIFT ZONE', z.lengthM + ' m · slide to the END gantry');
      }
    }

    // Speed zones (average speed between the gantries, either direction)
    if (this.zone) {
      const z = this.zone.zone;
      this.zone.time += dt;
      const exitIdx = this.zone.dir > 0 ? z.i1 : z.i0;
      const entryIdx = this.zone.dir > 0 ? z.i0 : z.i1;
      if (crossed(exitIdx)) { this._zoneDone(z, this.zone.time); this.zone = null; }
      else if (crossed(entryIdx) || !onRoad && Math.abs(W.lateral(car.pos, idx)) > s.hw + 12 || W.roadOf(idx).id !== z.road) { this.zone = null; this.hud.toast('Speed zone cancelled'); }
    } else if (onRoad) {
      for (const z of W.zones) {
        if (crossed(z.i0) && idx > prevIdx) { this.zone = { zone: z, time: 0, dir: 1 }; this.hud.popup('SPEED ZONE', z.lengthM + ' m · average speed counts'); }
        else if (crossed(z.i1) && idx < prevIdx) { this.zone = { zone: z, time: 0, dir: -1 }; this.hud.popup('SPEED ZONE', z.lengthM + ' m · average speed counts'); }
      }
    }
    this.hud.live = this.drift ? { label: 'DRIFT ZONE', value: Math.round(this.drift.score).toLocaleString() } : this.zone ? { label: 'SPEED ZONE', value: this.zone.time.toFixed(1) + ' s' } : null;
  }

  _stars(value, thresholds) { let n = 0; for (const t of thresholds) if (value >= t) n++; return n; }
  _starStr(n) { return '★'.repeat(n) + '☆'.repeat(3 - n); }

  _trap(t, kph) {
    const stars = this._stars(kph, t.stars);
    const prev = this.prog.traps[t.id] || 0;
    const prevStars = this._stars(prev, t.stars);
    const best = kph > prev;
    if (best) this.prog.traps[t.id] = Math.round(kph);
    this.audio.lap();
    this.hud.popup(`${Math.round(kph)} km/h · ${this._starStr(stars)}`, best ? (prev ? 'SPEED TRAP · NEW BEST' : 'SPEED TRAP') : `SPEED TRAP · best ${Math.round(prev)} km/h`);
    this._reward(stars - prevStars, 300);
  }

  endDrift(cancel = false) {
    if (!this.drift) return;
    const { zone, score } = this.drift;
    this.drift = null;
    if (cancel || score < 50) { this.hud.toast('Drift zone ended'); return; }
    const stars = this._stars(score, zone.stars);
    const prev = this.prog.drifts[zone.id] || 0;
    const prevStars = this._stars(prev, zone.stars);
    if (score > prev) this.prog.drifts[zone.id] = Math.round(score);
    this.audio.lap();
    this.hud.popup(`${Math.round(score).toLocaleString()} · ${this._starStr(stars)}`, score > prev ? 'DRIFT ZONE · NEW BEST' : `DRIFT ZONE · best ${Math.round(prev).toLocaleString()}`);
    this._reward(stars - prevStars, 300);
  }

  _zoneDone(z, time) {
    const avg = (z.lengthM / Math.max(0.1, time)) * 3.6;
    const stars = this._stars(avg, z.stars);
    const prev = this.prog.zones[z.id] || 0;
    const prevStars = this._stars(prev, z.stars);
    if (avg > prev) this.prog.zones[z.id] = Math.round(avg);
    this.audio.lap();
    this.hud.popup(`${Math.round(avg)} km/h avg · ${this._starStr(stars)}`, avg > prev ? 'SPEED ZONE · NEW BEST' : `SPEED ZONE · best ${Math.round(prev)} km/h`);
    this._reward(stars - prevStars, 300);
  }

  /** New stars earned → XP and credits. */
  _reward(newStars, xpPerStar) {
    if (newStars <= 0) return;
    this.addXp(newStars * xpPerStar);
    this.profile.money += newStars * 250;
    this.hud.toast(`+${newStars * 250} cr`);
    this.saveState();
  }

  addXp(n) {
    const before = levelForXp(this.prog.xp).level;
    this.prog.xp += n;
    this.hud.toast(`+${n} XP`);
    const after = levelForXp(this.prog.xp).level;
    if (after > before) {
      this.profile.money += 2000 * (after - before);
      setTimeout(() => this.hud.popup(`LEVEL ${after}`, '+2,000 cr'), 900);
      this.audio.finish();
      this.onLevel(after);
    }
  }

  /** Passing traffic closely at speed. */
  nearMiss() {
    this.hud.toast('NEAR MISS +40 XP');
    this.prog.xp += 40;
  }

  _updateBoards(car) {
    if (car.speed < 3) return;
    for (const b of this.world.boards) {
      const m = this.boardMeshes.get(b.id);
      if (!m) continue;
      const dx = car.pos.x - b.x, dz = car.pos.z - b.z;
      if (dx * dx + dz * dz > 3.4 * 3.4) continue;
      this.props.remove(m); disposeGroup(m); this.boardMeshes.delete(b.id);
      this.prog.boards.push(b.id);
      this.audio.impact(6);
      this.hud.popup('BONUS BOARD', `${this.prog.boards.length} / ${this.world.boards.length} found`);
      this.addXp(BOARD_XP);
      this.saveState();
    }
  }

  /** Discovery of markers and the "start event" prompt. */
  _updateMarkers(car) {
    const W = this.world;
    this.prompt = null;
    for (const m of W.markers) {
      const dx = car.pos.x - m.x, dz = car.pos.z - m.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < 130 * 130 && !this.prog.discovered.includes(m.id)) {
        this.prog.discovered.push(m.id);
        this.hud.toast(`Discovered ${m.name}`);
        this.addXp(100);
      }
      if (m.kind === 'event') {
        const s = W.samples[m.idx];
        const ex = car.pos.x - s.p.x, ez = car.pos.z - s.p.z;
        const r = Math.max(15, s.hw + 5);
        if (ex * ex + ez * ez < r * r) this.prompt = m;
      }
    }
    if (this.waypoint) {
      const d = Math.hypot(car.pos.x - this.waypoint.x, car.pos.z - this.waypoint.z);
      if (d < 35) { this.hud.toast(`Arrived: ${this.waypoint.name}`); this.waypoint = null; }
    }
  }

  // ------------------------------------------------------------ Progress summary (for the map screen)
  summary() {
    const W = this.world, P = this.prog;
    const stars = (list, key) => list.reduce((a, z) => a + this._stars(P[key][z.id] || 0, z.stars), 0);
    return {
      level: levelForXp(P.xp), xp: P.xp, money: this.profile.money,
      events: Object.keys(P.events).length, eventsTotal: W.events.length,
      trapStars: stars(W.traps, 'traps'), trapTotal: W.traps.length * 3,
      driftStars: stars(W.drifts, 'drifts'), driftTotal: W.drifts.length * 3,
      zoneStars: stars(W.zones, 'zones'), zoneTotal: W.zones.length * 3,
      boards: P.boards.length, boardsTotal: W.boards.length,
      distance: P.stats.distance || 0,
      discovered: P.discovered.length, markers: W.markers.length,
    };
  }

  markerBest(m) {
    const P = this.prog;
    if (m.kind === 'trap') return P.traps[m.id] ? `${P.traps[m.id]} km/h · ${this._starStr(this._stars(P.traps[m.id], m.stars))}` : 'Not set';
    if (m.kind === 'drift') return P.drifts[m.id] ? `${P.drifts[m.id].toLocaleString()} pts · ${this._starStr(this._stars(P.drifts[m.id], m.stars))}` : 'Not set';
    if (m.kind === 'zone') return P.zones[m.id] ? `${P.zones[m.id]} km/h avg · ${this._starStr(this._stars(P.zones[m.id], m.stars))}` : 'Not set';
    if (m.kind === 'event') return P.events[m.id] ? `Best finish: P${P.events[m.id]}` : 'Not raced yet';
    return '';
  }

  saveState() {
    this.prog.pos = [+this.car.pos.x.toFixed(1), +this.car.pos.z.toFixed(1), +this.car.heading.toFixed(3)];
    this.onSave();
  }

  // ------------------------------------------------------------ Map rendering (for the UI)
  /** Draw the whole world into a canvas; the static layer is cached. */
  drawMap(canvas, selected = null) {
    const size = canvas.width;
    const W = this.world;
    const sc = size / (WORLD_HALF * 2);
    const X = (x) => (x + WORLD_HALF) * sc, Z = (z) => (z + WORLD_HALF) * sc;
    if (!this.mapLayer || this.mapLayer.width !== size) {
      const off = document.createElement('canvas'); off.width = off.height = size;
      const c = off.getContext('2d');
      const tint = { grass: '#4b7d3a', forest: '#2f5f2c', desert: '#c9a36b', alpine: '#b9c3cc', city: '#6b6e76', coast: '#5f9450' };
      const cells = 96, cs = size / cells;
      for (let i = 0; i < cells; i++) for (let j = 0; j < cells; j++) {
        const x = -WORLD_HALF + (i + 0.5) * (WORLD_HALF * 2 / cells), z = -WORLD_HALF + (j + 0.5) * (WORLD_HALF * 2 / cells);
        c.fillStyle = z > SEA_Z ? '#2a6fb0' : (z > SEA_Z - 120 ? '#d9c795' : tint[W.regionAt(x, z).id]);
        c.fillRect(i * cs - 0.5, j * cs - 0.5, cs + 1, cs + 1);
      }
      c.lineCap = 'round'; c.lineJoin = 'round';
      for (const road of W.roads) {
        const wpx = { highway: 4.2, road: 3, lane: 2.2, dirt: 2, street: 2 }[road.kind] * (size / 640);
        c.beginPath();
        for (let li = 0; li < road.n; li += 3) { const s = W.samples[road.i0 + li]; if (li === 0) c.moveTo(X(s.p.x), Z(s.p.z)); else c.lineTo(X(s.p.x), Z(s.p.z)); }
        if (road.closed) c.closePath();
        c.strokeStyle = 'rgba(0,0,0,0.45)'; c.lineWidth = wpx + 2; c.stroke();
        c.strokeStyle = road.kind === 'dirt' ? '#c9ad7a' : road.kind === 'highway' ? '#f4f4f4' : '#dcdcdc'; c.lineWidth = wpx; c.stroke();
      }
      this.mapLayer = off;
    }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(this.mapLayer, 0, 0);
    const k = size / 640;
    for (const b of W.boards) {
      if (this.prog.boards.includes(b.id)) continue;
      ctx.fillStyle = '#3ddc84'; ctx.fillRect(X(b.x) - 2.5 * k, Z(b.z) - 2.5 * k, 5 * k, 5 * k);
    }
    for (const m of W.markers) drawMarkerIcon(ctx, X(m.x), Z(m.z), m, this, selected === m, k);
    if (this.waypoint) {
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 * k; ctx.setLineDash([4 * k, 4 * k]);
      ctx.beginPath(); ctx.moveTo(X(this.car.pos.x), Z(this.car.pos.z)); ctx.lineTo(X(this.waypoint.x), Z(this.waypoint.z)); ctx.stroke(); ctx.setLineDash([]);
    }
    // player
    const px = X(this.car.pos.x), pz = Z(this.car.pos.z);
    ctx.save(); ctx.translate(px, pz); ctx.rotate(this.car.heading + Math.PI);
    ctx.fillStyle = '#ff5a1f'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 * k;
    ctx.beginPath(); ctx.moveTo(0, -9 * k); ctx.lineTo(6 * k, 7 * k); ctx.lineTo(0, 3 * k); ctx.lineTo(-6 * k, 7 * k); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  /** Marker closest to a canvas point (within 16 px), or null. */
  markerAt(canvas, px, py) {
    const size = canvas.width, sc = size / (WORLD_HALF * 2);
    let best = null, bd = 16 * (size / 640);
    for (const m of this.world.markers) {
      const d = Math.hypot((m.x + WORLD_HALF) * sc - px, (m.z + WORLD_HALF) * sc - py);
      if (d < bd) { bd = d; best = m; }
    }
    return best;
  }

  render() {
    const r = this.renderer;
    r.setScissorTest(false);
    r.setViewport(0, 0, this.viewport.w, this.viewport.h);
    r.render(this.scene, this.camera);
  }

  dispose() {
    this.audio.stopEngines();
    this.hud.dispose();
    this.fx.dispose();
    this.input.setTouchVisible(false);
    if (this.envTex) this.envTex.dispose();
    disposeGroup(this.scene);
  }
}

// ------------------------------------------------------------------ Helpers
function disposeGroup(root) {
  root.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) { const ms = Array.isArray(o.material) ? o.material : [o.material]; for (const m of ms) { if (m.map && !m.userData.shared) m.map.dispose(); m.dispose(); } }
  });
}

/** Ground colour at a point from the region blend, height (snow) and a little noise. */
const C = {
  grass: new THREE.Color(0x4f8f3c), grassAlt: new THREE.Color(0x3f7530), forest: new THREE.Color(0x2f6a2a), desert: new THREE.Color(0xd4ab6e), desertAlt: new THREE.Color(0xb8865a),
  rock: new THREE.Color(0x8d9196), snow: new THREE.Color(0xf0f4f8), city: new THREE.Color(0x707379), sand: new THREE.Color(0xe6d6a6), seabed: new THREE.Color(0x3b6f7a), coast: new THREE.Color(0x5f9a4a),
};
const tmpC = new THREE.Color();
function groundColor(W, x, z, h, out) {
  const w = W.regionWeights(x, z);
  const n = fbm(x, z, 60, 2, 21) * 0.5 + 0.5;
  out.setRGB(0, 0, 0);
  const add = (c, k) => { if (k > 0.001) out.add(tmpC.copy(c).multiplyScalar(k)); };
  add(tmpC.copy(C.grass).lerp(C.grassAlt, n), w.grass);
  add(C.forest, w.forest);
  add(tmpC.copy(C.desert).lerp(C.desertAlt, n), w.desert);
  add(tmpC.copy(C.rock).lerp(C.snow, smoothstep(150, 200, h)), w.alpine);
  add(C.city, w.city);
  const beach = smoothstep(SEA_Z - 160, SEA_Z - 40, z);
  add(tmpC.copy(C.coast).lerp(C.sand, beach), w.coast);
  if (z > SEA_Z) out.lerp(C.seabed, smoothstep(SEA_Z, SEA_Z + 120, z));
  out.multiplyScalar(0.92 + n * 0.16);
}

function makeDetailTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#bdbdbd'; ctx.fillRect(0, 0, 128, 128);
  const img = ctx.getImageData(0, 0, 128, 128);
  for (let i = 0; i < img.data.length; i += 4) { const v = 150 + Math.random() * 105; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function makeWorldRoadTexture(kind, width) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const ctx = c.getContext('2d');
  const base = new THREE.Color(ROAD_COLORS[kind] || 0x3a3a40);
  ctx.fillStyle = `rgb(${base.r * 255 | 0},${base.g * 255 | 0},${base.b * 255 | 0})`;
  ctx.fillRect(0, 0, 256, 256);
  const img = ctx.getImageData(0, 0, 256, 256);
  for (let i = 0; i < img.data.length; i += 4) { const n = (Math.random() - 0.5) * (kind === 'dirt' ? 40 : 26); img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n; }
  ctx.putImageData(img, 0, 0);
  if (kind !== 'dirt' && kind !== 'pad') {
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillRect(5, 0, 4, 256); ctx.fillRect(247, 0, 4, 256);
    if (kind === 'highway') {
      ctx.fillStyle = 'rgba(255,210,60,0.9)'; ctx.fillRect(124, 0, 3, 256); ctx.fillRect(130, 0, 3, 256);
      ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.fillRect(62, 0, 3, 110); ctx.fillRect(190, 0, 3, 110);
    } else if (kind === 'street') {
      ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.fillRect(126, 0, 4, 90);
    } else if (kind === 'road') {
      ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.fillRect(126, 0, 4, 110);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapT = THREE.RepeatWrapping; tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 8;
  tex.userData.shared = true;
  return tex;
}

function textTexture(text, bg, fg, w = 1024, h = 128, font = 'italic 900 64px Arial') {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = fg; ctx.fillRect(0, 0, w, 10); ctx.fillRect(0, h - 10, w, 10);
  ctx.font = font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const label = text.toUpperCase();
  const m = /(\d+)px/.exec(font);
  if (m) {
    let px = +m[1];
    while (px > 20 && ctx.measureText(label).width > w - 70) { px -= 4; ctx.font = font.replace(/\d+px/, px + 'px'); }
  }
  ctx.fillText(label, w / 2, h / 2 + 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Two posts and a banner beam across the road. `camera` adds a speed-camera box. */
function makeGantry(span, text, bg, fg, height = 6.4, camera = false) {
  const g = new THREE.Group();
  const postMat = new THREE.MeshStandardMaterial({ color: 0x8a8f99, metalness: 0.5, roughness: 0.4 });
  const postGeo = new THREE.BoxGeometry(0.45, height, 0.45);
  for (const sd of [1, -1]) { const post = new THREE.Mesh(postGeo, postMat); post.position.set(sd * (span / 2), height / 2, 0); g.add(post); }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(span + 1, 1.4, 0.8), new THREE.MeshStandardMaterial({ map: textTexture(text, bg, fg), roughness: 0.6 }));
  beam.position.set(0, height - 0.2, 0); g.add(beam);
  if (camera) {
    const cam = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.6, 1.2), new THREE.MeshStandardMaterial({ color: 0x222228, metalness: 0.6, roughness: 0.3 }));
    cam.position.set(0, height - 1.3, 0.3); g.add(cam);
    const lens = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 8), new THREE.MeshStandardMaterial({ color: 0x8fd0ff, emissive: 0x8fd0ff, emissiveIntensity: 2 }));
    lens.position.set(0, height - 1.3, 0.95); g.add(lens);
  }
  return g;
}

/** Roadside sign with the event name. */
function makeSign(text, color, x, y, z, heading) {
  const g = new THREE.Group();
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 3.2, 6), new THREE.MeshStandardMaterial({ color: 0x8a8f99 }));
  post.position.y = 1.6; g.add(post);
  const board = new THREE.Mesh(new THREE.BoxGeometry(4.4, 1.3, 0.16), new THREE.MeshStandardMaterial({ map: textTexture(text, '#15171d', color, 1024, 300, 'italic 900 150px Arial'), roughness: 0.6 }));
  board.position.y = 3.6; g.add(board);
  g.position.set(x, y, z); g.rotation.y = heading;
  return g;
}

/** Tall translucent light beam marking a point of interest from afar. */
function makeBeam(color, x, y, z, h) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.6, h, 10, 1, true), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
  m.position.set(x, y + h / 2, z);
  return m;
}

function makeBoardTexture() {
  const c = document.createElement('canvas'); c.width = 512; c.height = 320;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#1f9a58'; ctx.fillRect(0, 0, 512, 320);
  ctx.fillStyle = '#3ddc84'; ctx.fillRect(16, 16, 480, 288);
  ctx.fillStyle = '#0b3d22'; ctx.font = 'italic 900 150px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('XP', 256, 150);
  ctx.font = '700 44px Arial'; ctx.fillText('BONUS BOARD', 256, 262);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.userData.shared = true;
  return t;
}

function makeFacadeTexture(baseHex) {
  const c = document.createElement('canvas'); c.width = 64; c.height = 64;
  const ctx = c.getContext('2d');
  const b = new THREE.Color(baseHex);
  ctx.fillStyle = `rgb(${b.r * 255 | 0},${b.g * 255 | 0},${b.b * 255 | 0})`; ctx.fillRect(0, 0, 64, 64);
  for (let y = 4; y < 64; y += 16) for (let x = 4; x < 64; x += 16) {
    const lit = Math.random() < 0.18;
    ctx.fillStyle = lit ? 'rgba(255,240,200,0.9)' : 'rgba(30,40,60,0.85)';
    ctx.fillRect(x, y, 8, 9);
    ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.fillRect(x, y, 8, 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.userData.shared = true;
  return t;
}

/** Map icon for a marker. */
export function drawMarkerIcon(ctx, x, y, m, hz, selected, k = 1) {
  const done = m.kind === 'event' ? !!hz.prog.events[m.id] : (m.kind === 'hub' ? false : hz._stars((hz.prog[m.kind + 's'] || {})[m.id] || 0, m.stars) === 3);
  ctx.save();
  ctx.translate(x, y);
  if (selected) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 * k; ctx.beginPath(); ctx.arc(0, 0, 13 * k, 0, Math.PI * 2); ctx.stroke(); }
  ctx.lineWidth = 1.5 * k; ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  if (m.kind === 'hub') {
    ctx.fillStyle = '#ffd23f';
    ctx.beginPath(); for (let i = 0; i < 10; i++) { const r = i % 2 ? 4.5 * k : 10 * k, a = -Math.PI / 2 + i * Math.PI / 5; ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r); } ctx.closePath(); ctx.fill(); ctx.stroke();
  } else if (m.kind === 'event') {
    ctx.fillStyle = done ? '#9a6a3a' : (m.track.kind === 'stage' ? '#3ddc84' : '#ff5a1f');
    ctx.beginPath(); ctx.arc(0, 0, 8 * k, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.fillRect(-1 * k, -5 * k, 1.6 * k, 10 * k); ctx.beginPath(); ctx.moveTo(0, -5 * k); ctx.lineTo(5 * k, -2.5 * k); ctx.lineTo(0, 0); ctx.fill();
  } else if (m.kind === 'trap') {
    ctx.fillStyle = done ? '#5a7a99' : '#2f7bff'; ctx.fillRect(-6 * k, -6 * k, 12 * k, 12 * k); ctx.strokeRect(-6 * k, -6 * k, 12 * k, 12 * k);
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(0, 0, 2.6 * k, 0, Math.PI * 2); ctx.fill();
  } else if (m.kind === 'drift') {
    ctx.fillStyle = done ? '#7a5a99' : '#b04cff'; ctx.beginPath(); ctx.moveTo(0, -8 * k); ctx.lineTo(8 * k, 0); ctx.lineTo(0, 8 * k); ctx.lineTo(-8 * k, 0); ctx.closePath(); ctx.fill(); ctx.stroke();
  } else if (m.kind === 'zone') {
    ctx.fillStyle = done ? '#4a8a92' : '#00d4ff'; ctx.beginPath(); ctx.roundRect(-8 * k, -5 * k, 16 * k, 10 * k, 3 * k); ctx.fill(); ctx.stroke();
  }
  if (done) { ctx.fillStyle = '#fff'; ctx.font = `${10 * k}px Arial`; ctx.textAlign = 'center'; ctx.fillText('✓', 0, 3.5 * k); }
  ctx.restore();
}

export { REGIONS };
