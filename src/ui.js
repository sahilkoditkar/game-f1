import { TRACKS, getTrack } from './tracks.js';
import { CARS, SERIES, UPGRADES, PLAYER_COLORS, getCar, getSeries, upgradeCost, effectiveStats } from './data.js';
import { listControls, getControl, connectedPads, gamepadDiagnostics } from './input.js';
import { seriesState, seriesLock, standings, canBuyUpgrade } from './career.js';
import { levelForXp } from './worlddef.js';
import { fmtTime } from './race.js';
import { WorldMap } from './worldmap.js';

const hex = (c) => '#' + c.toString(16).padStart(6, '0');
const money = (n) => `${Math.round(n).toLocaleString()} cr`;
const ORD = (n) => n + (['th', 'st', 'nd', 'rd'][((n % 100) - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');

// Browser-tab titles. The main menu keeps the full SEO title from index.html; other screens get
// "<label> – Turbo Tour" via UI.show(html, { title }) and, while driving, from the race mode (UI.hide).
const SEO_TITLE = document.title;
const RACE_TITLES = { quick: 'Quick Race', split: 'Split Screen', timetrial: 'Time Trial', career: 'Championship', horizon: 'Free Roam Event' };
const MODE_TITLES = { quick: 'Quick Race', split: 'Split Screen', timetrial: 'Time Trial' };

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
    this.initAbout();
  }

  /** Set the browser-tab title: '' restores the SEO title (main menu). */
  setTitle(label) {
    this._title = label;
    document.title = label ? `${label} – Turbo Tour` : SEO_TITLE;
  }

  /** Title while a race or the open world is running (no menu on screen). */
  _liveTitle() {
    const app = this.app;
    if (app.race) return RACE_TITLES[app.raceCtx && app.raceCtx.mode] || 'Race';
    if (app.horizon) return 'Free Roam';
    return this._title;
  }

  // ------------------------------------------------------------ About
  /**
   * The static <section id="about"> in index.html (crawlable, readable without JavaScript) is hidden
   * by main.js on start-up and shown as an overlay from the main menu's "About Turbo Tour" button.
   */
  initAbout() {
    const about = this.aboutEl = document.getElementById('about');
    if (!about) return;
    about.classList.add('hidden');
    const panel = about.querySelector('.about-panel');
    const back = document.createElement('button');
    back.type = 'button'; back.className = 'small ghost about-back'; back.textContent = '← Back';
    const done = document.createElement('div');
    done.className = 'row end about-done';
    done.innerHTML = '<button type="button" class="primary">Back to the menu</button>';
    panel.prepend(back);
    panel.append(done);
    for (const b of [back, done.firstElementChild]) b.addEventListener('click', () => { this.app.audio.click(); this.closeAbout(); });
    about.addEventListener('click', (e) => { if (e.target === about) this.closeAbout(); });
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.aboutOpen) { e.preventDefault(); this.closeAbout(); } });
  }

  openAbout() {
    if (!this.aboutEl) return;
    this.aboutOpen = true;
    this.aboutEl.classList.remove('hidden');
    this.aboutEl.scrollTop = 0;
    document.title = 'About – Turbo Tour';
    const back = this.aboutEl.querySelector('.about-back');
    if (back) back.focus({ preventScroll: true });
  }

  closeAbout() {
    if (!this.aboutEl || !this.aboutOpen) return;
    this.aboutOpen = false;
    this.aboutEl.classList.add('hidden');
    this.setTitle(this._title);
  }

  hide() {
    if (this.worldMap) { this.worldMap.dispose(); this.worldMap = null; }
    this.el.innerHTML = ''; this.el.classList.add('empty'); this.el.classList.remove('fullbleed'); this.rerender = null; this.mapOpen = false;
    this.closeAbout();
    // the caller usually starts or resumes a race / the world right after hiding the menu
    queueMicrotask(() => { if (this.el.classList.contains('empty')) this.setTitle(this._liveTitle()); });
  }

  show(html, { transparent = false, title } = {}) {
    if (this.worldMap) { this.worldMap.dispose(); this.worldMap = null; }
    if (title !== undefined) this.setTitle(title);
    this.el.classList.remove('empty', 'fullbleed');
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
    this.rerender = null;
    this.show(`
      <div class="panel narrow">
        <div class="logo">TURBO <span>TOUR</span></div>
        <div class="tagline">3D arcade racing · open world · split screen</div>
        ${this._walletBar()}
        <div class="menu">
          <button class="primary" data-go="horizon">Play <span class="hint" style="color:#fff;opacity:.85">Open-world career · championships, events, garage</span></button>
          <div class="menu-label">Arcade <span>· all cars unlocked, no rewards</span></div>
          <button data-go="quick">Quick Race <span class="hint">Single player vs AI</span></button>
          <button data-go="split">Split Screen <span class="hint">2 players, one screen</span></button>
          <button data-go="timetrial">Time Trial <span class="hint">Beat your best laps</span></button>
          <button data-go="settings" class="ghost">Settings &amp; Controls</button>
          <button data-go="about" class="ghost">About Turbo Tour <span class="hint">Features, controls, FAQ</span></button>
        </div>
        <div class="footer-note">
          <div class="keys-row"><span>Player 1</span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd><span>steer</span><kbd>Shift</kbd><span>drift</span></div>
          <div class="keys-row"><span>Player 2</span><kbd>↑</kbd><kbd>←</kbd><kbd>↓</kbd><kbd>→</kbd><span>steer</span><kbd>R-Shift</kbd><span>drift</span></div>
          <div class="keys-row"><span>Any</span><kbd>Esc</kbd><span>pause</span><kbd>R</kbd><span>reset</span><span>· gamepads and touch supported</span></div>
          <a href="./showroom.html">Car showroom: see every car up close →</a>
        </div>
      </div>`, { title: '' });
    this.on('[data-go]', 'click', (e, el) => {
      const go = el.dataset.go;
      if (go === 'horizon') this.horizonIntro();
      else if (go === 'settings') this.settings();
      else if (go === 'about') this.openAbout();
      else this.raceSetup(go);
    });
  }

  /** One wallet for the whole game: credits, level, cars, championship titles. */
  _walletBar() {
    const p = this.app.profile;
    const lv = levelForXp((p.horizon || {}).xp || 0).level;
    const titles = SERIES.filter(s => (p.series[s.id] || {}).finalRank === 1).length;
    return `<div class="wallet-bar">
      <div><span>Wallet</span><b class="money">${money(p.money)}</b></div>
      <div><span>Level</span><b>${lv}</b></div>
      <div><span>Cars</span><b>${p.cars.length}<small>/${CARS.length}</small></b></div>
      <div><span>Titles</span><b>${titles}<small>/${SERIES.length}</small></b></div>
    </div>`;
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
    const title = { quick: 'Quick Race', split: 'Split Screen', timetrial: 'Time Trial' }[mode] + ' <span class="badge" title="Arcade: all cars unlocked, no rewards">Arcade: all cars unlocked, no rewards</span>';
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
        </div>`, { title: MODE_TITLES[mode] });
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

  // ------------------------------------------------------------ Championship (opened at its venue in the world)
  seriesPanel(id, { onClose, onRace }) {
    const app = this.app, p = app.profile;
    const s = getSeries(id), st = seriesState(p, id), lock = seriesLock(p, s);
    const car = getCar(p.selected);
    const rows = standings(p, id);
    const myRank = rows.findIndex(r => r.isPlayer) + 1;
    const next = !lock && !st.complete ? s.events[st.event] : null;
    const badge = lock ? '<span class="badge locked">Locked</span>'
      : st.complete ? `<span class="badge ${st.finalRank === 1 ? 'gold' : 'done'}">${st.finalRank === 1 ? '🏆 Champion' : 'Finished ' + ORD(st.finalRank)}</span>`
      : st.event > 0 ? `<span class="badge">Round ${st.event + 1}/${s.events.length}${myRank ? ' · ' + ORD(myRank) + ' in standings' : ''}</span>` : '<span class="badge">Not started</span>';
    const rankNeed = s.requires ? `finish ${s.requireRank === 1 ? '1st' : 'top ' + s.requireRank} in ${getSeries(s.requires).name}` : '';
    const needs = [rankNeed, (s.level || 1) > 1 ? `reach level ${s.level}` : ''].filter(Boolean);
    const myLevel = levelForXp((p.horizon || {}).xp || 0).level;
    this.rerender = null;
    this.show(`
      <div class="panel">
        <div class="row between"><div><div class="meta eyebrow">Championship</div><h2 style="margin:2px 0 0">${s.name} ${badge}</h2></div>
          <div style="text-align:right"><div class="money" style="font-size:22px">${money(p.money)}</div><div class="meta">your wallet</div></div></div>
        <p>${s.desc}</p>
        <div class="meta">${s.aiCount} opponents · ${s.events.length} rounds · prize up to ${money(s.prize[0])} a race · title bonus ${money(s.bonus)}${needs.length ? ` · needs: ${needs.join(' and ')}` : ''}</div>
        ${lock ? `<div class="notice" style="margin-top:12px">🔒 To enter: ${[lock.rank ? rankNeed : '', lock.level ? `reach level ${s.level} (you are level ${myLevel})` : ''].filter(Boolean).join(' and ')}. Earn XP from events, skills, bonus boards and discoveries around the island.</div>` : ''}
        <div class="grid-2" style="margin-top:14px">
          <div class="card"><h4>Rounds</h4>
            ${s.events.map((e, i) => {
              const res = (st.results || []).find(r => r.event === i);
              const state = res ? `<b>${ORD(res.position)}</b>` : i === st.event && !st.complete ? '<span class="badge gold">next</span>' : '<span class="meta">–</span>';
              return `<div class="row between round-row"><span>${i + 1}. ${getTrack(e.track).name} <span class="meta">· ${e.laps} laps</span></span>${state}</div>`;
            }).join('')}
          </div>
          <div class="card"><h4>Standings</h4>${st.event > 0 ? this._standingsTable(id, 8) : '<div class="meta">No rounds raced yet.</div>'}</div>
        </div>
        <div class="meta" style="margin-top:12px">Driving: <b>${car.name}</b> · change car or upgrade at Festival HQ (pause → Go to garage)</div>
        <div class="row end" style="margin-top:16px">
          <button class="ghost" data-close>Close <kbd>Esc</kbd></button>
          ${st.complete ? '<button data-restart>Replay series</button>' : ''}
          ${next ? `<button class="primary" data-race style="min-width:240px">Race round ${st.event + 1}: ${getTrack(next.track).name}</button>` : ''}
        </div>
      </div>`, { title: s.name });
    this.on('[data-close]', 'click', () => onClose());
    this.on('[data-race]', 'click', () => onRace());
    this.on('[data-restart]', 'click', () => {
      if (confirm('Replay this series from round 1? Standings will be reset (your credits and cars are kept).')) { app.restartSeries(id); this.seriesPanel(id, { onClose, onRace }); }
    });
  }

  _standingsTable(seriesId, limit = 12) {
    const rows = standings(this.app.profile, seriesId).slice(0, limit);
    return `<table style="margin-top:12px"><tr><th>#</th><th>Driver</th><th class="num">Points</th></tr>
      ${rows.map((r, i) => `<tr class="${r.isPlayer ? 'you' : ''}"><td>${i + 1}</td><td>${r.name}</td><td class="num">${r.points}</td></tr>`).join('')}</table>`;
  }

  // ------------------------------------------------------------ Garage
  /**
   * A garage in the world. opts.mode: 'hq' (Festival HQ: paint, choose and buy cars,
   * upgrades), 'dealer' (buy cars; a new car is the one you drive away in) or 'tuning'
   * (upgrades for the car you came in). opts.onClose drives away.
   */
  garage(opts = {}) {
    const app = this.app, p = app.profile;
    const mode = opts.mode || 'hq';
    this.rerender = null;
    const sel = getCar(p.selected);
    const lv = p.upgrades[sel.id] || {};
    const again = () => this.garage(opts);
    const eyebrow = { hq: 'Garage', dealer: 'Dealership', tuning: 'Tuning shop' }[mode];
    const elsewhere = {
      hq: '',
      dealer: 'Upgrades at a tuning shop or Festival HQ · paint and switching cars at Festival HQ.',
      tuning: 'Buy cars at Turbo Motors or Festival HQ · paint and switching cars at Festival HQ.',
    }[mode];
    const carCard = (c) => {
      const owned = p.cars.includes(c.id);
      return `<div class="card ${c.id === p.selected ? 'selected' : ''}">
        <div class="row between"><h4>${c.name}</h4>${owned ? (c.id === p.selected ? '<span class="badge gold">Driving</span>' : '<span class="badge done">Owned</span>') : `<span class="badge">${money(c.price)}</span>`}</div>
        <div class="meta" style="margin-bottom:8px">${c.desc}</div>
        ${this._statBars(effectiveStats(c, p.upgrades[c.id] || {}))}
        <div class="row end" style="margin-top:8px">
          ${owned && c.id !== p.selected && mode === 'hq' ? `<button class="small" data-select="${c.id}">Drive this one</button>` : ''}
          ${!owned ? `<button class="small primary" data-buy="${c.id}" ${p.money < c.price ? 'disabled' : ''}>Buy · ${money(c.price)}</button>` : ''}
        </div></div>`;
    };
    const upgrades = `<h3>Upgrades — ${sel.name}</h3>
      <div class="grid-2">
        ${UPGRADES.map(u => {
          const lvl = lv[u.id] || 0;
          const r = canBuyUpgrade(p, sel.id, u.id);
          return `<div class="card"><div class="row between"><h4>${u.name} <span class="badge">Lv ${lvl}/${u.maxLevel}</span></h4>
            ${r.reason === 'MAX' ? '<span class="badge gold">MAX</span>' : `<button class="small primary" data-up="${u.id}" ${r.ok ? '' : 'disabled'}>Upgrade · ${money(r.cost)}</button>`}</div>
            <div class="meta">${u.desc}</div>
            <div class="stat-bar" style="margin-top:8px"><i style="width:${(lvl / u.maxLevel) * 100}%"></i></div></div>`;
        }).join('')}
      </div>`;
    const cars = (list) => `<h3>${mode === 'dealer' ? 'Cars for sale' : 'Cars'}</h3><div class="grid-2">${list.map(carCard).join('')}</div>`;
    const body = mode === 'dealer' ? cars(CARS.filter(c => c.price > 0))
      : mode === 'tuning' ? `<div class="card" style="margin-top:12px"><h4>${sel.name} <span class="badge gold">Driving</span></h4>${this._statBars(effectiveStats(sel, lv))}</div>${upgrades}`
      : `<h3>Paint</h3>
        <div class="chips">${PLAYER_COLORS.map((c, ci) => `<div class="swatch ${(p.colorIndex || 0) === ci ? 'active' : ''}" data-paint="${ci}" style="background:${hex(c)}" title="Paint"></div>`).join('')}</div>
        ${cars(CARS)}${upgrades}`;
    this.show(`
      <div class="panel">
        <div class="row between"><div><div class="meta eyebrow">${eyebrow}</div><h2 style="margin:2px 0 0">${opts.name || 'Festival HQ'}</h2></div>
          <div style="text-align:right"><div class="money" style="font-size:24px">${money(p.money)}</div><div class="meta">your wallet · earned everywhere on the island</div></div></div>
        ${body}
        ${elsewhere ? `<div class="meta" style="margin-top:12px">${elsewhere}</div>` : ''}
        <div class="row end" style="margin-top:16px"><button class="primary" data-back style="min-width:240px">Drive away in the ${sel.name} <kbd>Esc</kbd></button></div>
      </div>`, { title: eyebrow });
    this.on('[data-back]', 'click', () => (opts.onClose ? opts.onClose() : this.mainMenu()));
    this.on('[data-paint]', 'click', (e, el) => { p.colorIndex = +el.dataset.paint; app.save(); again(); });
    this.on('[data-select]', 'click', (e, el) => { p.selected = el.dataset.select; app.save(); again(); });
    this.on('[data-buy]', 'click', (e, el) => { if (app.buyCar(el.dataset.buy)) { this.toast(`Bought ${getCar(el.dataset.buy).name}! It's the one you'll drive away in.`); } again(); });
    this.on('[data-up]', 'click', (e, el) => { if (app.buyUpgrade(sel.id, el.dataset.up)) this.toast('Upgrade installed'); again(); });
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
      </div>`, { title: 'Settings' });
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
          ${roaming ? '<button data-map>Map <span class="hint">Waypoints, fast travel, progress</span></button><button data-garage>Go to garage <span class="hint">Fast travel to Festival HQ: cars, upgrades, paint</span></button>' : '<button data-restart>Restart race</button>'}
          ${inEvent ? '<button data-quit>Back to Free Roam</button>' : roaming ? '<button data-quit-roam>Quit to menu <span class="hint">Position is saved</span></button>' : '<button data-quit>Quit to menu</button>'}
        </div>
      </div>`, { title: 'Paused' });
    this.on('[data-resume]', 'click', () => app.togglePause());
    this.on('[data-restart]', 'click', () => app.restartRace());
    this.on('[data-map]', 'click', () => { this.horizonMap(true); });
    this.on('[data-garage]', 'click', () => app.goToGarage());
    this.on('[data-quit]', 'click', () => app.quitRace());
    this.on('[data-quit-roam]', 'click', () => app.quitHorizon());
  }

  // ------------------------------------------------------------ Free Roam
  horizonIntro() {
    const app = this.app, p = app.profile;
    const car = getCar(p.selected);
    const hz = p.horizon || {};
    const lv = levelForXp(hz.xp || 0);
    this.rerender = () => this.horizonIntro();
    this.show(`
      <div class="panel">
        <div class="row between"><h2>Turbo Tour</h2><button class="small ghost" data-back>← Back</button></div>
        <p>Your career is the island. Race drive-up events, take on the four championships at their venues, hunt speed traps, drift zones and bonus boards,
        and spend what you win at Festival HQ, the garage next to the festival start.</p>
        ${this._walletBar()}
        <div class="grid-2">
          <div class="card">
            <h4>Your car: ${car.name}</h4>
            <div class="meta">${car.desc}</div>
            ${this._statBars(effectiveStats(car, p.upgrades[car.id] || {}))}
            <div class="meta" style="margin-top:6px">Buy, upgrade and paint cars at Festival HQ (or pause → Go to garage).</div>
          </div>
          <div class="card">
            <h4>Championships</h4>
            ${SERIES.map(s => {
              const st = seriesState(p, s.id), lock = seriesLock(p, s);
              const tag = lock ? `<span class="badge locked">${lock.level ? 'Level ' + s.level : 'Locked'}</span>`
                : st.complete ? `<span class="badge ${st.finalRank === 1 ? 'gold' : 'done'}">${st.finalRank === 1 ? '🏆' : ORD(st.finalRank)}</span>`
                : st.event > 0 ? `<span class="badge">Round ${st.event + 1}/${s.events.length}</span>` : '<span class="badge">Open</span>';
              return `<div class="row between" style="padding:3px 0">${s.name}${tag}</div>`;
            }).join('')}
            <div class="meta" style="margin-top:6px">Level ${lv.level} · ${(hz.xp || 0).toLocaleString()} XP · ${(hz.discovered || []).length} places discovered · ${((hz.stats || {}).distance || 0).toFixed(1)} km driven</div>
            <div class="field" style="margin-top:10px"><label>Controls</label>${this._controlChips(p.settings.p1Control || 'wasd', 'data-ctl="1"', 0)}</div>
            <div class="meta"><kbd>M</kbd> map · <kbd>Enter</kbd> at a marker · <kbd>R</kbd> back to the road · <kbd>Esc</kbd> pause</div>
          </div>
        </div>
        <div class="row end" style="margin-top:18px">
          ${hz.pos ? '<button data-fresh>Start at Festival HQ</button>' : ''}
          <button class="primary" data-start style="min-width:240px">${hz.pos ? 'Continue' : 'Drive'}</button>
        </div>
      </div>`, { title: 'Free Roam' });
    this.on('[data-back]', 'click', () => this.mainMenu());
    this.on('[data-ctl]', 'click', (e, el) => { p.settings.p1Control = el.dataset.id; app.save(); this.horizonIntro(); });
    this.on('[data-fresh]', 'click', () => { p.horizon.pos = null; app.save(); this._launchHorizon(); });
    this.on('[data-start]', 'click', () => this._launchHorizon());
  }

  _launchHorizon() {
    this.show(`<div class="panel narrow" style="text-align:center"><div class="logo" style="font-size:40px">TURBO <span>TOUR</span></div><div class="tagline" style="margin:14px 0 0">Building the world…</div></div>`, { title: 'Free Roam' });
    setTimeout(() => this.app.startHorizon(), 40);
  }

  /** Full-screen world map: pan/zoom, GPS waypoints, fast travel and progress. */
  horizonMap(fromPause = false) {
    const app = this.app, hz = app.horizon;
    if (!hz) return;
    if (this.worldMap) this.worldMap.dispose();
    this.mapOpen = true;
    this.rerender = null;
    this.show('', { transparent: true, title: 'Map' });
    this.el.classList.add('fullbleed');
    this.worldMap = new WorldMap(this.el, {
      hz, app, fromPause,
      onClose: () => { this.worldMap = null; if (fromPause) { this.mapOpen = false; this.el.classList.remove('fullbleed'); this.pause(); } else app.closeMap(); },
    });
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
          <div><div class="meta">Prize money → wallet</div><div class="money" style="font-size:24px">+${money(c.money)}</div></div>
          ${c.championBonus ? `<div><div class="meta">Title bonus → wallet</div><div class="money" style="font-size:24px">+${money(c.championBonus)}</div></div>` : ''}
        </div>
        ${c.seriesComplete ? `<div class="notice" style="margin-top:10px">Series complete — you finished <b>${ORD(c.finalRank)}</b> overall.${c.unlocked ? ` <b>${c.unlocked.name}</b> unlocked!` : ''}</div>` : ''}
        ${this._standingsTable(ctx.seriesId, 6)}
      </div>`;
    }
    const rewardHtml = ctx.horizonReward ? `<div class="notice" style="margin-top:12px">Reward: <b class="money">+${money(ctx.horizonReward.credits)} → wallet</b> · <b>+${ctx.horizonReward.xp} XP</b></div>` : '';
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
          <button class="primary" data-continue>${ctx.mode === 'horizon' || (ctx.mode === 'career' && app.horizon) ? 'Back to the island' : ctx.mode === 'career' ? 'Continue' : 'Main menu'}</button>
        </div>
      </div>`, { title: 'Results' });
    this.on('[data-retry]', 'click', () => app.restartRace());
    this.on('[data-continue]', 'click', () => app.leaveRace(ctx.mode === 'career' ? 'career' : ctx.mode === 'horizon' ? 'horizon' : 'menu'));
  }
}
