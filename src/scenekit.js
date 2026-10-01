// Scene pieces shared by the circuit races and the open world: sun with a
// player-following shadow camera, a cheap procedural environment map, and the
// third-person chase camera.
import * as THREE from 'three';

const clamp = THREE.MathUtils.clamp;
const SUN_DIR = new THREE.Vector3(120, 180, 80);

/** Hemisphere + directional sun. Returns the sun (its target is added to the scene too). */
export function buildSun(scene, th, castShadow, size = 90) {
  scene.add(new THREE.HemisphereLight(th.sky, th.ground, th.ambient * 2.4));
  const sun = new THREE.DirectionalLight(th.night ? 0x9fb0ff : 0xfff4e0, th.sun * 3.0);
  sun.position.copy(SUN_DIR);
  sun.castShadow = castShadow;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 10; sun.shadow.camera.far = 600;
  sun.shadow.camera.left = -size; sun.shadow.camera.right = size;
  sun.shadow.camera.top = size; sun.shadow.camera.bottom = -size;
  sun.shadow.bias = -0.0008;
  sun.shadow.camera.updateProjectionMatrix();
  scene.add(sun);
  scene.add(sun.target);
  return sun;
}

/** Point the sun's shadow camera at `focus`, snapped to the shadow map's texel grid so edges don't shimmer. */
export function aimSun(sun, focus) {
  if (!sun.userData.basis) {
    const dir = SUN_DIR.clone().normalize();
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), dir).normalize();
    const up = new THREE.Vector3().crossVectors(dir, right).normalize();
    sun.userData.basis = { right, up, dir };
  }
  const b = sun.userData.basis;
  const cam = sun.shadow.camera;
  const texel = (cam.right - cam.left) / sun.shadow.mapSize.x;
  const r = focus.dot(b.right), u = focus.dot(b.up), d = focus.dot(b.dir);
  const rs = Math.round(r / texel) * texel, us = Math.round(u / texel) * texel;
  focus.set(0, 0, 0).addScaledVector(b.right, rs).addScaledVector(b.up, us).addScaledVector(b.dir, d);
  sun.position.set(focus.x + SUN_DIR.x, focus.y + SUN_DIR.y, focus.z + SUN_DIR.z);
  sun.target.position.copy(focus);
}

/** Cheap procedural environment map so paint and glass have reflections. */
export function buildEnvironment(renderer, th) {
  const env = new THREE.Scene();
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: { top: { value: new THREE.Color(th.sky) }, bottom: { value: new THREE.Color(th.ground) }, horizon: { value: new THREE.Color(th.fog) } },
    vertexShader: 'varying vec3 vW; void main(){ vW = (modelMatrix * vec4(position,1.0)).xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'uniform vec3 top; uniform vec3 bottom; uniform vec3 horizon; varying vec3 vW; void main(){ float h = normalize(vW).y; vec3 c = h > 0.0 ? mix(horizon, top, pow(h, 0.6)) : mix(horizon, bottom, pow(-h, 0.5)); gl_FragColor = vec4(c, 1.0); }',
  });
  env.add(new THREE.Mesh(new THREE.SphereGeometry(50, 16, 8), skyMat));
  const sunDisc = new THREE.Mesh(new THREE.SphereGeometry(4, 8, 8), new THREE.MeshBasicMaterial({ color: th.night ? 0x334466 : 0xffffff }));
  sunDisc.position.set(20, 30, 14);
  env.add(sunDisc);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const tex = pmrem.fromScene(env, 0.04).texture;
  pmrem.dispose();
  return tex;
}

/**
 * Third-person chase camera. Position is rigidly attached to the car; only the
 * heading eases toward the car's heading, and vertical tracking is low-passed so
 * crests and dips don't shake the view. `tmp` is a scratch Vector3.
 */
export function updateChaseCamera(cam, car, dt, tmp) {
  if (cam.userData.heading === undefined) cam.userData.heading = car.heading;
  let d = car.heading - cam.userData.heading;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  cam.userData.heading += d * Math.min(1, dt * 6);
  const h = cam.userData.heading;
  const speedF = clamp(car.speed / 60, 0, 1);
  const dist = 7.5 + speedF * 2.5;
  const height = 3.0 + speedF * 0.7;
  const fx = Math.sin(h), fz = Math.cos(h);
  const ky = 1 - Math.exp(-dt * 7);
  if (cam.userData.y === undefined || dt >= 1) { cam.userData.y = car.pos.y; cam.userData.lookY = car.pos.y; }
  cam.userData.y += (car.pos.y - cam.userData.y) * ky;
  cam.userData.lookY += (car.pos.y - cam.userData.lookY) * ky;
  cam.position.set(car.pos.x - fx * dist, cam.userData.y + height, car.pos.z - fz * dist);
  if (cam.userData.shake > 0.01) {
    cam.position.x += (Math.random() - 0.5) * cam.userData.shake;
    cam.position.y += (Math.random() - 0.5) * cam.userData.shake * 0.6;
    cam.userData.shake *= Math.exp(-dt * 7);
  }
  const f = car.forward;
  const look = tmp.copy(car.pos).addScaledVector(f, 6);
  look.y = cam.userData.lookY + 0.9;
  cam.lookAt(look);
  const fov = 66 + speedF * 14;
  if (Math.abs(cam.fov - fov) > 0.1) { cam.fov += (fov - cam.fov) * Math.min(1, dt * 4); cam.updateProjectionMatrix(); }
}

/** Snap a camera to the car (no easing), e.g. after a teleport. */
export function snapChaseCamera(cam, car, tmp) {
  cam.userData.heading = car.heading;
  cam.userData.y = undefined;
  updateChaseCamera(cam, car, 1, tmp);
}
