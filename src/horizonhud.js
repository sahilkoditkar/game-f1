// Free Roam HUD: speed, compass, radar minimap, waypoint, event prompt,
// live drift/speed-zone score, XP, and popups/toasts for skills and discoveries.
import { levelForXp } from './worlddef.js';

const RADAR_M = 380;   // metres shown across the radar

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
        <div class="hz-mode">FREE ROAM</div>
        <div class="hz-region">—</div>
        <div class="hz-road"></div>
      </div>
      <canvas class="hz-compass" width="440" height="36"></canvas>
      <div class="hz-top-right">
        <div class="hz-level">LEVEL <b>1</b></div>
        <div class="hz-xpbar"><i style="width:0%"></i></div>
        <div class="hz-money">0 cr</div>
      </div>
      <div class="bottom-right hz-br">
        <div class="speed"><b>0</b><small>km/h</small></div>
        <div class="gear-bar"><i style="width:0%"></i></div>
      </div>
      <canvas class="hz-radar" width="240" height="240"></canvas>
      <div class="hz-waypoint hidden"><span class="arrow">➤</span><b></b><span class="name"></span></div>
      <div class="hz-prompt hidden"></div>
      <div class="hz-live hidden"><div class="label"></div><div class="score"></div></div>
      <div class="msg"><span class="main"></span><span class="sub"></span></div>
      <div class="hz-toasts"></div>
      <button class="hz-mapbtn">MAP</button>
      <div class="hz-hint"><kbd>M</kbd> map · <kbd>Enter</kbd> start event · <kbd>R</kbd> back to road · <kbd>Esc</kbd> pause</div>`;
    // Touch and mouse: tapping the prompt starts the event, the MAP button opens the map.
    this.el.querySelector('.hz-prompt').addEventListener('click', () => { if (this.hz.prompt && this.hz.promptCooldown <= 0) this.hz.onEvent(this.hz.prompt); });
    this.el.querySelector('.hz-mapbtn').addEventListener('click', () => { this.hz.requestMap = true; });
    const q = (s) => this.el.querySelector(s);
    this.q = {
      region: q('.hz-region'), road: q('.hz-road'), compass: q('.hz-compass'), level: q('.hz-level b'), xp: q('.hz-xpbar i'), money: q('.hz-money'),
      speed: q('.speed b'), bar: q('.gear-bar i'), radar: q('.hz-radar'), wp: q('.hz-waypoint'), wpArrow: q('.hz-waypoint .arrow'), wpDist: q('.hz-waypoint b'), wpName: q('.hz-waypoint .name'),
      prompt: q('.hz-prompt'), live: q('.hz-live'), liveLabel: q('.hz-live .label'), liveScore: q('.hz-live .score'),
      msg: q('.msg'), msgMain: q('.msg .main'), msgSub: q('.msg .sub'), toasts: q('.hz-toasts'),
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
    }

    // Waypoint
    if (hz.waypoint) {
      const dx = hz.waypoint.x - car.pos.x, dz = hz.waypoint.z - car.pos.z;
      const d = Math.hypot(dx, dz);
      let rel = Math.atan2(dx, dz) - car.heading;
      while (rel > Math.PI) rel -= Math.PI * 2;
      while (rel < -Math.PI) rel += Math.PI * 2;
      q.wp.classList.remove('hidden');
      q.wpArrow.style.transform = `rotate(${(-rel * 180 / Math.PI) - 90}deg)`;
      q.wpDist.textContent = d >= 1000 ? `${(d / 1000).toFixed(1)} km` : `${Math.round(d)} m`;
      q.wpName.textContent = hz.waypoint.name;
    } else q.wp.classList.add('hidden');

    // Event prompt
    if (hz.prompt) {
      const e = hz.prompt;
      q.prompt.classList.remove('hidden');
      q.prompt.innerHTML = `<kbd>Enter</kbd> Start <b>${e.name}</b> · ${e.track.kind === 'stage' ? 'point-to-point stage' : `${e.laps} laps`} · ${e.ai} rivals${hz.prog.events[e.id] ? ` · best P${hz.prog.events[e.id]}` : ''}`;
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

  _drawRadar(car) {
    const c = this.q.radar, ctx = c.getContext('2d');
    const size = c.width, half = size / 2;
    const sc = size / RADAR_M;
    const W = this.hz.world;
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.beginPath(); ctx.arc(half, half, half - 2, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = 'rgba(10,14,22,0.55)'; ctx.fillRect(0, 0, size, size);
    ctx.translate(half, half);
    ctx.rotate(car.heading + Math.PI);
    ctx.scale(sc, sc);
    ctx.translate(-car.pos.x, -car.pos.z);
    // roads from the grid cells around the player
    const cell = W.cell, R = Math.ceil((RADAR_M * 0.75) / cell);
    const cx = Math.floor(car.pos.x / cell), cz = Math.floor(car.pos.z / cell);
    ctx.lineCap = 'round';
    for (let pass = 0; pass < 2; pass++) {
      ctx.strokeStyle = pass === 0 ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.85)';
      ctx.beginPath();
      for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) {
        const list = W.grid.get(`${cx + dx},${cz + dz}`);
        if (!list) continue;
        for (const i of list) {
          const s = W.samples[i];
          if (s.li % 2) continue;
          const road = W.roads[s.road];
          const j = W.roadWrap(road, i + 2);
          if (j < 0) continue;
          const o = W.samples[j];
          ctx.lineWidth = (s.hw * 2) + (pass === 0 ? 4 : 0);
          ctx.moveTo(s.p.x, s.p.z); ctx.lineTo(o.p.x, o.p.z);
        }
      }
      ctx.stroke();
    }
    // markers
    const col = { hub: '#ffd23f', event: '#ff5a1f', trap: '#2f7bff', drift: '#b04cff', zone: '#00d4ff' };
    for (const m of W.markers) {
      const dx = m.x - car.pos.x, dz = m.z - car.pos.z;
      if (dx * dx + dz * dz > (RADAR_M * 0.8) ** 2) continue;
      ctx.fillStyle = m.kind === 'event' && m.track.kind === 'stage' ? '#3ddc84' : col[m.kind];
      ctx.beginPath(); ctx.arc(m.x, m.z, 7, 0, Math.PI * 2); ctx.fill();
    }
    for (const b of W.boards) {
      if (!this.hz.boardMeshes.has(b.id)) continue;
      const dx = b.x - car.pos.x, dz = b.z - car.pos.z;
      if (dx * dx + dz * dz > (RADAR_M * 0.8) ** 2) continue;
      ctx.fillStyle = '#3ddc84'; ctx.fillRect(b.x - 4, b.z - 4, 8, 8);
    }
    ctx.restore();
    // waypoint edge indicator
    if (this.hz.waypoint) {
      const wp = this.hz.waypoint;
      const dx = wp.x - car.pos.x, dz = wp.z - car.pos.z;
      const d = Math.hypot(dx, dz);
      let rel = Math.atan2(dx, dz) - car.heading;   // >0 = target to the left
      const r = Math.min(half - 10, d * sc);
      const x = half - Math.sin(rel) * r, y = half - Math.cos(rel) * r;
      ctx.fillStyle = '#ffd23f'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x, y - 7); ctx.lineTo(x + 6, y); ctx.lineTo(x, y + 7); ctx.lineTo(x - 6, y); ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    // player
    ctx.fillStyle = '#ff5a1f'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(half, half - 9); ctx.lineTo(half + 6, half + 7); ctx.lineTo(half, half + 3); ctx.lineTo(half - 6, half + 7); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(half, half, half - 2, 0, Math.PI * 2); ctx.stroke();
  }

  dispose() {
    this.layer.classList.add('hidden');
    this.center.innerHTML = '';
    this.el.innerHTML = '';
  }
}
