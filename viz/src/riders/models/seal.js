// Seal model + animation (WP6b). A chubby ~1.6 m harbour seal: dark brown-grey mottled back, lighter belly, round
// head with big dark eyes, a dark nose and pale whiskers, fore flippers and a paired hind-flipper "tail".
// One SkinnedMesh: a 5-bone spine (smooth weights along x, side-to-side undulation like a phocid) plus a bone for
// each fore flipper. Body space: +x nose, +y back, +z right; origin at the body centre.
import * as THREE from 'three';
import { SkinBuilder, M, Mdir, loftBody, finGeometry, ellipsoid, taper, riderMaterial, makeSkinned, color, clamp, smooth, lerp, table } from './common.js';
import { hash01 } from '../../contracts.js';

export const SEAL = { len: 1.42, x0: -0.62 };              // body loft (hind flippers add ~0.22 m behind)
const JX = [0.5, 0.28, 0.02, -0.28, -0.55];                // spine joints front → back
const NJ = JX.length, FL = NJ, FR = NJ + 1;                // fore flipper bones
const FLIP_AT = [0.28, -0.13, 0.17];                       // left flipper root (z mirrored for right)

function weights(x) {
  if (x >= JX[0]) return [[0, 1]];
  for (let k = 0; k < NJ - 1; k++) {
    if (x >= JX[k + 1]) { const w = (x - JX[k + 1]) / (JX[k] - JX[k + 1]); return [[k, w], [k + 1, 1 - w]]; }
  }
  return [[NJ - 1, 1]];
}

function buildSeal(back, id) {
  const sb = new SkinBuilder();
  const { len, x0 } = SEAL;
  const cBack = color(back).multiplyScalar(1.7), cBelly = color(0xb0a28c), cSpot = color(back).multiplyScalar(0.8), cDark = color(0x070605);
  const cWhisk = color(0xe8e0d0), cFlip = color(back).multiplyScalar(1.2);
  const PROF = [[0, 0.055], [0.1, 0.115], [0.25, 0.2], [0.45, 0.25], [0.6, 0.232], [0.71, 0.18], [0.77, 0.15], [0.83, 0.142],
    [0.89, 0.128], [0.94, 0.09], [0.975, 0.058], [1.0, 0.012]];
  const h = (s) => table(PROF, s);
  const w = (s) => h(s) * (s < 0.72 ? 1.1 : lerp(1.1, 1.0, smooth(0.72, 0.85, s)));
  const yc = (s) => 0.02 * Math.sin(Math.PI * s) + 0.035 * smooth(0.72, 0.88, s) - 0.02 * smooth(0.92, 1, s);
  const body = loftBody(len, x0, 40, 18, h, w, yc, 0.9);
  sb.add(body, M(), (p, n) => {
    const s = (p.x - x0) / len;
    if (p.y - yc(s) < -0.35 * h(s) && s < 0.9) return cBelly;
    const hh = hash01(Math.floor(p.x * 18) + 100 * id, Math.floor(p.z * 18), Math.floor(p.y * 18));
    return hh > 0.82 ? cSpot : cBack;
  }, (p) => weights(p.x));
  // face: eyes, nose, whiskers (thin pale spokes from the muzzle)
  const hx = x0 + 0.86 * len;
  for (const sz of [-1, 1]) {
    sb.add(ellipsoid(0.034, 0.034, 0.024, 8, 6), M([hx + 0.05, 0.095, sz * 0.1], [0, sz * -0.5, 0]), cDark, () => [[0, 1]]);
    for (let k = 0; k < 4; k++) {
      const a = -0.3 + k * 0.2;
      sb.add(taper(0.13, 0.0035, 0.002, 3, 1), Mdir([hx + 0.15, 0.012 + 0.012 * k, sz * 0.05], [-0.35, a, sz]), cWhisk, () => [[0, 1]]);
    }
  }
  sb.add(ellipsoid(0.026, 0.02, 0.03, 6, 5), M([x0 + len - 0.012, 0.035, 0]), cDark, () => [[0, 1]]);
  // fore flippers (each on its own bone; built pointing back-down from the root)
  for (const [bone, sz] of [[FL, -1], [FR, 1]]) {
    const g = finGeometry([[0.04, 0], [-0.02, -0.06], [-0.16, -0.1], [-0.25, -0.08], [-0.26, -0.02], [-0.12, 0.035]], 0.03);
    sb.add(g, M([0, 0, 0], [sz * 1.3, 0, 0]), cFlip, () => [[bone, 1]]);
  }
  // hind flippers: a pair of fans held together behind the tail (vertical when swimming)
  for (const sy of [-1, 1]) {
    const g = finGeometry([[0.02, 0], [-0.08, 0.05], [-0.24, 0.09], [-0.27, 0.0], [-0.24, -0.09], [-0.08, -0.05]], 0.025);
    sb.add(g, M([x0 + 0.05, 0.0, sy * 0.03], [sy * 0.3, 0, 0]), cFlip, () => [[NJ - 1, 1]]);
  }
  return sb.build();
}

/**
 * Seal pose → { pitch, roll, yaw, depth, beat (rad, lateral), freq, arch (+ convex), flip (fore flipper spread 0..1),
 * scull (fore flipper scull amplitude), headUp (rad) }.
 */
export function sealPose(action, state, s, t, seed, speed = 0) {
  s = clamp(Number.isFinite(s) ? s : 0, 0, 1);
  const ph = t + seed * 11;
  const o = { pitch: 0, roll: 0, yaw: 0, depth: 0.12, beat: 0.25, freq: 1.2, arch: 0, flip: 0.2, scull: 0, headUp: 0.15, phase: ph };
  const onWave = state === 'RIDE' || state === 'TAKEOFF';
  if (action === 'jump' || action === 'kickout') {          // breach: body follows the arc, flippers out
    o.pitch = lerp(0.9, -1.0, smooth(0.05, 0.95, s)); o.arch = 0.3 * Math.sin(Math.PI * s);
    o.depth = 0; o.beat = 0.1; o.freq = 2; o.flip = 0.9; o.headUp = -0.1;
    o.roll = 0.6 * Math.sin(Math.PI * s);
  } else if (action === 'wipe') {
    o.roll = 2 * Math.PI * smooth(0, 1, s); o.depth = 0.35; o.beat = 0.5; o.freq = 2.2; o.flip = 0.8;
  } else if (action === 'dive') {
    o.pitch = -0.6 * Math.sin(Math.PI * Math.min(1, s * 1.2)); o.depth = lerp(0.15, 0.8, smooth(0, 0.6, s)) * (1 - smooth(0.85, 1, s));
  } else if (onWave || ['trim', 'bottomTurn', 'cutback', 'crouch', 'lipHit', 'pop'].includes(action)) {
    // bodysurfing: stretched on the face, flippers swept back, head up
    o.depth = 0.1; o.beat = 0.06; o.freq = 0.8; o.arch = -0.18; o.flip = 0.0; o.headUp = 0.3;
    if (action === 'pop') { o.arch = lerp(0, -0.18, s); o.flip = lerp(0.3, 0, s); o.beat = lerp(0.35, 0.06, s); o.freq = 1.8; }
    if (action === 'bottomTurn') o.roll = 0.6 * Math.sin(Math.PI * s);
    if (action === 'cutback') o.roll = -0.8 * Math.sin(Math.PI * s);
    if (action === 'lipHit') { o.pitch = 0.4 * Math.sin(Math.PI * s); o.roll = 2 * Math.PI * smooth(0.2, 0.8, s); }
  } else if (action === 'roll') {                         // lazy barrel roll at the surface
    o.depth = 0.1; o.pitch = 0.05; o.roll = 2 * Math.PI * smooth(0.1, 0.9, s); o.beat = 0.15; o.freq = 0.6; o.flip = 0.5;
    o.headUp = 0.1;
  } else if (action === 'swim' || action === 'paddle') {
    o.depth = 0.12; o.beat = 0.38; o.freq = 1.3; o.headUp = 0.35; o.pitch = 0.06; o.flip = 0.05;
  } else {                                                   // idle: bottling, head up, sculling
    o.pitch = 1.2 + 0.06 * Math.sin(ph * 0.9);
    o.depth = 0.36 + 0.04 * Math.sin(ph * 1.1);
    o.roll = 0.12 * Math.sin(ph * 0.4); o.yaw = 0.3 * Math.sin(ph * 0.23);
    o.beat = 0.08; o.freq = 0.5; o.flip = 0.6; o.scull = 0.5; o.headUp = -0.25;
  }
  return o;
}

const _m = new THREE.Matrix4(), _f = new THREE.Matrix4();

export class SealModel {
  constructor(def, sunDir) {
    this.def = def;
    this.mat = riderMaterial(sunDir, { roughness: 0.38, rim: 1.1, sheen: 1.0 });
    this.group = new THREE.Group();
    this.group.name = 'seal:' + def.name;
    this.group.matrixAutoUpdate = false;
    const geo = buildSeal(def.color, def.id);
    const inv = [...JX.map((x) => new THREE.Matrix4().makeTranslation(-x, 0, 0)), new THREE.Matrix4(), new THREE.Matrix4()];
    const { mesh, bones } = makeSkinned(geo, this.mat, inv);
    this.body = mesh; this.bones = bones;
    this.body.matrixAutoUpdate = false;
    this.group.add(this.body);
    this.triangles = geo.index.count / 3;
  }

  apply(frame, o) {
    this.group.matrix.copy(frame);
    const bm = this.body.matrix;
    bm.makeTranslation(0, -o.depth, 0);
    bm.multiply(_m.makeRotationY(o.yaw || 0));
    bm.multiply(_m.makeRotationZ(o.pitch));
    bm.multiply(_m.makeRotationX(o.roll));
    const w = 2 * Math.PI * o.freq;
    // spine: lateral (yaw) wave toward the tail, vertical arch, head lifted
    // rotations per bone; the chest (bone 2) is the root, the chain is walked forward and backward from it
    const Rk = this._R || (this._R = JX.map(() => new THREE.Matrix4()));
    for (let k = 0; k < NJ; k++) {
      const amp = k === 0 ? -0.25 * o.beat : o.beat * Math.pow(Math.max(0, k - 1) / (NJ - 2), 1.6);
      const yaw = amp * Math.sin(w * o.phase - k * 1.1);
      const pitch = o.arch * (k / (NJ - 1) - 0.5) + (k === 0 ? o.headUp : 0);
      Rk[k].makeRotationY(yaw).multiply(_m.makeRotationZ(pitch));
    }
    const J = new Array(NJ);
    const v = new THREE.Vector3();
    J[2] = new THREE.Vector3(JX[2], 0, 0);
    for (let k = 1; k >= 0; k--) J[k] = v.set(JX[k] - JX[k + 1], 0, 0).applyMatrix4(_m.extractRotation(Rk[k + 1])).clone().add(J[k + 1]);
    for (let k = 3; k < NJ; k++) J[k] = v.set(JX[k] - JX[k - 1], 0, 0).applyMatrix4(_m.extractRotation(Rk[k - 1])).clone().add(J[k - 1]);
    for (let k = 0; k < NJ; k++) { this.bones[k].matrix.copy(Rk[k]).setPosition(J[k]); }
    // fore flippers: rotate about their root; spread (out from the body) and scull
    for (const [bone, sz] of [[FL, -1], [FR, 1]]) {
      const sc = o.scull * Math.sin(o.phase * 3.2 + (sz > 0 ? 0 : Math.PI));
      const spread = lerp(0.1, 1.1, o.flip);
      const m = this.bones[bone].matrix;
      m.makeTranslation(FLIP_AT[0], FLIP_AT[1], sz * FLIP_AT[2]);
      m.multiply(_m.makeRotationY(sz * (0.15 + 0.5 * o.flip) + sc * 0.5));
      m.multiply(_f.makeRotationX(-sz * (spread - 0.3) + sc * 0.3));
      // follow the chest bone (index 2) so the flippers ride the spine
      m.premultiply(_m.copy(this.bones[2].matrix).multiply(_f.makeTranslation(-JX[2], 0, 0)));
    }
    this.group.updateMatrixWorld(true);
  }
}
