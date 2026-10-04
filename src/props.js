// Low-poly models for the Free Roam roadside props (see World._placeProps). Geometry
// and materials are shared across chunks (userData.shared keeps them alive when a
// chunk is dropped); repeated small things are drawn as instanced meshes.
import * as THREE from 'three';

const HOUSE_WALLS = [0xe8dcc4, 0xf2f0ea, 0xe9d49a, 0xb9cfe0, 0xe2a58c, 0xb8c9a3];
const HOUSE_ROOFS = [0x8b3a2e, 0x5a4a42, 0x3f4f5f, 0x7a2f2f, 0x4d5a3a, 0x6b5b4b];
const HUT_COLORS = [0xff6f61, 0x4ecdc4, 0xffd93d, 0x6c5ce7, 0xff9ff3, 0x48dbfb];

/** Map colours (roof seen from above) for the props that show on the map and radar. */
export const PROP_MAP_COLORS = {
  house: (p) => '#' + HOUSE_ROOFS[p.variant].toString(16).padStart(6, '0'), barn: () => '#a8322a', silo: () => '#b9c2cc',
  cabin: () => '#3a2a1e', shack: () => '#c99a6a', watertower: () => '#9aa4ad', lodge: () => '#2b2b30',
  hut: (p) => '#' + HUT_COLORS[p.variant].toString(16).padStart(6, '0'), lifeguard: () => '#d83a2e', gas: () => '#e8e8ea', hq: () => '#ff7a3d',
};

export class PropKit {
  constructor(highQ) {
    this.highQ = highQ;
    const shared = (o) => { o.userData.shared = true; return o; };
    const mat = (color, extra = {}) => shared(new THREE.MeshStandardMaterial({ color, roughness: 0.85, ...extra }));
    this.m = {
      walls: HOUSE_WALLS.map(c => mat(c)), roofs: HOUSE_ROOFS.map(c => mat(c)), huts: HUT_COLORS.map(c => mat(c)),
      door: mat(0x3a2a20), glass: mat(0x8fb8d8, { roughness: 0.2, metalness: 0.4 }), white: mat(0xf4f4f4), red: mat(0xa8322a),
      darkRed: mat(0x6e1f1a), wood: mat(0x6b4a2f), darkWood: mat(0x4a3426), slate: mat(0x2b2b30), adobe: mat(0xc99a6a),
      adobeTop: mat(0xb3875a), metal: mat(0x9aa4ad, { metalness: 0.5, roughness: 0.45 }), concrete: mat(0xb9c2cc),
      pole: mat(0x6a5038), straw: mat(0xd9b65c), rock: mat(0x8a8d92, { flatShading: true }), redRock: mat(0xa8664a, { flatShading: true }),
      post: mat(0x8a8f99, { metalness: 0.5, roughness: 0.4 }), canopy: mat(0xf2f2f2), signGreen: mat(0x0f6b3a), panelBack: mat(0x2a2d33),
      apron: mat(0x6a6e76), orange: mat(0xff5a1f),
    };
    const g = (geo) => shared(geo);
    this.g = {
      box: g(new THREE.BoxGeometry(1, 1, 1)),
      // a four-sided cone turned 45° covers a unit square: a hip roof once scaled
      roof: g((() => { const c = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1); c.rotateY(Math.PI / 4); c.translate(0, 0.5, 0); return c; })()),
      cyl: g(new THREE.CylinderGeometry(0.5, 0.5, 1, 14)),
      dome: g(new THREE.SphereGeometry(0.5, 14, 7, 0, Math.PI * 2, 0, Math.PI / 2)),
      pole: g(new THREE.CylinderGeometry(0.13, 0.17, 9, 6).translate(0, 4.5, 0)),
      bar: g(new THREE.BoxGeometry(2.2, 0.14, 0.14).translate(0, 8.3, 0)),
      rock: g(new THREE.DodecahedronGeometry(0.5, 0)),
      hay: g(new THREE.CylinderGeometry(0.75, 0.75, 1.5, 12).rotateZ(Math.PI / 2).translate(0, 0.75, 0)),
    };
    this.adTextures = new Map();
  }

  /**
   * Build the props of one chunk into `group`. Every building part is merged into one
   * mesh per material for the whole chunk (a village would otherwise be thousands of
   * draw calls); small repeated things are instanced.
   */
  build(group, props) {
    const inst = { pole: [], rock: [], redRock: [], hay: [] };
    const holder = new THREE.Group();
    for (const p of props) {
      if (p.kind === 'pole') { inst.pole.push(p); continue; }
      if (p.kind === 'rock') { inst[p.tint ? 'redRock' : 'rock'].push(p); continue; }
      if (p.kind === 'hay') { inst.hay.push(p); continue; }
      const o = this[p.kind] ? this[p.kind](p) : null;
      if (!o) continue;
      o.position.set(p.x, p.y, p.z);
      o.rotation.y = p.rot;
      holder.add(o);
    }
    mergeByMaterial(group, holder, this.highQ);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), sc = new THREE.Vector3();
    const instanced = (list, geo, material, scaleFn = () => sc.set(1, 1, 1), yaw = (p) => p.rot) => {
      if (!list.length) return;
      const im = new THREE.InstancedMesh(geo, material, list.length);
      list.forEach((p, i) => { q.setFromEuler(e.set(0, yaw(p), 0)); m4.compose(v.set(p.x, p.y, p.z), q, scaleFn(p)); im.setMatrixAt(i, m4); });
      im.receiveShadow = true;
      group.add(im);
    };
    instanced(inst.pole, this.g.pole, this.m.pole);
    instanced(inst.pole, this.g.bar, this.m.pole);
    instanced(inst.rock, this.g.rock, this.m.rock, (p) => sc.set(p.w, p.h * 2, p.d));
    instanced(inst.redRock, this.g.rock, this.m.redRock, (p) => sc.set(p.w, p.h * 2, p.d));
    instanced(inst.hay, this.g.hay, this.m.straw);
  }

  // ------------------------------------------------------------ helpers
  _box(parent, material, w, h, d, x, y, z) {
    const m = new THREE.Mesh(this.g.box, material);
    m.scale.set(w, h, d); m.position.set(x, y + h / 2, z);
    m.receiveShadow = true; m.castShadow = this.highQ;
    parent.add(m);
    return m;
  }
  _roof(parent, material, w, h, d, y) {
    const m = new THREE.Mesh(this.g.roof, material);
    m.scale.set(w, h, d); m.position.y = y;
    m.castShadow = this.highQ;
    parent.add(m);
    return m;
  }
  _cyl(parent, material, r, h, x, y, z) {
    const m = new THREE.Mesh(this.g.cyl, material);
    m.scale.set(r * 2, h, r * 2); m.position.set(x, y + h / 2, z);
    m.castShadow = this.highQ;
    parent.add(m);
    return m;
  }

  // ------------------------------------------------------------ buildings (+x faces the road)
  house(p) {
    const o = new THREE.Group(), M = this.m;
    const base = 0.6;                                   // a plinth hides any slope under the footprint
    this._box(o, M.concrete, p.w + 0.4, base, p.d + 0.4, 0, 0, 0);
    this._box(o, M.walls[p.variant], p.w, p.h, p.d, 0, base, 0);
    this._roof(o, M.roofs[p.variant], p.w * 1.18, p.h * 0.62, p.d * 1.18, base + p.h);
    this._box(o, M.door, 0.15, 2.1, 1.1, p.w / 2 + 0.05, base, 0);
    for (const z of [-p.d * 0.28, p.d * 0.28]) this._box(o, M.glass, 0.12, 1.1, 1.3, p.w / 2 + 0.04, base + 1.3, z);
    this._box(o, M.roofs[p.variant], 0.8, 2.2, 0.8, -p.w * 0.2, base + p.h + p.h * 0.2, p.d * 0.25);
    return o;
  }

  barn(p) {
    const o = new THREE.Group(), M = this.m;
    this._box(o, M.red, p.w, p.h, p.d, 0, 0, 0);
    this._roof(o, M.darkRed, p.w * 1.1, p.h * 0.6, p.d * 1.06, p.h);
    this._box(o, M.white, 0.2, p.h * 0.65, p.w * 0.45, p.w / 2 + 0.05, 0, 0);
    this._box(o, M.door, 0.15, p.h * 0.55, p.w * 0.35, p.w / 2 + 0.12, 0, 0);
    return o;
  }

  silo(p) {
    const o = new THREE.Group(), M = this.m;
    this._cyl(o, M.concrete, p.w / 2, p.h, 0, 0, 0);
    const d = new THREE.Mesh(this.g.dome, M.metal); d.scale.setScalar(p.w); d.position.y = p.h; o.add(d);
    return o;
  }

  cabin(p) {
    const o = new THREE.Group(), M = this.m;
    this._box(o, M.wood, p.w, p.h, p.d, 0, 0, 0);
    this._roof(o, M.slate, p.w * 1.25, p.h * 0.95, p.d * 1.2, p.h);
    this._box(o, M.door, 0.15, 1.9, 1, p.w / 2 + 0.05, 0, 0);
    this._box(o, M.glass, 0.12, 0.9, 1, p.w / 2 + 0.04, 1.1, p.d * 0.28);
    this._box(o, M.darkWood, 0.9, 2, 0.9, -p.w * 0.25, p.h + 0.4, -p.d * 0.2);
    return o;
  }

  shack(p) {
    const o = new THREE.Group(), M = this.m;
    this._box(o, M.adobe, p.w, p.h, p.d, 0, 0, 0);
    this._box(o, M.adobeTop, p.w + 0.5, 0.35, p.d + 0.5, 0, p.h, 0);
    this._box(o, M.door, 0.15, 2, 1, p.w / 2 + 0.05, 0, -p.d * 0.15);
    this._box(o, M.glass, 0.12, 0.8, 0.9, p.w / 2 + 0.04, 1.2, p.d * 0.25);
    return o;
  }

  watertower(p) {
    const o = new THREE.Group(), M = this.m;
    const legH = p.h - 6;
    for (const [x, z] of [[-2.4, -2.4], [2.4, -2.4], [-2.4, 2.4], [2.4, 2.4]]) this._box(o, M.metal, 0.3, legH, 0.3, x, 0, z);
    this._cyl(o, M.metal, 3.5, 4.5, 0, legH, 0);
    const cap = new THREE.Mesh(this.g.roof, M.slate); cap.scale.set(7.4, 1.6, 7.4); cap.position.y = legH + 4.5; cap.rotation.y = Math.PI / 4; o.add(cap);
    return o;
  }

  lodge(p) {
    const o = new THREE.Group(), M = this.m;
    this._box(o, M.concrete, p.w + 0.6, 0.8, p.d + 0.6, 0, 0, 0);
    this._box(o, M.darkWood, p.w, p.h, p.d, 0, 0.8, 0);
    this._roof(o, M.slate, p.w * 1.2, p.h * 1.1, p.d * 1.15, 0.8 + p.h);
    for (const z of [-p.d * 0.3, 0, p.d * 0.3]) this._box(o, M.glass, 0.12, 1.4, 1.6, p.w / 2 + 0.04, 2.2, z);
    this._box(o, M.concrete, 1.1, 3, 1.1, -p.w * 0.3, 0.8 + p.h, 0);
    return o;
  }

  hut(p) {
    const o = new THREE.Group(), M = this.m;
    for (const [x, z] of [[-p.w * 0.4, -p.d * 0.4], [p.w * 0.4, -p.d * 0.4], [-p.w * 0.4, p.d * 0.4], [p.w * 0.4, p.d * 0.4]]) this._box(o, M.wood, 0.2, 0.7, 0.2, x, 0, z);
    this._box(o, M.huts[p.variant], p.w, p.h, p.d, 0, 0.7, 0);
    this._roof(o, M.white, p.w * 1.3, 1.3, p.d * 1.3, 0.7 + p.h);
    return o;
  }

  lifeguard(p) {
    const o = new THREE.Group(), M = this.m;
    for (const [x, z] of [[-1.3, -1.3], [1.3, -1.3], [-1.3, 1.3], [1.3, 1.3]]) this._box(o, M.white, 0.2, 2.6, 0.2, x, 0, z);
    this._box(o, M.white, 3.6, 0.2, 3.6, 0, 2.6, 0);
    this._box(o, M.huts[0], 2.6, 1.8, 2.6, 0, 2.8, 0);
    this._roof(o, M.huts[0], 3.6, 0.9, 3.6, 4.6);
    return o;
  }

  gas(p) {
    const o = new THREE.Group(), M = this.m;
    // canopy over the pumps (toward the road), kiosk at the back
    for (const [x, z] of [[-1, -6], [-1, 6], [5, -6], [5, 6]]) this._box(o, M.post, 0.4, 5, 0.4, x, 0, z);
    this._box(o, M.canopy, 9, 0.8, 16, 2, 5, 0);
    this._box(o, M.red, 9.1, 0.3, 16.1, 2, 5.3, 0);
    for (const z of [-4, 4]) { this._box(o, M.concrete, 1.6, 0.25, 4.4, 2, 0, z); this._box(o, M.red, 0.8, 1.7, 1.2, 2, 0.25, z); }
    this._box(o, M.walls[1], 9, 3.6, 7, -8, 0, 0);
    this._box(o, M.red, 9.3, 0.5, 7.3, -8, 3.6, 0);
    this._box(o, M.glass, 0.12, 1.8, 4.5, -3.45, 0.6, 0);
    // a tall price sign at the roadside
    this._box(o, M.post, 0.35, 7, 0.35, 12.5, 0, -8);
    const sign = new THREE.Mesh(this.g.box, [M.red, M.red, M.red, M.red, this._adMat('FUEL', '#c8102e', '#fff'), this._adMat('FUEL', '#c8102e', '#fff')]);
    sign.scale.set(2.4, 1.8, 0.3); sign.position.set(12.5, 7.6, -8); sign.rotation.y = Math.PI / 2;
    o.add(sign);
    return o;
  }

  /** Festival HQ: the garage. Roller doors and a sign face the road; the forecourt runs to the kerb. */
  hq(p) {
    const o = new THREE.Group(), M = this.m;
    const W = p.w, D = p.d, H = p.h;
    // forecourt: concrete from the building to the road edge (local +x is toward the road)
    this._box(o, M.apron, 19, 0.3, D - 2, W / 2 + 9.5, -0.25, 0);
    for (const z of [-D / 2 + 3, D / 2 - 3]) this._box(o, M.white, 17, 0.32, 0.25, W / 2 + 9.5, -0.25, z);   // painted bay lines
    this._box(o, M.concrete, W + 1, 0.6, D + 1, 0, -0.3, 0);
    this._box(o, M.walls[1], W, H, D, 0, 0.3, 0);
    this._box(o, M.glass, W + 0.1, 1.6, D + 0.1, 0, H - 2.2, 0);
    this._box(o, M.slate, W + 0.6, 0.5, D + 0.6, 0, H + 0.3, 0);
    // two bays: one roller door down, one open with the workshop lit inside
    for (const [z, open] of [[-8, true], [8, false]]) {
      this._box(o, M.orange, 0.3, 6, 8.4, W / 2 + 0.1, 0.3, z);
      this._box(o, open ? M.door : M.metal, 0.35, 5.2, 7, W / 2 + 0.2, 0.3, z);
      if (!open) for (let k = 1; k < 9; k++) this._box(o, M.slate, 0.4, 0.06, 7, W / 2 + 0.22, 0.3 + k * 0.58, z);
    }
    const sign = new THREE.Mesh(this.g.box, [this._adMat('FESTIVAL HQ · GARAGE', '#ff5a1f', '#fff'), M.orange, M.orange, M.orange, M.orange, M.orange]);
    sign.scale.set(0.4, 2.4, 20); sign.position.set(W / 2 + 0.3, 7.6, 0);
    o.add(sign);
    // flags at the forecourt corners
    for (const z of [-D / 2 + 1, D / 2 - 1]) {
      this._box(o, M.post, 0.15, 9, 0.15, W / 2 + 18, 0, z);
      this._box(o, M.orange, 0.08, 1.6, 2.4, W / 2 + 18, 7, z + (z < 0 ? 1.25 : -1.25));
    }
    return o;
  }

  billboard(p) {
    const o = new THREE.Group(), M = this.m;
    for (const z of [-3.5, 3.5]) this._box(o, M.post, 0.35, 5, 0.35, 0, 0, z);
    const face = this._adMat(p.text, p.bg, p.fg);
    const panel = new THREE.Mesh(this.g.box, [face, M.panelBack, M.panelBack, M.panelBack, M.panelBack, M.panelBack]);
    panel.scale.set(0.3, 4.2, 11); panel.position.y = 6.9;
    panel.castShadow = this.highQ;
    o.add(panel);
    return o;
  }

  /** Green direction sign facing oncoming drivers: the road ahead and which way it goes. */
  sign(p) {
    const o = new THREE.Group(), M = this.m;
    for (const x of [-2.1, 2.1]) this._box(o, M.post, 0.18, 4.4, 0.18, x, 0, -0.1);
    const tex = signTexture(p.text, p.left, p.right);
    const face = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5 });
    const board = new THREE.Mesh(this.g.box, [M.signGreen, M.signGreen, M.signGreen, M.signGreen, face, M.panelBack]);
    board.scale.set(5.4, 1.7, 0.14); board.position.y = 3.7;
    o.add(board);
    return o;
  }

  _adMat(text, bg, fg) {
    const key = `${text}|${bg}|${fg}`;
    if (!this.adTextures.has(key)) {
      const c = document.createElement('canvas'); c.width = 1024; c.height = 400;
      const ctx = c.getContext('2d');
      ctx.fillStyle = bg; ctx.fillRect(0, 0, 1024, 400);
      ctx.fillStyle = fg; ctx.fillRect(0, 0, 1024, 18); ctx.fillRect(0, 382, 1024, 18);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      let px = 150;
      ctx.font = `italic 900 ${px}px Arial`;
      while (px > 40 && ctx.measureText(text).width > 940) { px -= 6; ctx.font = `italic 900 ${px}px Arial`; }
      ctx.fillText(text, 512, 205);
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
      const m = new THREE.MeshStandardMaterial({ map: t, roughness: 0.55 });
      t.userData.shared = true; m.userData.shared = true;
      this.adTextures.set(key, m);
    }
    return this.adTextures.get(key);
  }
}

/**
 * Add every mesh under `holder` to `group` merged into one mesh per material (multi-
 * material meshes are split by their geometry groups). The parts' geometries are
 * copied, so `holder` itself is thrown away.
 */
export function mergeByMaterial(group, holder, castShadow = false) {
  const batches = new Map();
  holder.updateMatrixWorld(true);
  holder.traverse(m => {
    if (!m.isMesh) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    const groups = Array.isArray(m.material) ? m.geometry.groups : [{ start: 0, count: m.geometry.index.count, materialIndex: 0 }];
    for (const g of groups) {
      const mat = mats[g.materialIndex];
      if (!batches.has(mat)) batches.set(mat, []);
      batches.get(mat).push({ geo: m.geometry, matrix: m.matrixWorld, start: g.start, count: g.count });
    }
  });
  for (const [mat, parts] of batches) {
    const mesh = new THREE.Mesh(mergeParts(parts), mat);
    mesh.receiveShadow = true; mesh.castShadow = castShadow;
    group.add(mesh);
  }
}

/** One indexed geometry from parts { geo, matrix, start, count } (an index range of geo). */
function mergeParts(parts) {
  let nv = 0, ni = 0;
  for (const p of parts) { nv += p.geo.attributes.position.count; ni += p.count; }
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), idx = new Uint32Array(ni);
  const v = new THREE.Vector3(), nm = new THREE.Matrix3();
  let vo = 0, io = 0;
  for (const p of parts) {
    const P = p.geo.attributes.position, N = p.geo.attributes.normal, U = p.geo.attributes.uv, I = p.geo.index;
    nm.getNormalMatrix(p.matrix);
    for (let k = 0; k < P.count; k++) {
      v.fromBufferAttribute(P, k).applyMatrix4(p.matrix); pos.set([v.x, v.y, v.z], (vo + k) * 3);
      v.fromBufferAttribute(N, k).applyMatrix3(nm).normalize(); nor.set([v.x, v.y, v.z], (vo + k) * 3);
      if (U) uv.set([U.getX(k), U.getY(k)], (vo + k) * 2);
    }
    for (let k = 0; k < p.count; k++) idx[io + k] = I.getX(p.start + k) + vo;
    vo += P.count; io += p.count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

function signTexture(text, left, right) {
  const c = document.createElement('canvas'); c.width = 640; c.height = 200;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0f6b3a'; ctx.fillRect(0, 0, 640, 200);
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 8; ctx.strokeRect(10, 10, 620, 180);
  ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  const arrow = (x, dir) => {
    ctx.beginPath();
    ctx.moveTo(x + dir * 46, 100); ctx.lineTo(x - dir * 4, 58); ctx.lineTo(x - dir * 4, 84); ctx.lineTo(x - dir * 42, 84);
    ctx.lineTo(x - dir * 42, 116); ctx.lineTo(x - dir * 4, 116); ctx.lineTo(x - dir * 4, 142); ctx.closePath(); ctx.fill();
  };
  if (left) arrow(70, -1);
  if (right) arrow(570, 1);
  const x0 = left ? 130 : 30, x1 = right ? 510 : 610;
  let px = 66;
  ctx.font = `700 ${px}px Arial`;
  while (px > 30 && ctx.measureText(text).width > x1 - x0) { px -= 3; ctx.font = `700 ${px}px Arial`; }
  ctx.fillText(text, (x0 + x1) / 2, 102);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
