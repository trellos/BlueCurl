// Surfer model + procedural animation (WP6b). A stylised low-poly human (rashguard in the rider colour,
// boardshorts, skin, hair) on the copied thruster board. One SkinnedMesh with 16 rigid bones whose frames are
// solved every frame from a pose (pelvis/chest/head orientation vectors + IK targets for hands and feet), all in
// board space: +x nose, +y deck normal, +z right rail; the regular-foot stance faces +z with the left foot forward.
// Goofy riders are the mirror image (z → -z, left ↔ right). A pose is a flat record of 3-vectors, so blending
// two poses is a plain lerp; every pose is a pure function of (action, actionT, t, seed).
import * as THREE from 'three';
import {
  SkinBuilder, M, taper, ellipsoid, loftBody, riderMaterial, makeSkinned, frameMatrix, ik2, color,
  clamp, smooth, lerp, add3, sub3, scl3, cross3, norm3, mix3, rot3,
} from './common.js';
import { boardGeometry, boardMaterial } from './board.js';

// bones
export const B = { pelvis: 0, abdomen: 1, chest: 2, head: 3, uArmL: 4, fArmL: 5, handL: 6, uArmR: 7, fArmR: 8, handR: 9,
  thighL: 10, shinL: 11, footL: 12, thighR: 13, shinR: 14, footR: 15 };
const NB = 16;
const L = { thigh: 0.44, shin: 0.43, uArm: 0.29, fArm: 0.26, ankle: 0.075, abd: 0.08, chest: 0.16, neck: 0.30,
  shoulderW: 0.185, shoulderH: 0.255, hipW: 0.092, hipD: 0.06 };

export const SURFER_LOOKS = {
  Kai:   { skin: 0xc08458, hair: 0x22160e, shorts: 0x15244a, stripe: 0xf2f2f2, hairStyle: 'short', goofy: false },
  Moana: { skin: 0xa86c46, hair: 0x120c08, shorts: 0x0c6a66, stripe: 0xff7a3a, hairStyle: 'long', goofy: true },
};

function buildBody(rash, look) {
  const sb = new SkinBuilder();
  const cRash = color(rash), cRashD = color(rash).multiplyScalar(0.55), cSkin = color(look.skin), cHair = color(look.hair);
  const cShorts = color(look.shorts), cStripe = color(look.stripe), cDark = color(0x0a0807), cLip = color(look.skin).multiplyScalar(0.7);
  // torso: one lofted trunk in bind space (pelvis origin, abdomen at y = 0.08, chest at 0.24), smoothly weighted
  // pelvis → abdomen → chest; boardshorts below the waistband, rashguard above
  const tab = (T, y) => {
    if (y <= T[0][0]) return T[0].slice(1);
    for (let i = 0; i < T.length - 1; i++) if (y <= T[i + 1][0]) {
      const k = smooth(T[i][0], T[i + 1][0], y); return [lerp(T[i][1], T[i + 1][1], k), lerp(T[i][2], T[i + 1][2], k)];
    }
    return T[T.length - 1].slice(1);
  };
  //            y      half-width  half-depth
  const TORSO = [[-0.16, 0.05, 0.05], [-0.12, 0.13, 0.095], [-0.05, 0.168, 0.118], [0.05, 0.158, 0.112], [0.15, 0.142, 0.1],
    [0.29, 0.168, 0.115], [0.42, 0.188, 0.112], [0.5, 0.15, 0.09], [0.545, 0.07, 0.055], [0.56, 0.05, 0.045]];
  const y0 = -0.16, y1 = 0.56;
  const trunk = loftBody(y1 - y0, y0, 26, 18, (s) => tab(TORSO, y0 + s * (y1 - y0))[0], (s) => tab(TORSO, y0 + s * (y1 - y0))[1], () => 0, 1);
  const rotZ = new THREE.Matrix4().makeRotationZ(Math.PI / 2);
  sb.add(trunk, rotZ, (p, n) => {
    if (p.y < 0.075) return Math.abs(Math.abs(p.x) - 0.15) < 0.025 && p.y < 0.05 ? cStripe : (p.y > 0.055 ? cDark : cShorts);
    return Math.abs(n.x) > 0.85 && p.y < 0.4 ? cRashD : cRash;
  }, (p) => {
    const y = p.y;
    if (y < 0.0) return [[B.pelvis, 1]];
    if (y < 0.14) { const k = smooth(0.0, 0.14, y); return [[B.pelvis, 1 - k], [B.abdomen, k]]; }
    if (y < 0.3) { const k = smooth(0.14, 0.3, y); return [[B.abdomen, 1 - k], [B.chest, k]]; }
    return [[B.chest, 1]];
  });
  for (const sx of [-1, 1]) sb.add(ellipsoid(0.068, 0.066, 0.07, 10, 7), M([sx * 0.18, 0.24 + 0.24, -0.005]), cRash, B.chest);
  // head: neck, skull, hair, nose, eyes, ears
  sb.add(taper(0.1, 0.05, 0.048, 10, 2), M([0, -0.01, 0]), cSkin, B.head);
  sb.add(ellipsoid(0.094, 0.115, 0.104, 16, 12), M([0, 0.175, 0.012]), cSkin, B.head);
  sb.add(ellipsoid(0.1, 0.1, 0.104, 14, 10), M([0, 0.205, -0.012]), (p) => (p.z > 0.075 && p.y < 0.215 ? cSkin : cHair), B.head);
  sb.add(ellipsoid(0.017, 0.028, 0.02, 6, 5), M([0, 0.16, 0.115], [-0.3, 0, 0]), cSkin, B.head);
  sb.add(ellipsoid(0.03, 0.01, 0.012, 6, 4), M([0, 0.118, 0.105]), cLip, B.head);
  for (const sx of [-1, 1]) {
    sb.add(ellipsoid(0.013, 0.01, 0.008, 6, 4), M([sx * 0.036, 0.183, 0.108]), cDark, B.head);
    sb.add(ellipsoid(0.014, 0.026, 0.018, 6, 4), M([sx * 0.095, 0.17, 0.0]), cSkin, B.head);
  }
  if (look.hairStyle === 'long') {
    sb.add(ellipsoid(0.105, 0.09, 0.1, 12, 8), M([0, 0.18, -0.035]), cHair, B.head);                 // volume at the back
    sb.add(taper(0.28, 0.045, 0.02, 8, 4), M([0, 0.2, -0.1], [-2.55, 0, 0]), cHair, B.head);          // ponytail
  } else {
    sb.add(ellipsoid(0.1, 0.06, 0.1, 10, 6), M([0, 0.255, -0.005], [0.15, 0, 0]), cHair, B.head);      // messy top
  }
  // arms (long-sleeve rashguard to the wrist)
  for (const [u, f, h] of [[B.uArmL, B.fArmL, B.handL], [B.uArmR, B.fArmR, B.handR]]) {
    sb.add(taper(L.uArm, 0.05, 0.04, 10, 4), M(), cRash, u);
    sb.add(taper(L.fArm, 0.04, 0.032, 10, 4), M(), (p) => (p.y > 0.235 ? cSkin : cRash), f);
    sb.add(ellipsoid(0.046, 0.062, 0.022, 8, 6), M([0, 0.065, 0]), cSkin, h);
    sb.add(ellipsoid(0.014, 0.032, 0.014, 5, 4), M([0.035, 0.035, 0.012], [0, 0, -0.5]), cSkin, h);   // thumb
  }
  // legs: boardshorts to just above the knee
  for (const [th, sh, ft] of [[B.thighL, B.shinL, B.footL], [B.thighR, B.shinR, B.footR]]) {
    sb.add(taper(L.thigh, 0.088, 0.062, 12, 5), M(), (p) => (p.y > 0.36 ? cSkin : (p.y > 0.33 ? cStripe : cShorts)), th);
    sb.add(taper(L.shin, 0.058, 0.037, 10, 5), M(), cSkin, sh);
    sb.add(ellipsoid(0.045, 0.125, 0.034, 8, 6), M([0, 0.065, -0.042]), cSkin, ft);
  }
  return sb.build();
}

// ---------------------------------------------------------------- poses (board space, regular stance)
const P = (o) => o;
export const POSES = {
  stance: P({ hip: [-0.05, 0.8, 0.0], pUp: [0.03, 1, 0.08], pFwd: [0.35, 0, 1], cUp: [0.1, 0.95, 0.3], cFwd: [0.5, -0.15, 1],
    hUp: [0, 1, 0], hFwd: [1, -0.15, 0.5], fL: [0.28, 0.14, 0.0], fR: [-0.4, 0.14, 0.0], tL: [0.55, 0, 1], tR: [0.08, 0, 1],
    kL: [0.4, 0, 1], kR: [0.3, 0, 1], hL: [0.62, 1.0, 0.3], hR: [-0.62, 0.95, 0.2], eL: [0.2, -1, -0.6], eR: [-0.2, -1, -0.6] }),
  sit: P({ hip: [-0.18, 0.2, 0], pUp: [0, 1, 0], pFwd: [1, 0, 0], cUp: [0.06, 1, 0], cFwd: [1, -0.05, 0],
    hUp: [0, 1, 0], hFwd: [1, 0.05, 0], fL: [0.05, -0.36, -0.34], fR: [0.05, -0.36, 0.34], tL: [0.5, -0.8, 0], tR: [0.5, -0.8, 0],
    kL: [1, 0.3, -0.5], kR: [1, 0.3, 0.5], hL: [0.12, 0.16, -0.2], hR: [0.12, 0.16, 0.2], eL: [-0.4, 0, -1], eR: [-0.4, 0, 1] }),
  prone: P({ hip: [-0.4, 0.19, 0], pUp: [1, 0, 0], pFwd: [0, -1, 0], cUp: [0.92, 0.36, 0], cFwd: [0.36, -0.92, 0],
    hUp: [-0.2, 1, 0], hFwd: [1, 0.2, 0], fL: [-1.24, 0.3, -0.09], fR: [-1.24, 0.3, 0.09], tL: [-1, -0.3, 0], tR: [-1, -0.3, 0],
    kL: [0, -1, -0.2], kR: [0, -1, 0.2], hL: [0.3, 0.1, -0.3], hR: [0.3, 0.1, 0.3], eL: [0, 1, -0.6], eR: [0, 1, 0.6] }),
  pushup: P({ hip: [-0.38, 0.22, 0], pUp: [0.95, 0.3, 0], pFwd: [0.3, -0.95, 0], cUp: [0.6, 0.8, 0], cFwd: [0.8, -0.6, 0],
    hUp: [-0.3, 1, 0], hFwd: [1, 0.1, 0], fL: [-1.2, 0.2, -0.08], fR: [-1.2, 0.2, 0.08], tL: [-0.4, -1, 0], tR: [-0.4, -1, 0],
    kL: [0, -1, -0.2], kR: [0, -1, 0.2], hL: [0.02, 0.1, -0.21], hR: [0.02, 0.1, 0.21], eL: [-1, 0.2, -0.5], eR: [-1, 0.2, 0.5] }),
  tuck: P({ hip: [-0.2, 0.5, 0], pUp: [0.55, 0.75, 0.3], pFwd: [0.45, -0.5, 0.75], cUp: [0.5, 0.75, 0.3], cFwd: [0.7, -0.6, 0.3],
    hUp: [-0.2, 1, 0], hFwd: [1, 0, 0.2], fL: [0.12, 0.2, -0.04], fR: [-0.38, 0.14, 0], tL: [0.5, 0, 1], tR: [0.1, 0, 1],
    kL: [0.6, 0.4, 0.8], kR: [0.3, 0, 1], hL: [0.25, 0.1, -0.2], hR: [0.25, 0.1, 0.2], eL: [-1, 0.3, -0.5], eR: [-1, 0.3, 0.5] }),
  crouchUp: P({ hip: [-0.06, 0.62, 0.0], pUp: [0.1, 0.95, 0.2], pFwd: [0.35, -0.2, 1], cUp: [0.2, 0.8, 0.5], cFwd: [0.45, -0.5, 1],
    hUp: [0, 1, -0.1], hFwd: [1, -0.1, 0.4], fL: [0.28, 0.14, 0.0], fR: [-0.4, 0.14, 0.0], tL: [0.55, 0, 1], tR: [0.08, 0, 1],
    kL: [0.4, 0, 1], kR: [0.3, 0, 1], hL: [0.45, 0.55, 0.3], hR: [-0.45, 0.6, 0.2], eL: [0, -1, -0.3], eR: [0, -1, -0.3] }),
  bottomTurn: P({ hip: [-0.07, 0.72, 0.06], pUp: [0.05, 0.93, 0.3], pFwd: [0.35, -0.25, 1], cUp: [0.12, 0.85, 0.45], cFwd: [0.45, -0.4, 1],
    hUp: [0, 1, 0], hFwd: [1, 0.25, 0.35], fL: [0.28, 0.14, 0.0], fR: [-0.4, 0.14, 0.0], tL: [0.55, 0, 1], tR: [0.08, 0, 1],
    kL: [0.45, 0, 1], kR: [0.3, 0, 1], hL: [0.55, 0.6, 0.75], hR: [-0.62, 0.95, -0.1], eL: [0.2, -1, 0.2], eR: [-0.2, -1, -0.5] }),
  lipHit: P({ hip: [-0.1, 0.86, -0.02], pUp: [0.0, 1, 0.0], pFwd: [0.3, 0, 1], cUp: [0.05, 1, 0.1], cFwd: [0.6, 0.0, 1],
    hUp: [0, 1, 0.2], hFwd: [1, -0.45, 0.35], fL: [0.28, 0.14, 0.0], fR: [-0.4, 0.14, 0.0], tL: [0.55, 0, 1], tR: [0.08, 0, 1],
    kL: [0.4, 0, 1], kR: [0.3, 0, 1], hL: [0.6, 1.35, 0.25], hR: [-0.65, 1.2, 0.0], eL: [0.3, -0.5, -1], eR: [-0.3, -0.5, -1] }),
  cutback: P({ hip: [-0.09, 0.72, -0.07], pUp: [-0.05, 0.95, -0.2], pFwd: [-0.2, 0, 1], cUp: [-0.12, 0.92, -0.2], cFwd: [-0.6, -0.1, 1],
    hUp: [0, 1, 0], hFwd: [-1, -0.15, 0.4], fL: [0.28, 0.14, 0.0], fR: [-0.4, 0.14, 0.0], tL: [0.55, 0, 1], tR: [0.08, 0, 1],
    kL: [0.4, 0, 1], kR: [0.3, 0, 1], hL: [-0.25, 1.0, 0.5], hR: [-0.75, 0.7, -0.3], eL: [0, -1, 0.3], eR: [0, -1, -0.5] }),
  tube: P({ hip: [-0.08, 0.53, 0.03], pUp: [0.15, 0.85, 0.45], pFwd: [0.3, -0.45, 1], cUp: [0.3, 0.6, 0.75], cFwd: [0.5, -0.7, 0.7],
    hUp: [-0.2, 1, -0.35], hFwd: [1, 0.3, 0.2], fL: [0.28, 0.14, 0.0], fR: [-0.4, 0.14, 0.0], tL: [0.55, 0, 1], tR: [0.08, 0, 1],
    kL: [0.5, 0, 1], kR: [0.35, 0, 1], hL: [0.6, 0.62, 0.3], hR: [-0.25, 0.1, 0.72], eL: [0, -1, -0.3], eR: [-0.5, 0.2, -1] }),
  hop: P({ hip: [-0.1, 0.95, -0.05], pUp: [-0.1, 1, -0.1], pFwd: [0.3, 0, 1], cUp: [0.1, 1, 0.1], cFwd: [0.4, 0, 1],
    hUp: [0, 1, 0], hFwd: [1, 0, 0.3], fL: [0.22, 0.14, 0.0], fR: [-0.38, 0.14, 0.0], tL: [0.55, 0, 1], tR: [0.08, 0, 1],
    kL: [0.4, 0, 1], kR: [0.3, 0, 1], hL: [0.3, 1.55, 0.3], hR: [-0.3, 1.55, 0.25], eL: [0, -0.5, -1], eR: [0, -0.5, -1] }),
  // thrown off: limbs splayed (body space of the detached rider)
  flail: P({ hip: [0, 0.9, 0], pUp: [0, 1, 0], pFwd: [0, 0, 1], cUp: [0.1, 1, 0.2], cFwd: [0, -0.2, 1],
    hUp: [0, 1, 0.2], hFwd: [0, -0.3, 1], fL: [0.35, 0.2, 0.25], fR: [-0.35, 0.25, -0.1], tL: [0.3, 0, 1], tR: [-0.3, 0, 1],
    kL: [0.3, 0, 1], kR: [-0.3, 0, 1], hL: [0.6, 1.8, 0.1], hR: [-0.65, 1.6, 0.3], eL: [0.3, -0.5, -1], eR: [-0.3, -0.5, -1] }),
};
const KEYS = Object.keys(POSES.stance);

export function blendPose(a, b, k, out = {}) {
  for (const key of KEYS) out[key] = mix3(a[key], b[key], k);
  return out;
}
const copyPose = (a) => blendPose(a, a, 0);

/** Arm stroke target for prone paddling: phase p ∈ [0,1), side s = -1 (left, -z) | +1 (right). */
function strokeHand(p, s, reach = 1) {
  if (p < 0.55) {                                   // pull: in the water, entry ahead → exit at the hip
    const q = p / 0.55;
    return [lerp(0.62, -0.18, q) * reach, 0.05 - 0.36 * Math.sin(Math.PI * q), s * 0.3];
  }
  const q = (p - 0.55) / 0.45;                       // recovery: elbow high, arc forward over the water
  return [lerp(-0.18, 0.62, q) * reach, 0.05 + 0.28 * Math.sin(Math.PI * q), s * (0.34 + 0.06 * Math.sin(Math.PI * q))];
}

const env = (s, a = 0.28, b = 0.72) => smooth(0, a, s) * (1 - smooth(b, 1, s));

/**
 * Pose + board modifiers for an action. Returns { pose, board: {roll, pitch, yaw, lift, sink}, detach: null |
 * {offset:[f,u,s] (board-local), rot:[axis], angle} }. t = sim time (cyclic motion), seed ∈ [0,1).
 */
export function surferPose(action, s, t, seed, speed = 0) {
  s = clamp(Number.isFinite(s) ? s : 0, 0, 1);
  const bm = { roll: 0, pitch: 0, yaw: 0, lift: 0, sink: 0.02 };
  let pose, detach = null;
  const ph = t + seed * 10;
  switch (action) {
    case 'idle': {                                  // sitting astride, legs in the water, looking around
      pose = copyPose(POSES.sit);
      const look = 0.55 * Math.sin(ph * 0.31) + 0.25 * Math.sin(ph * 0.83);
      pose.hFwd = [Math.cos(look), 0.05 + 0.05 * Math.sin(ph * 0.5), Math.sin(look)];
      pose.cFwd = [Math.cos(look * 0.35), -0.05, Math.sin(look * 0.35)];
      pose.hip = add3(pose.hip, [0, 0.015 * Math.sin(ph * 1.3), 0]);
      const kick = 0.1 * Math.sin(ph * 1.7);
      pose.fL = add3(pose.fL, [kick, 0, 0]); pose.fR = add3(pose.fR, [-kick, 0, 0]);
      bm.pitch = 0.17; bm.sink = 0.05;
      break;
    }
    case 'paddle': case 'swim': {                   // prone, alternating arm strokes
      pose = copyPose(POSES.prone);
      const rate = 0.95, pL = ((ph * rate) % 1 + 1) % 1, pR = (pL + 0.5) % 1;
      pose.hL = strokeHand(pL, -1); pose.hR = strokeHand(pR, 1);
      pose.eL = [0.2, 1, -0.7]; pose.eR = [0.2, 1, 0.7];
      const roll = 0.12 * Math.sin(2 * Math.PI * pL);
      pose.cFwd = norm3(rot3(POSES.prone.cFwd, [1, 0, 0], roll));
      const kick = 0.06 * Math.sin(ph * 6.0);
      pose.fL = add3(pose.fL, [0, kick, 0]); pose.fR = add3(pose.fR, [0, -kick, 0]);
      bm.sink = 0.025; bm.roll = -roll * 0.4;
      break;
    }
    case 'pop': {                                   // prone → push-up → feet under → compressed → stance
      const k1 = smooth(0.0, 0.3, s), k2 = smooth(0.3, 0.6, s), k3 = smooth(0.6, 0.82, s), k4 = smooth(0.82, 1.0, s);
      pose = blendPose(POSES.prone, POSES.pushup, k1);
      pose = blendPose(pose, POSES.tuck, k2);
      pose = blendPose(pose, POSES.crouchUp, k3);
      pose = blendPose(pose, POSES.stance, k4);
      bm.sink = lerp(0.07, 0.02, k3); bm.pitch = -0.08 * env(s, 0.2, 0.6);
      break;
    }
    case 'bottomTurn': {
      const e = env(s);
      pose = blendPose(POSES.stance, POSES.bottomTurn, e);
      bm.roll = 0.6 * e;
      break;
    }
    case 'lipHit': {
      const e = env(s, 0.3, 0.7);
      pose = blendPose(POSES.stance, POSES.crouchUp, smooth(0, 0.25, s) * (1 - smooth(0.25, 0.45, s)));
      pose = blendPose(pose, POSES.lipHit, e);
      bm.pitch = 0.55 * e; bm.roll = -0.25 * e; bm.yaw = 0.6 * smooth(0.35, 0.8, s) * (1 - smooth(0.8, 1, s));
      break;
    }
    case 'cutback': {
      const e = env(s, 0.25, 0.75);
      pose = blendPose(POSES.stance, POSES.cutback, e);
      bm.roll = -0.55 * e;
      break;
    }
    case 'crouch': {
      const e = env(s, 0.18, 0.88);
      pose = blendPose(POSES.stance, POSES.tube, e);
      pose.hR = add3(pose.hR, [0.06 * Math.sin(ph * 2.3) * e, 0, 0]);
      bm.roll = 0.15 * e;
      break;
    }
    case 'kickout': {                               // compress, hop over the back pulling the board, land prone
      const k1 = smooth(0.0, 0.25, s), k2 = smooth(0.25, 0.45, s), k3 = smooth(0.62, 0.9, s);
      pose = blendPose(POSES.stance, POSES.crouchUp, k1);
      pose = blendPose(pose, POSES.hop, k2);
      pose = blendPose(pose, POSES.prone, k3);
      const air = smooth(0.25, 0.42, s) * (1 - smooth(0.55, 0.75, s));
      bm.lift = 0.65 * Math.sin(Math.PI * clamp((s - 0.25) / 0.5, 0, 1));
      bm.pitch = 0.65 * air; bm.yaw = -0.5 * air;
      bm.sink = lerp(0.02, 0.07, k3);
      break;
    }
    case 'wipe': {                                  // thrown forward, somersault, under, climb back on prone
      const out = smooth(0.0, 0.5, s), back = smooth(0.78, 1.0, s);
      pose = blendPose(POSES.stance, POSES.flail, smooth(0, 0.2, s));
      pose = blendPose(pose, POSES.prone, back);
      const arc = Math.sin(Math.PI * clamp(s / 0.55, 0, 1));
      const fwd = 2.2 * out * (1 - back), up = 0.9 * arc - 1.1 * smooth(0.45, 0.65, s) * (1 - back);
      detach = { offset: [fwd, up, 0.3 * out * (1 - back)], angle: -2 * Math.PI * smooth(0.04, 0.55, s) - 0.3 * smooth(0.55, 0.78, s) * (1 - back),
        pivot: [0, 0.9, 0] };
      bm.roll = 2 * Math.PI * smooth(0.05, 0.5, s) + Math.PI * 0 ;
      bm.lift = 0.7 * Math.sin(Math.PI * clamp(s / 0.45, 0, 1));
      bm.pitch = 0.9 * Math.sin(Math.PI * clamp(s / 0.45, 0, 1));
      bm.sink = 0.05;
      break;
    }
    case 'trim': default: {                        // pumping down the line
      pose = copyPose(POSES.stance);
      const pump = Math.sin(ph * 2 * Math.PI * 0.55);
      pose = blendPose(pose, POSES.crouchUp, 0.25 + 0.2 * pump);
      bm.roll = 0.08 * Math.sin(ph * 2 * Math.PI * 0.55 + 0.8);
      break;
    }
  }
  return { pose, board: bm, detach };
}

// ---------------------------------------------------------------- model
const _m = new THREE.Matrix4();
const MIR = new THREE.Matrix4().makeScale(1, 1, -1);
const FLIPX = new THREE.Matrix4().makeScale(-1, 1, 1);
const SWAP = [0, 1, 2, 3, 7, 8, 9, 4, 5, 6, 13, 14, 15, 10, 11, 12];

export class SurferModel {
  constructor(def, sunDir) {
    this.def = def;
    this.look = SURFER_LOOKS[def.name] || SURFER_LOOKS.Kai;
    this.mat = riderMaterial(sunDir, { roughness: 0.55, rim: 1.0, sheen: 0.6 });
    this.group = new THREE.Group();                       // world: rider frame (pos, fwd, up) × riderScale
    this.group.name = 'surfer:' + def.name;
    this.boardFrame = new THREE.Group();                  // board-local action modifiers
    this.boardFrame.matrixAutoUpdate = false;
    this.board = new THREE.Mesh(boardGeometry(def.color), boardMaterial(sunDir, this.mat));
    this.board.frustumCulled = false;
    this.boardFrame.add(this.board);
    const geo = buildBody(def.color, this.look);
    const inv = Array.from({ length: NB }, () => new THREE.Matrix4());
    inv[B.abdomen].makeTranslation(0, -L.abd, 0);                 // torso bones have a bind pose (smooth trunk)
    inv[B.chest].makeTranslation(0, -(L.abd + L.chest), 0);
    const { mesh, bones } = makeSkinned(geo, this.mat, inv);
    this.body = mesh; this.bones = bones;
    this.body.matrixAutoUpdate = false;
    this.group.add(this.boardFrame, this.body);
    this.frames = Array.from({ length: NB }, () => new THREE.Matrix4());
    this.triangles = (geo.index.count + this.board.geometry.index.count) / 3;
  }

  /** Solve bone frames for a pose (board space, regular stance) into this.frames. */
  solve(p) {
    const F = this.frames;
    const pY = norm3(p.pUp), pZ = norm3(sub3(p.pFwd, scl3(pY, p.pFwd[0] * pY[0] + p.pFwd[1] * pY[1] + p.pFwd[2] * pY[2])));
    const pX = cross3(pY, pZ);
    frameMatrix(F[B.pelvis], p.hip, pY, pZ);
    const aY = norm3(add3(pY, norm3(p.cUp))), aZ = norm3(add3(pZ, norm3(p.cFwd)));
    const aO = add3(p.hip, scl3(pY, L.abd));
    frameMatrix(F[B.abdomen], aO, aY, aZ);
    const cO = add3(aO, scl3(aY, L.chest));
    frameMatrix(F[B.chest], cO, p.cUp, p.cFwd);
    const cY = norm3(p.cUp);
    const cZ = norm3(sub3(p.cFwd, scl3(cY, p.cFwd[0] * cY[0] + p.cFwd[1] * cY[1] + p.cFwd[2] * cY[2])));
    const cX = cross3(cY, cZ);
    frameMatrix(F[B.head], add3(cO, scl3(cY, L.neck)), p.hUp, p.hFwd);
    // arms
    for (const [side, u, f, h, hand, elbow] of [[1, B.uArmL, B.fArmL, B.handL, p.hL, p.eL], [-1, B.uArmR, B.fArmR, B.handR, p.hR, p.eR]]) {
      const sh = add3(add3(cO, scl3(cY, L.shoulderH)), scl3(cX, side * L.shoulderW));
      const { mid, end } = ik2(sh, hand, L.uArm, L.fArm, elbow);
      const up1 = sub3(mid, sh), fa = sub3(end, mid);
      const zr = scl3(norm3(elbow), -1);
      frameMatrix(F[u], sh, up1, zr);
      frameMatrix(F[f], mid, fa, zr);
      frameMatrix(F[h], end, fa, cross3(fa, scl3(cX, side)));
    }
    // legs
    for (const [side, th, sn, ft, foot, toe, knee] of [[1, B.thighL, B.shinL, B.footL, p.fL, p.tL, p.kL], [-1, B.thighR, B.shinR, B.footR, p.fR, p.tR, p.kR]]) {
      const hj = add3(add3(p.hip, scl3(pX, side * L.hipW)), scl3(pY, -L.hipD));
      const { mid, end } = ik2(hj, foot, L.thigh, L.shin, knee);
      frameMatrix(F[th], hj, sub3(mid, hj), knee);
      frameMatrix(F[sn], mid, sub3(end, mid), knee);
      const shinUp = norm3(sub3(mid, end));
      frameMatrix(F[ft], end, toe, shinUp);
    }
  }

  /**
   * Pose the model. frame: THREE.Matrix4 rider frame (world, includes riderScale); a = surferPose(...) result.
   */
  apply(frame, a) {
    this.group.matrixAutoUpdate = false;
    this.group.matrix.copy(frame);
    const bm = a.board;
    // board modifiers: lift/sink along up, yaw about up, pitch about z (nose up), roll about x (toe rail down)
    const bmat = this.boardFrame.matrix;
    bmat.makeRotationY(bm.yaw);
    bmat.multiply(_m.makeRotationZ(bm.pitch));
    bmat.multiply(_m.makeRotationX(bm.roll));
    bmat.setPosition(0, bm.lift - bm.sink, 0);
    this.solve(a.pose);
    // body: carried by the board frame, or detached (wipe-out) with a somersault about its own centre
    const bodyM = this.body.matrix;
    if (a.detach) {
      const d = a.detach, pv = d.pivot;
      bodyM.makeTranslation(d.offset[0], d.offset[1] - bm.sink, d.offset[2]);
      bodyM.multiply(_m.makeTranslation(pv[0], pv[1], pv[2]));
      bodyM.multiply(_m.makeRotationZ(d.angle));
      bodyM.multiply(_m.makeTranslation(-pv[0], -pv[1], -pv[2]));
    } else {
      // keep the body on the board but without the board's roll for the wipe board flips (roll is small otherwise)
      bodyM.copy(bmat);
    }
    const goofy = this.look.goofy;
    for (let i = 0; i < NB; i++) {
      const src = this.frames[goofy ? SWAP[i] : i];
      if (goofy) this.bones[i].matrix.multiplyMatrices(MIR, src).multiply(FLIPX);
      else this.bones[i].matrix.copy(src);
    }
    if (goofy) {
      // mirror the board modifiers too (roll / yaw sense flips with the stance)
      bmat.makeRotationY(-bm.yaw);
      bmat.multiply(_m.makeRotationZ(bm.pitch));
      bmat.multiply(_m.makeRotationX(-bm.roll));
      bmat.setPosition(0, bm.lift - bm.sink, 0);
      if (!a.detach) bodyM.copy(bmat);
      else { const d = a.detach; bodyM.elements[14] = -d.offset[2]; }
    }
    this.group.updateMatrixWorld(true);
  }
}
