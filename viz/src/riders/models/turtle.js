// Sea turtle model + animation (WP12b). A ~1 m green sea turtle (Honu), stylised for readability at range: a high
// domed carapace with a firm marginal edge and a painted scute pattern (vertebral row, costals, marginal ring; pale
// seams, warm amber scutes with radiating streaks, per-scute colour variation), a cream plastron, long wing-like
// fore flippers, short rear flippers, a scaled head on a short neck. One SkinnedMesh, 6 rigid bones: body, head,
// fore flipper L/R, rear flipper L/R (the carapace is rigid, so no spine chain). Fore flippers beat together in the
// sea turtle's "flying" stroke (flap + feather + sweep); rear flippers ruddering. Every pose is a pure function of
// (action, actionT, t, seed). Body space: +x nose, +y back, +z right; origin at the body centre (shell equator).
import * as THREE from 'three';
import { SkinBuilder, M, Mdir, ellipsoid, taper, riderMaterial, makeSkinned, color, clamp, smooth, lerp, table } from './common.js';
import { hash01 } from '../../contracts.js';

export const TURTLE = { len: 1.0, x0: -0.5 };
const BN = { body: 0, head: 1, FL: 2, FR: 3, RL: 4, RR: 5 };
const HEAD_AT = [0.4, 0.045, 0];                           // head/neck pivot
const FORE_AT = [0.22, 0.04, 0.27];                         // fore flipper root (left: z mirrored), at the shell's edge
const REAR_AT = [-0.33, 0.02, 0.17];
export const TURTLE_SIZE = 1.15;                          // uniform model scale (readability at range)

//            s     top h  half-w  belly
const PROF = [[0, 0.012, 0.02, 0.006], [0.08, 0.07, 0.17, 0.03], [0.2, 0.14, 0.29, 0.05], [0.35, 0.195, 0.37, 0.065],
  [0.52, 0.222, 0.405, 0.072], [0.68, 0.208, 0.392, 0.07], [0.8, 0.175, 0.345, 0.062], [0.9, 0.128, 0.27, 0.05],
  [0.96, 0.085, 0.19, 0.04], [1.0, 0.04, 0.11, 0.025]];

/** Carapace + plastron loft with per-vertex (s, lat): lat 0 = ridge, ±1 = marginal edge, |lat| > 1 = plastron. */
function shellLoft(NU, NV) {
  const { len, x0 } = TURTLE;
  const pos = [], idx = [], sl = [];
  for (let i = 0; i <= NU; i++) {
    const s = 0.5 - 0.5 * Math.cos(Math.PI * i / NU);
    const h = table(PROF, s, 1), w = table(PROF, s, 2), hb = table(PROF, s, 3);
    const yc = 0.012 * smooth(0.0, 0.25, 1 - s);           // rear margin flares up a touch
    for (let j = 0; j <= NV; j++) {
      const a = (j / NV) * Math.PI * 2;
      const cy = Math.cos(a), cz = Math.sin(a);
      // upper: fuller dome with a firm (near-vertical) marginal edge; lower: flat plastron
      const y = cy >= 0 ? yc + h * Math.pow(cy, 0.62) : yc - hb * Math.pow(-cy, 0.55);
      const z = w * Math.sign(cz) * Math.pow(Math.abs(cz), cy >= 0 ? 0.92 : 0.6);
      pos.push(x0 + s * len, y, z);
      const aa = a <= Math.PI ? a : a - 2 * Math.PI;
      sl.push(s, aa / (Math.PI / 2));
    }
  }
  const row = NV + 1;
  for (let i = 0; i < NU; i++) for (let j = 0; j < NV; j++) {
    const a = i * row + j, b = a + 1, c = a + row, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return { geo: g, sl };
}

/** Scute map: (s, |lat|) → { key, d (m to the nearest seam), f, g (0..1 position inside the scute) }. */
function scute(s, al) {
  const S0 = 0.06, S1 = 0.95, M0 = 0.84;
  const kv = clamp((s - S0) / (S1 - S0), 0, 1) * 5, VW = 0.24 + 0.07 * Math.sin(Math.PI * (kv - Math.floor(kv)));   // hexagonal-ish
  if (al > M0 || s < S0 || s > S1) {                        // marginal ring
    const k = s * 13, fk = k - Math.floor(k);
    const dEdge = al > M0 ? (al - M0) * 0.5 : (s < S0 ? S0 - s : s - S1);
    return { key: 300 + Math.floor(k) + (al > M0 ? 0 : 50), d: dEdge, f: fk, g: 0.5 };      // no cross seams: a calm rim
  }
  if (al < VW) {                                             // vertebral row (5)
    const k = (s - S0) / (S1 - S0) * 5, fk = k - Math.floor(k);
    return { key: 100 + Math.floor(k), d: Math.min(Math.min(fk, 1 - fk) * 0.18, (VW - al) * 0.5), f: fk, g: al / VW };
  }
  const k = (s - S0 + 0.1 * (al - VW)) / (S1 - S0) * 4, fk = k - Math.floor(k);   // costals (4 a side)
  return { key: 200 + Math.floor(k), d: Math.min(Math.min(fk, 1 - fk) * 0.22, (al - VW) * 0.5, (M0 - al) * 0.5), f: fk,
    g: (al - VW) / (M0 - VW) };
}

/** Flipper paddle: a loft of flat ellipses along +y (span len), chord from table T [v, lead x, trail x, half-thick]. */
function paddle(T, len, NS = 14, NR = 12) {
  const pos = [], idx = [];
  for (let i = 0; i <= NS; i++) {
    const v = i / NS, xl = table(T, v, 1), xt = table(T, v, 2), th = table(T, v, 3);
    const cx = 0.5 * (xl + xt), hc = Math.max(0.5 * (xl - xt), 0.004);
    for (let j = 0; j <= NR; j++) {
      const a = (j / NR) * Math.PI * 2;
      // leading edge rounder (fuller), trailing edge thin: offset the thickness peak forward
      const cxa = Math.cos(a);
      pos.push(cx + hc * cxa, v * len, th * Math.sin(a) * (0.55 + 0.45 * Math.max(0, cxa) + 0.45 * (1 - Math.abs(cxa))));
    }
  }
  const row = NR + 1;
  for (let i = 0; i < NS; i++) for (let j = 0; j < NR; j++) {
    const a = i * row + j, b = a + 1, c = a + row, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function buildTurtle(base, id) {
  const sb = new SkinBuilder();
  const cOlive = color(base), cAmber = color(0xa8692a), cDarkB = color(0x3a2a16), cSeam = color(0xe6d6a2);
  const cPlast = color(0xe0cb84), cPlastS = color(0xb9a462);
  const cSkin = color(0x5a5634), cSkinPale = color(0xe2d49c), cDark = color(0x060504), cBeak = color(0x8c7a46);
  const tmp = new THREE.Color();
  // shell
  const { geo, sl } = shellLoft(56, 48);
  let vi = 0;
  sb.add(geo, M(), () => {
    const s = sl[2 * vi], lat = sl[2 * vi + 1]; vi++;
    const al = Math.abs(lat);
    if (al > 1.0) {                                          // plastron: cream with faint plate seams
      const k = s * 6, fk = k - Math.floor(k);
      return tmp.copy(cPlast).lerp(cPlastS, 1 - smooth(0.0, 0.06, Math.min(fk, 1 - fk)) * smooth(0.0, 0.05, Math.abs(al - 2)));
    }
    const sc = scute(s, al);
    const side = lat < 0 && sc.key >= 200 ? 17 : 0;
    const hh = hash01(sc.key + side, id, 7);
    tmp.copy(cOlive).lerp(cAmber, 0.05 + 0.4 * hh);
    if (sc.key >= 300) tmp.lerp(cDarkB, 0.35);
    // radiating streaks from the scute's growth centre (toward its rear edge)
    const ang = Math.atan2(sc.g - 0.5, sc.f - 0.35);
    const st = 0.5 + 0.5 * Math.sin(ang * 7 + hh * 20);
    tmp.multiplyScalar((0.62 + 0.6 * st * st) * 1.35);
    tmp.lerp(cDarkB, 0.45 * (1 - smooth(0.0, 0.05, sc.d)));  // darker toward the seam
    return tmp.lerp(cSeam, 1 - smooth(0.004, 0.017, sc.d));  // pale seam line
  }, () => [[BN.body, 1]]);
  // scaled skin: dark polygons with pale borders (cell hash), pale underside
  const scales = (q) => (p, n) => {
    if (n.y < -0.45) return cSkinPale;
    const cx = Math.floor(p.x * q + 0.5 * Math.floor(p.z * q)), cz = Math.floor(p.z * q);
    const hh = hash01(cx, cz, Math.floor(p.y * q));
    return hh > 0.72 ? cSkinPale : tmp.copy(cSkin).multiplyScalar(0.8 + 0.6 * hh);
  };
  // neck + head (head bone)
  sb.add(taper(0.2, 0.072, 0.066, 10, 3), Mdir([0.34, 0.02, 0], [1, 0.25, 0]), scales(30), () => [[BN.head, 1]]);
  sb.add(ellipsoid(0.125, 0.085, 0.092, 14, 10), M([0.6, 0.075, 0], [0, 0, 0.12]), scales(40), () => [[BN.head, 1]]);
  sb.add(ellipsoid(0.05, 0.045, 0.058, 8, 6), M([0.697, 0.052, 0], [0, 0, -0.3]), cBeak, () => [[BN.head, 1]]);
  for (const sz of [-1, 1]) {
    sb.add(ellipsoid(0.026, 0.022, 0.016, 8, 6), M([0.645, 0.098, sz * 0.071], [0, sz * -0.6, 0]), cDark, () => [[BN.head, 1]]);
    sb.add(ellipsoid(0.03, 0.012, 0.012, 6, 4), M([0.64, 0.123, sz * 0.066], [0, sz * -0.6, 0.2]), cSkinPale, () => [[BN.head, 1]]);
  }
  // flippers: smooth lofted paddles (x chord, +y span outward, z thickness), laid flat with the span along ±z;
  // root at the origin. Dark scaled top with pale scale borders and a pale rim, pale underside.
  const flipCol = (p, n) => {
    if (n.y < -0.3) return tmp.copy(cSkinPale).multiplyScalar(0.9);
    if (n.y < 0.45) return cSkinPale;                                     // rim: pale edge reads at range
    const hh = hash01(Math.floor(p.x * 26 + 40), Math.floor(p.z * 26 + 40 + 0.5 * Math.floor(p.x * 26)), id);
    return hh > 0.7 ? tmp.copy(cSkinPale).multiplyScalar(0.9) : tmp.copy(cSkin).multiplyScalar(0.7 + 0.5 * hh);
  };
  //            v     lead x   trail x  half-thick   (v = span fraction)
  const FORE = [[0, 0.065, -0.065, 0.03], [0.15, 0.09, -0.1, 0.026], [0.4, 0.07, -0.15, 0.02], [0.65, 0.0, -0.18, 0.014],
    [0.85, -0.1, -0.21, 0.009], [1, -0.2, -0.225, 0.004]];
  const REAR = [[0, 0.045, -0.05, 0.022], [0.35, 0.05, -0.11, 0.016], [0.75, 0.0, -0.15, 0.01], [1, -0.1, -0.13, 0.004]];
  for (const [bone, sz] of [[BN.FL, -1], [BN.FR, 1]]) sb.add(paddle(FORE, 0.6), M([0, 0, 0], [sz * Math.PI / 2, 0, 0]), flipCol, () => [[bone, 1]]);
  for (const [bone, sz] of [[BN.RL, -1], [BN.RR, 1]]) sb.add(paddle(REAR, 0.24), M([0, 0, 0], [sz * Math.PI / 2, 0, 0]), flipCol, () => [[bone, 1]]);
  // tail
  sb.add(taper(0.1, 0.035, 0.008, 6, 2), Mdir([-0.46, -0.02, 0], [-1, -0.15, 0]), cSkin, () => [[BN.body, 1]]);
  return sb.build();
}

/**
 * Turtle pose → { pitch, roll, yaw, depth, freq, flap (fore flipper stroke amplitude, rad), lift (flap bias, + up),
 * sweep (rest sweep, − = swept back), feather, rear (rear flipper paddle 0..1), headUp, headYaw, bob, phase }.
 */
export function turtlePose(action, state, s, t, seed, speed = 0) {
  s = clamp(Number.isFinite(s) ? s : 0, 0, 1);
  const ph = t + seed * 13;
  const o = { pitch: 0.03, roll: 0, yaw: 0, depth: 0.01, freq: 0.5, flap: 0.3, lift: 0.17, sweep: -0.32, feather: 0.3,
    rear: 0.3, headUp: 0.1, headYaw: 0, bob: 0.012, phase: ph };
  const onWave = state === 'RIDE' || state === 'TAKEOFF';
  const env = Math.sin(Math.PI * s);
  if (action === 'jump' || action === 'kickout') {          // pull off over the back: a short nose-up hop
    o.pitch = lerp(0.6, -0.7, smooth(0.05, 0.95, s)); o.roll = 0.35 * env;
    o.depth = 0; o.freq = 1.0; o.flap = 0.5; o.lift = 0.3; o.sweep = -0.15; o.headUp = 0.25; o.bob = 0;
  } else if (action === 'wipe') {                           // tumbled: rolls over, flippers flailing
    o.roll = 2 * Math.PI * smooth(0, 1, s); o.pitch = 0.7 * env; o.depth = 0.3; o.freq = 1.2; o.flap = 0.9; o.sweep = 0.1;
  } else if (action === 'dive') {
    o.pitch = -0.7 * Math.sin(Math.PI * Math.min(1, s * 1.2)); o.depth = lerp(0.1, 0.9, smooth(0, 0.6, s)) * (1 - smooth(0.85, 1, s));
    o.freq = 0.65; o.flap = 0.95; o.headUp = -0.15;
  } else if (onWave || ['trim', 'bottomTurn', 'cutback', 'crouch', 'lipHit', 'pop'].includes(action)) {
    // bodysurfing: flippers held out and swept back like wings, small trimming strokes, head up
    o.depth = 0.03; o.freq = 0.35; o.flap = 0.12; o.lift = 0.16; o.sweep = -0.65; o.feather = 0.2; o.rear = 0.1; o.headUp = 0.22;
    o.bob = 0.004;
    if (action === 'pop') {                                  // power strokes onto the face
      o.freq = lerp(0.95, 0.35, s); o.flap = lerp(0.95, 0.12, smooth(0.3, 1, s)); o.sweep = lerp(-0.25, -0.65, s); o.feather = lerp(0.6, 0.2, s);
    }
    if (action === 'bottomTurn') o.roll = 0.55 * env;
    if (action === 'cutback') o.roll = -0.65 * env;
    if (action === 'crouch') { o.sweep = -1.0; o.flap = 0.05; o.headUp = 0.05; }
    if (action === 'lipHit') { o.pitch = 0.4 * env; o.roll = 0.5 * Math.sin(2 * Math.PI * s); }
  } else if (action === 'roll') {                            // lazy roll at the surface
    o.depth = 0.06 - 0.12 * env; o.roll = 2 * Math.PI * smooth(0.1, 0.9, s); o.freq = 0.4; o.flap = 0.35; o.sweep = -0.2; o.headUp = 0.05;
  } else if (action === 'swim' || action === 'paddle') {
    o.freq = lerp(0.42, 0.62, smooth(0.3, 2.0, speed));
  } else {                                                   // idle: resting at the surface, lifts its head to breathe
    const breath = smooth(0.0, 0.12, ((ph * 0.16) % 1)) * (1 - smooth(0.3, 0.45, ((ph * 0.16) % 1)));
    o.depth = 0.015 + 0.012 * Math.sin(ph * 0.9); o.pitch = 0.02 + 0.08 * breath;
    o.roll = 0.06 * Math.sin(ph * 0.45); o.yaw = 0.25 * Math.sin(ph * 0.17);
    o.freq = 0.22; o.flap = 0.2; o.lift = 0.1; o.sweep = -0.35; o.feather = 0.35; o.rear = 0.25;
    o.headUp = 0.05 + 0.4 * breath; o.headYaw = 0.35 * Math.sin(ph * 0.31); o.bob = 0.006;
  }
  return o;
}

const _m = new THREE.Matrix4();

export class TurtleModel {
  constructor(def, sunDir) {
    this.def = def;
    this.mat = riderMaterial(sunDir, { roughness: 0.42, rim: 1.6, sheen: 0.8 });
    this.group = new THREE.Group();
    this.group.name = 'turtle:' + def.name;
    this.group.matrixAutoUpdate = false;
    const geo = buildTurtle(def.color ?? 0x6b7a3a, def.id | 0);
    const inv = [new THREE.Matrix4(), new THREE.Matrix4().makeTranslation(-HEAD_AT[0], -HEAD_AT[1], -HEAD_AT[2]),
      new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4()];
    const { mesh, bones } = makeSkinned(geo, this.mat, inv);
    this.body = mesh; this.bones = bones;
    this.body.matrixAutoUpdate = false;
    this.group.add(this.body);
    this.triangles = geo.index.count / 3;
  }

  apply(frame, o) {
    this.group.matrix.copy(frame);
    const S = TURTLE_SIZE;
    const p = 2 * Math.PI * (o.freq || 0) * o.phase;
    const bm = this.body.matrix;
    bm.makeTranslation(0, -o.depth + (o.bob || 0) * Math.sin(2 * p), 0);   // each downstroke lifts the body a little
    bm.multiply(_m.makeRotationY(o.yaw || 0));
    bm.multiply(_m.makeRotationZ(o.pitch || 0));
    bm.multiply(_m.makeRotationX(o.roll || 0));
    bm.multiply(_m.makeScale(S, S, S));
    this.bones[BN.body].matrix.identity();
    // head: turn, then nod (with a small counter-bob to the stroke)
    this.bones[BN.head].matrix.makeTranslation(...HEAD_AT)
      .multiply(_m.makeRotationY(o.headYaw || 0))
      .multiply(_m.makeRotationZ((o.headUp || 0) - 0.04 * (o.flap || 0) * Math.sin(p)));
    // fore flippers ("flying" stroke, both together): flap about the body axis, sweep forward/back, feather (pitch)
    const flap = (o.lift || 0) + (o.flap || 0) * Math.sin(p);
    const sweep = (o.sweep || 0) - 0.35 * (o.flap || 0) * Math.cos(p);
    const feather = (o.feather || 0) * Math.cos(p);
    for (const [bone, sz] of [[BN.FL, -1], [BN.FR, 1]]) {
      this.bones[bone].matrix.makeTranslation(FORE_AT[0], FORE_AT[1], sz * FORE_AT[2])
        .multiply(_m.makeRotationY(sz * sweep))
        .multiply(_m.makeRotationX(-sz * flap))
        .multiply(_m.makeRotationZ(feather));
    }
    // rear flippers: trailing rudders that paddle a little out of phase
    const rp = (o.rear || 0) * Math.sin(p + Math.PI * 0.6);
    for (const [bone, sz] of [[BN.RL, -1], [BN.RR, 1]]) {
      this.bones[bone].matrix.makeTranslation(REAR_AT[0], REAR_AT[1], sz * REAR_AT[2])
        .multiply(_m.makeRotationY(sz * (-0.75 + 0.35 * rp)))
        .multiply(_m.makeRotationX(-sz * (-0.05 + 0.25 * rp)));
    }
    this.group.updateMatrixWorld(true);
  }
}
