import * as THREE from 'three';
import { Input, getControl, connectedPads } from './input.js';
import { AudioSystem } from './audio.js';
import { UI } from './ui.js';
import { Race } from './race.js';
import { Horizon } from './horizon.js';
import { EVENT_PRIZE } from './worlddef.js';
import { getTrack } from './tracks.js';
import { getCar, getSeries, PLAYER_COLORS, effectiveStats } from './data.js';
import {
  loadProfile, saveProfile, resetProfile, seriesState, seriesField, quickField, playerStats,
  applyCareerResult, restartSeries, buyCar, buyUpgrade, recordBestLap,
} from './career.js';

const GHOST_PREFIX = 'apexrush.ghost.';
function loadGhost(key) {
  try { const raw = localStorage.getItem(GHOST_PREFIX + key); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}
function saveGhost(key, data) {
  try {
    const json = JSON.stringify(data);
    if (json.length > 600000) return false; // keep well inside localStorage limits
    localStorage.setItem(GHOST_PREFIX + key, json);
    return true;
  } catch (e) { return false; }
}

class App {
  constructor() {
    this.canvas = document.getElementById('game');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.input = new Input();
    this.audio = new AudioSystem();
    this.profile = loadProfile();
    this.audio.setVolume(this.profile.settings.volume);
    this.audio.setEnabled(this.profile.settings.sound);
    this.ui = new UI(this);
    this.race = null;
    this.horizon = null;
    this.raceCtx = null;
    this.lastRaceConfig = null;
    this.paused = false;
    this.clock = new THREE.Clock();

    window.addEventListener('resize', () => this.onResize());
    // First user gesture unlocks audio
    const unlock = () => { this.audio.init(); };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });

    this._buildIdleScene();
    this.ui.mainMenu();
    document.getElementById('loading').style.opacity = '0';
    setTimeout(() => document.getElementById('loading').remove(), 450);
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // A showroom with the player's current car, shown behind the menus.
  _buildIdleScene() {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0d12);
    scene.fog = new THREE.Fog(0x0b0d12, 18, 45);
    scene.add(new THREE.HemisphereLight(0x8ab4ff, 0x1a1c24, 1.6));
    const key = new THREE.SpotLight(0xffffff, 260, 40, 0.42, 0.6, 1.6); key.position.set(2, 11, 4); key.castShadow = true; key.shadow.mapSize.set(1024, 1024); scene.add(key); scene.add(key.target);
    const rim = new THREE.DirectionalLight(0xff5a1f, 2.5); rim.position.set(-6, 3, -6); scene.add(rim);
    const fill = new THREE.DirectionalLight(0x4a7dff, 1.2); fill.position.set(6, 2, -4); scene.add(fill);
    const floor = new THREE.Mesh(new THREE.CircleGeometry(30, 48), new THREE.MeshStandardMaterial({ color: 0x14161c, roughness: 0.35, metalness: 0.5 }));
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(3.6, 3.8, 0.12, 48), new THREE.MeshStandardMaterial({ color: 0x1f2230, roughness: 0.3, metalness: 0.6 }));
    disc.position.y = 0.06; disc.receiveShadow = true; scene.add(disc);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(3.7, 0.04, 8, 64), new THREE.MeshStandardMaterial({ color: 0xff5a1f, emissive: 0xff5a1f, emissiveIntensity: 2 }));
    ring.rotation.x = Math.PI / 2; ring.position.y = 0.13; scene.add(ring);
    // simple reflections for the paint
    const pm = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    envScene.add(new THREE.Mesh(new THREE.SphereGeometry(30, 12, 8), new THREE.MeshBasicMaterial({ color: 0x2a3140, side: THREE.BackSide })));
    for (const [x, y, z] of [[10, 12, 6], [-8, 10, -6], [0, 14, -10]]) { const l = new THREE.Mesh(new THREE.BoxGeometry(6, 1, 12), new THREE.MeshBasicMaterial({ color: 0xffffff })); l.position.set(x, y, z); l.lookAt(0, 0, 0); envScene.add(l); }
    scene.environment = pm.fromScene(envScene, 0.04).texture;
    pm.dispose();
    this.idle = { scene, camera: new THREE.PerspectiveCamera(40, 1, 0.1, 100), cars: [], t: 0, pivot: new THREE.Group() };
    scene.add(this.idle.pivot);
    this.idle.pivot.position.set(0, 0.12, 0);
    this._refreshIdleCars();
    this.onResize();
  }

  _refreshIdleCars() {
    if (!this.idle) return;
    for (const c of this.idle.cars) this.idle.pivot.remove(c);
    this.idle.cars = [];
    import('./car.js').then(({ buildCarMesh }) => {
      const car = getCar(this.profile.selected);
      const m = buildCarMesh(car.shape, PLAYER_COLORS[this.profile.colorIndex || 0]);
      this.idle.pivot.add(m);
      this.idle.cars.push(m);
    });
  }

  onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    if (this.idle) { this.idle.camera.aspect = w / h; this.idle.camera.updateProjectionMatrix(); }
    if (this.race) this.race.resize();
    if (this.horizon) this.horizon.resize();
  }

  frame() {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    if (this.race || this.horizon) {
      let pauseKey = this.input.justPressed('Escape') || this.input.touch.pause;
      for (const pd of connectedPads()) if (this.input.read('none', pd.index, -1).pause) pauseKey = true;
      if (pauseKey && !(this.race && this.race.state === 'finished')) {
        if (this.ui.mapOpen) this.closeMap();
        else if (this.ui.worldPanelClose) this.ui.worldPanelClose();   // garage / championship screen over the world
        else this.togglePause();
      }
      if (this.race) {
        if (!this.paused) this.race.update(dt);
        this.race.render();
      } else {
        if (!this.paused) {
          this.horizon.update(dt);
          if (this.horizon.requestMap) { this.horizon.requestMap = false; this.openMap(); }
        }
        this.horizon.render();
      }
    } else if (this.idle) {
      this.idle.t += dt;
      this.idle.pivot.rotation.y = this.idle.t * 0.35;
      // keep the car on the right-hand side, clear of the centred menu panel
      const wide = window.innerWidth > 900;
      this.idle.camera.position.set(wide ? 5 : 0, 2.6 + Math.sin(this.idle.t * 0.3) * 0.2, 13);
      this.idle.camera.lookAt(wide ? -6 : 0, 0.5, 0);
      this.renderer.render(this.idle.scene, this.idle.camera);
    }
    this.input.endFrame();
  }

  // ------------------------------------------------------------ Races
  _playerEntry(p, i, stats, shape) {
    const c = getControl(p.control || (i === 0 ? 'wasd' : 'arrows'));
    return { name: p.name, color: PLAYER_COLORS[p.colorIndex % PLAYER_COLORS.length], stats, shape, scheme: c.scheme, pad: c.pad };
  }

  startQuickRace(mode) {
    const st = this.setup;
    const track = getTrack(st.trackId);
    const nPlayers = mode === 'split' ? 2 : 1;
    const players = st.players.slice(0, nPlayers).map((p, i) => {
      const car = getCar(p.carId);
      return this._playerEntry(p, i, effectiveStats(car, { engine: 2, tires: 2, brakes: 2, aero: 2 }), car.shape);
    });
    const dynamic = st.difficulty === 3;
    const difficulty = dynamic ? 0.85 : ([0.45, 0.75, 1.0][st.difficulty] ?? 0.75);
    const ai = mode === 'timetrial' ? [] : quickField(st.aiCount, difficulty, st.players[0].carId);
    const ghost = mode === 'timetrial' ? loadGhost(`${track.id}:${st.players[0].carId}`) : null;
    const laps = track.open ? 1 : st.laps;
    this.startRace({ track, laps, players, ai, mode, ghost, dynamic, quality: this.profile.settings.quality }, { mode, trackName: track.name, laps, trackId: track.id, carId: st.players[0].carId, hasGhost: !!ghost, dynamic, stage: !!track.open });
  }

  /** Enter pressed at a marker in the world: race an event, open a championship or the garage. */
  onWorldMarker(marker) {
    if (marker.kind === 'event') this.startHorizonEvent(marker);
    else if (marker.kind === 'garage') this.openGarage(marker);
    else if (marker.kind === 'series') this.openSeries(marker);
  }

  /** Pause the world under a full-screen panel; `show(close)` draws it and must call close() to leave. */
  _worldPanel(show, after = () => {}) {
    const hz = this.horizon;
    if (!hz || this.race) return;
    this.paused = true;
    hz.setPaused(true);
    const close = () => {
      this.ui.worldPanelClose = null;
      this.ui.hide();
      this.paused = false;
      hz.setPaused(false);
      hz.promptCooldown = 1.5;
      after();
    };
    this.ui.worldPanelClose = close;
    show(close);
  }

  /** A garage in the world: Festival HQ (everything), the dealership (buy) or a tuning shop (upgrades). */
  openGarage(marker = this.horizon && this.horizon.world.garages[0]) {
    const hz = this.horizon;
    this._worldPanel((close) => this.ui.garage({ inWorld: true, mode: marker.type, name: marker.name, onClose: close }), () => { hz.swapCar(); hz.onGarageClosed(); });
  }

  openSeries(marker) {
    this._worldPanel((close) => this.ui.seriesPanel(marker.series, { onClose: close, onRace: () => { this.ui.worldPanelClose = null; this.horizon.paused = false; this.startWorldSeriesRace(marker); } }));
  }

  /** Pause menu → "Go to garage": fast travel to Festival HQ and open it. */
  goToGarage() {
    const hz = this.horizon;
    if (!hz) return;
    this.paused = false;
    hz.setPaused(false);
    this.ui.hide();
    hz.teleportTo(hz.world.garages[0]);
    this.openGarage(hz.world.garages[0]);
  }

  /** A championship round raced from its venue; the results screen returns to the world. */
  startWorldSeriesRace(marker) {
    const hz = this.horizon;
    hz.saveState();
    hz.suspend();
    this.startCareerRace(marker.series, marker);
  }

  startCareerRace(seriesId, marker = null) {
    const series = getSeries(seriesId);
    const st = seriesState(this.profile, seriesId);
    const ev = series.events[st.event];
    if (!ev) return;
    const track = getTrack(ev.track);
    const car = getCar(this.profile.selected);
    const players = [this._playerEntry({ name: this.profile.name, colorIndex: this.profile.colorIndex || 0, control: this.profile.settings.p1Control }, 0, playerStats(this.profile), car.shape)];
    const ai = seriesField(series);
    this.startRace({ track, laps: ev.laps, players, ai, mode: 'career', quality: this.profile.settings.quality },
      { mode: 'career', seriesId, trackName: track.name, laps: ev.laps, trackId: track.id, carId: car.id, marker });
  }

  // ------------------------------------------------------------ Free Roam
  startHorizon() {
    this.disposeRace();
    this.disposeHorizon();
    this.ui.hide();
    this.audio.init();
    this.horizon = new Horizon({
      renderer: this.renderer, input: this.input, audio: this.audio, profile: this.profile, quality: this.profile.settings.quality,
      onEvent: (marker) => this.onWorldMarker(marker),
      onSave: () => this.save(),
      onLevel: () => this._refreshIdleCars(),
    });
    this.paused = false;
  }

  /** Drive-up event inside Free Roam: run the circuit as a race, then return to the world. */
  startHorizonEvent(marker) {
    const hz = this.horizon;
    if (!hz) return;
    hz.saveState();
    hz.suspend();
    const car = getCar(this.profile.selected);
    const players = [this._playerEntry({ name: this.profile.name, colorIndex: this.profile.colorIndex || 0, control: this.profile.settings.p1Control }, 0, playerStats(this.profile), car.shape)];
    const ai = quickField(marker.ai, 0.85, car.id);
    const laps = marker.track.open ? 1 : marker.laps;
    this.startRace({ track: marker.track, laps, players, ai, mode: 'horizon', dynamic: true, quality: this.profile.settings.quality },
      { mode: 'horizon', eventId: marker.id, trackName: marker.track.name, laps, trackId: marker.track.id, carId: car.id, dynamic: true, stage: !!marker.track.open, marker });
  }

  /** Back to the world after an event (results screen "Back to Free Roam"). */
  returnToHorizon() {
    const marker = this.raceCtx && this.raceCtx.marker;
    this.disposeRace();
    this.paused = false;
    this.ui.hide();
    if (this.horizon) this.horizon.resume(marker);
    else this.startHorizon();
  }

  quitHorizon() {
    if (this.horizon) this.horizon.saveState();
    this.disposeHorizon();
    this.paused = false;
    this.ui.mapOpen = false;
    this.ui.worldPanelClose = null;
    this.ui.mainMenu();
  }

  disposeHorizon() {
    if (this.horizon) { this.horizon.dispose(); this.horizon = null; }
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
  }

  openMap(fromPause = false) {
    if (!this.horizon || this.race) return;
    this.paused = true;
    this.horizon.setPaused(true);
    this.ui.horizonMap(fromPause);
  }

  closeMap() {
    this.ui.mapOpen = false;
    // the key that closed the map must not reopen it on the next frame
    for (const k of ['KeyM', 'Tab']) this.input.pressed.delete(k);
    if (!this.horizon) return;
    this.horizon.requestMap = false;
    this.paused = false;
    this.horizon.setPaused(false);
    this.ui.hide();
  }

  setWaypoint(marker) { if (this.horizon) this.horizon.setWaypoint(marker); }

  fastTravel(marker) {
    if (!this.horizon) return;
    this.horizon.teleportTo(marker);
    this.closeMap();
  }

  startRace(config, ctx) {
    this.disposeRace();
    this.lastRaceConfig = { config, ctx };
    this.raceCtx = ctx;
    this.ui.hide();
    this.audio.init();
    this.race = new Race({ renderer: this.renderer, config, input: this.input, audio: this.audio, onFinish: (results) => this.onRaceFinished(results) });
    this.paused = false;
  }

  onRaceFinished(results) {
    const ctx = { ...this.raceCtx };
    const me = results.find(r => r.isPlayer && r.playerIndex === 0);
    if (me && me.bestLap && ctx.carId && recordBestLap(this.profile, ctx.trackId, ctx.carId, me.bestLap)) ctx.newBest = me.bestLap;
    if (ctx.mode === 'timetrial' && this.race) {
      const g = this.race.ghostCandidate();
      const key = `${ctx.trackId}:${ctx.carId}`;
      const prev = loadGhost(key);
      if (g && (!prev || g.lapTime < prev.lapTime)) { saveGhost(key, g); ctx.ghostSaved = true; }
    }
    if (ctx.mode === 'career') {
      ctx.career = applyCareerResult(this.profile, ctx.seriesId, results);
      this._refreshIdleCars();
    }
    if (ctx.mode === 'horizon' && me && this.horizon) {
      const field = results.length;
      const credits = Math.round((EVENT_PRIZE[me.rank - 1] || 200) * (ctx.laps > 2 ? 1.3 : 1));
      const xp = 500 + Math.max(0, field - me.rank) * 90 + (me.rank === 1 ? 500 : me.rank <= 3 ? 200 : 0);
      this.profile.money += credits;
      this.profile.stats.races++;
      if (me.rank === 1) this.profile.stats.wins++;
      if (me.rank <= 3) this.profile.stats.podiums++;
      const prev = this.profile.horizon.events[ctx.eventId];
      if (!prev || me.rank < prev) this.profile.horizon.events[ctx.eventId] = me.rank;
      this.horizon.addXp(xp);
      ctx.horizonReward = { credits, xp };
      this.save();
    }
    document.getElementById('hud-layer').classList.add('hidden');
    this.ui.results(results, ctx);
  }

  restartRace() {
    if (!this.lastRaceConfig) return this.ui.mainMenu();
    const { config, ctx } = this.lastRaceConfig;
    if (ctx.mode === 'timetrial') { config.ghost = loadGhost(`${ctx.trackId}:${ctx.carId}`); ctx.hasGhost = !!config.ghost; }
    if (ctx.mode === 'career') {
      // Career events can't be replayed once scored; only allow restart mid-race.
      if (this.race && this.race.state !== 'finished') { this.startRace(config, ctx); return; }
      return this.horizon ? this.returnToHorizon() : this.ui.mainMenu();
    }
    this.startRace(config, ctx);
  }

  quitRace() {
    if (this.horizon) return this.returnToHorizon();
    this.disposeRace();
    this.paused = false;
    this.ui.mainMenu();
  }

  /** Leave a finished race and show a menu screen ('menu' | 'career'). */
  leaveRace(where = 'menu') {
    // championships are raced from the world, so they go back to it
    if (where === 'horizon' || (where === 'career' && this.horizon)) return this.returnToHorizon();
    this.disposeRace();
    this.paused = false;
    this.ui.mainMenu();
  }

  disposeRace() {
    if (this.race) { this.race.dispose(); this.race = null; }
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
  }

  togglePause() {
    const live = this.race || this.horizon;
    if (!live) return;
    this.paused = !this.paused;
    live.setPaused(this.paused);
    if (this.paused) this.ui.pause(); else this.ui.hide();
  }

  // ------------------------------------------------------------ Profile
  save() { saveProfile(this.profile); }
  resetProfile() { this.profile = resetProfile(); this.setup = null; this._refreshIdleCars(); }
  buyCar(id) { const ok = buyCar(this.profile, id); if (ok) this._refreshIdleCars(); return ok; }
  buyUpgrade(carId, upId) { return buyUpgrade(this.profile, carId, upId); }
  restartSeries(id) { restartSeries(this.profile, id); }

  toggleFullscreen() {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  }
}

window.app = new App();
