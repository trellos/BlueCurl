// Dolphin model + animation (WP6b). A sleek ~2.5 m bottlenose: grey-blue back (rider colour), darker cape,
// light belly, melon and rostrum, falcate dorsal fin, pectoral flippers and a crescent fluke. One SkinnedMesh on a
// 7-bone spine chain (smooth weights along x) beating vertically: a travelling wave whose amplitude grows toward
// the fluke. Body space: +x nose, +y back (dorsal), +z right; origin at the body's centre of buoyancy.
import * as THREE from 'three';
import { SkinBuilder, M, loftBody, finGeometry, ellipsoid, riderMaterial, makeSkinned, color, clamp, smooth, lerp, table } from './common.js';

export const DOLPHIN = { len: 2.5, x0: -1.3 };          // tail tip at x0, rostrum tip at x0 + len
// spine joints (x), front to back: bone 0 = head/front (root), last = fluke
const JX = [0.55, 0.2, -0.15, -0.45, -0.75, -1.0, -1.18];
const NJ = JX.length;

function weights(x) {
  if (x >= JX[0]) return [[0, 1]];
  for (let k = 0; k < NJ - 1; k++) {
    if (x >= JX[k + 1]) { const w = (x - JX[k + 1]) / (JX[k] - JX[k + 1]); return [[k, w], [k + 1, 1 - w]]; }
  }
  return [[NJ - 1, 1]];
}

function buildDolphin(back) {
  const sb = new SkinBuilder();
  const { len, x0 } = DOLPHIN;
  const base = color(back).lerp(color(0x7a7f86), 0.5);
  const cBack = base, cCape = base.clone().multiplyScalar(0.55), cBelly = color(0xe4ebef), cDark = color(0x101418);
  const cFin = base.clone().multiplyScalar(0.7);
  // half-height h(s) (tail 0 .. rostrum 1), half-width w(s): peduncle laterally compressed, melon, short beak
  const PROF = [[0, 0.028], [0.08, 0.045], [0.2, 0.085], [0.35, 0.155], [0.5, 0.205], [0.62, 0.222], [0.74, 0.2], [0.82, 0.165],
    [0.88, 0.125], [0.915, 0.08], [0.94, 0.05], [0.985, 0.032], [1.0, 0.012]];
  const h = (s) => table(PROF, s);
  const w = (s) => h(s) * (s < 0.35 ? lerp(0.38, 0.88, smooth(0.04, 0.35, s)) : 0.88);
  const yc = (s) => 0.018 * Math.sin(Math.PI * s) - 0.045 * smooth(0.86, 0.95, s);
  const body = loftBody(len, x0, 44, 18, h, w, yc, 0.92);
  sb.add(body, M(), (p, n) => {
    const s = (p.x - x0) / len;
    // countershading: belly line rises toward the head, a darker cape on the back between the blowhole and dorsal
    const line = -0.03 + 0.05 * Math.sin(p.x * 3.1) + 0.06 * smooth(0.6, 0.95, s);
    const c = p.y - yc(s) < line * h(s) * 3 ? cBelly : cBack;
    if (c === cBack && n.y > 0.55 && s > 0.38 && s < 0.82) return cCape;
    return c;
  }, (p) => weights(p.x));
  // eyes
  for (const sz of [-1, 1]) sb.add(ellipsoid(0.018, 0.014, 0.012, 6, 4), M([0.86, 0.0, sz * 0.105]), cDark, (p) => weights(p.x));
  // dorsal fin (falcate), base over the middle of the back
  const dor = finGeometry([[0.22, 0], [0.05, 0.12], [-0.12, 0.27], [-0.2, 0.3], [-0.14, 0.22], [-0.16, 0.08], [-0.2, 0]], 0.03);
  sb.add(dor, M([-0.05, 0.19, 0]), cFin, (p) => weights(p.x));
  // pectoral flippers: angled down and back
  for (const sz of [-1, 1]) {
    const pec = finGeometry([[0.1, 0.01], [0.04, -0.07], [-0.12, -0.17], [-0.22, -0.2], [-0.18, -0.12], [-0.08, -0.02], [-0.06, 0.03]], 0.024);
    sb.add(pec, M([0.52, -0.08, sz * 0.13], [sz * 0.75, sz * -0.3, 0]), cFin, (p) => weights(p.x));
  }
  // fluke: horizontal crescent (outline in x/z, built in XY then laid flat)
  const fl = finGeometry([[0.05, 0], [-0.05, 0.12], [-0.17, 0.3], [-0.23, 0.31], [-0.17, 0.14], [-0.2, 0.0],
    [-0.17, -0.14], [-0.23, -0.31], [-0.17, -0.3], [-0.05, -0.12]], 0.025);
  sb.add(fl, M([x0 + 0.12, 0.01, 0], [Math.PI / 2, 0, 0]), cFin, () => [[NJ - 1, 1]]);
  return sb.build();
}

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _ax = new THREE.Vector3(0, 0, 1);

/**
 * Dolphin pose for an action → { beat (rad amplitude at the fluke), freq (Hz), arch (rad, + = convex: back bowed up,
 * head and fluke down), pitch, roll, depth (m below the water line for the origin; < 0 = above), finOut }.
 * pitchJump: body follows a jump trajectory: actionT 0 → nose up, 1 → nose down.
 */
export function dolphinPose(action, state, s, t, seed, speed = 0) {
  s = clamp(Number.isFinite(s) ? s : 0, 0, 1);
  const o = { beat: 0.3, freq: 1.4, arch: 0, pitch: 0, roll: 0, yaw: 0, depth: 0.22, phase: t + seed * 7 };
  const onWave = state === 'RIDE' || state === 'TAKEOFF';
  if (action === 'jump' || action === 'kickout') {          // porpoise / launch: nose up → arched → nose down
    o.pitch = lerp(0.85, -0.95, smooth(0.05, 0.95, s));
    o.arch = 0.25 * Math.sin(Math.PI * s);
    o.beat = 0.08 * (1 - Math.sin(Math.PI * s)); o.freq = 2.2;
    o.depth = 0.0;                                          // trajectory comes from pos (sim)
  } else if (action === 'dive') {
    o.pitch = -0.55 * Math.sin(Math.PI * Math.min(s * 1.2, 1)); o.depth = lerp(0.25, 0.9, smooth(0, 0.6, s)) * (1 - smooth(0.85, 1, s));
    o.beat = 0.35; o.freq = 1.8;
  } else if (onWave || action === 'trim' || action === 'bottomTurn' || action === 'cutback' || action === 'crouch' || action === 'lipHit') {
    // surfing inside the face just under the surface: dorsal fin cuts through, gentle beat, banking in turns
    o.depth = 0.17; o.beat = 0.16; o.freq = 0.9; o.arch = -0.04;
    if (action === 'bottomTurn') o.roll = 0.6 * Math.sin(Math.PI * s);
    if (action === 'cutback') o.roll = -0.7 * Math.sin(Math.PI * s);
    if (action === 'lipHit') { o.pitch = 0.5 * Math.sin(Math.PI * s); o.depth = lerp(0.3, -0.2, Math.sin(Math.PI * s)); }
    if (action === 'crouch') o.depth = 0.38;
    if (action === 'wipe') { o.roll = 2 * Math.PI * smooth(0, 1, s); o.beat = 0.4; o.freq = 2.0; }
  } else if (action === 'wipe') {
    o.roll = 2 * Math.PI * smooth(0, 1, s); o.depth = 0.4; o.beat = 0.4; o.freq = 2.0;
  } else if (action === 'swim' || action === 'paddle') {    // cruising at the surface, rolling up to breathe
    const cyc = ((o.phase * 0.3) % 1 + 1) % 1;             // breath cycle: surface → roll forward → under
    const br = Math.sin(Math.PI * clamp(cyc / 0.35, 0, 1));
    o.depth = lerp(0.3, 0.1, br); o.pitch = 0.12 * Math.cos(Math.PI * clamp(cyc / 0.35, 0, 1));
    o.beat = 0.32; o.freq = 1.6;
  } else {                                                   // idle: logging at the surface, slow beat
    o.depth = 0.16 + 0.04 * Math.sin(o.phase * 0.7); o.beat = 0.1; o.freq = 0.5;
    o.roll = 0.1 * Math.sin(o.phase * 0.33);
  }
  return o;
}

export class DolphinModel {
  constructor(def, sunDir) {
    this.def = def;
    this.mat = riderMaterial(sunDir, { roughness: 0.32, rim: 1.0, sheen: 1.0 });
    this.group = new THREE.Group();
    this.group.name = 'dolphin:' + def.name;
    this.group.matrixAutoUpdate = false;
    const geo = buildDolphin(def.color);
    const inv = JX.map((x) => new THREE.Matrix4().makeTranslation(-x, 0, 0));
    const { mesh, bones } = makeSkinned(geo, this.mat, inv);
    this.body = mesh; this.bones = bones;
    this.body.matrixAutoUpdate = false;
    this.group.add(this.body);
    this.triangles = geo.index.count / 3;
  }

  /** frame: rider frame (world, includes riderScale); o = dolphinPose(...). */
  apply(frame, o) {
    this.group.matrix.copy(frame);
    // body transform: depth along up, pitch about z, roll about x
    const bm = this.body.matrix;
    bm.makeTranslation(0, -o.depth, 0);
    bm.multiply(_m.makeRotationY(o.yaw || 0));
    bm.multiply(_m.makeRotationZ(o.pitch));
    bm.multiply(_m.makeRotationX(o.roll));
    // spine chain from the head backward: joint k at JX[k] in bind; accumulate a pitch angle per segment
    const w = 2 * Math.PI * o.freq;
    let ang = 0, px = JX[0], py = 0;
    // a small counter-rotation at the head keeps the rostrum steady while the fluke beats
    const head = -0.15 * o.beat * Math.sin(w * o.phase);
    ang = head - o.arch * 0.5;
    for (let k = 0; k < NJ; k++) {
      if (k > 0) {
        const seg = JX[k - 1] - JX[k];
        px -= Math.cos(ang) * seg; py -= Math.sin(ang) * seg;
        const amp = o.beat * Math.pow(k / (NJ - 1), 1.6);
        ang += amp * Math.sin(w * o.phase - k * 0.9) / Math.max(1, k * 0.6) + o.arch * (k / (NJ - 1)) * 0.5;
      }
      const b = this.bones[k].matrix;
      b.makeRotationZ(ang);
      b.setPosition(px, py, 0);
    }
    this.group.updateMatrixWorld(true);
  }
}
