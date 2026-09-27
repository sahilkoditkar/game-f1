// Drift effects: rubber skid marks laid on the road and tyre smoke / dust puffs.
// Both are pooled ring buffers in a single draw call each, so cost is flat however
// much sliding is going on.
import * as THREE from 'three';

const clamp = THREE.MathUtils.clamp;
const ROAD_LIFT = 0.12; // the road surface sits this far above the centreline samples (see Track._buildMeshes)

const SKID_VERT = /* glsl */`
  attribute float aAlpha;
  varying float vAlpha;
  #include <fog_pars_vertex>
  void main() {
    vAlpha = aAlpha;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;
const SKID_FRAG = /* glsl */`
  uniform vec3 uColor;
  varying float vAlpha;
  #include <fog_pars_fragment>
  void main() {
    gl_FragColor = vec4(uColor, vAlpha);
    #include <fog_fragment>
  }`;

const SMOKE_VERT = /* glsl */`
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  uniform float uScale;
  varying float vAlpha;
  varying vec3 vColor;
  #include <fog_pars_vertex>
  void main() {
    vAlpha = aAlpha;
    vColor = aColor;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = min(512.0, aSize * uScale / max(0.5, -mvPosition.z));
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;
const SMOKE_FRAG = /* glsl */`
  uniform sampler2D uMap;
  varying float vAlpha;
  varying vec3 vColor;
  #include <fog_pars_fragment>
  void main() {
    float a = texture2D(uMap, gl_PointCoord).a * vAlpha;
    if (a < 0.004) discard;
    gl_FragColor = vec4(vColor, a);
    #include <fog_fragment>
  }`;

/** Soft round puff sprite. */
function makePuffTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.minFilter = THREE.LinearFilter;
  return t;
}

/**
 * How hard a car's tyres are sliding, 0..1. Rear axle lets go in a drift; the
 * handbrake locks the rears on a straight too.
 */
export function slideIntensity(car) {
  const v = car.speed;
  if (v < 3) return 0;
  let k = car.slide * clamp((Math.abs(car.vr) - 1.5) / 6, 0, 1);
  if (car.input.handbrake && v > 6) k = Math.max(k, 0.55 * car.slide);
  return k;
}

export class DriftFx {
  /**
   * @param {THREE.Scene} scene
   * @param {import('./track.js').Track} track
   * @param {string} quality 'high' | 'low'
   */
  constructor(scene, track, quality = 'high') {
    this.scene = scene;
    this.track = track;
    const th = track.theme;
    const low = quality === 'low';
    this.night = !!th.night;

    // ---- Skid marks: ring buffer of quads (2 triangles each) ------------------
    this.maxSegs = low ? 700 : 2200;
    this.segHead = 0;
    const segs = this.maxSegs;
    const pos = new Float32Array(segs * 4 * 3);
    const alpha = new Float32Array(segs * 4);
    const idx = new Uint32Array(segs * 6);
    for (let i = 0; i < segs; i++) {
      const b = i * 4, o = i * 6;
      idx[o] = b; idx[o + 1] = b + 2; idx[o + 2] = b + 1;
      idx[o + 3] = b + 1; idx[o + 4] = b + 2; idx[o + 5] = b + 3;
    }
    const sg = new THREE.BufferGeometry();
    this.skidPos = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.skidAlpha = new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage);
    sg.setAttribute('position', this.skidPos);
    sg.setAttribute('aAlpha', this.skidAlpha);
    sg.setIndex(new THREE.BufferAttribute(idx, 1));
    sg.setDrawRange(0, 0);
    const skidMat = new THREE.ShaderMaterial({
      vertexShader: SKID_VERT, fragmentShader: SKID_FRAG,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uColor: { value: new THREE.Color(0x07070a) } }]),
      transparent: true, depthWrite: false, fog: true, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    this.skids = new THREE.Mesh(sg, skidMat);
    this.skids.frustumCulled = false;
    this.skids.renderOrder = 1;
    scene.add(this.skids);

    // ---- Smoke: pooled points -------------------------------------------------
    this.maxPuffs = low ? 220 : 600;
    const n = this.maxPuffs;
    this.puffPos = new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.puffSize = new THREE.BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage);
    this.puffAlpha = new THREE.BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage);
    this.puffColor = new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.puffs = []; // { vx, vy, vz, life, age, a0, s0, s1 } per slot; life <= 0 = free
    for (let i = 0; i < n; i++) this.puffs.push({ vx: 0, vy: 0, vz: 0, life: 0, age: 0, a0: 0, s0: 0, s1: 0 });
    this.puffHead = 0;
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', this.puffPos);
    pg.setAttribute('aSize', this.puffSize);
    pg.setAttribute('aAlpha', this.puffAlpha);
    pg.setAttribute('aColor', this.puffColor);
    this.puffTex = makePuffTexture();
    const smokeMat = new THREE.ShaderMaterial({
      vertexShader: SMOKE_VERT, fragmentShader: SMOKE_FRAG,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uMap: { value: null }, uScale: { value: 500 } }]),
      transparent: true, depthWrite: false, fog: true,
    });
    smokeMat.uniforms.uMap.value = this.puffTex;
    this.smokeMat = smokeMat;
    this.smoke = new THREE.Points(pg, smokeMat);
    this.smoke.frustumCulled = false;
    this.smoke.renderOrder = 2;
    scene.add(this.smoke);

    // Colours: rubber smoke is light grey, dust takes the ground colour; both dim at night.
    const dim = this.night ? 0.35 : 1;
    this.smokeColor = new THREE.Color(0xd8d8dc).multiplyScalar(dim);
    this.dustColor = new THREE.Color(th.groundAlt).lerp(new THREE.Color(0xffffff), 0.25).multiplyScalar(dim);

    // Per-wheel trail state, keyed by wheel object
    this.trails = new Map();
    this.tmp = new THREE.Vector3();
  }

  /** Point size scale so aSize is in metres: viewport height / (2 tan(fov/2)). */
  setViewport(heightPx, fovDeg) {
    this.smokeMat.uniforms.uScale.value = heightPx / (2 * Math.tan((fovDeg * Math.PI) / 360));
  }

  /** @param {import('./car.js').Car[]} cars */
  update(cars, dt) {
    for (const car of cars) this._updateCar(car, dt);
    this._updatePuffs(dt);
  }

  _updateCar(car, dt) {
    const k = slideIntensity(car);
    const sinH = Math.sin(car.heading), cosH = Math.cos(car.heading);
    const fx = sinH, fz = cosH;          // forward
    const lx = cosH, lz = -sinH;         // car-local +x (left side)
    const track = this.track;
    for (const w of car.wheels) {
      const front = car.frontWheels.includes(w.parent);
      // Fronts only mark when the whole car is really sideways (the handbrake leaves the fronts rolling).
      const wk = front ? (car.input.handbrake ? 0 : k * clamp((Math.abs(car.vr) - 5) / 6, 0, 1)) : k;
      const p = w.parent.position;      // wheel pivot in car space: (x, r, z)
      const wx = car.pos.x + fx * p.z + lx * p.x;
      const wz = car.pos.z + fz * p.z + lz * p.x;
      let trail = this.trails.get(w);
      if (!trail) { trail = { on: false, lx: 0, lz: 0, x: 0, z: 0, a: 0, acc: 0 }; this.trails.set(w, trail); }

      const onRoad = Math.abs(track.lateral(this.tmp.set(wx, 0, wz), car.trackIdx)) < track.samples[car.trackIdx].hw + 0.9;
      const marking = wk > 0.08 && onRoad;
      if (marking) {
        const y = track.heightAtPos(this.tmp, car.trackIdx) + ROAD_LIFT + 0.02;
        if (!trail.on) { trail.on = true; trail.x = wx; trail.z = wz; trail.lx = 0; trail.lz = 0; trail.a = wk * 0.7; }
        else {
          const dx = wx - trail.x, dz = wz - trail.z, d = Math.hypot(dx, dz);
          if (d > 0.3) {
            // edge perpendicular to the contact patch's path; the first segment has no previous edge
            const hw = 0.14, ex = (-dz / d) * hw, ez = (dx / d) * hw;
            if (trail.lx === 0 && trail.lz === 0) { trail.lx = ex; trail.lz = ez; }
            this._pushSeg(trail.x - trail.lx, y, trail.z - trail.lz, trail.x + trail.lx, trail.z + trail.lz,
              wx - ex, y, wz - ez, wx + ex, wz + ez, trail.a, wk * 0.7);
            trail.x = wx; trail.z = wz; trail.lx = ex; trail.lz = ez; trail.a = wk * 0.7;
            if (d > 6) trail.on = false; // teleported (reset) – start a fresh trail
          }
        }
      } else trail.on = false;

      // Smoke off sliding tyres; dust when off the road.
      if (wk > 0.1 && car.speed > 3) {
        trail.acc += dt * (front ? 14 : 26) * wk;
        while (trail.acc >= 1) { trail.acc -= 1; this._spawnPuff(car, wx, wz, wk, onRoad && !car.offroad); }
      }
    }
  }

  _pushSeg(x0, y, z0, x1, z1, x2, y2, z2, x3, z3, a01, a23) {
    const i = this.segHead;
    const P = this.skidPos.array, A = this.skidAlpha.array, b = i * 4;
    P[b * 3] = x0; P[b * 3 + 1] = y; P[b * 3 + 2] = z0;
    P[b * 3 + 3] = x1; P[b * 3 + 4] = y; P[b * 3 + 5] = z1;
    P[b * 3 + 6] = x2; P[b * 3 + 7] = y2; P[b * 3 + 8] = z2;
    P[b * 3 + 9] = x3; P[b * 3 + 10] = y2; P[b * 3 + 11] = z3;
    A[b] = a01; A[b + 1] = a01; A[b + 2] = a23; A[b + 3] = a23;
    this.segHead = (i + 1) % this.maxSegs;
    this.segCount = Math.min(this.maxSegs, (this.segCount || 0) + 1);
    this.skids.geometry.setDrawRange(0, this.segCount * 6);
    this.skidPos.needsUpdate = true;
    this.skidAlpha.needsUpdate = true;
  }

  _spawnPuff(car, x, z, k, rubber) {
    const i = this.puffHead;
    this.puffHead = (i + 1) % this.maxPuffs;
    const p = this.puffs[i];
    const r = () => Math.random() - 0.5;
    p.vx = car.vel.x * 0.35 + r() * 1.6;
    p.vz = car.vel.z * 0.35 + r() * 1.6;
    p.vy = 0.9 + Math.random() * 1.2;
    p.life = rubber ? 0.9 + Math.random() * 0.6 : 1.1 + Math.random() * 0.8;
    p.age = 0;
    p.a0 = (rubber ? 0.5 : 0.42) * clamp(k, 0.3, 1);
    p.s0 = 0.6 + Math.random() * 0.3;
    p.s1 = (rubber ? 2.4 : 3.2) + Math.random() * 1.2;
    const y = this.track.heightAtPos(this.tmp.set(x, 0, z), car.trackIdx) + ROAD_LIFT + 0.25;
    this.puffPos.setXYZ(i, x + r() * 0.4, y, z + r() * 0.4);
    const c = rubber ? this.smokeColor : this.dustColor;
    this.puffColor.setXYZ(i, c.r, c.g, c.b);
    this.puffSize.setX(i, p.s0);
    this.puffAlpha.setX(i, p.a0);
    this.puffColor.needsUpdate = true;
  }

  _updatePuffs(dt) {
    const pos = this.puffPos.array, S = this.puffSize.array, A = this.puffAlpha.array;
    let any = false;
    for (let i = 0; i < this.maxPuffs; i++) {
      const p = this.puffs[i];
      if (p.life <= 0) continue;
      any = true;
      p.age += dt;
      if (p.age >= p.life) { p.life = 0; A[i] = 0; continue; }
      const t = p.age / p.life;
      const damp = Math.exp(-2.2 * dt);
      p.vx *= damp; p.vz *= damp; p.vy = p.vy * damp + 0.4 * dt;
      pos[i * 3] += p.vx * dt; pos[i * 3 + 1] += p.vy * dt; pos[i * 3 + 2] += p.vz * dt;
      S[i] = p.s0 + (p.s1 - p.s0) * Math.sqrt(t);
      A[i] = p.a0 * (1 - t) * (1 - t);
    }
    if (any) { this.puffPos.needsUpdate = true; this.puffSize.needsUpdate = true; this.puffAlpha.needsUpdate = true; }
  }

  dispose() {
    this.scene.remove(this.skids); this.scene.remove(this.smoke);
    this.skids.geometry.dispose(); this.skids.material.dispose();
    this.smoke.geometry.dispose(); this.smoke.material.dispose();
    this.puffTex.dispose();
  }
}
