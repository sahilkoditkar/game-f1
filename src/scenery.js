import * as THREE from 'three';

// Deterministic pseudo-random so the scenery is the same every time.
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export function buildScenery(track, quality = 'high') {
  const g = new THREE.Group();
  const th = track.theme;
  const rand = mulberry32(track.def.id.length * 7919 + track.count);
  const highQ = quality !== 'low';
  const b = track.bounds;
  const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
  const extent = Math.max(b.maxX - b.minX, b.maxZ - b.minZ);

  // Terrain: a height-mapped ground that hugs the road and rolls away from it
  const groundTex = makeGroundTexture(th);
  groundTex.wrapS = groundTex.wrapT = THREE.RepeatWrapping;
  const terrainSize = extent + 1100;
  const cellsN = Math.min(highQ ? 420 : 300, Math.round(terrainSize / (highQ ? 9 : 14)));
  groundTex.repeat.set(terrainSize / 40, terrainSize / 40);
  const terrainGeo = new THREE.PlaneGeometry(terrainSize, terrainSize, cellsN, cellsN);
  terrainGeo.rotateX(-Math.PI / 2);
  const tp = terrainGeo.attributes.position;
  for (let i = 0; i < tp.count; i++) {
    const x = tp.getX(i) + cx, z = tp.getZ(i) + cz;
    tp.setY(i, track.terrainHeight(x, z));
  }
  terrainGeo.computeVertexNormals();
  const terrain = new THREE.Mesh(terrainGeo, new THREE.MeshStandardMaterial({ map: groundTex, roughness: 1, metalness: 0 }));
  terrain.position.set(cx, 0, cz);
  terrain.receiveShadow = true;
  g.add(terrain);
  // Far ground so the horizon never shows the void
  const far = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), new THREE.MeshStandardMaterial({ color: th.ground, roughness: 1 }));
  far.rotation.x = -Math.PI / 2;
  far.position.set(cx, Math.min(0, track.minHeight) - (th.hills || 8) - 6, cz);
  g.add(far);
  const hAt = (x, z) => track.terrainHeight(x, z);

  // Water for coastal
  if (th.water !== null) {
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(3000, 1400),
      new THREE.MeshStandardMaterial({ color: th.water, roughness: 0.15, metalness: 0.4, transparent: true, opacity: 0.92 })
    );
    water.rotation.x = -Math.PI / 2;
    water.position.set(cx, track.seaLevel, b.maxZ + 780);
    g.add(water);
  }

  const farFromTrack = (x, z, margin) => track.nearestGlobal(x, z).dist > margin;

  // Trees / cacti / pines
  if (th.trees !== 'none') {
    const area = (extent + 500) * (extent + 500) / (1500 * 1500);
    const count = Math.round(Math.min(1600, Math.max(200, (highQ ? 420 : 160) * area)));
    const positions = [];
    let tries = 0;
    while (positions.length < count && tries < count * 20) {
      tries++;
      const x = cx + (rand() - 0.5) * (extent + 500);
      const z = cz + (rand() - 0.5) * (extent + 500);
      if (!farFromTrack(x, z, track.wallOffset + 6 + rand() * 12)) continue;
      if (th.water !== null && z > b.maxZ + 60) continue;
      positions.push([x, z, 0.7 + rand() * 0.8, rand() * Math.PI * 2, hAt(x, z)]);
    }
    addTrees(g, th.trees, positions, highQ);
  }

  // Buildings for city theme
  if (th.buildings) {
    const boxes = [];
    let tries = 0;
    while (boxes.length < Math.round(Math.min(400, (highQ ? 140 : 60) * Math.max(1, (extent + 500) * (extent + 500) / (1500 * 1500)))) && tries < 6000) {
      tries++;
      const x = cx + (rand() - 0.5) * (extent + 420);
      const z = cz + (rand() - 0.5) * (extent + 420);
      const w = 14 + rand() * 22, d = 14 + rand() * 22;
      if (!farFromTrack(x, z, track.wallOffset + Math.max(w, d) * 0.75 + 4)) continue;
      if (boxes.some(o => Math.abs(o.x - x) < (o.w + w) / 2 + 3 && Math.abs(o.z - z) < (o.d + d) / 2 + 3)) continue;
      boxes.push({ x, z, w, d, h: 18 + rand() * 90, hue: rand(), y: hAt(x, z) });
    }
    addBuildings(g, boxes, rand);
    addStreetLights(g, track, highQ);
  }

  // Mountains ring
  const mountainMat = new THREE.MeshStandardMaterial({ color: th.mountains, roughness: 1, flatShading: true });
  // Ring the mountains around the track's bounding circle so long stages never run through them.
  const boundR = Math.hypot(b.maxX - b.minX, b.maxZ - b.minZ) / 2;
  const mCount = Math.round(26 + boundR / 120);
  for (let i = 0; i < mCount; i++) {
    const a = (i / mCount) * Math.PI * 2 + rand() * 0.2;
    const coneR = 220 + rand() * 180;
    const r = boundR + coneR + 350 + rand() * 400;
    const h = 180 + rand() * 260;
    const m = new THREE.Mesh(new THREE.ConeGeometry(coneR, h, 6 + Math.floor(rand() * 3)), mountainMat);
    const base = Math.min(0, track.minHeight) - 25;
    m.position.set(cx + Math.cos(a) * r, base + h / 2, cz + Math.sin(a) * r);
    m.rotation.y = rand() * Math.PI;
    g.add(m);
    if (th.trees === 'pine' || th.trees === 'round') {
      // snow caps
      const cap = new THREE.Mesh(new THREE.ConeGeometry(70 + rand() * 40, h * 0.3, 6), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, flatShading: true }));
      cap.position.set(m.position.x, base + h - h * 0.15, m.position.z);
      cap.rotation.y = m.rotation.y;
      g.add(cap);
    }
  }

  // Grandstand near start line
  const s0 = track.samples[0];
  const stand = buildGrandstand(th, rand);
  const side = -1; // right side of the track
  stand.position.set(s0.p.x + s0.n.x * side * (s0.wall + 12), s0.p.y - 0.3, s0.p.z + s0.n.z * side * (s0.wall + 12));
  stand.rotation.y = s0.heading + Math.PI / 2 * side;
  g.add(stand);

  // Sponsor boards scattered along the outside
  const boardMat = new THREE.MeshStandardMaterial({ map: makeBoardTexture(rand), roughness: 0.7 });
  const boardGeo = new THREE.BoxGeometry(10, 2.2, 0.3);
  for (let i = 0; i < track.count; i += Math.floor(track.count / 14)) {
    const s = track.samples[i];
    const sd = rand() > 0.5 ? 1 : -1;
    const m = new THREE.Mesh(boardGeo, boardMat);
    m.position.set(s.p.x + s.n.x * sd * (s.wall + 4), s.p.y + 1.0, s.p.z + s.n.z * sd * (s.wall + 4));
    m.rotation.y = s.heading;
    m.castShadow = highQ;
    g.add(m);
  }

  return g;
}

export function addTrees(g, kind, positions, highQ) {
  let trunkGeo, leafGeo, trunkColor, leafColor, leafY, trunkY;
  if (kind === 'pine') {
    trunkGeo = new THREE.CylinderGeometry(0.35, 0.6, 3, 6);
    leafGeo = new THREE.ConeGeometry(3.2, 9, 7);
    trunkColor = 0x5a3b22; leafColor = 0x1f5b2f; trunkY = 1.5; leafY = 6.5;
  } else if (kind === 'cactus') {
    trunkGeo = new THREE.CylinderGeometry(0.7, 0.9, 6, 7);
    leafGeo = new THREE.CylinderGeometry(0.45, 0.5, 3, 6);
    trunkColor = 0x3f7f3a; leafColor = 0x3f7f3a; trunkY = 3; leafY = 4.5;
  } else if (kind === 'palm') {
    trunkGeo = new THREE.CylinderGeometry(0.35, 0.55, 9, 6);
    leafGeo = new THREE.ConeGeometry(4.5, 2.4, 7);
    trunkColor = 0x8a6a45; leafColor = 0x2e8b3a; trunkY = 4.5; leafY = 9.6;
  } else {
    trunkGeo = new THREE.CylinderGeometry(0.4, 0.6, 3.5, 6);
    leafGeo = new THREE.IcosahedronGeometry(3.6, 1);
    trunkColor = 0x5c3f24; leafColor = 0x2f7d32; trunkY = 1.75; leafY = 5.6;
  }
  const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: trunkColor, roughness: 1 }), positions.length);
  const leaves = new THREE.InstancedMesh(leafGeo, new THREE.MeshStandardMaterial({ color: leafColor, roughness: 1, flatShading: true }), positions.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const col = new THREE.Color();
  positions.forEach(([x, z, sc, rot, y = 0], i) => {
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot);
    m.compose(new THREE.Vector3(x, y + trunkY * sc - 0.3, z), q, new THREE.Vector3(sc, sc, sc));
    trunks.setMatrixAt(i, m);
    if (kind === 'cactus') {
      const q2 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2 * 0.9);
      m.compose(new THREE.Vector3(x + Math.cos(rot) * 1.4 * sc, y + leafY * sc, z + Math.sin(rot) * 1.4 * sc), q.multiply(q2), new THREE.Vector3(sc, sc, sc));
    } else {
      m.compose(new THREE.Vector3(x, y + leafY * sc, z), q, new THREE.Vector3(sc, sc, sc));
    }
    leaves.setMatrixAt(i, m);
    col.set(leafColor).offsetHSL((Math.sin(i * 12.9898) * 43758.5453 % 1) * 0.03, 0, ((i * 7) % 10) / 10 * 0.12 - 0.06);
    leaves.setColorAt(i, col);
  });
  trunks.castShadow = highQ; leaves.castShadow = highQ;
  g.add(trunks, leaves);
}

function addBuildings(g, boxes, rand) {
  const winTex = makeWindowTexture();
  winTex.wrapS = winTex.wrapT = THREE.RepeatWrapping;
  for (const bx of boxes) {
    const tex = winTex.clone();
    tex.needsUpdate = true;
    tex.repeat.set(Math.round(bx.w / 4), Math.round(bx.h / 4));
    const c = new THREE.Color().setHSL(0.55 + bx.hue * 0.2, 0.25, 0.22);
    const mat = new THREE.MeshStandardMaterial({ color: c, map: tex, emissive: 0xffe8b0, emissiveMap: tex, emissiveIntensity: 0.9, roughness: 0.5 });
    const m = new THREE.Mesh(new THREE.BoxGeometry(bx.w, bx.h + 4, bx.d), mat);
    m.position.set(bx.x, (bx.y || 0) + bx.h / 2 - 2, bx.z);
    g.add(m);
    if (rand() > 0.6) {
      const neon = new THREE.Mesh(new THREE.BoxGeometry(bx.w * 0.6, 1.2, 0.4), new THREE.MeshStandardMaterial({ color: 0x000000, emissive: [0xff2d95, 0x00e5ff, 0xb7ff00, 0xff8a00][Math.floor(rand() * 4)], emissiveIntensity: 2 }));
      neon.position.set(bx.x, (bx.y || 0) + bx.h * (0.5 + rand() * 0.4), bx.z + bx.d / 2 + 0.3);
      g.add(neon);
    }
  }
}

function addStreetLights(g, track, highQ) {
  const poleGeo = new THREE.CylinderGeometry(0.12, 0.16, 7, 6);
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x555a66 });
  const lampGeo = new THREE.SphereGeometry(0.4, 8, 8);
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xfff1c0, emissive: 0xffd27a, emissiveIntensity: 3 });
  const step = 22;
  for (let i = 0; i < track.count; i += step) {
    const s = track.samples[i];
    const sd = (Math.floor(i / step) % 2) ? 1 : -1;
    const x = s.p.x + s.n.x * sd * (s.wall + 1.5), z = s.p.z + s.n.z * sd * (s.wall + 1.5);
    const y = s.p.y;
    const pole = new THREE.Mesh(poleGeo, poleMat); pole.position.set(x, y + 3.5, z); g.add(pole);
    const lamp = new THREE.Mesh(lampGeo, lampMat); lamp.position.set(x, y + 7.1, z); g.add(lamp);
    if (highQ && (Math.floor(i / step) % 3 === 0)) {
      const pl = new THREE.PointLight(0xffd27a, 40, 45, 2);
      pl.position.set(x, y + 6.5, z);
      g.add(pl);
    }
  }
}

function buildGrandstand(th, rand) {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(60, 1, 14), new THREE.MeshStandardMaterial({ color: 0x777c88 }));
  base.position.y = 0.5; g.add(base);
  const seatColors = [0xff5a1f, 0x2f7bff, 0xffd23f, 0x3ddc84];
  for (let r = 0; r < 6; r++) {
    const row = new THREE.Mesh(new THREE.BoxGeometry(60, 1.2, 2.2), new THREE.MeshStandardMaterial({ color: seatColors[r % seatColors.length] }));
    row.position.set(0, 1.6 + r * 1.1, -2 + r * 2.1);
    g.add(row);
    // crowd dots
    const crowd = new THREE.InstancedMesh(new THREE.SphereGeometry(0.35, 5, 5), new THREE.MeshStandardMaterial({ color: 0xffffff }), 40);
    const m = new THREE.Matrix4(); const c = new THREE.Color();
    for (let i = 0; i < 40; i++) {
      m.makeTranslation(-29 + i * 1.5 + rand() * 0.5, 2.6 + r * 1.1, -2 + r * 2.1);
      crowd.setMatrixAt(i, m);
      c.setHSL(rand(), 0.7, 0.55); crowd.setColorAt(i, c);
    }
    g.add(crowd);
  }
  const roof = new THREE.Mesh(new THREE.BoxGeometry(62, 0.6, 18), new THREE.MeshStandardMaterial({ color: 0xdddddd, side: THREE.DoubleSide }));
  roof.position.set(0, 10, 4); roof.rotation.x = 0.15; g.add(roof);
  for (const x of [-28, 0, 28]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 10, 6), new THREE.MeshStandardMaterial({ color: 0x8a8f99 }));
    post.position.set(x, 5, 12); g.add(post);
  }
  return g;
}

function makeGroundTexture(th) {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const ctx = c.getContext('2d');
  const a = new THREE.Color(th.ground), b = new THREE.Color(th.groundAlt);
  for (let y = 0; y < 128; y += 4) for (let x = 0; x < 128; x += 4) {
    const t = Math.random();
    const col = a.clone().lerp(b, t);
    ctx.fillStyle = `rgb(${col.r * 255 | 0},${col.g * 255 | 0},${col.b * 255 | 0})`;
    ctx.fillRect(x, y, 4, 4);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

function makeWindowTexture() {
  const c = document.createElement('canvas');
  c.width = 32; c.height = 32;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 32, 32);
  for (let y = 0; y < 32; y += 8) for (let x = 0; x < 32; x += 8) {
    if (Math.random() < 0.55) { ctx.fillStyle = `rgba(255,${200 + Math.random() * 55 | 0},${120 + Math.random() * 100 | 0},1)`; ctx.fillRect(x + 2, y + 2, 4, 4); }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeBoardTexture(rand) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 112;
  const ctx = c.getContext('2d');
  const names = ['TURBO TOUR', 'OCTANE OIL', 'NITRO TYRES', 'VELOCITA', 'GRIP&GO', 'PIT STOP CAFE'];
  const colors = ['#ff5a1f', '#2f7bff', '#3ddc84', '#ffd23f', '#b04cff', '#ffffff'];
  const i = Math.floor(rand() * names.length);
  ctx.fillStyle = '#14161c'; ctx.fillRect(0, 0, 512, 112);
  ctx.fillStyle = colors[i]; ctx.fillRect(0, 0, 512, 12); ctx.fillRect(0, 100, 512, 12);
  ctx.font = 'italic 900 56px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = colors[i]; ctx.fillText(names[i], 256, 56);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
