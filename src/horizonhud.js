// Free Roam HUD: speed, compass, radar minimap, waypoint, event prompt,
// live drift/speed-zone score, XP, and popups/toasts for skills and discoveries.
import { levelForXp, CITY } from './worlddef.js';
import { terrainLayer, MAP_EXTENT, ROAD_STYLE, ROUTE_COLOR, MARKER_COLORS, drawMarkerIcon, drawPin, drawPlayerArrow, drawPropFootprints } from './worldmap.js';

const RADAR_NEAR = 320, RADAR_FAR = 680;   // metres shown top to bottom, standing still → flat out
const RADAR_KINDS = ['dirt', 'lane', 'street', 'road', 'highway'];

export class HorizonHUD {
  constructor(hz) {
    this.hz = hz;
    this.layer = document.getElementById('hud-layer');
    this.center = document.getElementById('hud-center');
    this.divider = document.getElementById('hud-divider');
    this.el = document.getElementById('hud-0');
    this.other = document.getElementById('hud-1');
    this.live = null;
    this.msgTimer = 0;
    this.regionTimer = 0;
    this.show();
  }

  show() {
    this.layer.classList.remove('hidden');
    this.other.classList.add('hidden');
    this.divider.className = 'hidden';
    this.el.className = 'hud';
    this.el.classList.remove('hidden');
    this.el.innerHTML = `
      <div class="hz-top-left">
        <div class="hz-mode">APEX HORIZON</div>
        <div class="hz-region">—</div>
        <div class="hz-road"></div>
      </div>
      <canvas class="hz-compass" width="440" height="36"></canvas>
      <div class="hz-top-right">
        <div class="hz-level">LEVEL <b>1</b></div>
        <div class="hz-xpbar"><i style="width:0%"></i></div>
        <div class="hz-wallet"><span>WALLET</span><b class="hz-money">0 cr</b><i class="hz-gain"></i></div>
      </div>
      <div class="bottom-right hz-br">
        <div class="speed"><b>0</b><small>km/h</small></div>
        <div class="gear-bar"><i style="width:0%"></i></div>
      </div>
      <canvas class="hz-radar"></canvas>
      <div class="hz-waypoint hidden"><span class="turn"></span><div><div class="instr"></div><div class="info"><b></b> · <span class="name"></span></div></div></div>
      <div class="hz-prompt hidden"></div>
      <div class="hz-guide hidden"><div><b></b><span></span></div><button class="small ghost">Skip tour</button></div>
      <div class="hz-live hidden"><div class="label"></div><div class="score"></div></div>
      <div class="msg"><span class="main"></span><span class="sub"></span></div>
      <div class="hz-toasts"></div>
      <button class="hz-mapbtn">MAP</button>
      <div class="hz-hint"><kbd>M</kbd> map · <kbd>Enter</kbd> at a marker · <kbd>R</kbd> back to road · <kbd>Esc</kbd> pause</div>`;
    // Touch and mouse: tapping the prompt starts the event, the MAP button opens the map.
    this.el.querySelector('.hz-prompt').addEventListener('click', () => { if (this.hz.prompt && this.hz.promptCooldown <= 0) this.hz.onEvent(this.hz.prompt); });
    this.el.querySelector('.hz-mapbtn').addEventListener('click', () => { this.hz.requestMap = true; });
    this.el.querySelector('.hz-guide button').addEventListener('click', () => this.hz.skipGuide());
    const q = (s) => this.el.querySelector(s);
    this.q = {
      region: q('.hz-region'), road: q('.hz-road'), compass: q('.hz-compass'), level: q('.hz-level b'), xp: q('.hz-xpbar i'), money: q('.hz-money'),
      speed: q('.speed b'), bar: q('.gear-bar i'), radar: q('.hz-radar'), wp: q('.hz-waypoint'), wpTurn: q('.hz-waypoint .turn'), wpInstr: q('.hz-waypoint .instr'), wpDist: q('.hz-waypoint .info b'), wpName: q('.hz-waypoint .name'),
      prompt: q('.hz-prompt'), live: q('.hz-live'), liveLabel: q('.hz-live .label'), liveScore: q('.hz-live .score'),
      msg: q('.msg'), msgMain: q('.msg .main'), msgSub: q('.msg .sub'), toasts: q('.hz-toasts'),
      guide: q('.hz-guide'), guideTitle: q('.hz-guide b'), guideText: q('.hz-guide span'), gain: q('.hz-gain'),
    };
    this.regionTimer = 0;
  }

  hide() { this.layer.classList.add('hidden'); }
  layout() { /* single viewport */ }

  popup(main, sub = '') {
    this.q.msgMain.textContent = main; this.q.msgSub.textContent = sub;
    this.q.msg.classList.add('show');
    this.msgTimer = 2.6;
  }

  toast(text) {
    const t = document.createElement('div');
    t.className = 'hz-toast'; t.textContent = text;
    this.q.toasts.appendChild(t);
    while (this.q.toasts.children.length > 4) this.q.toasts.firstChild.remove();
    setTimeout(() => t.classList.add('out'), 1800);
    setTimeout(() => t.remove(), 2300);
  }

  update(dt) {
    const hz = this.hz, car = hz.car, W = hz.world;
    const q = this.q;
    const kmh = Math.round(car.speed * 3.6);
    q.speed.textContent = kmh;
    q.bar.style.width = `${Math.min(100, (car.speed / car.stats.maxSpeed) * 100)}%`;

    this.regionTimer -= dt;
    if (this.regionTimer <= 0) {
      this.regionTimer = 0.5;
      const reg = W.regionAt(car.pos.x, car.pos.z);
      q.region.textContent = reg.name;
      const s = W.samples[car.trackIdx];
      const onRoad = Math.abs(W.lateral(car.pos, car.trackIdx)) < s.hw + 3;
      q.road.textContent = onRoad ? W.roadOf(car.trackIdx).name : (car.offroad ? 'off-road' : '');
      const lv = levelForXp(hz.prog.xp);
      q.level.textContent = lv.level;
      q.xp.style.width = `${Math.round((lv.into / lv.need) * 100)}%`;
      q.money.textContent = `${Math.round(hz.profile.money).toLocaleString()} cr`;
      // the guide banner
      const g = hz.guideText();
      q.guide.classList.toggle('hidden', !g);
      if (g && q.guideTitle.textContent !== g.title) { q.guideTitle.textContent = g.title; q.guideText.textContent = g.text; }
    }
    // a "+N cr" pop beside the wallet whenever money comes in
    const money = Math.round(hz.profile.money);
    if (this.lastMoney !== undefined && money > this.lastMoney) {
      q.gain.textContent = `+${(money - this.lastMoney).toLocaleString()} cr`;
      q.gain.classList.remove('pop'); void q.gain.offsetWidth; q.gain.classList.add('pop');
      q.money.textContent = `${money.toLocaleString()} cr`;
    }
    this.lastMoney = money;

    // Waypoint: turn-by-turn from the GPS route
    if (hz.waypoint) {
      const fmt = (d) => d >= 1000 ? `${(d / 1000).toFixed(1)} km` : `${Math.round(d / 10) * 10} m`;
      const g = hz.routeGuide();
      const total = hz.route ? hz.route.length : Math.hypot(hz.waypoint.x - car.pos.x, hz.waypoint.z - car.pos.z);
      q.wp.classList.remove('hidden');
      const turn = g ? g.turn : 'ahead';
      q.wpTurn.className = `turn t-${turn}`;
      q.wpTurn.textContent = { left: '↰', right: '↱', ahead: '↑', back: '↶', arrive: '◎' }[turn];
      q.wpInstr.textContent = g ? (g.dist > 0 && turn !== 'back' ? `${g.text} · ${fmt(g.dist)}` : g.text) : 'Head to the waypoint';
      q.wpDist.textContent = fmt(total);
      q.wpName.textContent = hz.waypoint.kind === 'custom' ? 'Waypoint' : hz.waypoint.name;
    } else q.wp.classList.add('hidden');

    // Prompt at an event ring, a championship venue or a garage pad
    if (hz.prompt) {
      const e = hz.prompt;
      q.prompt.classList.remove('hidden');
      let html;
      if (e.kind === 'garage') html = `<kbd>Enter</kbd> Open the garage at <b>${e.name}</b> · buy cars, upgrade, paint`;
      else if (e.kind === 'series') {
        const st = hz.seriesStatus(e.series);
        html = st.locked ? `🔒 <b>${e.name}</b> · ${st.text.replace('Locked: ', '')} <span class="meta">(Enter for details)</span>`
          : `<kbd>Enter</kbd> <b>${e.name}</b> · ${st.text}${st.next ? ` · next: ${st.nextName || ''}` : ''}`;
      } else html = `<kbd>Enter</kbd> Start <b>${e.name}</b> · ${e.track.kind === 'stage' ? 'point-to-point stage' : `${e.laps} laps`} · ${e.ai} rivals${hz.prog.events[e.id] ? ` · best P${hz.prog.events[e.id]}` : ''}`;
      if (q.prompt.innerHTML !== html) q.prompt.innerHTML = html;
    } else q.prompt.classList.add('hidden');

    // Live zone score
    if (this.live) { q.live.classList.remove('hidden'); q.liveLabel.textContent = this.live.label; q.liveScore.textContent = this.live.value; }
    else q.live.classList.add('hidden');

    if (this.msgTimer > 0) { this.msgTimer -= dt; if (this.msgTimer <= 0) q.msg.classList.remove('show'); }

    this._drawCompass(car);
    this._drawRadar(car);
  }

  _drawCompass(car) {
    const c = this.q.compass, ctx = c.getContext('2d');
    const w = c.width, h = c.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath(); ctx.roundRect(0, 0, w, h, 8); ctx.fill();
    const pxPerRad = (w / 2) / (Math.PI / 2);
    const wrap = (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };
    const labels = [['S', 0], ['E', Math.PI / 2], ['N', Math.PI], ['W', -Math.PI / 2]];
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let deg = 0; deg < 360; deg += 15) {
      const a = deg * Math.PI / 180;
      const d = wrap(a - car.heading);
      if (Math.abs(d) > Math.PI / 2) continue;
      const x = w / 2 - d * pxPerRad;
      const major = deg % 90 === 0;
      ctx.fillStyle = major ? '#fff' : 'rgba(255,255,255,0.45)';
      ctx.fillRect(x - 1, major ? 4 : h - 10, 2, major ? 8 : 6);
    }
    ctx.font = '800 15px Segoe UI, Arial';
    for (const [l, a] of labels) {
      const d = wrap(a - car.heading);
      if (Math.abs(d) > Math.PI / 2) continue;
      ctx.fillStyle = l === 'N' ? '#ff5a1f' : '#fff';
      ctx.fillText(l, w / 2 - d * pxPerRad, h / 2 + 3);
    }
    if (this.hz.waypoint) {
      const wp = this.hz.waypoint;
      const d = wrap(Math.atan2(wp.x - car.pos.x, wp.z - car.pos.z) - car.heading);
      const x = Math.max(8, Math.min(w - 8, w / 2 - d * pxPerRad));
      ctx.fillStyle = '#ffd23f';
      ctx.beginPath(); ctx.moveTo(x, h - 2); ctx.lineTo(x - 6, h - 10); ctx.lineTo(x + 6, h - 10); ctx.closePath(); ctx.fill();
    }
    ctx.fillStyle = '#ff5a1f'; ctx.fillRect(w / 2 - 1, 0, 2, h);
  }

  /** GTA-style radar: heading-up terrain, roads by class, the GPS route, and markers clamped to the edge. */
  _drawRadar(car) {
    const c = this.q.radar, hz = this.hz, W = hz.world;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = c.clientWidth || 280, ch = c.clientHeight || 190;
    if (c.width !== Math.round(cw * dpr) || c.height !== Math.round(ch * dpr)) { c.width = Math.round(cw * dpr); c.height = Math.round(ch * dpr); }
    const ctx = c.getContext('2d');
    if (!this.terrain) this.terrain = terrainLayer(W);
    // zoom out with speed so there is time to read the junction coming up
    this.radarSpan = (this.radarSpan || RADAR_NEAR) + ((RADAR_NEAR + (RADAR_FAR - RADAR_NEAR) * Math.min(1, car.speed / 55)) - (this.radarSpan || RADAR_NEAR)) * 0.04;
    const sc = ch / this.radarSpan;
    const cx = cw / 2, cy = ch * 0.64;
    const th = car.heading + Math.PI, cos = Math.cos(th), sin = Math.sin(th);
    const toR = (x, z) => { const dx = x - car.pos.x, dz = z - car.pos.z; return { x: cx + (dx * cos - dz * sin) * sc, y: cy + (dx * sin + dz * cos) * sc }; };
    const rad = 14;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.save();
    ctx.beginPath(); ctx.roundRect(1, 1, cw - 2, ch - 2, rad); ctx.clip();
    ctx.fillStyle = 'rgb(38,104,168)'; ctx.fillRect(0, 0, cw, ch);
    // world layer
    ctx.save();
    ctx.translate(cx, cy); ctx.rotate(th); ctx.scale(sc, sc); ctx.translate(-car.pos.x, -car.pos.z);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.terrain, -MAP_EXTENT, -MAP_EXTENT, MAP_EXTENT * 2, MAP_EXTENT * 2);
    const reach = this.radarSpan * 0.95;
    if (Math.abs(car.pos.x - CITY.cx) < 900 && Math.abs(car.pos.z - CITY.cz) < 900) {
      for (const b of W.buildings) {
        if (Math.abs(b.x - car.pos.x) > reach || Math.abs(b.z - car.pos.z) > reach) continue;
        ctx.save(); ctx.translate(b.x, b.z); ctx.rotate(-b.rot);
        ctx.fillStyle = '#a9adb8'; ctx.fillRect(-b.hw, -b.hd, b.w, b.d);
        ctx.restore();
      }
    }
    drawPropFootprints(ctx, W.props, { x0: car.pos.x - reach, z0: car.pos.z - reach, x1: car.pos.x + reach, z1: car.pos.z + reach }, sc);
    // roads from the grid cells in reach, batched by class
    const cell = W.cell, R = Math.ceil(reach / cell);
    const gx = Math.floor(car.pos.x / cell), gz = Math.floor(car.pos.z / cell);
    const segs = Object.fromEntries(RADAR_KINDS.map(k => [k, []]));
    for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) {
      const list = W.grid.get(`${gx + dx},${gz + dz}`);
      if (!list) continue;
      for (const i of list) {
        const s = W.samples[i];
        if (s.li % 2) continue;
        const road = W.roads[s.road];
        const j = W.roadWrap(road, i + 2);
        if (j < 0) continue;
        segs[road.kind].push(s.p, W.samples[j].p);
      }
    }
    ctx.lineCap = 'round';
    for (const pass of ['casing', 'fill']) for (const kind of RADAR_KINDS) {
      const list = segs[kind];
      if (!list.length) continue;
      const st = ROAD_STYLE[kind];
      const wpx = Math.max(st.min * 1.2, { highway: 20, road: 14, street: 13, lane: 10, dirt: 9 }[kind] * sc);
      ctx.lineWidth = (pass === 'casing' ? wpx + 2.4 : wpx) / sc;
      ctx.strokeStyle = pass === 'casing' ? st.casing : st.fill;
      ctx.beginPath();
      for (let k = 0; k < list.length; k += 2) { ctx.moveTo(list[k].x, list[k].z); ctx.lineTo(list[k + 1].x, list[k + 1].z); }
      ctx.stroke();
    }
    // GPS route
    if (hz.routeIdx && hz.routeIdx.length > 1) {
      ctx.lineJoin = 'round';
      ctx.beginPath();
      let pen = false;
      for (const i of hz.routeIdx) {
        const p = W.samples[i].p;
        const near = Math.abs(p.x - car.pos.x) < reach * 1.3 && Math.abs(p.z - car.pos.z) < reach * 1.3;
        if (!near) { pen = false; continue; }
        if (pen) ctx.lineTo(p.x, p.z); else { ctx.moveTo(p.x, p.z); pen = true; }
      }
      ctx.strokeStyle = 'rgba(30,8,48,0.7)'; ctx.lineWidth = 8.5 / sc; ctx.stroke();
      ctx.strokeStyle = ROUTE_COLOR; ctx.lineWidth = 5.5 / sc; ctx.stroke();
    }
    ctx.restore();

    // markers (screen space so icons stay upright)
    const inset = 12;
    const inside = (p, m = 0) => p.x > m && p.y > m && p.x < cw - m && p.y < ch - m;
    for (const b of W.boards) {
      if (!hz.boardMeshes.has(b.id)) continue;
      const p = toR(b.x, b.z);
      if (inside(p, 4)) drawMarkerIcon(ctx, p.x, p.y, b, {}, 5);
    }
    for (const t of hz.traffic.cars) {
      const p = toR(t.pos.x, t.pos.z);
      if (!inside(p)) continue;
      ctx.fillStyle = 'rgba(255,255,255,0.95)'; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(p.x, p.y, 2.6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    for (const m of W.markers) {
      const p = toR(m.x, m.z);
      const done = m.kind === 'event' ? !!hz.prog.events[m.id] : false;
      if (inside(p, 6)) drawMarkerIcon(ctx, p.x, p.y, m, { done, locked: m.kind !== 'hub' && !hz.prog.discovered.includes(m.id) }, 7.5);
      else if (m.kind === 'event' || m.kind === 'hub' || m.kind === 'series' || m.kind === 'garage') {
        // nearby events peek in at the edge, like the games' radar blips
        const d = Math.hypot(m.x - car.pos.x, m.z - car.pos.z);
        if (d < this.radarSpan * 1.6) { const e = this._edge(cx, cy, p, cw, ch, inset); ctx.globalAlpha = 0.75; drawMarkerIcon(ctx, e.x, e.y, m, {}, 5.5); ctx.globalAlpha = 1; }
      }
    }
    // waypoint: pin, or clamped to the edge with its distance
    if (hz.waypoint) {
      const wp = hz.waypoint, p = toR(wp.x, wp.z);
      if (inside(p, 8)) drawPin(ctx, p.x, p.y, 6, MARKER_COLORS.custom);
      else {
        const e = this._edge(cx, cy, p, cw, ch, inset + 2);
        ctx.fillStyle = MARKER_COLORS.custom; ctx.strokeStyle = '#2a2000'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(e.x, e.y, 6.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#2a2000'; ctx.beginPath(); ctx.arc(e.x, e.y, 2.4, 0, Math.PI * 2); ctx.fill();
      }
    }
    drawPlayerArrow(ctx, cx, cy, 0, 8);
    // north marker on the rim
    const nP = toR(car.pos.x, car.pos.z - 10000), nE = this._edge(cx, cy, nP, cw, ch, 11);
    ctx.fillStyle = 'rgba(10,14,22,0.85)'; ctx.beginPath(); ctx.arc(nE.x, nE.y, 8, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ff5a1f'; ctx.font = '900 10px Segoe UI, Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('N', nE.x, nE.y + 0.5);
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect(1, 1, cw - 2, ch - 2, rad); ctx.stroke();
  }

  /** Where the ray from (cx, cy) toward p leaves the radar rectangle (inset by m). */
  _edge(cx, cy, p, w, h, m) {
    const dx = p.x - cx, dy = p.y - cy;
    let t = Infinity;
    if (dx > 0) t = Math.min(t, (w - m - cx) / dx); else if (dx < 0) t = Math.min(t, (m - cx) / dx);
    if (dy > 0) t = Math.min(t, (h - m - cy) / dy); else if (dy < 0) t = Math.min(t, (m - cy) / dy);
    if (!isFinite(t)) t = 0;
    t = Math.min(1, t);
    return { x: cx + dx * t, y: cy + dy * t };
  }

  dispose() {
    this.layer.classList.add('hidden');
    this.center.innerHTML = '';
    this.el.innerHTML = '';
  }
}
