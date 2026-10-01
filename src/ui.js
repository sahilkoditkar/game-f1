import { TRACKS, getTrack } from './tracks.js';
import { CARS, SERIES, UPGRADES, PLAYER_COLORS, getCar, getSeries, upgradeCost, effectiveStats } from './data.js';
import { listControls, getControl, connectedPads, gamepadDiagnostics } from './input.js';
import { seriesState, isSeriesUnlocked, standings, canBuyUpgrade } from './career.js';
import { fmtTime } from './race.js';

const hex = (c) => '#' + c.toString(16).padStart(6, '0');
const money = (n) => `${Math.round(n).toLocaleString()} cr`;
const ORD = (n) => n + (['th', 'st', 'nd', 'rd'][((n % 100) - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');

export class UI {
  constructor(app) {
    this.app = app;
    this.el = document.getElementById('screen');
    this.rerender = null; // re-render function for screens that show a controls chooser
    window.addEventListener('controls-changed', (e) => {
      const pads = e.detail || [];
      if (this._padCount !== undefined && pads.length !== this._padCount) {
        this.toast(pads.length > this._padCount ? `🎮 ${pads[pads.length - 1].name} connected` : 'Gamepad disconnected');
      }
      this._padCount = pads.length;
      if (this.rerender && !this.el.classList.contains('empty')) this.rerender();
    });
  }

  hide() { this.el.innerHTML = ''; this.el.classList.add('empty'); this.rerender = null; this.mapOpen = false; }

  show(html, { transparent = false } = {}) {
    this.el.classList.remove('empty');
    this.el.classList.toggle('transparent', transparent);
    this.el.innerHTML = html;
    this.el.querySelectorAll('button').forEach(b => b.addEventListener('click', () => this.app.audio.click()));
  }

  on(selector, event, fn) {
    this.el.querySelectorAll(selector).forEach(el => el.addEventListener(event, (e) => fn(e, el)));
  }

  toast(msg, ms = 2200) {
    const t = document.createElement('div');
    t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  // ------------------------------------------------------------ Main menu
  mainMenu() {
    const p = this.app.profile;
    this.rerender = null;
    this.show(`
      <div class="panel narrow">
        <div class="logo">APEX <span>RUSH</span></div>
        <div class="tagline">3D arcade racing · split screen · career</div>
        <div class="menu">
          <button class="primary" data-go="career">Career <span class="hint" style="color:#fff;opacity:.85">${money(p.money)}</span></button>
          <button data-go="horizon" class="roam">Free Roam <span class="badge gold">new</span><span class="hint">Open world · events, speed traps, drift zones</span></button>
          <button data-go="quick">Quick Race <span class="hint">Single player vs AI</span></button>
          <button data-go="split">Split Screen <span class="hint">2 players, one screen</span></button>
          <button data-go="timetrial">Time Trial <span class="hint">Beat your best laps</span></button>
          <button data-go="settings">Settings &amp; Controls</button>
        </div>
        <div class="footer-note">
          <div class="keys-row"><span>Player 1</span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd><span>steer</span><kbd>Shift</kbd><span>drift</span></div>
          <div class="keys-row"><span>Player 2</span><kbd>↑</kbd><kbd>←</kbd><kbd>↓</kbd><kbd>→</kbd><span>steer</span><kbd>R-Shift</kbd><span>drift</span></div>
          <div class="keys-row"><span>Any</span><kbd>Esc</kbd><span>pause</span><kbd>R</kbd><span>reset</span><span>· gamepads and touch supported</span></div>
        </div>
      </div>`);
    this.on('[data-go]', 'click', (e, el) => {
      const go = el.dataset.go;
      if (go === 'career') this.career();
      else if (go === 'horizon') this.horizonIntro();
      else if (go === 'settings') this.settings();
      else this.raceSetup(go);
    });
  }

  // ------------------------------------------------------------ Race setup
  raceSetup(mode) {
    const app = this.app;
    const p = app.profile;
    const st = app.setup = app.setup || {
      trackId: 'sunrise', laps: 3, aiCount: 5, difficulty: 1,
      players: [
        { name: 'Player 1', carId: 'hatch', colorIndex: 0, control: p.settings.p1Control || 'wasd' },
        { name: 'Player 2', carId: 'gt', colorIndex: 1, control: p.settings.p2Control || 'arrows' },
      ],
    };
    st.mode = mode;
    const nPlayers = mode === 'split' ? 2 : 1;
    const title = { quick: 'Quick Race', split: 'Split Screen', timetrial: 'Time Trial' }[mode];
    const render = () => {
      const tr = getTrack(st.trackId);
      this.show(`
        <div class="panel">
          <div class="row between"><h2>${title}</h2><button class="small ghost" data-back>← Back</button></div>
          ${this._trackSection('Real-world circuits', 'Layouts inspired by famous tracks, with their elevation changes', TRACKS.filter(t => t.kind === 'real'), st.trackId)}
          ${this._trackSection('Original circuits', 'Fictional tracks designed for this game', TRACKS.filter(t => t.kind === 'original'), st.trackId)}
          ${this._trackSection('Point-to-point stages', 'Long one-way runs: start to finish, no laps', TRACKS.filter(t => t.kind === 'stage'), st.trackId)}
          <div class="grid-2" style="margin-top:16px">
            ${tr.open ? `<div class="field"><label>Stage</label><div>Single run, start to finish · ${tr.lengthKm ? tr.lengthKm + ' km' : 'long'}</div></div>` : `<div class="field"><label>Laps: <b id="lapsv">${st.laps}</b></label><input type="range" min="1" max="10" value="${st.laps}" data-field="laps"></div>`}
            ${mode !== 'timetrial' ? `
            <div class="field"><label>AI opponents: <b id="aiv">${st.aiCount}</b></label><input type="range" min="0" max="11" value="${st.aiCount}" data-field="aiCount"></div>
            <div class="field"><label>AI difficulty</label><div class="chips">
              ${['Easy', 'Medium', 'Hard', 'Dynamic'].map((d, i) => `<div class="chip ${st.difficulty === i ? 'active' : ''}" data-diff="${i}">${d}</div>`).join('')}
            </div><div class="meta" style="margin-top:6px">${['Club-level opponents.', 'Quick, consistent drivers.', 'Elite pace, no mistakes.', 'The AI reads your pace in real time and races around you: a couple just ahead, most just behind. Works on stages too.'][st.difficulty]}</div></div>` : `<div class="field"><label>Best lap here</label><div>${this._bestLapLine(tr.id)}</div><div class="meta" style="margin-top:6px">Your best lap is replayed as a ghost car. Beat it to record a new one.</div></div>`}
          </div>
          <div class="grid-2">
            ${st.players.slice(0, nPlayers).map((pl, i) => `
              <div class="card">
                <h4>${nPlayers > 1 ? `Player ${i + 1}` : 'Your car'}</h4>
                <div class="field"><label>Name</label><input type="text" maxlength="14" value="${pl.name}" data-name="${i}"></div>
                <div class="field"><label>Controls</label>${this._controlChips(pl.control, `data-control="${i}"`, i)}</div>
                <div class="field"><label>Car</label><select data-car="${i}">${CARS.map(c => `<option value="${c.id}" ${c.id === pl.carId ? 'selected' : ''}>${c.name}</option>`).join('')}</select></div>
                ${this._statBars(effectiveStats(getCar(pl.carId), { engine: 2, tires: 2, brakes: 2, aero: 2 }))}
                <div class="field"><label>Colour</label><div class="chips">${PLAYER_COLORS.map((c, ci) => `<div class="swatch ${pl.colorIndex === ci ? 'active' : ''}" data-color="${i}:${ci}" style="background:${hex(c)}"></div>`).join('')}</div></div>
              </div>`).join('')}
          </div>
          <div class="row end" style="margin-top:18px"><button class="primary" data-start style="min-width:220px">Start Race</button></div>
        </div>`);
      this.on('[data-back]', 'click', () => this.mainMenu());
      this.on('[data-track]', 'click', (e, el) => { st.trackId = el.dataset.track; render(); });
      this.on('[data-field]', 'input', (e, el) => { st[el.dataset.field] = parseInt(el.value, 10); const v = document.getElementById(el.dataset.field === 'laps' ? 'lapsv' : 'aiv'); if (v) v.textContent = el.value; });
      this.on('[data-diff]', 'click', (e, el) => { st.difficulty = parseInt(el.dataset.diff, 10); render(); });
      this.on('[data-name]', 'input', (e, el) => { st.players[+el.dataset.name].name = el.value.trim() || `Player ${+el.dataset.name + 1}`; });
      this.on('[data-car]', 'change', (e, el) => { st.players[+el.dataset.car].carId = el.value; render(); });
      this.on('[data-control]', 'click', (e, el) => {
        if (el.classList.contains('disabled')) return;
        const i = +el.dataset.control, id = el.dataset.id;
        const other = st.players[1 - i];
        if (other && other.control === id && nPlayers > 1) other.control = st.players[i].control; // swap
        st.players[i].control = id;
        p.settings[i === 0 ? 'p1Control' : 'p2Control'] = id; app.save();
        render();
      });
      this.on('[data-color]', 'click', (e, el) => { const [i, ci] = el.dataset.color.split(':').map(Number); st.players[i].colorIndex = ci; render(); });
      this.on('[data-start]', 'click', () => app.startQuickRace(mode));
      this.rerender = render;
    };
    render();
  }

  _trackSection(title, sub, tracks, selectedId) {
    return `<h3>${title} <span class="meta" style="text-transform:none;letter-spacing:0;font-weight:400">· ${sub}</span></h3>
      <div class="grid-3">
        ${tracks.map(t => `<div class="card ${t.id === selectedId ? 'selected' : ''}" data-track="${t.id}" style="cursor:pointer">
          <h4>${t.name}</h4><div class="meta">${t.desc}</div>
          <div class="meta" style="margin-top:6px">${'★'.repeat(t.difficulty)}${'☆'.repeat(4 - t.difficulty)} · ${t.theme}${t.lengthKm ? ' · ' + t.lengthKm + ' km' : ''}${t.kind === 'real' ? ' · <span class="badge">real</span>' : t.kind === 'stage' ? ' · <span class="badge done">stage</span>' : ' · <span class="badge" style="opacity:.7">original</span>'}</div></div>`).join('')}
      </div>`;
  }

  _controlChips(current, attr, playerIndex = 0) {
    const touch = this.app.input.isTouchDevice;
    const list = listControls().filter(c => !c.touchOnly || (touch && playerIndex === 0));
    const pads = connectedPads();
    const selectedMissing = /^pad\d+$/.test(current || '') && !list.some(c => c.id === current);
    const chips = list.map(c => `<div class="chip ${current === c.id ? 'active' : ''}" ${attr} data-id="${c.id}" title="${c.keys}">${c.name}${c.sub ? ` <span class="badge done">${c.sub}</span>` : ''}</div>`);
    if (selectedMissing) chips.push(`<div class="chip active" ${attr} data-id="${current}" title="Reconnect the controller">🎮 ${getControl(current).name} <span class="badge locked">disconnected</span></div>`);
    const hint = pads.length === 0
      ? '<div class="meta" style="margin-top:6px">No gamepad detected. Plug one in and press any button on it; it will appear here.</div>'
      : `<div class="meta" style="margin-top:6px">${pads.length} gamepad${pads.length > 1 ? 's' : ''} detected.</div>`;
    return `<div class="chips">${chips.join('')}</div>${hint}`;
  }

  _bestLapLine(trackId) {
    const bl = this.app.profile.bestLaps;
    const entries = Object.entries(bl).filter(([k]) => k.startsWith(trackId + ':'));
    if (!entries.length) return '<span class="meta">No time set yet</span>';
    return entries.map(([k, t]) => `<div>${getCar(k.split(':')[1]).name}: <b>${fmtTime(t)}</b></div>`).join('');
  }

  _statBars(s) {
    const rows = [['Top speed', s.maxSpeed / 95], ['Acceleration', s.accel / 32], ['Grip', s.grip / 12.5], ['Braking', s.brake / 62]];
    return rows.map(([n, v]) => `<div class="stat-row"><span>${n}</span><span>${Math.round(v * 100)}</span></div><div class="stat-bar"><i style="width:${Math.min(100, v * 100)}%"></i></div>`).join('');
  }

  // ------------------------------------------------------------ Career hub
  career() {
    const app = this.app, p = app.profile;
    const car = getCar(p.selected);
    const current = SERIES.find(s => isSeriesUnlocked(p, s) && !seriesState(p, s.id).complete) || null;
    this.show(`
      <div class="panel">
        <div class="row between">
          <div><h2 style="margin:0">Career</h2><div class="meta" style="color:var(--muted)">${p.stats.races} races · ${p.stats.wins} wins · ${p.stats.podiums} podiums</div></div>
          <div style="text-align:right"><div class="money" style="font-size:26px">${money(p.money)}</div><div class="meta" style="color:var(--muted)">Driving: ${car.name}</div></div>
        </div>
        <div class="row" style="margin:14px 0">
          <button data-garage>🔧 Garage <span class="hint">Buy cars &amp; upgrades</span></button>
          <button data-back class="ghost">← Main menu</button>
        </div>
        <div class="field"><label>Your controls</label>${this._controlChips(p.settings.p1Control || 'wasd', 'data-ctl="1"', 0)}</div>
        <h3>Championships</h3>
        <div class="menu">
          ${SERIES.map(s => {
            const st = seriesState(p, s.id);
            const unlocked = isSeriesUnlocked(p, s);
            const rows = standings(p, s.id);
            const myRank = rows.findIndex(r => r.isPlayer) + 1;
            const badge = !unlocked ? `<span class="badge locked">Locked · finish ${ORD(s.requireRank)} or better in ${getSeries(s.requires).name}</span>`
              : st.complete ? `<span class="badge ${st.finalRank === 1 ? 'gold' : 'done'}">${st.finalRank === 1 ? '🏆 Champion' : 'Finished ' + ORD(st.finalRank)}</span>`
              : st.event > 0 ? `<span class="badge">Round ${st.event + 1}/${s.events.length} · ${myRank ? ORD(myRank) + ' in standings' : ''}</span>` : `<span class="badge">Not started</span>`;
            const next = !st.complete && unlocked ? s.events[st.event] : null;
            return `<div class="card ${current && current.id === s.id ? 'selected' : ''}">
              <div class="row between">
                <div><h4>${s.name} ${badge}</h4><div class="meta">${s.desc}</div>
                  <div class="meta" style="margin-top:6px">${s.aiCount} opponents · ${s.events.length} rounds · prize up to ${money(s.prize[0])}/race · title bonus ${money(s.bonus)}</div>
                  <div class="progress" style="margin-top:8px;max-width:320px"><i style="width:${(st.event / s.events.length) * 100}%"></i></div>
                </div>
                <div class="menu" style="min-width:200px">
                  ${next ? `<button class="primary" data-race="${s.id}">Race: ${getTrack(next.track).name}<br><small style="opacity:.8;font-weight:400">${next.laps} laps</small></button>` : ''}
                  ${unlocked && st.event > 0 ? `<button class="small" data-standings="${s.id}">Standings</button>` : ''}
                  ${st.complete ? `<button class="small" data-restart="${s.id}">Replay series</button>` : ''}
                </div>
              </div>
              <div class="standings-box" id="stand-${s.id}"></div>
            </div>`;
          }).join('')}
        </div>
      </div>`);
    this.rerender = () => this.career();
    this.on('[data-back]', 'click', () => this.mainMenu());
    this.on('[data-garage]', 'click', () => this.garage());
    this.on('[data-ctl]', 'click', (e, el) => { p.settings.p1Control = el.dataset.id; app.save(); this.career(); });
    this.on('[data-race]', 'click', (e, el) => app.startCareerRace(el.dataset.race));
    this.on('[data-restart]', 'click', (e, el) => { if (confirm('Replay this series from round 1? Standings will be reset (your credits and cars are kept).')) { app.restartSeries(el.dataset.restart); this.career(); } });
    this.on('[data-standings]', 'click', (e, el) => {
      const box = document.getElementById(`stand-${el.dataset.standings}`);
      box.innerHTML = box.innerHTML ? '' : this._standingsTable(el.dataset.standings);
    });
  }

  _standingsTable(seriesId, limit = 12) {
    const rows = standings(this.app.profile, seriesId).slice(0, limit);
    return `<table style="margin-top:12px"><tr><th>#</th><th>Driver</th><th class="num">Points</th></tr>
      ${rows.map((r, i) => `<tr class="${r.isPlayer ? 'you' : ''}"><td>${i + 1}</td><td>${r.name}</td><td class="num">${r.points}</td></tr>`).join('')}</table>`;
  }

  // ------------------------------------------------------------ Garage
  garage() {
    const app = this.app, p = app.profile;
    this.rerender = null;
    const sel = getCar(p.selected);
    const lv = p.upgrades[sel.id] || {};
    this.show(`
      <div class="panel">
        <div class="row between"><h2>Garage</h2><div class="money" style="font-size:24px">${money(p.money)}</div></div>
        <h3>Cars</h3>
        <div class="grid-2">
          ${CARS.map(c => {
            const owned = p.cars.includes(c.id);
            return `<div class="card ${c.id === p.selected ? 'selected' : ''}">
              <div class="row between"><h4>${c.name}</h4>${owned ? (c.id === p.selected ? '<span class="badge gold">Selected</span>' : '<span class="badge done">Owned</span>') : `<span class="badge">${money(c.price)}</span>`}</div>
              <div class="meta" style="margin-bottom:8px">${c.desc}</div>
              ${this._statBars(effectiveStats(c, p.upgrades[c.id] || {}))}
              <div class="row end" style="margin-top:8px">
                ${owned && c.id !== p.selected ? `<button class="small" data-select="${c.id}">Select</button>` : ''}
                ${!owned ? `<button class="small primary" data-buy="${c.id}" ${p.money < c.price ? 'disabled' : ''}>Buy · ${money(c.price)}</button>` : ''}
              </div></div>`;
          }).join('')}
        </div>
        <h3>Upgrades — ${sel.name}</h3>
        <div class="grid-2">
          ${UPGRADES.map(u => {
            const lvl = lv[u.id] || 0;
            const r = canBuyUpgrade(p, sel.id, u.id);
            return `<div class="card"><div class="row between"><h4>${u.name} <span class="badge">Lv ${lvl}/${u.maxLevel}</span></h4>
              ${r.reason === 'MAX' ? '<span class="badge gold">MAX</span>' : `<button class="small primary" data-up="${u.id}" ${r.ok ? '' : 'disabled'}>Upgrade · ${money(r.cost)}</button>`}</div>
              <div class="meta">${u.desc}</div>
              <div class="stat-bar" style="margin-top:8px"><i style="width:${(lvl / u.maxLevel) * 100}%"></i></div></div>`;
          }).join('')}
        </div>
        <div class="row end" style="margin-top:16px"><button data-back>← Back to career</button></div>
      </div>`);
    this.on('[data-back]', 'click', () => this.career());
    this.on('[data-select]', 'click', (e, el) => { p.selected = el.dataset.select; app.save(); this.garage(); });
    this.on('[data-buy]', 'click', (e, el) => { if (app.buyCar(el.dataset.buy)) { this.toast(`Bought ${getCar(el.dataset.buy).name}!`); } this.garage(); });
    this.on('[data-up]', 'click', (e, el) => { if (app.buyUpgrade(sel.id, el.dataset.up)) this.toast('Upgrade installed'); this.garage(); });
  }

  // ------------------------------------------------------------ Settings
  settings() {
    const app = this.app, s = app.profile.settings;
    const keyRow = (label, keys) => `<tr><td>${label}</td><td>${keys.map(k => `<kbd>${k}</kbd>`).join(' ')}</td></tr>`;
    this.show(`
      <div class="panel">
        <div class="row between"><h2>Settings</h2><button class="small ghost" data-back>← Back</button></div>
        <div class="grid-2">
          <div>
            <div class="field"><label>Graphics quality</label><div class="chips">
              <div class="chip ${s.quality === 'high' ? 'active' : ''}" data-q="high">High (shadows)</div>
              <div class="chip ${s.quality === 'low' ? 'active' : ''}" data-q="low">Low (fast)</div></div></div>
            <div class="field"><label>Sound: ${s.sound ? 'on' : 'off'}</label><div class="chips">
              <div class="chip ${s.sound ? 'active' : ''}" data-sound="1">On</div><div class="chip ${!s.sound ? 'active' : ''}" data-sound="0">Off</div></div></div>
            <div class="field"><label>Volume</label><input type="range" min="0" max="1" step="0.05" value="${s.volume}" data-vol></div>
            <div class="field"><label>Player 1 controls (default)</label>${this._controlChips(s.p1Control || 'wasd', 'data-ctl="p1Control"', 0)}</div>
            <div class="field"><label>Player 2 controls (default)</label>${this._controlChips(s.p2Control || 'arrows', 'data-ctl="p2Control"', 1)}</div>
            <button class="small" data-fullscreen>Toggle fullscreen</button>
          </div>
          <div>
            <h3>Controls</h3>
            <table class="controls-table">
              ${keyRow('Accelerate', ['W', '↑', 'Pad: RT / A'])}
              ${keyRow('Brake / reverse', ['S', '↓', 'Pad: LT / X'])}
              ${keyRow('Steer', ['A', 'D', '←', '→', 'Pad: left stick'])}
              ${keyRow('Handbrake (drift)', ['Shift', 'Space', 'R-Shift', 'R-Ctrl', 'Pad: B / RB'])}
              ${keyRow('Reset to track', ['R', '.', 'Pad: Y'])}
              ${keyRow('Pause', ['Esc', 'Pad: Start'])}
            </table>
            <p>Gamepad 1 drives Player 1, gamepad 2 drives Player 2. Keyboard always works too.</p>
            <h3>Controller test</h3>
            <div id="pad-diag" class="card" style="font-size:13px"></div>
            <h3>Save data</h3>
            <button class="small" data-reset style="border-color:var(--bad);color:var(--bad)">Reset career progress</button>
          </div>
        </div>
      </div>`);
    this.rerender = () => this.settings();
    this._startPadDiag();
    this.on('[data-back]', 'click', () => this.mainMenu());
    this.on('[data-q]', 'click', (e, el) => { s.quality = el.dataset.q; app.save(); this.settings(); });
    this.on('[data-sound]', 'click', (e, el) => { s.sound = el.dataset.sound === '1'; app.audio.setEnabled(s.sound); app.save(); this.settings(); });
    this.on('[data-vol]', 'input', (e, el) => { s.volume = parseFloat(el.value); app.audio.setVolume(s.volume); app.save(); });
    this.on('[data-ctl]', 'click', (e, el) => { s[el.dataset.ctl] = el.dataset.id; if (app.setup) { app.setup.players[0].control = s.p1Control; app.setup.players[1].control = s.p2Control; } app.save(); this.settings(); });
    this.on('[data-fullscreen]', 'click', () => app.toggleFullscreen());
    this.on('[data-reset]', 'click', () => { if (confirm('Delete all career progress, cars and best laps?')) { app.resetProfile(); this.toast('Progress reset'); this.settings(); } });
  }

  /** Live gamepad readout on the settings screen; stops itself when the panel goes away. */
  _startPadDiag() {
    clearInterval(this._padDiagTimer);
    const render = () => {
      const box = document.getElementById('pad-diag');
      if (!box) { clearInterval(this._padDiagTimer); return; }
      const d = gamepadDiagnostics();
      const pads = d.pads.filter(Boolean);
      let html = `<div class="meta">Gamepad API: <b>${d.supported ? 'available' : 'NOT available'}</b> · secure context: <b>${d.secure ? 'yes' : 'no'}</b> · page focused: <b>${d.focused ? 'yes' : 'no'}</b> · slots: ${d.pads.length}</div>`;
      if (!pads.length) {
        html += `<div style="margin-top:8px">No controller reported by the browser.</div>
          <div class="meta" style="margin-top:6px">Browsers hide controllers until you press a button on them while this tab is focused. Click anywhere on this page, then press A / X or a trigger. If nothing appears after that, the browser itself doesn't see the controller: check it works in another app, try a different USB port or cable, or a different browser.</div>`;
      } else {
        for (const p of pads) {
          const pressed = p.buttons.map((b, i) => b ? `B${i}${b === 1 ? '' : ':' + b}` : null).filter(Boolean).join(' ') || '—';
          html += `<div style="margin-top:8px"><b>#${p.index + 1}</b> ${p.id}<br><span class="meta">mapping: ${p.mapping || 'none'} · connected: ${p.connected}</span><br>axes: <code>${p.axes.join(' ')}</code><br>pressed: <code>${pressed}</code></div>`;
        }
        html += `<div class="meta" style="margin-top:6px">Move the sticks and press buttons: the values above should change. Steering uses axis 0; gas is B7 (right trigger) or B0; brake is B6 or B2.</div>`;
      }
      if (d.error) html += `<div class="meta">error: ${d.error}</div>`;
      box.innerHTML = html;
    };
    render();
    this._padDiagTimer = setInterval(render, 200);
  }

  // ------------------------------------------------------------ Pause
  pause() {
    const app = this.app;
    const inEvent = !!(app.race && app.horizon);
    const roaming = !!(app.horizon && !app.race);
    this.show(`
      <div class="panel narrow">
        <h2>Paused</h2>
        <div class="menu">
          <button class="primary" data-resume>Resume</button>
          ${roaming ? '<button data-map>Map <span class="hint">Waypoints, fast travel, progress</span></button>' : '<button data-restart>Restart race</button>'}
          ${inEvent ? '<button data-quit>Back to Free Roam</button>' : roaming ? '<button data-quit-roam>Quit to menu <span class="hint">Position is saved</span></button>' : '<button data-quit>Quit to menu</button>'}
        </div>
      </div>`);
    this.on('[data-resume]', 'click', () => app.togglePause());
    this.on('[data-restart]', 'click', () => app.restartRace());
    this.on('[data-map]', 'click', () => { this.horizonMap(true); });
    this.on('[data-quit]', 'click', () => app.quitRace());
    this.on('[data-quit-roam]', 'click', () => app.quitHorizon());
  }

  // ------------------------------------------------------------ Free Roam
  horizonIntro() {
    const app = this.app, p = app.profile;
    const car = getCar(p.selected);
    const hz = p.horizon || {};
    this.rerender = () => this.horizonIntro();
    this.show(`
      <div class="panel">
        <div class="row between"><h2>Free Roam</h2><button class="small ghost" data-back>← Back</button></div>
        <p>A 6 km open world with six regions: meadows, pine forest, red-rock desert, an alpine pass, a coastline and Apex City.
        Every circuit and stage is out there as a drive-up event. Hunt speed traps, drift zones, speed zones and bonus boards for XP and credits.</p>
        <div class="grid-2">
          <div class="card">
            <h4>Your car: ${car.name}</h4>
            <div class="meta">${car.desc}</div>
            ${this._statBars(effectiveStats(car, p.upgrades[car.id] || {}))}
            <div class="meta" style="margin-top:6px">Change or upgrade cars in Career → Garage. Event prize money goes to your career balance (${money(p.money)}).</div>
          </div>
          <div class="card">
            <h4>Progress</h4>
            <div class="meta">${hz.xp ? `${hz.xp.toLocaleString()} XP` : 'No XP yet'} · ${(hz.discovered || []).length} places discovered · ${(hz.boards || []).length} boards · ${Object.keys(hz.events || {}).length} events raced · ${((hz.stats || {}).distance || 0).toFixed(1)} km driven</div>
            <div class="field" style="margin-top:10px"><label>Controls</label>${this._controlChips(p.settings.p1Control || 'wasd', 'data-ctl="1"', 0)}</div>
            <div class="meta"><kbd>M</kbd> map · <kbd>Enter</kbd> start an event when you are on its ring · <kbd>R</kbd> back to the nearest road · <kbd>Esc</kbd> pause</div>
          </div>
        </div>
        <div class="row end" style="margin-top:18px">
          ${hz.pos ? '<button data-fresh>Start at the festival</button>' : ''}
          <button class="primary" data-start style="min-width:240px">${hz.pos ? 'Continue' : 'Drive'}</button>
        </div>
      </div>`);
    this.on('[data-back]', 'click', () => this.mainMenu());
    this.on('[data-ctl]', 'click', (e, el) => { p.settings.p1Control = el.dataset.id; app.save(); this.horizonIntro(); });
    this.on('[data-fresh]', 'click', () => { p.horizon.pos = null; app.save(); this._launchHorizon(); });
    this.on('[data-start]', 'click', () => this._launchHorizon());
  }

  _launchHorizon() {
    this.show(`<div class="panel narrow" style="text-align:center"><div class="logo" style="font-size:40px">APEX <span>HORIZON</span></div><div class="tagline" style="margin:14px 0 0">Building the world…</div></div>`);
    setTimeout(() => this.app.startHorizon(), 40);
  }

  /** Full-world map: waypoints, fast travel and progress. */
  horizonMap(fromPause = false) {
    const app = this.app, hz = app.horizon;
    if (!hz) return;
    this.mapOpen = true;
    this.rerender = null;
    const sum = hz.summary();
    const size = Math.max(420, Math.min(640, Math.floor(Math.min(window.innerWidth - 80, window.innerHeight - 120))));
    let selected = hz.waypoint || null;
    const stars = (a, b) => `${a}<span class="meta">/${b}</span> ★`;
    this.show(`
      <div class="panel" style="width:min(1060px,100%)">
        <div class="row between"><h2 style="margin:0">Map</h2><div class="meta">${sum.level.level > 1 ? `Level ${sum.level.level}` : 'Level 1'} · ${sum.xp.toLocaleString()} XP · ${money(sum.money)}</div><button class="small ghost" data-close>${fromPause ? '← Back' : 'Close (Esc / M)'}</button></div>
        <div class="row" style="align-items:flex-start;margin-top:12px;gap:18px">
          <canvas id="hz-map" width="${size}" height="${size}" style="border-radius:12px;cursor:crosshair;max-width:100%"></canvas>
          <div style="flex:1;min-width:240px">
            <div class="card" id="hz-sel"></div>
            <h3>Progress</h3>
            <div class="card hz-stats">
              <div><span>Events raced</span><b>${sum.events}<span class="meta">/${sum.eventsTotal}</span></b></div>
              <div><span>Speed traps</span><b>${stars(sum.trapStars, sum.trapTotal)}</b></div>
              <div><span>Drift zones</span><b>${stars(sum.driftStars, sum.driftTotal)}</b></div>
              <div><span>Speed zones</span><b>${stars(sum.zoneStars, sum.zoneTotal)}</b></div>
              <div><span>Bonus boards</span><b>${sum.boards}<span class="meta">/${sum.boardsTotal}</span></b></div>
              <div><span>Discovered</span><b>${sum.discovered}<span class="meta">/${sum.markers}</span></b></div>
              <div><span>Distance driven</span><b>${sum.distance.toFixed(1)} km</b></div>
            </div>
            <div class="hz-legend meta">
              <span><i style="background:#ffd23f"></i>Festival</span><span><i style="background:#ff5a1f"></i>Circuit</span><span><i style="background:#3ddc84"></i>Stage / board</span>
              <span><i style="background:#2f7bff"></i>Speed trap</span><span><i style="background:#b04cff"></i>Drift zone</span><span><i style="background:#00d4ff"></i>Speed zone</span>
            </div>
          </div>
        </div>
      </div>`);
    const canvas = document.getElementById('hz-map');
    const selBox = document.getElementById('hz-sel');
    const renderSel = () => {
      if (!selected) { selBox.innerHTML = '<div class="meta">Click a marker for details, a waypoint, or fast travel (once discovered).</div>'; return; }
      const m = selected;
      const discovered = m.kind === 'hub' || hz.prog.discovered.includes(m.id);
      const kindName = { hub: 'Festival hub', event: m.track ? (m.track.kind === 'stage' ? 'Point-to-point stage' : 'Circuit race') : 'Event', trap: 'Speed trap', drift: 'Drift zone', zone: 'Speed zone' }[m.kind];
      const d = Math.hypot(m.x - hz.car.pos.x, m.z - hz.car.pos.z);
      selBox.innerHTML = `
        <h4>${m.name}</h4>
        <div class="meta">${kindName}${m.track ? ` · ${m.track.desc}` : ''}</div>
        <div class="meta" style="margin-top:6px">${hz.world.regionAt(m.x, m.z).name} · ${d >= 1000 ? (d / 1000).toFixed(1) + ' km' : Math.round(d) + ' m'} away${m.kind === 'event' ? ` · ${m.track.open ? 'stage' : m.laps + ' laps'} · ${m.ai} rivals` : ''}</div>
        <div style="margin-top:6px">${hz.markerBest(m)}</div>
        <div class="row" style="margin-top:10px">
          <button class="small primary" data-wp>${hz.waypoint === m ? 'Clear waypoint' : 'Set waypoint'}</button>
          <button class="small" data-travel ${discovered ? '' : 'disabled title="Drive there first to unlock fast travel"'}>Fast travel</button>
        </div>`;
      selBox.querySelector('[data-wp]').addEventListener('click', () => { app.setWaypoint(hz.waypoint === m ? null : m); app.audio.click(); renderSel(); draw(); });
      selBox.querySelector('[data-travel]').addEventListener('click', () => { if (discovered) { app.audio.click(); app.fastTravel(m); } });
    };
    const draw = () => hz.drawMap(canvas, selected);
    canvas.addEventListener('click', (e) => {
      const r = canvas.getBoundingClientRect();
      const px = (e.clientX - r.left) * (canvas.width / r.width), py = (e.clientY - r.top) * (canvas.height / r.height);
      const m = hz.markerAt(canvas, px, py);
      if (m) { selected = m; app.audio.click(); renderSel(); draw(); }
    });
    renderSel(); draw();
    this.on('[data-close]', 'click', () => { if (fromPause) { this.mapOpen = false; this.pause(); } else app.closeMap(); });
  }

  // ------------------------------------------------------------ Results
  results(results, ctx) {
    const app = this.app;
    const winner = results[0];
    const top3 = results.slice(0, 3);
    const players = results.filter(r => r.isPlayer);
    const heading = ctx.mode === 'timetrial' ? 'Time Trial Complete'
      : players.length === 1 ? `${ORD(players[0].rank)} place`
      : `${players.sort((a, b) => a.rank - b.rank)[0].name} wins the duel!`;
    const bestOverall = Math.min(...results.filter(r => r.bestLap).map(r => r.bestLap));
    let careerHtml = '';
    if (ctx.career) {
      const c = ctx.career;
      careerHtml = `<div class="card" style="margin-top:14px">
        <h4>Championship update</h4>
        <div class="row" style="gap:24px">
          <div><div class="meta">Points earned</div><div style="font-size:24px;font-weight:800">+${c.pointsEarned}</div></div>
          <div><div class="meta">Prize money</div><div class="money" style="font-size:24px">+${money(c.money)}</div></div>
          ${c.championBonus ? `<div><div class="meta">Title bonus</div><div class="money" style="font-size:24px">+${money(c.championBonus)}</div></div>` : ''}
        </div>
        ${c.seriesComplete ? `<div class="notice" style="margin-top:10px">Series complete — you finished <b>${ORD(c.finalRank)}</b> overall.${c.unlocked ? ` <b>${c.unlocked.name}</b> unlocked!` : ''}</div>` : ''}
        ${this._standingsTable(ctx.seriesId, 6)}
      </div>`;
    }
    const rewardHtml = ctx.horizonReward ? `<div class="notice" style="margin-top:12px">Free Roam reward: <b class="money">+${money(ctx.horizonReward.credits)}</b> · <b>+${ctx.horizonReward.xp} XP</b></div>` : '';
    this.show(`
      <div class="panel">
        <h1>${heading}</h1>
        <div class="tagline">${ctx.trackName} · ${ctx.stage ? 'point-to-point stage' : `${ctx.laps} lap${ctx.laps === 1 ? '' : 's'}`}${ctx.dynamic ? ' · dynamic AI' : ''}</div>
        ${ctx.mode !== 'timetrial' ? `<div class="podium">${top3.map(r => `<div class="step p${r.rank}"><div class="n">${r.rank}</div><div class="who"><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${hex(r.color)};margin-right:5px"></span>${r.name}</div></div>`).join('')}</div>` : ''}
        <table>
          <tr><th>#</th><th>Driver</th><th class="num">Time</th><th class="num">${ctx.stage ? 'Stage time' : 'Best lap'}</th></tr>
          ${results.map(r => `<tr class="${r.isPlayer ? 'you' : ''}"><td>${r.rank}</td><td><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${hex(r.color)};margin-right:8px"></span>${r.name}</td>
            <td class="num">${r.finished ? (r.rank === 1 || !winner.finished ? fmtTime(r.time) : '+' + (r.time - winner.time).toFixed(3)) : (r.stagePct !== null && r.stagePct !== undefined ? `${r.stagePct}% of stage` : `${r.laps}/${ctx.laps} laps`)}</td>
            <td class="num" style="${r.bestLap === bestOverall ? 'color:var(--accent-2);font-weight:700' : ''}">${fmtTime(r.bestLap)}</td></tr>`).join('')}
        </table>
        ${ctx.newBest ? `<div class="notice" style="margin-top:12px">🏁 New personal best ${ctx.stage ? 'stage time' : 'lap'}: <b>${fmtTime(ctx.newBest)}</b>${ctx.ghostSaved ? ' · saved as your ghost' : ''}</div>` : ''}
        ${rewardHtml}
        ${careerHtml}
        <div class="row end" style="margin-top:18px">
          ${ctx.mode !== 'career' ? '<button data-retry>Race again</button>' : ''}
          <button class="primary" data-continue>${ctx.mode === 'career' ? 'Continue' : ctx.mode === 'horizon' ? 'Back to Free Roam' : 'Main menu'}</button>
        </div>
      </div>`);
    this.on('[data-retry]', 'click', () => app.restartRace());
    this.on('[data-continue]', 'click', () => app.leaveRace(ctx.mode === 'career' ? 'career' : ctx.mode === 'horizon' ? 'horizon' : 'menu'));
  }
}
