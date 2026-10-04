// Free Roam map: a shaded terrain layer (shared with the HUD radar), marker icons,
// and the full-screen pan/zoom map screen with GPS waypoints and fast travel.
import { fbm, smoothstep, mulberry32 } from './world.js';
import { WORLD_HALF, SEA_Z, REGIONS, CITY } from './worlddef.js';

/** The terrain layer covers a little more than the drivable square so the edges read as "beyond". */
export const MAP_EXTENT = WORLD_HALF + 300;

export const ROAD_STYLE = {
  highway: { fill: '#ffc94d', casing: '#6b4a12', min: 3.2 },
  road: { fill: '#ffffff', casing: '#2a2f3a', min: 2.4 },
  street: { fill: '#e6e8ee', casing: '#2a2f3a', min: 1.6 },
  lane: { fill: '#f4efe2', casing: '#3a3a3a', min: 1.8 },
  dirt: { fill: '#d8b47c', casing: '#5a4426', min: 1.6 },
};
const ROAD_ORDER = ['dirt', 'lane', 'street', 'road', 'highway'];
export const ROUTE_COLOR = '#c45bff';

export const MARKER_COLORS = { hub: '#ffd23f', event: '#ff5a1f', stage: '#2fcf78', trap: '#2f7bff', drift: '#b04cff', zone: '#00c2e8', board: '#3ddc84', custom: '#ffd23f' };
export const markerCategory = (m) => m.kind === 'event' ? (m.track.kind === 'stage' ? 'stage' : 'event') : m.kind;

// ------------------------------------------------------------------ Terrain layer
const T = {
  grass: [111, 154, 82], grassAlt: [94, 138, 70], forest: [58, 104, 54], desert: [214, 180, 124], desertAlt: [196, 150, 98],
  rock: [128, 134, 142], snow: [236, 241, 246], city: [96, 100, 108], coast: [118, 162, 90], sand: [232, 217, 168],
  sea: [38, 104, 168], shallow: [70, 150, 204], outside: [28, 34, 44],
};

/**
 * Paint the whole world once into a canvas: region colours blended like the 3D
 * ground, hill shading from the natural height, beaches, the sea, tree speckle in
 * the forests and the city's ground. Cached on the world.
 */
export function terrainLayer(world, size = 1536) {
  if (world._mapTerrain && world._mapTerrain.width === size) return world._mapTerrain;
  const G = 360;                         // height grid resolution
  const step = (MAP_EXTENT * 2) / (G - 1);
  const hgt = new Float32Array(G * G);
  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
    const x = -MAP_EXTENT + i * step, z = -MAP_EXTENT + j * step;
    hgt[j * G + i] = world.baseHeight(Math.max(-WORLD_HALF, Math.min(WORLD_HALF, x)), Math.max(-WORLD_HALF, Math.min(WORLD_HALF, z)));
  }
  const small = document.createElement('canvas'); small.width = small.height = G;
  const sctx = small.getContext('2d');
  const img = sctx.createImageData(G, G);
  const L = [-0.55, 0.62, -0.56];        // light from the north-west, fairly low
  const ll = Math.hypot(...L); L[0] /= ll; L[1] /= ll; L[2] /= ll;
  const mix = (out, c, k) => { out[0] += c[0] * k; out[1] += c[1] * k; out[2] += c[2] * k; };
  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
    const x = -MAP_EXTENT + i * step, z = -MAP_EXTENT + j * step;
    const h = hgt[j * G + i];
    const hx = hgt[j * G + Math.min(G - 1, i + 1)] - hgt[j * G + Math.max(0, i - 1)];
    const hz = hgt[Math.min(G - 1, j + 1) * G + i] - hgt[Math.max(0, j - 1) * G + i];
    // exaggerate relief a little so the hills read at map scale
    let nx = -hx * 2.4 / (2 * step), nz = -hz * 2.4 / (2 * step), ny = 1;
    const nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl; nz /= nl;
    const lit = nx * L[0] + ny * L[1] + nz * L[2];
    const shade = 0.72 + 0.5 * (lit - 0.62);
    const c = [0, 0, 0];
    const w = world.regionWeights(Math.max(-WORLD_HALF, Math.min(WORLD_HALF, x)), z);
    const n = fbm(x, z, 90, 2, 21) * 0.5 + 0.5;
    const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    mix(c, lerp(T.grass, T.grassAlt, n), w.grass);
    mix(c, T.forest, w.forest);
    mix(c, lerp(T.desert, T.desertAlt, n), w.desert);
    mix(c, lerp(T.rock, T.snow, smoothstep(168, 182, h + 14 * fbm(x, z, 70, 2, 22))), w.alpine);
    mix(c, T.city, w.city);
    mix(c, lerp(T.coast, T.sand, smoothstep(SEA_Z - 170, SEA_Z - 50, z)), w.coast);
    let col = c.map(v => v * shade);
    // the sea: shallow turquoise at the shore fading to deep blue
    const sea = smoothstep(SEA_Z - 20, SEA_Z + 10, z);
    if (sea > 0) {
      const deep = smoothstep(SEA_Z, SEA_Z + 260, z);
      const water = lerp(T.shallow, T.sea, deep);
      col = lerp(col, water, sea);
    }
    // beyond the drivable square
    const out = Math.max(Math.abs(x), z < 0 ? -z : 0) > WORLD_HALF ? 1 : 0;
    if (out && z < SEA_Z) col = lerp(col, T.outside, 0.62);
    const o = (j * G + i) * 4;
    img.data[o] = col[0]; img.data[o + 1] = col[1]; img.data[o + 2] = col[2]; img.data[o + 3] = 255;
  }
  sctx.putImageData(img, 0, 0);

  const cv = document.createElement('canvas'); cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(small, 0, 0, size, size);
  const px = size / (MAP_EXTENT * 2);
  const X = (x) => (x + MAP_EXTENT) * px;
  // fine grain so flat areas don't look like plastic
  const rand = mulberry32(5150);
  ctx.globalAlpha = 0.06;
  for (let k = 0; k < size * size / 90; k++) {
    ctx.fillStyle = rand() < 0.5 ? '#000' : '#fff';
    ctx.fillRect(rand() * size, rand() * size, 1.4, 1.4);
  }
  // tree speckle where the 3D world plants forest and alpine pines
  ctx.globalAlpha = 1;
  for (let k = 0; k < 26000; k++) {
    const x = (rand() * 2 - 1) * WORLD_HALF, z = (rand() * 2 - 1) * WORLD_HALF;
    if (z > SEA_Z - 80) continue;
    const w = world.regionWeights(x, z);
    const dens = w.forest * 1 + w.alpine * 0.35 + w.grass * 0.08 + w.coast * 0.1;
    if (rand() > dens) continue;
    if (w.alpine > 0.5 && world.baseHeight(x, z) > 190) continue;
    const near = world.nearestGlobal(x, z, 1);
    if (near.idx >= 0 && near.dist < world.samples[near.idx].hw + 8) continue;
    ctx.fillStyle = w.forest > 0.5 ? 'rgba(24,58,26,0.55)' : 'rgba(30,70,32,0.45)';
    ctx.beginPath(); ctx.arc(X(x), X(z), 1.1 + rand() * 1.3, 0, Math.PI * 2); ctx.fill();
  }
  // shoreline foam
  ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(0, X(SEA_Z - 6)); ctx.lineTo(size, X(SEA_Z - 6)); ctx.stroke();
  // city ground: pavement under the blocks
  ctx.fillStyle = 'rgba(70,74,82,0.85)';
  ctx.fillRect(X(CITY.x0 - 40), X(CITY.z0 - 40), (CITY.x1 - CITY.x0 + 80) * px, (CITY.z1 - CITY.z0 + 80) * px);
  world._mapTerrain = cv;
  return cv;
}

// ------------------------------------------------------------------ Drawing helpers
/** Stroke every road (casing then fill, minor roads first) through a world→screen transform already set on ctx. */
export function strokeRoads(ctx, world, scale, opts = {}) {
  const { stride = 1, view = null, widthBoost = 1 } = opts;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const pass of ['casing', 'fill']) {
    for (const kind of ROAD_ORDER) {
      const st = ROAD_STYLE[kind];
      const roads = world.roads.filter(r => r.kind === kind);
      if (!roads.length) continue;
      const wpx = Math.max(st.min, roads[0].width * scale * widthBoost);
      ctx.lineWidth = (pass === 'casing' ? wpx + Math.max(1.6, wpx * 0.35) : wpx) / scale;
      ctx.strokeStyle = pass === 'casing' ? st.casing : st.fill;
      ctx.beginPath();
      for (const road of roads) traceRoad(ctx, world, road, stride, view);
      ctx.stroke();
    }
  }
}

/** Path along a road, skipping stretches outside `view` ({x0,z0,x1,z1} in metres). */
function traceRoad(ctx, world, road, stride, view) {
  const n = road.n, last = road.closed ? n : n - 1;   // a loop ends back on its first sample
  let pen = false;
  const visit = (li) => {
    const s = world.samples[road.i0 + (li % n)];
    const inside = !view || (s.p.x > view.x0 && s.p.x < view.x1 && s.p.z > view.z0 && s.p.z < view.z1);
    if (!inside) { if (pen) ctx.lineTo(s.p.x, s.p.z); pen = false; return; }
    if (pen) ctx.lineTo(s.p.x, s.p.z); else { ctx.moveTo(s.p.x, s.p.z); pen = true; }
  };
  for (let li = 0; li < last; li += stride) visit(li);
  visit(last);
}

/** Draw a route polyline (world coordinates; transform already set). */
export function strokeRoute(ctx, world, idxs, scale, widthPx = 6) {
  if (!idxs || idxs.length < 2) return;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let k = 0; k < idxs.length; k++) { const s = world.samples[idxs[k]]; if (k === 0) ctx.moveTo(s.p.x, s.p.z); else ctx.lineTo(s.p.x, s.p.z); }
  ctx.strokeStyle = 'rgba(30,8,48,0.75)'; ctx.lineWidth = (widthPx + 3) / scale; ctx.stroke();
  ctx.strokeStyle = ROUTE_COLOR; ctx.lineWidth = widthPx / scale; ctx.stroke();
}

/**
 * Marker badge in screen space: a coloured disc with a white glyph. `state` is
 * { done, locked, selected, hover }. `r` is the radius in px.
 */
export function drawMarkerIcon(ctx, x, y, m, state = {}, r = 11) {
  const cat = m.kind === 'board' ? 'board' : m.kind === 'custom' ? 'custom' : markerCategory(m);
  const color = MARKER_COLORS[cat];
  ctx.save();
  ctx.translate(x, y);
  if (state.selected || state.hover) {
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.beginPath(); ctx.arc(0, 0, r + 6, 0, Math.PI * 2); ctx.fill();
  }
  if (cat === 'custom') {
    drawPin(ctx, 0, 0, r, color);
    ctx.restore();
    return;
  }
  if (cat === 'board') {
    ctx.fillStyle = color; ctx.strokeStyle = '#0b3d22'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.roundRect(-r * 0.6, -r * 0.6, r * 1.2, r * 1.2, 2); ctx.fill(); ctx.stroke();
    ctx.restore();
    return;
  }
  const R = cat === 'hub' ? r * 1.3 : r;
  ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 4; ctx.shadowOffsetY = 1;
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = Math.max(1.5, R * 0.16); ctx.strokeStyle = state.locked ? 'rgba(20,24,32,0.9)' : '#fff';
  ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#fff';
  const g = R * 0.55;
  if (cat === 'hub') {
    ctx.beginPath();
    for (let i = 0; i < 10; i++) { const rr = i % 2 ? g * 0.45 : g * 1.05, a = -Math.PI / 2 + i * Math.PI / 5; ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); }
    ctx.closePath(); ctx.fillStyle = '#5a3d00'; ctx.fill();
  } else if (cat === 'event' || cat === 'stage') {
    // chequered flag on a pole
    ctx.fillRect(-g * 0.75, -g, g * 0.2, g * 2);
    const fw = g * 1.4, fh = g * 0.95, cs = fw / 4;
    for (let a = 0; a < 4; a++) for (let b = 0; b < 3; b++) {
      ctx.fillStyle = (a + b) % 2 ? '#fff' : 'rgba(20,20,20,0.85)';
      ctx.fillRect(-g * 0.55 + a * cs, -g + b * (fh / 3), cs, fh / 3);
    }
  } else if (cat === 'trap') {
    // speed camera
    ctx.beginPath(); ctx.roundRect(-g * 0.95, -g * 0.55, g * 1.5, g * 1.1, 2); ctx.fill();
    ctx.beginPath(); ctx.moveTo(g * 0.55, -g * 0.3); ctx.lineTo(g * 1.05, -g * 0.6); ctx.lineTo(g * 1.05, g * 0.6); ctx.lineTo(g * 0.55, g * 0.3); ctx.closePath(); ctx.fill();
    ctx.fillStyle = MARKER_COLORS.trap; ctx.beginPath(); ctx.arc(-g * 0.2, 0, g * 0.32, 0, Math.PI * 2); ctx.fill();
  } else if (cat === 'drift') {
    // a sliding S-curve
    ctx.lineWidth = g * 0.42; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-g * 0.8, g * 0.85); ctx.bezierCurveTo(g * 1.4, g * 0.6, -g * 1.4, -g * 0.6, g * 0.8, -g * 0.85); ctx.stroke();
  } else if (cat === 'zone') {
    // speedometer
    ctx.lineWidth = g * 0.32; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(0, g * 0.3, g * 0.95, Math.PI * 1.1, Math.PI * 1.9); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, g * 0.3); ctx.lineTo(g * 0.6, -g * 0.45); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, g * 0.3, g * 0.22, 0, Math.PI * 2); ctx.fill();
  }
  if (state.locked) {
    ctx.fillStyle = '#20242e'; ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(R * 0.72, R * 0.72, R * 0.45, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.font = `900 ${Math.max(7, Math.round(R * 0.62))}px Segoe UI, Arial`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('?', R * 0.72, R * 0.76);
  }
  if (state.done) {
    ctx.fillStyle = '#3ddc84'; ctx.strokeStyle = '#0b2a18'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(R * 0.72, -R * 0.72, R * 0.42, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(1.2, R * 0.12);
    ctx.beginPath(); ctx.moveTo(R * 0.52, -R * 0.72); ctx.lineTo(R * 0.67, -R * 0.56); ctx.lineTo(R * 0.92, -R * 0.9); ctx.stroke();
  }
  ctx.restore();
}

/** A map pin whose point sits at (x, y). */
export function drawPin(ctx, x, y, r, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 5; ctx.shadowOffsetY = 2;
  ctx.fillStyle = color; ctx.strokeStyle = '#2a2000'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(-r * 0.4, -r * 0.9, -r, -r * 1.3, -r, -r * 1.9);
  ctx.arc(0, -r * 1.9, r, Math.PI, 0);
  ctx.bezierCurveTo(r, -r * 1.3, r * 0.4, -r * 0.9, 0, 0);
  ctx.fill(); ctx.shadowColor = 'transparent'; ctx.stroke();
  ctx.fillStyle = '#2a2000'; ctx.beginPath(); ctx.arc(0, -r * 1.9, r * 0.38, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

/** Player arrow pointing along `heading` (world heading: 0 = +z / south). */
export function drawPlayerArrow(ctx, x, y, angle, size = 10, pulse = 0) {
  ctx.save();
  ctx.translate(x, y);
  if (pulse > 0) {
    ctx.strokeStyle = `rgba(255,90,31,${0.6 * (1 - pulse)})`; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, 0, size * (1.2 + pulse * 1.6), 0, Math.PI * 2); ctx.stroke();
  }
  ctx.rotate(angle);
  ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 4;
  ctx.fillStyle = '#ff5a1f'; ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(1.5, size * 0.18);
  ctx.beginPath(); ctx.moveTo(0, -size); ctx.lineTo(size * 0.72, size * 0.8); ctx.lineTo(0, size * 0.35); ctx.lineTo(-size * 0.72, size * 0.8); ctx.closePath();
  ctx.fill(); ctx.shadowColor = 'transparent'; ctx.stroke();
  ctx.restore();
}

/** Name label positions along each road: every ~1.4 km, plus one for short roads. */
function roadLabelSpots(world) {
  if (world._labelSpots) return world._labelSpots;
  const out = [];
  const seen = new Set();
  for (const road of world.roads) {
    // the city's streets share names per street, so label each once
    if (seen.has(road.name)) continue;
    seen.add(road.name);
    const L = road.length;
    const count = Math.max(1, Math.round(L / 500));
    for (let k = 0; k < count; k++) {
      const li = Math.round(((k + 0.5) / count) * (road.n - 1));
      out.push({ road, li });
    }
  }
  world._labelSpots = out;
  return out;
}

// ------------------------------------------------------------------ Map screen
const FILTERS = [
  { id: 'event', label: 'Circuits' }, { id: 'stage', label: 'Stages' }, { id: 'trap', label: 'Speed traps' },
  { id: 'drift', label: 'Drift zones' }, { id: 'zone', label: 'Speed zones' }, { id: 'board', label: 'Bonus boards' },
];

export class WorldMap {
  /**
   * @param {HTMLElement} host   element to fill
   * @param {object} o { hz, app, fromPause, onClose() }
   */
  constructor(host, o) {
    this.hz = o.hz; this.app = o.app; this.world = o.hz.world;
    this.onClose = o.onClose; this.fromPause = !!o.fromPause;
    this.filters = this.hz.mapFilters || (this.hz.mapFilters = Object.fromEntries(FILTERS.map(f => [f.id, true])));
    this.selected = this.hz.waypoint || null;
    this.hover = null;
    this.dragging = null;
    this.pointers = new Map();
    this.padMode = false;
    this.padPrev = {};
    this.keys = new Set();
    this.dirtyBase = true;
    this.time = 0;
    this.terrain = terrainLayer(this.world);
    this._buildDom(host);
    this.resize();
    // open centred on the player at a zoom that shows the surroundings, like the games do
    const fit = this._fitScale();
    this.view = { x: this.hz.car.pos.x, z: this.hz.car.pos.z, scale: Math.max(fit, Math.min(0.42, fit * 2.6)) };
    this._clampView();
    this._bind();
    this._renderSel();
    this.last = performance.now();
    this.raf = requestAnimationFrame(() => this._frame());
  }

  _buildDom(host) {
    const sum = this.hz.summary();
    const stars = (a, b) => `${a}<span>/${b}</span>`;
    host.innerHTML = `
      <div class="hzmap">
        <canvas class="hzmap-canvas"></canvas>
        <div class="hzmap-top">
          <div class="hzmap-title"><b>MAP</b><span class="hzmap-where"></span></div>
          <div class="hzmap-stats"><span>LEVEL <b>${sum.level.level}</b></span><span>${sum.xp.toLocaleString()} XP</span><span class="money">${Math.round(sum.money).toLocaleString()} cr</span></div>
          <button class="small ghost" data-close>${this.fromPause ? '← Back' : 'Close'} <kbd>Esc</kbd></button>
        </div>
        <div class="hzmap-side">
          <div class="hzmap-card" data-sel></div>
          <details class="hzmap-card hzmap-progress">
            <summary>Progress</summary>
            <div class="hz-stats">
              <div><span>Events raced</span><b>${stars(sum.events, sum.eventsTotal)}</b></div>
              <div><span>Speed traps</span><b>${stars(sum.trapStars, sum.trapTotal)} ★</b></div>
              <div><span>Drift zones</span><b>${stars(sum.driftStars, sum.driftTotal)} ★</b></div>
              <div><span>Speed zones</span><b>${stars(sum.zoneStars, sum.zoneTotal)} ★</b></div>
              <div><span>Bonus boards</span><b>${stars(sum.boards, sum.boardsTotal)}</b></div>
              <div><span>Discovered</span><b>${stars(sum.discovered, sum.markers)}</b></div>
              <div><span>Distance driven</span><b>${sum.distance.toFixed(1)} km</b></div>
            </div>
          </details>
        </div>
        <div class="hzmap-legend">${FILTERS.map(f => `<button class="hzmap-chip${this.filters[f.id] ? ' on' : ''}" data-filter="${f.id}"><canvas width="44" height="44"></canvas>${f.label}</button>`).join('')}</div>
        <div class="hzmap-zoom"><button data-zoom="1" title="Zoom in">+</button><button data-zoom="-1" title="Zoom out">−</button><button data-center title="Centre on your car (C)">◎</button></div>
        <div class="hzmap-scale"><i></i><span></span></div>
        <div class="hzmap-hints">Drag to pan · Scroll to zoom · Click a marker or road to select · Double-click sets a waypoint · Right-click clears it · <kbd>C</kbd> centre · <kbd>M</kbd> close</div>
        <div class="hzmap-tip hidden"></div>
      </div>`;
    this.root = host.querySelector('.hzmap');
    this.canvas = host.querySelector('.hzmap-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.tip = host.querySelector('.hzmap-tip');
    this.selBox = host.querySelector('[data-sel]');
    this.where = host.querySelector('.hzmap-where');
    this.scaleEl = host.querySelector('.hzmap-scale');
    // legend icons
    host.querySelectorAll('[data-filter]').forEach(b => {
      const c = b.querySelector('canvas').getContext('2d');
      const id = b.dataset.filter;
      const fake = id === 'board' ? { kind: 'board' } : id === 'event' ? { kind: 'event', track: { kind: 'circuit' } } : id === 'stage' ? { kind: 'event', track: { kind: 'stage' } } : { kind: id };
      c.scale(2, 2);
      drawMarkerIcon(c, 11, 11, fake, {}, 8);
    });
  }

  _bind() {
    const c = this.canvas;
    this.listeners = [];
    const on = (el, ev, fn, opt) => { el.addEventListener(ev, fn, opt); this.listeners.push([el, ev, fn, opt]); };
    on(window, 'resize', () => this.resize());
    on(c, 'contextmenu', (e) => { e.preventDefault(); if (this.hz.waypoint) { this._setWaypoint(null); } });
    on(c, 'pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      this.padMode = false;
      if (e.button !== 0) return;
      this.dragging = { x: e.offsetX, y: e.offsetY, vx: this.view.x, vz: this.view.z, moved: 0 };
      if (this.pointers.size === 2) this.pinch = this._pinchState();
    });
    on(c, 'pointermove', (e) => {
      const p = this.pointers.get(e.pointerId);
      if (p) { p.x = e.offsetX; p.y = e.offsetY; }
      if (this.pointers.size === 2 && this.pinch) {
        const now = this._pinchState();
        this._zoomAt(now.cx, now.cy, now.d / this.pinch.d);
        this.pinch = now;
        if (this.dragging) this.dragging.moved = 99;
        return;
      }
      if (this.dragging) {
        const dx = e.offsetX - this.dragging.x, dy = e.offsetY - this.dragging.y;
        this.dragging.moved = Math.max(this.dragging.moved, Math.hypot(dx, dy));
        if (this.dragging.moved > 4) {
          this.view.x = this.dragging.vx - dx / this.view.scale;
          this.view.z = this.dragging.vz - dy / this.view.scale;
          this._clampView();
          this.dirtyBase = true;
          c.style.cursor = 'grabbing';
        }
      }
      this.mouse = { x: e.offsetX, y: e.offsetY };
      this._updateHover();
    });
    const up = (e) => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
      if (this.dragging && e.type === 'pointerup' && this.dragging.moved <= 4) this._clickAt(e.offsetX, e.offsetY, false);
      this.dragging = null;
      c.style.cursor = '';
    };
    on(c, 'pointerup', up); on(c, 'pointercancel', up);
    on(c, 'pointerleave', () => { this.mouse = null; this._updateHover(); });
    on(c, 'dblclick', (e) => this._clickAt(e.offsetX, e.offsetY, true));
    on(c, 'wheel', (e) => { e.preventDefault(); this._zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
    on(window, 'keydown', (e) => {
      if (e.code === 'KeyM' || e.code === 'Tab') {
        e.preventDefault();
        this.close();
        return;
      }
      if (e.code === 'KeyC' || e.code === 'Space') { e.preventDefault(); this.centerOnPlayer(); }
      if (e.code === 'Enter' || e.code === 'NumpadEnter') { if (this.selected) this._setWaypoint(this.hz.waypoint === this.selected ? null : this.selected); }
      if (e.code === 'KeyF' && this.selected) this._fastTravel(this.selected);
      if (e.code === 'Equal' || e.code === 'NumpadAdd' || e.code === 'KeyE') this._zoomAt(this.w / 2, this.h / 2, 1.35);
      if (e.code === 'Minus' || e.code === 'NumpadSubtract' || e.code === 'KeyQ') this._zoomAt(this.w / 2, this.h / 2, 1 / 1.35);
      this.keys.add(e.code);
    });
    on(window, 'keyup', (e) => this.keys.delete(e.code));
    this.root.querySelector('[data-close]').addEventListener('click', () => this.close());
    this.root.querySelectorAll('[data-zoom]').forEach(b => b.addEventListener('click', () => this._zoomAt(this.w / 2, this.h / 2, +b.dataset.zoom > 0 ? 1.5 : 1 / 1.5)));
    this.root.querySelector('[data-center]').addEventListener('click', () => this.centerOnPlayer());
    this.root.querySelectorAll('[data-filter]').forEach(b => b.addEventListener('click', () => {
      const id = b.dataset.filter;
      this.filters[id] = !this.filters[id];
      b.classList.toggle('on', this.filters[id]);
      this.app.audio.click();
      this._updateHover();
    }));
  }

  _pinchState() {
    const [a, b] = [...this.pointers.values()];
    return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, d: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)) };
  }

  resize() {
    const r = this.root.getBoundingClientRect();
    this.w = Math.max(320, r.width); this.h = Math.max(240, r.height);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.w * this.dpr); this.canvas.height = Math.round(this.h * this.dpr);
    this.canvas.style.width = this.w + 'px'; this.canvas.style.height = this.h + 'px';
    this.base = document.createElement('canvas');
    this.base.width = this.canvas.width; this.base.height = this.canvas.height;
    if (this.view) this._clampView();
    this.dirtyBase = true;
  }

  _fitScale() { return Math.min(this.w - 40, this.h - 170) / (WORLD_HALF * 2 + 300); }

  _clampView() {
    const v = this.view;
    v.scale = Math.max(this._fitScale(), Math.min(3, v.scale));
    const lim = WORLD_HALF + 200 + 160 / v.scale;   // room to pan the edges clear of the panels
    const hx = Math.max(0, lim - this.w / 2 / v.scale), hz = Math.max(0, lim - this.h / 2 / v.scale);
    v.x = Math.max(-hx, Math.min(hx, v.x));
    v.z = Math.max(-hz, Math.min(hz, v.z));
  }

  _zoomAt(sx, sy, k) {
    const before = this.toWorld(sx, sy);
    this.view.scale *= k;
    this._clampView();
    const after = this.toWorld(sx, sy);
    this.view.x += before.x - after.x; this.view.z += before.z - after.z;
    this._clampView();
    this.dirtyBase = true;
    this._updateHover();
  }

  centerOnPlayer() {
    this.view.x = this.hz.car.pos.x; this.view.z = this.hz.car.pos.z;
    this.view.scale = Math.max(this.view.scale, 0.35);
    this._clampView();
    this.dirtyBase = true;
  }

  toScreen(x, z) { return { x: this.w / 2 + (x - this.view.x) * this.view.scale, y: this.h / 2 + (z - this.view.z) * this.view.scale }; }
  toWorld(sx, sy) { return { x: this.view.x + (sx - this.w / 2) / this.view.scale, z: this.view.z + (sy - this.h / 2) / this.view.scale }; }

  // ------------------------------------------------------------ Picking & selection
  _visibleMarkers() {
    const W = this.world, out = [];
    for (const m of W.markers) {
      const cat = markerCategory(m);
      if (cat !== 'hub' && !this.filters[cat]) continue;
      out.push(m);
    }
    if (this.filters.board) for (const b of W.boards) if (!this.hz.prog.boards.includes(b.id)) out.push(b);
    return out;
  }

  _pick(sx, sy) {
    let best = null, bd = 18;
    for (const m of this._visibleMarkers()) {
      const p = this.toScreen(m.x, m.z);
      const d = Math.hypot(p.x - sx, p.y - sy) * (m.kind === 'board' ? 1.6 : 1);
      if (d < bd) { bd = d; best = m; }
    }
    const wp = this.hz.waypoint;
    if (wp && wp.kind === 'custom') {
      const p = this.toScreen(wp.x, wp.z);
      if (Math.hypot(p.x - sx, p.y - 14 - sy) < 16) best = wp;
    }
    return best;
  }

  /** A point on the road network under the cursor (within ~14 px), for custom waypoints. */
  _roadAt(sx, sy) {
    const w = this.toWorld(sx, sy);
    const reach = Math.max(18, 14 / this.view.scale);
    const near = this.world.nearestGlobal(w.x, w.z, Math.ceil(reach / this.world.cell) + 1);
    if (near.idx < 0 || near.dist > reach) return null;
    const s = this.world.samples[near.idx];
    const road = this.world.roadOf(near.idx);
    return { id: 'custom', kind: 'custom', name: road.name, x: s.p.x, z: s.p.z, y: s.p.y, idx: near.idx };
  }

  _clickAt(sx, sy, setWp) {
    const m = this._pick(sx, sy) || this._roadAt(sx, sy);
    if (!m) { this.selected = null; this._renderSel(); return; }
    this.selected = m;
    this.app.audio.click();
    if (setWp) this._setWaypoint(m);
    this._renderSel();
  }

  _setWaypoint(m) {
    this.app.setWaypoint(m);
    this.dirtyBase = true;
    if (m) this.selected = m;
    this._renderSel();
  }

  _fastTravel(m) {
    if (!this._canTravel(m)) return;
    this.app.audio.click();
    this.dispose();
    this.app.fastTravel(m);
  }

  _discovered(m) { return m.kind === 'hub' || this.hz.prog.discovered.includes(m.id); }
  _canTravel(m) { return m.kind !== 'board' && m.kind !== 'custom' && this._discovered(m); }

  _updateHover() {
    if (this.padMode) this.hover = this._pick(this.w / 2, this.h / 2);
    else this.hover = this.mouse ? this._pick(this.mouse.x, this.mouse.y) : null;
    const W = this.world;
    const pt = this.padMode ? { x: this.w / 2, y: this.h / 2 } : this.mouse;
    if (pt) {
      const w = this.toWorld(pt.x, pt.y);
      const inside = Math.abs(w.x) <= WORLD_HALF && Math.abs(w.z) <= WORLD_HALF && w.z < SEA_Z;
      this.where.textContent = inside ? W.regionAt(w.x, w.z).name : (w.z >= SEA_Z ? 'The sea' : 'Out of bounds');
    }
    if (this.hover && pt) {
      const m = this.hover;
      this.tip.innerHTML = `<b>${m.kind === 'custom' ? 'Waypoint' : m.name}</b><span>${this._kindName(m)}</span>${m.kind !== 'board' && m.kind !== 'custom' ? `<em>${this._discovered(m) ? this.hz.markerBest(m) : 'Undiscovered: drive near it to unlock fast travel'}</em>` : ''}`;
      this.tip.classList.remove('hidden');
      const tx = Math.min(this.w - 260, pt.x + 18), ty = Math.max(70, pt.y - 10);
      this.tip.style.transform = `translate(${tx}px, ${ty}px)`;
      this.canvas.style.cursor = 'pointer';
    } else {
      this.tip.classList.add('hidden');
      if (!this.dragging) this.canvas.style.cursor = this.mouse && this._roadAt(this.mouse.x, this.mouse.y) ? 'crosshair' : 'grab';
    }
  }

  _kindName(m) {
    return {
      hub: 'Festival hub', trap: 'Speed trap', drift: 'Drift zone', zone: 'Speed zone', board: 'Bonus board', custom: m.name,
      event: m.track ? (m.track.kind === 'stage' ? 'Point-to-point stage' : 'Circuit race') : 'Event',
    }[m.kind];
  }

  _renderSel() {
    const m = this.selected, hz = this.hz, box = this.selBox;
    if (!m) {
      box.innerHTML = `<div class="meta">Click a marker for details, or click any road to drop a waypoint there. Your route is drawn in <b style="color:${ROUTE_COLOR}">purple</b> on the map and the radar.</div>`;
      return;
    }
    const d = Math.hypot(m.x - hz.car.pos.x, m.z - hz.car.pos.z);
    const isWp = hz.waypoint && (hz.waypoint === m || (m.kind === 'custom' && hz.waypoint.kind === 'custom' && hz.waypoint.idx === m.idx));
    const route = isWp ? hz.route : (m.idx !== undefined ? this.world.route(hz.car.trackIdx, m.idx) : null);
    const fmt = (v) => v >= 1000 ? (v / 1000).toFixed(1) + ' km' : Math.round(v) + ' m';
    const region = this.world.regionAt(m.x, m.z).name;
    const travel = this._canTravel(m);
    const title = m.kind === 'custom' ? 'Custom waypoint' : m.name;
    const sub = m.kind === 'custom' ? `${m.name} · ${region}` : `${this._kindName(m)} · ${region}`;
    const extra = m.kind === 'event' ? `${m.track.desc}<br>${m.track.open ? 'Stage' : m.laps + ' laps'} · ${m.ai} rivals` : '';
    box.innerHTML = `
      <div class="hzmap-sel-head"><canvas width="56" height="56"></canvas><div><h4>${title}</h4><div class="meta">${sub}</div></div></div>
      ${extra ? `<div class="meta hzmap-extra" style="margin-top:8px">${extra}</div>` : ''}
      <div class="hzmap-dist">${route ? `<b>${fmt(route.length)}</b> by road` : ''}<span>${fmt(d)} direct</span></div>
      ${m.kind !== 'custom' && m.kind !== 'board' ? `<div class="hzmap-best">${this._discovered(m) ? hz.markerBest(m) || '&nbsp;' : 'Undiscovered'}</div>` : ''}
      <div class="row" style="margin-top:10px;gap:8px">
        <button class="small primary" data-wp>${isWp ? 'Clear waypoint' : 'Set waypoint'} <kbd>Enter</kbd></button>
        ${m.kind !== 'custom' && m.kind !== 'board' ? `<button class="small" data-travel ${travel ? '' : 'disabled title="Drive there first to unlock fast travel"'}>Fast travel <kbd>F</kbd></button>` : ''}
      </div>`;
    const ic = box.querySelector('canvas').getContext('2d');
    ic.scale(2, 2);
    drawMarkerIcon(ic, 14, m.kind === 'custom' ? 24 : 14, m, { locked: m.kind !== 'board' && m.kind !== 'custom' && !this._discovered(m) }, 10);
    box.querySelector('[data-wp]').addEventListener('click', () => { this.app.audio.click(); this._setWaypoint(isWp ? null : m); });
    const tb = box.querySelector('[data-travel]');
    if (tb) tb.addEventListener('click', () => this._fastTravel(m));
  }

  // ------------------------------------------------------------ Loop
  _frame() {
    if (this.disposed) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.time += dt;
    this._input(dt);
    this._draw();
    this.raf = requestAnimationFrame(() => this._frame());
  }

  _input(dt) {
    // keyboard pan
    let px = 0, pz = 0;
    if (this.keys.has('ArrowLeft') || this.keys.has('KeyA')) px -= 1;
    if (this.keys.has('ArrowRight') || this.keys.has('KeyD')) px += 1;
    if (this.keys.has('ArrowUp') || this.keys.has('KeyW')) pz -= 1;
    if (this.keys.has('ArrowDown') || this.keys.has('KeyS')) pz += 1;
    // gamepad: left stick moves the map under a centre reticle, triggers zoom
    const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
    const gp = pads[0];
    let zoom = 0;
    if (gp) {
      const ax = Math.abs(gp.axes[0]) > 0.18 ? gp.axes[0] : 0, ay = Math.abs(gp.axes[1]) > 0.18 ? gp.axes[1] : 0;
      if (ax || ay) { px += ax; pz += ay; if (!this.padMode) { this.padMode = true; this.mouse = null; } }
      const rt = gp.buttons[7] ? gp.buttons[7].value : 0, lt = gp.buttons[6] ? gp.buttons[6].value : 0;
      const ry = Math.abs(gp.axes[3] || 0) > 0.2 ? -gp.axes[3] : 0;
      zoom = rt - lt + ry;
      const just = (b) => { const down = !!(gp.buttons[b] && gp.buttons[b].pressed); const was = this.padPrev[b]; this.padPrev[b] = down; return down && !was; };
      if (just(0)) { this.padMode = true; this._clickAt(this.w / 2, this.h / 2, false); if (this.selected) this._setWaypoint(this.hz.waypoint === this.selected ? null : this.selected); }
      if (just(2) && this.selected) this._fastTravel(this.selected);
      if (just(3)) this.centerOnPlayer();
      if (just(1) || just(8)) { this.close(); return; }
    }
    if (px || pz) {
      const speed = 620 / this.view.scale;   // px per second → metres
      this.view.x += px * speed * dt; this.view.z += pz * speed * dt;
      this._clampView();
      this.dirtyBase = true;
      if (this.padMode) this._updateHover();
    }
    if (zoom) this._zoomAt(this.w / 2, this.h / 2, Math.exp(zoom * dt * 2.2));
  }

  /** Terrain, city and roads: redrawn only when the view moves. */
  _drawBase() {
    const ctx = this.base.getContext('2d'), v = this.view, W = this.world;
    const dpr = this.dpr, s = v.scale;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#1d3f66'; ctx.fillRect(0, 0, this.base.width, this.base.height);
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * (this.w / 2 - v.x * s), dpr * (this.h / 2 - v.z * s));
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.terrain, -MAP_EXTENT, -MAP_EXTENT, MAP_EXTENT * 2, MAP_EXTENT * 2);
    // drivable boundary
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1.5 / s; ctx.setLineDash([8 / s, 6 / s]);
    ctx.strokeRect(-WORLD_HALF, -WORLD_HALF, WORLD_HALF * 2, SEA_Z + WORLD_HALF);
    ctx.setLineDash([]);
    const tl = this.toWorld(-40, -40), br = this.toWorld(this.w + 40, this.h + 40);
    const view = { x0: tl.x, z0: tl.z, x1: br.x, z1: br.z };
    // city blocks
    for (const b of W.buildings) {
      if (b.x < view.x0 - 60 || b.x > view.x1 + 60 || b.z < view.z0 - 60 || b.z > view.z1 + 60) continue;
      const tone = 150 + Math.min(80, b.h * 0.6);
      ctx.fillStyle = `rgb(${tone - 12},${tone - 8},${tone})`;
      ctx.fillRect(b.x - b.hw, b.z - b.hd, b.w, b.d);
      if (s > 0.5) { ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1 / s; ctx.strokeRect(b.x - b.hw, b.z - b.hd, b.w, b.d); }
    }
    const stride = Math.max(1, Math.min(8, Math.round(1.5 / (s * W.spacing))));
    strokeRoads(ctx, W, s, { stride, view, widthBoost: s < 0.25 ? 1.6 : 1 });
    if (this.hz.routeIdx && this.hz.routeIdx.length > 1) strokeRoute(ctx, W, this.hz.routeIdx, s, Math.max(4, Math.min(9, 12 * s + 3)));
    // labels in screen space
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._drawLabels(ctx);
    this.dirtyBase = false;
  }

  _drawLabels(ctx) {
    const W = this.world, s = this.view.scale;
    const boxes = [];
    const R = Math.max(8, Math.min(13, 8 + s * 10)) + 3;
    for (const m of this._visibleMarkers()) { const p = this.toScreen(m.x, m.z); boxes.push({ x: p.x, y: p.y, w: R * 2, h: R * 2 }); }
    const free = (x, y, w, h) => {
      for (const b of boxes) if (Math.abs(b.x - x) < (b.w + w) / 2 && Math.abs(b.y - y) < (b.h + h) / 2) return false;
      boxes.push({ x, y, w, h });
      return true;
    };
    // region names: big and spaced, fading out as you zoom in
    const regionAlpha = 1 - smoothstep(0.22, 0.6, s);
    if (regionAlpha > 0.02) {
      ctx.save();
      ctx.globalAlpha = regionAlpha;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const r of REGIONS) {
        const x = r.lx !== undefined ? r.lx : r.cx, z = r.lz !== undefined ? r.lz : r.cz;
        const p = this.toScreen(x, z);
        const fs = Math.round(Math.max(13, Math.min(22, 14 + s * 30)));
        ctx.font = `800 ${fs}px Segoe UI, Arial`;
        const text = r.name.toUpperCase().split('').join(' ');
        const tw = ctx.measureText(text).width;
        boxes.push({ x: p.x, y: p.y, w: tw + 20, h: fs + 10 });
        ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(10,14,22,0.7)'; ctx.strokeText(text, p.x, p.y);
        ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.fillText(text, p.x, p.y);
      }
      ctx.restore();
    }
    // road names along the road
    const minScale = { highway: 0.12, road: 0.16, lane: 0.3, dirt: 0.3, street: 0.7 };
    ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    ctx.wordSpacing = '3px'; ctx.letterSpacing = '0.3px';
    const placed = new Map();   // road name → label positions, to keep them ~320 px apart
    for (const { road, li } of roadLabelSpots(W)) {
      if (s < minScale[road.kind]) continue;
      const a = W.samples[road.i0 + li];
      const p = this.toScreen(a.p.x, a.p.z);
      if (p.x < 40 || p.y < 70 || p.x > this.w - 40 || p.y > this.h - 70) continue;
      const mine = placed.get(road.name) || [];
      if (mine.some(q => Math.hypot(q.x - p.x, q.y - p.y) < 320)) continue;
      let ang = Math.atan2(a.t.z, a.t.x);
      if (ang > Math.PI / 2) ang -= Math.PI; else if (ang < -Math.PI / 2) ang += Math.PI;
      const fs = road.kind === 'highway' ? 13 : road.kind === 'street' ? 11 : 12;
      ctx.font = `${road.kind === 'highway' ? 800 : 700} ${fs}px Segoe UI, Arial`;
      const tw = ctx.measureText(road.name).width;
      const bw = Math.abs(Math.cos(ang)) * tw + Math.abs(Math.sin(ang)) * fs + 6, bh = Math.abs(Math.sin(ang)) * tw + Math.abs(Math.cos(ang)) * fs + 6;
      if (!free(p.x, p.y, bw, bh)) continue;
      mine.push(p); placed.set(road.name, mine);
      ctx.save();
      ctx.translate(p.x, p.y); ctx.rotate(ang);
      ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(12,16,24,0.85)'; ctx.strokeText(road.name, 0, 0);
      ctx.fillStyle = road.kind === 'highway' ? '#ffe08a' : '#ffffff'; ctx.fillText(road.name, 0, 0);
      ctx.restore();
    }
    ctx.wordSpacing = '0px'; ctx.letterSpacing = '0px';
  }

  _draw() {
    const ctx = this.ctx, hz = this.hz, W = this.world, s = this.view.scale, dpr = this.dpr;
    if (this.dirtyBase) this._drawBase();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.base, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // markers
    const R = Math.max(8, Math.min(13, 8 + s * 10));
    const list = this._visibleMarkers();
    for (const m of list) {
      if (m === this.hover || m === this.selected) continue;
      this._drawMarker(ctx, m, R);
    }
    for (const m of [this.selected, this.hover]) if (m && m.kind !== 'custom' && list.includes(m)) this._drawMarker(ctx, m, R, true);
    // waypoint pin
    const wp = hz.waypoint;
    if (wp) {
      const p = this.toScreen(wp.x, wp.z);
      if (wp.kind === 'custom') drawPin(ctx, p.x, p.y, 9, MARKER_COLORS.custom);
      else drawPin(ctx, p.x, p.y - R - 2, 7, MARKER_COLORS.custom);
    }
    // a selected custom point that isn't the waypoint yet
    if (this.selected && this.selected.kind === 'custom' && this.selected !== wp) {
      const p = this.toScreen(this.selected.x, this.selected.z);
      ctx.globalAlpha = 0.65; drawPin(ctx, p.x, p.y, 9, '#ffffff'); ctx.globalAlpha = 1;
    }
    // player
    const car = hz.car, pp = this.toScreen(car.pos.x, car.pos.z);
    drawPlayerArrow(ctx, pp.x, pp.y, Math.PI - car.heading, 11, (this.time % 1.6) / 1.6);
    // gamepad reticle
    if (this.padMode) {
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 2;
      const cx = this.w / 2, cy = this.h / 2;
      ctx.beginPath(); ctx.arc(cx, cy, 14, 0, Math.PI * 2);
      ctx.moveTo(cx - 22, cy); ctx.lineTo(cx - 8, cy); ctx.moveTo(cx + 8, cy); ctx.lineTo(cx + 22, cy);
      ctx.moveTo(cx, cy - 22); ctx.lineTo(cx, cy - 8); ctx.moveTo(cx, cy + 8); ctx.lineTo(cx, cy + 22); ctx.stroke();
    }
    this._updateScaleBar();
  }

  _drawMarker(ctx, m, R, emph = false) {
    const p = this.toScreen(m.x, m.z);
    if (p.x < -20 || p.y < -20 || p.x > this.w + 20 || p.y > this.h + 20) return;
    const hz = this.hz;
    let done = false;
    if (m.kind === 'event') done = !!hz.prog.events[m.id];
    else if (m.kind === 'trap' || m.kind === 'drift' || m.kind === 'zone') done = hz._stars((hz.prog[m.kind + 's'] || {})[m.id] || 0, m.stars) === 3;
    const locked = m.kind !== 'board' && !this._discovered(m);
    drawMarkerIcon(ctx, p.x, p.y, m, { done, locked, selected: m === this.selected, hover: m === this.hover }, m.kind === 'board' ? R * 0.75 : (emph ? R * 1.15 : R));
  }

  _updateScaleBar() {
    const s = this.view.scale;
    if (this._lastScale === s) return;
    this._lastScale = s;
    const target = 120 / s;
    const nice = [50, 100, 200, 250, 500, 1000, 2000].reduce((a, b) => Math.abs(b - target) < Math.abs(a - target) ? b : a);
    this.scaleEl.querySelector('i').style.width = `${nice * s}px`;
    this.scaleEl.querySelector('span').textContent = nice >= 1000 ? `${nice / 1000} km` : `${nice} m`;
  }

  close() {
    if (this.disposed) return;
    this.dispose();
    this.onClose();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    for (const [el, ev, fn, opt] of this.listeners || []) el.removeEventListener(ev, fn, opt);
  }
}
