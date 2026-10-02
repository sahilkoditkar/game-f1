// Ambient traffic for Free Roam: kinematic cars that follow the road network in
// their lane, slow for corners, queue behind each other and the player, pick a
// turn at junctions, and are recycled as the player moves on.
import * as THREE from 'three';
import { buildCarMesh } from './carmodels.js';
import { mulberry32 } from './world.js';

const SHAPES = ['hatch', 'hatch', 'classic', 'muscle', 'gt', 'hatch', 'super'];
const COLORS = [0xd9d9df, 0x2b2e36, 0x8c939e, 0xb52a2a, 0x1f4e9c, 0xe6e6e6, 0x3f3f46, 0x6c8f3a, 0xc27a1a, 0x7a2d6d];
const KIND_SPEED = { highway: 29, road: 22, lane: 17, dirt: 12, street: 13 };
const SPAWN_MIN = 200, SPAWN_MAX = 520, DESPAWN = 640;

export class Traffic {
  /** @param {import('./horizon.js').Horizon} hz */
  constructor(hz, count) {
    this.hz = hz; this.W = hz.world;
    this.count = count;
    this.cars = [];
    this.group = new THREE.Group();
    hz.scene.add(this.group);
    this.rand = mulberry32(1337);
    this.pool = [];
    this.nearMissCd = 0;
    this.tmp = new THREE.Vector3();
  }

  /** Right-hand lane offset (metres along the left normal) for a road and travel direction. */
  laneFor(road, dir, slot = 0) {
    const hw = road.width / 2;
    const k = road.kind === 'highway' ? (slot ? 0.74 : 0.28) : 0.5;
    return -dir * hw * k;
  }

  _spawn() {
    const W = this.W, p = this.hz.car.pos;
    for (let tries = 0; tries < 60; tries++) {
      const idx = Math.floor(this.rand() * W.count);
      const s = W.samples[idx];
      const d = Math.hypot(s.p.x - p.x, s.p.z - p.z);
      if (d < SPAWN_MIN || d > SPAWN_MAX) continue;
      const road = W.roadOf(idx);
      if (road.kind === 'dirt' && this.rand() < 0.7) continue;
      if (!road.closed && (s.li < 30 || s.li > road.n - 30)) continue;
      // keep a gap from other traffic
      if (this.cars.some(c => Math.hypot(c.pos.x - s.p.x, c.pos.z - s.p.z) < 25)) continue;
      const dir = this.rand() < 0.5 ? 1 : -1;
      const car = this.pool.pop() || this._makeCar();
      car.road = road; car.dir = dir; car.s = s.li; car.slot = road.kind === 'highway' && this.rand() < 0.4 ? 1 : 0;
      car.lane = this.laneFor(road, dir, car.slot); car.lat = car.lane;
      car.speed = KIND_SPEED[road.kind] * (0.8 + this.rand() * 0.2); car.cruise = KIND_SPEED[road.kind] * (0.85 + this.rand() * 0.25);
      car.brake = false; car.heading = s.heading + (dir < 0 ? Math.PI : 0); car.lastJunction = -1;
      car.mesh.visible = true;
      this._placeMesh(car);
      this.cars.push(car);
      return true;
    }
    return false;
  }

  _makeCar() {
    const shape = SHAPES[Math.floor(this.rand() * SHAPES.length)];
    const color = COLORS[Math.floor(this.rand() * COLORS.length)];
    const mesh = buildCarMesh(shape, color, this.hz.quality);
    this.group.add(mesh);
    return { mesh, pos: new THREE.Vector3(), wheels: mesh.userData.wheels, front: mesh.userData.frontWheels, brakeLights: mesh.userData.brakeLights, spin: 0, steer: 0 };
  }

  _recycle(car) {
    car.mesh.visible = false;
    this.pool.push(car);
  }

  /** World position/heading for a car from its road parameter and lateral offset. */
  _placeMesh(car) {
    const W = this.W, road = car.road;
    const N = road.n;
    let f = car.s;
    if (road.closed) f = ((f % N) + N) % N; else f = Math.max(0, Math.min(N - 1, f));
    const i0 = Math.floor(f), u = f - i0;
    const a = W.samples[road.i0 + i0], b = W.samples[W.roadWrap(road, road.i0 + i0 + 1, true)];
    const px = a.p.x + (b.p.x - a.p.x) * u, pz = a.p.z + (b.p.z - a.p.z) * u, py = a.p.y + (b.p.y - a.p.y) * u;
    const nx = a.n.x + (b.n.x - a.n.x) * u, nz = a.n.z + (b.n.z - a.n.z) * u;
    car.pos.set(px + nx * car.lat, py + road.yOff + 0.02, pz + nz * car.lat);
    let h = Math.atan2(a.t.x, a.t.z) + (car.dir < 0 ? Math.PI : 0);
    // steer visually toward the lane change
    const dLat = (car.lane - car.lat) * car.dir;
    h += Math.max(-0.35, Math.min(0.35, dLat * 0.25));
    let dh = h - car.heading; while (dh > Math.PI) dh -= Math.PI * 2; while (dh < -Math.PI) dh += Math.PI * 2;
    car.heading += dh * 0.3;
    const slope = (a.slope + (b.slope - a.slope) * u) * car.dir;
    car.mesh.position.copy(car.pos);
    car.mesh.rotation.set(-Math.atan(slope), car.heading, 0, 'YXZ');
  }

  update(dt) {
    const W = this.W, player = this.hz.car;
    const pp = player.pos;
    // population
    for (let i = this.cars.length - 1; i >= 0; i--) {
      const c = this.cars[i];
      if (Math.hypot(c.pos.x - pp.x, c.pos.z - pp.z) > DESPAWN) { this._recycle(c); this.cars.splice(i, 1); }
    }
    let spawnBudget = 2;
    while (this.cars.length < this.count && spawnBudget-- > 0) if (!this._spawn()) break;

    const playerRoad = W.roadOf(player.trackIdx);
    const playerLat = W.lateral(pp, player.trackIdx);
    const playerLi = W.samples[player.trackIdx].li;
    const playerOnRoad = Math.abs(playerLat) < W.samples[player.trackIdx].hw + 1.5;

    for (let i = this.cars.length - 1; i >= 0; i--) {
      const car = this.cars[i];
      const road = car.road, N = road.n, sp = W.spacing;
      // target speed: cruise, limited by curvature ahead
      let target = car.cruise;
      const lookM = 12 + car.speed * 2.2;
      let maxCurv = 0;
      for (let m = 4; m < lookM; m += 8) {
        const idx = W.roadWrap(road, road.i0 + Math.round(car.s) + car.dir * Math.round(m / sp), true);
        maxCurv = Math.max(maxCurv, Math.abs(W.samples[idx].curv));
      }
      if (maxCurv > 1e-4) target = Math.min(target, Math.sqrt(3.2 / maxCurv));
      // queue behind traffic in the same lane and direction
      for (const o of this.cars) {
        if (o === car || o.road !== road || o.dir !== car.dir || Math.abs(o.lane - car.lane) > 2) continue;
        let ds = (o.s - car.s) * car.dir * sp;
        if (road.closed) { const L = N * sp; ds = ((ds % L) + L) % L; }
        if (ds > 0 && ds < 45) {
          const gap = 7 + car.speed * 0.9;
          if (ds < gap) target = Math.min(target, ds < 6 ? 0 : o.speed * 0.9);
          else target = Math.min(target, o.speed + (ds - gap) * 0.3);
        }
      }
      // the player ahead in our lane
      if (playerOnRoad && playerRoad === road && Math.abs(playerLat - car.lat) < 2.6) {
        let ds = (playerLi - car.s) * car.dir * sp;
        if (road.closed) { const L = N * sp; ds = ((ds % L) + L) % L; }
        if (ds > 0 && ds < 40) {
          const along = player.vel.x * Math.sin(car.heading) + player.vel.z * Math.cos(car.heading);
          target = Math.min(target, ds < 9 ? 0 : Math.max(0, along) + (ds - 9) * 0.4);
        }
      }
      // accelerate / brake
      const dv = target - car.speed;
      car.speed += Math.max(-9 * dt, Math.min(2.8 * dt, dv));
      car.brake = dv < -1.5;
      if (car.speed < 0) car.speed = 0;
      // lane change easing
      car.lat += Math.max(-3 * dt, Math.min(3 * dt, car.lane - car.lat));
      // advance
      const prevS = car.s;
      car.s += (car.dir * car.speed * dt) / sp;
      // junctions: maybe turn onto the crossing road
      for (const j of W.roadJunctions[W.samples[road.i0].road]) {
        const passed = car.dir > 0 ? (prevS < j.li && car.s >= j.li) : (prevS > j.li && car.s <= j.li);
        if (!passed || car.lastJunction === j.li) continue;
        car.lastJunction = j.li;
        if (this.rand() < 0.4) {
          const other = W.samples[j.other], oroad = W.roadOf(j.other);
          if (oroad.closed || (other.li > 25 && other.li < oroad.n - 25)) {
            car.road = oroad; car.s = other.li; car.dir = this.rand() < 0.5 ? 1 : -1;
            car.slot = oroad.kind === 'highway' && this.rand() < 0.4 ? 1 : 0;
            car.lane = this.laneFor(oroad, car.dir, car.slot); car.lat = car.lat * 0.5 + car.lane * 0.5;
            car.cruise = KIND_SPEED[oroad.kind] * (0.85 + this.rand() * 0.25);
            car.speed = Math.min(car.speed, 9);
            car.lastJunction = other.li;
          }
        }
        break;
      }
      // off the end of an open road: recycle
      if (!road.closed && (car.s < 2 || car.s > road.n - 3)) { this._recycle(car); this.cars.splice(i, 1); continue; }
      this._placeMesh(car);
      // wheels & lights
      car.spin += (car.speed / 0.36) * dt;
      for (const w of car.wheels) w.rotation.x = car.spin;
      for (const l of car.brakeLights) l.material.emissiveIntensity = car.brake ? 3.5 : 0.8;
    }
    this._collidePlayer(dt);
  }

  /** The player bounces off traffic (traffic is heavy and kinematic); near misses give XP. */
  _collidePlayer(dt) {
    const player = this.hz.car;
    const R = 2.3;
    this.nearMissCd -= dt;
    for (const c of this.cars) {
      const dx = player.pos.x - c.pos.x, dz = player.pos.z - c.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 4.2 * 4.2) continue;
      const d = Math.sqrt(d2) || 0.01;
      if (d < R) {
        const nx = dx / d, nz = dz / d, pen = R - d;
        player.pos.x += nx * pen; player.pos.z += nz * pen;
        const cvx = Math.sin(c.heading) * c.speed, cvz = Math.cos(c.heading) * c.speed;
        const rvx = player.vel.x - cvx, rvz = player.vel.z - cvz;
        const vn = rvx * nx + rvz * nz;
        if (vn < 0) {
          player.vel.x -= nx * vn * 1.5; player.vel.z -= nz * vn * 1.5;
          const fx = Math.sin(player.heading), fz = Math.cos(player.heading);
          player.vf = player.vel.x * fx + player.vel.z * fz;
          player.vr = player.vel.x * -fz + player.vel.z * fx;
          player.carHit = Math.max(player.carHit, -vn);
          c.speed *= 0.6;
        }
      } else if (this.nearMissCd <= 0 && player.speed > 18) {
        const rel = Math.hypot(player.vel.x - Math.sin(c.heading) * c.speed, player.vel.z - Math.cos(c.heading) * c.speed);
        if (rel > 12) { this.nearMissCd = 1.5; this.hz.nearMiss(); }
      }
    }
  }
}
