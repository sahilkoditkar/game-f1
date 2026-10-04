import * as THREE from 'three';
import { Track } from './track.js';
import { buildScenery } from './scenery.js';
import { Car, makeGhost } from './car.js';
import { driveAI } from './ai.js';
import { collideCars, crashShake } from './crash.js';
import { HUD } from './hud.js';
import { DriftFx } from './fx.js';
import { buildSun, aimSun, buildEnvironment, updateChaseCamera, snapChaseCamera } from './scenekit.js';

const clamp = THREE.MathUtils.clamp;

export class Race {
  /**
   * @param {object} o
   * @param {THREE.WebGLRenderer} o.renderer
   * @param {object} o.config  { track, laps, players:[], ai:[], mode, quality }
   * @param {Input} o.input
   * @param {AudioSystem} o.audio
   * @param {function} o.onFinish(results)
   */
  constructor(o) {
    this.renderer = o.renderer;
    this.config = o.config;
    this.input = o.input;
    this.audio = o.audio;
    this.onFinish = o.onFinish;
    this.quality = o.config.quality || 'high';

    this.scene = new THREE.Scene();
    this.track = new Track(o.config.track, this.quality);
    this.theme = this.track.theme;
    this.scene.background = new THREE.Color(this.theme.sky);
    this.scene.fog = new THREE.Fog(this.theme.fog, this.theme.night ? 60 : 180, this.theme.night ? 520 : 1400);
    this.scene.add(this.track.group);
    this.scene.add(buildScenery(this.track, this.quality));
    this._lights();
    this._environment();

    this.cars = [];
    this.players = [];
    this.time = 0;
    this.state = 'countdown';
    this.countdown = 3.9;
    this.lastCount = -1;
    this.finishDelay = 0;
    this.paused = false;
    this.elapsed = 0;

    this.tmp = new THREE.Vector3();
    this.tmp2 = new THREE.Vector3();
    this._setupCars();
    this.fx = new DriftFx(this.scene, this.track, this.quality);
    this.hud = new HUD(this.players.length, this.track, this.cars, this.config);
    this._setupCameras();
    this._setupAudio();
    this.input.setTouchVisible(this.players.length === 1);
    this.track.setStartLights(0, false);
    this._setupGhost();
  }

  _lights() {
    this.sun = buildSun(this.scene, this.theme, this.quality !== 'low');
  }

  _environment() {
    this.envTex = buildEnvironment(this.renderer, this.theme);
    this.scene.environment = this.envTex;
    this.scene.environmentIntensity = this.theme.night ? 0.5 : 0.9;
  }

  _setupGhost() {
    this.ghost = null;
    this.ghostData = this.config.ghost || null; // { samples: [[x,z,heading],...], step, lapTime }
    this.recording = null;
    this.bestRecording = null;
    if (this.config.mode !== 'timetrial') return;
    const p = this.players[0];
    const ghostMesh = makeGhost(p.shape, 0x9ad6ff, this.quality);
    ghostMesh.visible = false;
    this.scene.add(ghostMesh);
    this.ghost = ghostMesh;
  }

  _updateGhost(dt) {
    if (!this.ghost) return;
    const p = this.players[0];
    if (this.state === 'countdown' || p.lap < 1 || p.finished) { this.ghost.visible = false; return; }
    const t = this.time - p.lapStart;
    // record current lap at 20 Hz
    if (this.recording) {
      const need = Math.floor(t / this.recording.step);
      while (this.recording.samples.length <= need) this.recording.samples.push([+p.pos.x.toFixed(2), +p.pos.z.toFixed(2), +p.heading.toFixed(3)]);
    }
    const g = this.ghostData;
    if (!g || !g.samples.length) { this.ghost.visible = false; return; }
    const f = t / g.step;
    const i = Math.min(g.samples.length - 1, Math.floor(f));
    const j = Math.min(g.samples.length - 1, i + 1);
    const k = f - i;
    const a = g.samples[i], b = g.samples[j];
    this.ghost.visible = t < g.lapTime + 0.5;
    const gx = a[0] + (b[0] - a[0]) * k, gz = a[1] + (b[1] - a[1]) * k;
    this.tmp.set(gx, 0, gz);
    this.ghostIdx = this.track.nearestIndex(this.tmp, this.ghostIdx ?? null);
    this.ghost.position.set(gx, this.track.heightAtPos(this.tmp, this.ghostIdx) + 0.12, gz);
    let dh = b[2] - a[2];
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    this.ghost.rotation.y = a[2] + dh * k;
    const wheels = this.ghost.userData.wheels;
    for (const w of wheels) w.rotation.x += dt * 30;
  }

  _setupCars() {
    const cfg = this.config;
    const grid = [];
    this.dynamic = !!cfg.dynamic;
    cfg.ai.forEach((a, i) => {
      const car = new Car({ name: a.name, color: a.color, stats: a.stats, shape: a.shape, isPlayer: false, aiSkill: a.skill, quality: this.quality });
      car.laneBase = ((i % 3) - 1) * this.track.halfWidth * 0.35;
      if (this.dynamic) {
        car.paceScale = 0.95;
        // Target time gap to the player in seconds: a couple of drivers just ahead, most just behind.
        car.desiredGap = -1.5 + (i / Math.max(1, cfg.ai.length - 1)) * 6.5;
      }
      grid.push(car);
    });
    cfg.players.forEach((p, i) => {
      const car = new Car({ name: p.name, color: p.color, stats: p.stats, shape: p.shape, isPlayer: true, playerIndex: i, quality: this.quality });
      car.scheme = p.scheme; car.pad = p.pad ?? -1;
      this.players.push(car);
      grid.push(car);
    });
    // Players start at the back of the grid.
    grid.forEach((car, slot) => {
      const g = this.track.gridSlot(slot);
      car.place(g.x, g.z, g.heading, g.y);
      car.trackIdx = g.idx;
      if (this.track.open) { car.lap = 1; car.nextSector = 1; car.progress = g.idx; }
      else { car.lap = 0; car.nextSector = this.track.sectorCount; car.progress = -(this.track.count - g.idx); } // waiting to cross the line
      this.scene.add(car.mesh);
      this.cars.push(car);
    });
    // headlights for players at night
    if (this.theme.night) {
      for (const car of this.players) {
        for (const sx of [-0.6, 0.6]) {
          const spot = new THREE.SpotLight(0xfff6d5, 60, 70, 0.45, 0.5, 1.2);
          spot.position.set(sx, 0.7, 2);
          spot.target.position.set(sx, 0.2, 30);
          car.mesh.add(spot); car.mesh.add(spot.target);
        }
      }
    }
  }

  _setupCameras() {
    this.cameras = this.players.map(() => {
      const cam = new THREE.PerspectiveCamera(70, 1, 0.5, 2500);
      cam.userData.shake = 0;
      return cam;
    });
    this.cameras.forEach((cam, i) => this._snapCamera(cam, this.players[i]));
    this.resize();
  }

  _setupAudio() {
    this.audio.init();
    this.engineVoices = this.players.map(() => this.audio.createEngine());
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    const n = this.players.length;
    this.vertical = n === 2 && w / h >= 1.35;
    this.viewports = [];
    if (n === 1) this.viewports.push({ x: 0, y: 0, w, h });
    else if (this.vertical) { this.viewports.push({ x: 0, y: 0, w: w / 2, h }, { x: w / 2, y: 0, w: w / 2, h }); }
    else { this.viewports.push({ x: 0, y: h / 2, w, h: h / 2 }, { x: 0, y: 0, w, h: h / 2 }); }
    this.viewports.forEach((v, i) => { this.cameras[i].aspect = v.w / v.h; this.cameras[i].updateProjectionMatrix(); });
    this.hud.layout(n, this.vertical);
  }

  _snapCamera(cam, car) { snapChaseCamera(cam, car, this.tmp2); }

  _updateCamera(cam, car, dt) { updateChaseCamera(cam, car, dt, this.tmp2); }

  /** Move a player car back onto the track facing the right way. */
  resetCar(car) {
    const s = this.track.samples[car.trackIdx];
    car.place(s.p.x, s.p.z, s.heading, s.p.y);
    car.wrongWay = false;
  }

  update(dt) {
    if (this.paused) return;
    dt = Math.min(dt, 1 / 20);
    this.elapsed += dt;

    // Countdown
    if (this.state === 'countdown') {
      this.countdown -= dt;
      const n = Math.ceil(this.countdown);
      if (n !== this.lastCount) {
        this.lastCount = n;
        if (n >= 1 && n <= 3) { this.hud.showCountdown(String(n)); this.audio.countdown(n); this.track.setStartLights(4 - n, false); }
        if (n <= 0) {
          this.hud.showCountdown('GO!', true); this.audio.countdown(0); this.track.setStartLights(0, true); this.state = 'racing'; this.time = 0;
          for (const c of this.cars) c.lapStart = 0;
          if (this.ghost && this.track.open) this.recording = { step: 0.05, samples: [], lapTime: null };
        }
      }
    } else {
      this.time += dt;
    }
    const live = this.state !== 'countdown';

    // Inputs
    this.players.forEach((car, i) => {
      const r = this.input.read(car.scheme, car.pad, i);
      if (car.finished && this.track.open) { car.input.throttle = 0; car.input.steer = 0; car.input.brake = car.vf > 1 ? 1 : 0; car.input.handbrake = car.vf <= 1; car.parked = car.speed < 0.5; }
      else if (car.finished) { car.autopilot = true; car.aiSkill = 0.7; }
      else { car.input.throttle = r.throttle; car.input.brake = r.brake; car.input.steer = r.steer; car.input.handbrake = r.handbrake; }
      if (r.reset && live && !car.finished) this.resetCar(car);
    });
    let bestPlayerProgress = null;
    for (const p of this.players) if (bestPlayerProgress === null || p.progress > bestPlayerProgress) bestPlayerProgress = p.progress;
    const ctx = { track: this.track, cars: this.cars, live, bestPlayerProgress, time: this.time, dynamic: this.dynamic };
    for (const car of this.cars) {
      if (car.finished && this.track.open) { car.input.throttle = 0; car.input.steer = 0; car.input.brake = car.vf > 1 ? 1 : 0; car.input.handbrake = car.vf <= 1; car.parked = car.speed < 0.5; continue; }
      if (!car.isPlayer || car.autopilot) driveAI(car, ctx, dt);
    }

    // Physics (sub-step for stability at high speed)
    const steps = 2, sdt = dt / steps;
    for (let s = 0; s < steps; s++) {
      for (const car of this.cars) car.update(sdt, { track: this.track, live });
      this._collideCars();
    }

    // Laps / progress / ranking
    for (const car of this.cars) this._lapLogic(car);
    this._rank();
    this._updateDynamic(dt);

    // Skid marks and tyre smoke
    this.fx.setViewport(this.viewports[0].h, this.cameras[0].fov);
    this.fx.update(this.cars, dt);

    // Cameras, audio, fx
    this.players.forEach((car, i) => {
      const cam = this.cameras[i];
      if (car.wallHit > 4) { cam.userData.shake = Math.min(0.6, car.wallHit * 0.05); this.audio.impact(car.wallHit); }
      if (car.carHit > 1.5) { cam.userData.shake = Math.max(cam.userData.shake, crashShake(car.carHit)); this.audio.impact(car.carHit); }
      car.carHit = 0;
      this._updateCamera(cam, car, dt);
      const v = this.engineVoices[i];
      if (v) this.audio.updateEngine(v, clamp(car.speed / car.stats.maxSpeed, 0, 1), car.input.throttle, car.drifting || (car.input.handbrake && car.speed > 5), (this.players.length > 1 ? 0.7 : 1) * (car.finished ? 0.25 : 1));
    });

    // Shadow camera follows the players, snapped to shadow-map texels so edges don't shimmer
    const focus = this.players.length === 1 ? this.players[0].pos.clone() : this.players[0].pos.clone().add(this.players[1].pos).multiplyScalar(0.5);
    aimSun(this.sun, focus);
    if (this.players.length > 1) {
      const d = this.players[0].pos.distanceTo(this.players[1].pos);
      const sz = clamp(60 + d * 0.6, 90, 260);
      if (Math.abs(this.sun.shadow.camera.right - sz) > 5) {
        this.sun.shadow.camera.left = -sz; this.sun.shadow.camera.right = sz; this.sun.shadow.camera.top = sz; this.sun.shadow.camera.bottom = -sz;
        this.sun.shadow.camera.updateProjectionMatrix();
      }
    }

    this._updateGhost(dt);
    this.hud.update(this, dt);

    // Finish handling
    if (this.state === 'racing' && this.players.every(p => p.finished)) {
      this.state = 'finishing';
      this.finishDelay = 2.5;
      this.audio.finish();
    }
    if (this.state === 'finishing') {
      this.finishDelay -= dt;
      if (this.finishDelay <= 0) { this.state = 'finished'; this.onFinish(this.results()); }
    }
  }

  /** Car-to-car contact as rigid-body crashes: mass, where they touch, spin (see crash.js). */
  _collideCars() {
    const cars = this.cars;
    for (let i = 0; i < cars.length; i++) {
      const a = cars[i];
      if (a.parked) continue;
      for (let j = i + 1; j < cars.length; j++) {
        const b = cars[j];
        if (b.parked) continue;
        collideCars(a, b);
      }
    }
  }

  _lapLogic(car) {
    const tr = this.track;
    if (tr.open) {
      if (!car.finished && car.trackIdx >= tr.finishIdx && tr._param(car.pos, car.trackIdx) >= 0) {
        const t = this.time - car.lapStart;
        car.lapTimes.push(t); car.bestLap = t;
        car.finished = true; car.finishTime = this.time;
        if (car.isPlayer) {
          let sub = `P${car.rank}`;
          if (this.ghost && car.playerIndex === 0) {
            const ref = this.ghostData ? this.ghostData.lapTime : null;
            if (ref) { const d = t - ref; sub = `${d <= 0 ? '' : '+'}${d.toFixed(3)} vs ghost`; }
            if (this.recording) { this.recording.lapTime = t; this.bestRecording = this.recording; this.recording = null; }
          }
          this.audio.lap();
          this.hud.flash(car.playerIndex, `FINISH · ${fmtTime(t)}`, sub);
        }
      }
      car.progress = tr.progressAt(car.pos, car.trackIdx);
      return;
    }
    const sector = tr.sectorOf(car.trackIdx);
    const C = tr.sectorCount;
    if (car.nextSector < C && sector === car.nextSector) car.nextSector++;
    else if (car.nextSector === C && sector === 0 && !car.finished) {
      // crossed the start/finish line in the right direction
      if (car.lap >= 1) {
        const t = this.time - car.lapStart;
        car.lapTimes.push(t);
        const wasBest = t < car.bestLap;
        if (wasBest) car.bestLap = t;
        if (car.isPlayer) {
          this.audio.lap();
          let sub = wasBest ? 'BEST LAP' : '';
          if (this.ghost && car.playerIndex === 0) {
            const ref = this.ghostData ? this.ghostData.lapTime : null;
            if (ref) { const d = t - ref; sub = `${d <= 0 ? '' : '+'}${d.toFixed(3)} vs ghost`; }
            if (this.recording && (!this.bestRecording || t < this.bestRecording.lapTime)) {
              this.recording.lapTime = t;
              this.bestRecording = this.recording;
            }
          }
          this.hud.flash(car.playerIndex, `LAP ${car.lap} · ${fmtTime(t)}`, sub);
        }
      }
      car.lap++;
      car.lapStart = this.time;
      car.nextSector = 1;
      if (this.ghost && car.playerIndex === 0 && !car.finished) this.recording = { step: 0.05, samples: [], lapTime: null };
      if (this.ghost && car.playerIndex === 0 && car.lap > this.config.laps) this.recording = null;
      if (car.lap > this.config.laps) {
        car.finished = true;
        car.finishTime = this.time;
        if (car.isPlayer) this.hud.flash(car.playerIndex, 'FINISH!', `P${car.rank}`);
      }
      if (car.isPlayer && car.lap === this.config.laps && !car.finished) this.hud.flash(car.playerIndex, 'FINAL LAP', '');
    }
    car.progress = (car.lap - 1) * tr.count + tr.progressAt(car.pos, car.trackIdx);
  }

  _rank() {
    const sorted = [...this.cars].sort((a, b) => {
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.progress - a.progress;
    });
    sorted.forEach((c, i) => c.rank = i + 1);
    this.ranking = sorted;
  }

  /**
   * Dynamic AI: real-time pace matching. Keeps a timeline of the lead player's
   * progress so each AI's time gap to the player is known every frame, then
   * steers the AI's pace toward its own target gap. Works from the first
   * metre and on point-to-point stages, no lap needed.
   */
  _updateDynamic(dt) {
    if (!this.dynamic || this.state === 'countdown') return;
    let p = null;
    for (const q of this.players) if (!p || q.progress > p.progress) p = q;
    if (!p) return;
    this.timeline = this.timeline || [];
    if (this.timeline.length === 0 || this.time - this.timeline[this.timeline.length - 1][0] >= 0.2) this.timeline.push([this.time, p.progress]);
    const spacing = this.track.spacing;
    const vRef = Math.max(8, p.speed);
    for (const car of this.cars) {
      if (car.isPlayer || car.paceScale === undefined || car.finished) continue;
      let gap; // seconds the AI is behind the player (negative = ahead)
      if (car.progress <= p.progress) gap = this.time - this._timeAtProgress(car.progress);
      else gap = -((car.progress - p.progress) * spacing) / vRef;
      gap = Math.max(-15, Math.min(15, gap));
      const err = gap - car.desiredGap; // positive: further behind than wanted -> more pace
      const want = Math.max(0.7, Math.min(1.3, 1 + (err / 4) * 0.18));
      car.paceScale += (want - car.paceScale) * Math.min(1, dt * 1.2);
    }
  }

  _timeAtProgress(P) {
    const tl = this.timeline;
    if (!tl || !tl.length || P <= tl[0][1]) return tl && tl.length ? tl[0][0] : 0;
    let lo = 0, hi = tl.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tl[mid][1] < P) lo = mid + 1; else hi = mid; }
    const b = tl[lo], a = tl[Math.max(0, lo - 1)];
    const span = b[1] - a[1];
    const f = span > 0 ? (P - a[1]) / span : 1;
    return a[0] + (b[0] - a[0]) * Math.max(0, Math.min(1, f));
  }

  /** Best recorded lap of this session (time trial), or null. */
  ghostCandidate() {
    const r = this.bestRecording;
    if (!r || !r.lapTime || r.samples.length < 10) return null;
    return { step: r.step, samples: r.samples, lapTime: r.lapTime };
  }

  results() {
    this._rank();
    return this.ranking.map(c => ({
      name: c.name, isPlayer: c.isPlayer, playerIndex: c.playerIndex, color: c.color, rank: c.rank,
      finished: c.finished, time: c.finished ? c.finishTime : null, bestLap: isFinite(c.bestLap) ? c.bestLap : null,
      laps: c.finished ? this.config.laps : Math.max(0, c.lap - 1),
      stagePct: this.track.open ? Math.round(100 * Math.max(0, Math.min(1, (c.trackIdx - this.track.startIdx) / (this.track.finishIdx - this.track.startIdx)))) : null,
    }));
  }

  render() {
    const r = this.renderer;
    const H = window.innerHeight;
    r.setScissorTest(true);
    this.viewports.forEach((v, i) => {
      r.setViewport(v.x, v.y, v.w, v.h);
      r.setScissor(v.x, v.y, v.w, v.h);
      // hide the driver's own car body? no – third person, keep it.
      r.render(this.scene, this.cameras[i]);
    });
    r.setScissorTest(false);
    void H;
  }

  setPaused(p) { this.paused = p; if (p) this.audio.stopEngines(); else this._setupAudio(); }

  dispose() {
    this.audio.stopEngines();
    this.hud.dispose();
    this.fx.dispose();
    if (this.envTex) this.envTex.dispose();
    this.input.setTouchVisible(false);
    this.scene.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) { const ms = Array.isArray(o.material) ? o.material : [o.material]; for (const m of ms) { if (m.map) m.map.dispose(); m.dispose(); } }
    });
  }
}

export function fmtTime(t) {
  if (t === null || t === undefined || !isFinite(t)) return '--:--.---';
  const m = Math.floor(t / 60), s = Math.floor(t % 60), ms = Math.floor((t * 1000) % 1000);
  return `${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}
