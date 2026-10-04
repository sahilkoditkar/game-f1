// Car-to-car crashes as rigid bodies in the ground plane.
//
// Each car is a box (its footprint) with a mass m and a yaw moment of inertia
// I = m (hl² + hw²) / 3, so *where* it is hit matters as much as how hard: a hit
// through the centre of mass mostly shoves it, a hit on a corner spins it (the PIT
// manoeuvre), and a glancing blow scrapes along the side and keeps most of its speed.
//
// Detection: separating axes of the two boxes. The axis of least overlap gives the
// contact normal n (pointing from A to B) and the penetration; the contact point P
// is the corner of one box that is deepest inside the other (the midpoint when two
// corners are level: side-to-side or nose-to-nose).
//
// Response, with r = P - centre and r⊥ = (-r.z, r.x) (the direction P moves when the
// car yaws: yawRate > 0 turns the nose right, as in car.js):
//   velocity of P            vP = v + ω r⊥
//   closing speed            vn = (vP_B - vP_A) · n           (< 0: approaching)
//   effective inverse mass   K  = 1/mA + 1/mB + (r⊥A·n)²/IA + (r⊥B·n)²/IB
//   normal impulse           jn = -(1 + e) vn / K
//   friction impulse         jt = clamp(-vt / Kt, -μ jn, μ jn)  along the sliding direction t
//   applied                  v_B += J / mB,  ω_B += (r⊥B·J) / IB  (and minus for A)
// Restitution e drops with the closing speed (panels crumple and soak up the energy):
// e = 0.08 + 0.37 exp(-|vn| / 8): a parking-speed nudge bounces, a big hit mostly
// sticks. Each car's ΔV = |J| / m is the crash severity, the number crash tests use.

/** Mass (kg) and half-footprint (m) per body shape; traffic carries a driver and passengers. */
const SPEC = {
  classic: { m: 1250, hl: 2.2, hw: 0.9 },
  hatch: { m: 1300, hl: 2.1, hw: 0.9 },
  muscle: { m: 1500, hl: 2.35, hw: 0.92 },
  gt: { m: 1450, hl: 2.25, hw: 0.95 },
  rally: { m: 1280, hl: 2.05, hw: 0.92 },
  groupb: { m: 1150, hl: 2.1, hw: 0.94 },
  super: { m: 1450, hl: 2.25, hw: 0.97 },
  proto: { m: 1050, hl: 2.5, hw: 1.0 },
  hyper: { m: 1950, hl: 2.27, hw: 1.0 },
  formula: { m: 800, hl: 2.8, hw: 1.0 },
};
const DEFAULT = { m: 1350, hl: 2.2, hw: 0.93 };
const MU = 0.35;            // body panel on body panel

export function specOf(shape, extraMass = 0) {
  const s = SPEC[shape] || DEFAULT;
  const m = s.m + extraMass;
  return { m, I: (m * (s.hl * s.hl + s.hw * s.hw)) / 3, hl: s.hl, hw: s.hw };
}

/** Camera shake for a hit, from the car's ΔV (m/s): a nudge barely moves it, a 50 km/h ΔV shakes hard. */
export function crashShake(dv) { return Math.min(0.8, 0.05 + dv * 0.045); }

/** Restitution for a closing speed (m/s). */
export function restitution(vn) { return 0.08 + 0.37 * Math.exp(-Math.abs(vn) / 8); }

function frame(b) {
  const fx = Math.sin(b.h), fz = Math.cos(b.h);
  return { fx, fz, rx: -fz, rz: fx };
}

function corners(b, f) {
  const out = [];
  for (const a of [1, -1]) for (const c of [1, -1]) {
    out.push({ x: b.x + f.fx * b.hl * a + f.rx * b.hw * c, z: b.z + f.fz * b.hl * a + f.rz * b.hw * c });
  }
  return out;
}

/**
 * Contact between two bodies { x, z, h (heading), hl, hw }, or null when they do not
 * overlap. Returns { nx, nz (A→B), pen, px, pz }.
 */
export function contact(A, B) {
  const dx = B.x - A.x, dz = B.z - A.z;
  const reach = Math.hypot(A.hl, A.hw) + Math.hypot(B.hl, B.hw);
  if (dx * dx + dz * dz > reach * reach) return null;
  const fa = frame(A), fb = frame(B);
  const axes = [[fa.fx, fa.fz, 0], [fa.rx, fa.rz, 0], [fb.fx, fb.fz, 1], [fb.rx, fb.rz, 1]];
  let best = null;
  for (const [ux, uz, owner] of axes) {
    const rA = A.hl * Math.abs(fa.fx * ux + fa.fz * uz) + A.hw * Math.abs(fa.rx * ux + fa.rz * uz);
    const rB = B.hl * Math.abs(fb.fx * ux + fb.fz * uz) + B.hw * Math.abs(fb.rx * ux + fb.rz * uz);
    const d = dx * ux + dz * uz;
    const o = rA + rB - Math.abs(d);
    if (o <= 0) return null;                       // a separating axis: no contact
    if (!best || o < best.pen) { const sg = d < 0 ? -1 : 1; best = { nx: ux * sg, nz: uz * sg, pen: o, owner }; }
  }
  // the deepest corner: one of B's inside A's face, or one of A's inside B's face
  const { nx, nz, owner } = best;
  const pts = owner === 0 ? corners(B, fb) : corners(A, fa);
  const sgn = owner === 0 ? 1 : -1;               // B's corners: least along n; A's: most along n
  let lo = Infinity;
  for (const p of pts) lo = Math.min(lo, sgn * (p.x * nx + p.z * nz));
  const level = pts.filter(p => sgn * (p.x * nx + p.z * nz) < lo + 0.12);
  let px = level.reduce((a, p) => a + p.x, 0) / level.length, pz = level.reduce((a, p) => a + p.z, 0) / level.length;
  if (level.length === 2) {
    // face on face (a rear-end, nose to nose, side by side): the contact is the middle of
    // the stretch where the two faces overlap, so an offset hit still has its lever arm
    const tx = -nz, tz = nx;
    const ref = owner === 0 ? corners(A, fa) : corners(B, fb);
    let hiN = -Infinity;
    for (const p of ref) hiN = Math.max(hiN, -sgn * (p.x * nx + p.z * nz));
    const face = ref.filter(p => -sgn * (p.x * nx + p.z * nz) > hiN - 0.12);
    const span = (q) => { const v = q.map(p => p.x * tx + p.z * tz); return [Math.min(...v), Math.max(...v)]; };
    const [ia, ib] = span(level), [ra, rb] = face.length === 2 ? span(face) : [ia, ib];
    const lo2 = Math.max(ia, ra), hi2 = Math.min(ib, rb);
    const mid = lo2 <= hi2 ? (lo2 + hi2) / 2 : (ia + ib) / 2;
    const cur = px * tx + pz * tz;
    px += tx * (mid - cur); pz += tz * (mid - cur);
  }
  return { nx, nz, pen: best.pen, px, pz };
}

/**
 * Exchange impulses between two bodies { x, z, h, vx, vz, w, m, I } at a contact, in
 * place, and push them apart (by inverse mass). Returns the crash numbers, or null
 * when the cars are already separating.
 */
export function resolve(A, B, c) {
  const iA = 1 / A.m, iB = 1 / B.m, iIA = 1 / A.I, iIB = 1 / B.I;
  // separate the overlap, the lighter car moving more
  const share = iA / (iA + iB);
  A.x -= c.nx * c.pen * share; A.z -= c.nz * c.pen * share;
  B.x += c.nx * c.pen * (1 - share); B.z += c.nz * c.pen * (1 - share);

  const rAx = c.px - A.x, rAz = c.pz - A.z, rBx = c.px - B.x, rBz = c.pz - B.z;
  const pAx = -rAz, pAz = rAx, pBx = -rBz, pBz = rBx;       // r⊥
  const vAx = A.vx + A.w * pAx, vAz = A.vz + A.w * pAz;
  const vBx = B.vx + B.w * pBx, vBz = B.vz + B.w * pBz;
  const rvx = vBx - vAx, rvz = vBz - vAz;
  const vn = rvx * c.nx + rvz * c.nz;
  if (vn >= 0) return null;

  const e = restitution(vn);
  const an = pAx * c.nx + pAz * c.nz, bn = pBx * c.nx + pBz * c.nz;
  const K = iA + iB + an * an * iIA + bn * bn * iIB;
  const jn = (-(1 + e) * vn) / K;

  // friction along the direction the contact points slide past each other
  let tx = rvx - vn * c.nx, tz = rvz - vn * c.nz;
  const vt = Math.hypot(tx, tz);
  let jt = 0;
  if (vt > 1e-3) {
    tx /= vt; tz /= vt;
    const at = pAx * tx + pAz * tz, bt = pBx * tx + pBz * tz;
    const Kt = iA + iB + at * at * iIA + bt * bt * iIB;
    jt = Math.max(-MU * jn, Math.min(MU * jn, -vt / Kt));
  } else { tx = 0; tz = 0; }

  const Jx = c.nx * jn + tx * jt, Jz = c.nz * jn + tz * jt;
  A.vx -= Jx * iA; A.vz -= Jz * iA; A.w -= (pAx * Jx + pAz * Jz) * iIA;
  B.vx += Jx * iB; B.vz += Jz * iB; B.w += (pBx * Jx + pBz * Jz) * iIB;
  const J = Math.hypot(Jx, Jz);
  return {
    closing: -vn, e, impulse: J,
    dvA: J * iA, dvB: J * iB,                                   // each car's change of speed (m/s)
    dwA: Math.abs(pAx * Jx + pAz * Jz) * iIA, dwB: Math.abs(pBx * Jx + pBz * Jz) * iIB,   // and of yaw rate (rad/s)
    // kinetic energy turned into bent metal and heat: ½ μ (1 - e²) vn², μ the reduced mass along n
    energy: 0.5 * (1 / K) * (1 - e * e) * vn * vn,
  };
}

// ------------------------------------------------------------ Car (physics) bodies
/** A crash body for a physics Car (see car.js). */
export function carBody(car) {
  if (!car._crash) car._crash = specOf(car.shape);
  const s = car._crash;
  return { x: car.pos.x, z: car.pos.z, h: car.heading, vx: car.vel.x, vz: car.vel.z, w: car.yawRate, m: s.m, I: s.I, hl: s.hl, hw: s.hw };
}

/**
 * Write a body back to its Car after a crash: the new velocity in the car's own frame,
 * the yaw rate the hit gave it, and (for a hard or off-centre hit) the rear tyres let
 * go for a moment so the spin plays out instead of the grip model straightening it.
 */
export function applyToCar(car, b, dv, dw) {
  car.pos.x = b.x; car.pos.z = b.z;
  car.vel.x = b.vx; car.vel.z = b.vz;
  const fx = Math.sin(car.heading), fz = Math.cos(car.heading);
  car.vf = b.vx * fx + b.vz * fz;
  car.vr = b.vx * -fz + b.vz * fx;
  car.yawRate = b.w;
  car.carHit = Math.max(car.carHit, dv);
  const spin = Math.min(1, dw / 1.2 + Math.max(0, dv - 4) / 10);
  if (spin > 0.45) {          // racing-pack rubbing stays a nudge
    car.slide = Math.max(car.slide, spin);
    car.spinTime = Math.max(car.spinTime || 0, 0.25 + 0.9 * spin);
  }
}

/** Collide two physics Cars; returns the crash numbers or null. */
export function collideCars(a, b) {
  const A = carBody(a), B = carBody(b);
  const c = contact(A, B);
  if (!c) return null;
  const r = resolve(A, B, c);
  if (!r) { a.pos.x = A.x; a.pos.z = A.z; b.pos.x = B.x; b.pos.z = B.z; return null; }
  applyToCar(a, A, r.dvA, r.dwA);
  applyToCar(b, B, r.dvB, r.dwB);
  return r;
}
