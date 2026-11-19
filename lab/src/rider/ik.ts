// Analytic two-bone leg IK with knee-plane control and foot-to-deck alignment.
// Works in model space (board frame) on the Rig's FK buffers; writes local rotations.

import * as THREE from 'three';
import type { Pose, Rig } from './rig.ts';

export interface LegChain {
  thigh: number;
  calf: number;
  foot: number;
  /** Rest lengths. */
  a: number;
  b: number;
  /** Calf hinge axis in the calf's LOCAL frame (knee flexion axis, sign: points to the knee's left for a forward knee). */
  hingeLocal: THREE.Vector3;
  /** Foot rest model rotation and rest sole frame (model space) for alignment. */
  footRestQ: THREE.Quaternion;
  soleRestInv: THREE.Quaternion;
  /** Ankle position relative to the sole centre, in the rest sole frame. */
  ankleInSole: THREE.Vector3;
}

const _H = new THREE.Vector3();
const _K = new THREE.Vector3();
const _A = new THREE.Vector3();
const _u = new THREE.Vector3();
const _w = new THREE.Vector3();
const _t0 = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _n = new THREE.Vector3();
const _h = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();

/** Build a frame quaternion from forward (+Z) and up (+Y): x = up × forward. */
export function frameFrom(forward: THREE.Vector3, up: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
  _y.copy(up).normalize();
  _t0.copy(forward).addScaledVector(_y, -forward.dot(_y)).normalize();
  _x.crossVectors(_y, _t0).normalize();
  _m.makeBasis(_x, _y, _t0);
  return out.setFromRotationMatrix(_m);
}

export function makeLegChain(rig: Rig, side: 'L' | 'R'): LegChain {
  const thigh = rig.idx[side === 'L' ? 'thighL' : 'thighR'];
  const calf = rig.idx[side === 'L' ? 'calfL' : 'calfR'];
  const foot = rig.idx[side === 'L' ? 'footL' : 'footR'];
  const toe = rig.idx[side === 'L' ? 'toeL' : 'toeR'];
  const pH = rig.restP(thigh, new THREE.Vector3());
  const pK = rig.restP(calf, new THREE.Vector3());
  const pA = rig.restP(foot, new THREE.Vector3());
  const pT = rig.restP(toe, new THREE.Vector3());
  // knee flexion axis in the rest pose: thigh direction × knee-forward (+Z) = -X; express it in calf local
  const hingeModel = new THREE.Vector3(-1, 0, 0);
  const calfRestQ = rig.restQ(calf, new THREE.Quaternion());
  const hingeLocal = hingeModel.clone().applyQuaternion(calfRestQ.clone().invert());
  // sole frame: up +Y, forward = heel → toe direction (horizontal)
  const fwd = new THREE.Vector3(pT.x - pA.x, 0, pT.z - pA.z).normalize();
  const soleRest = frameFrom(fwd, new THREE.Vector3(0, 1, 0), new THREE.Quaternion());
  const soleCentre = new THREE.Vector3(pA.x, 0, pA.z).addScaledVector(fwd, 0.07);
  const ankleInSole = pA.clone().sub(soleCentre).applyQuaternion(soleRest.clone().invert());
  return {
    thigh,
    calf,
    foot,
    a: pK.distanceTo(pH),
    b: pA.distanceTo(pK),
    hingeLocal,
    footRestQ: rig.restQ(foot, new THREE.Quaternion()),
    soleRestInv: soleRest.clone().invert(),
    ankleInSole,
  };
}

/** Ankle target for a sole frame (position = sole centre, quaternion = +Y normal, +Z heel→toe). */
export function ankleTarget(leg: LegChain, solePos: THREE.Vector3, soleQ: THREE.Quaternion, out: THREE.Vector3): THREE.Vector3 {
  return out.copy(leg.ankleInSole).applyQuaternion(soleQ).add(solePos);
}

/**
 * Solve one leg. Rig FK buffers must be current for the chain's parents.
 * pole: desired knee-forward direction (model space). Returns the reach excess (m) that could
 * not be met (0 when the target is reachable).
 */
export function solveLeg(rig: Rig, pose: Pose, leg: LegChain, target: THREE.Vector3, pole: THREE.Vector3, soleQ: THREE.Quaternion | null): number {
  rig.modelP(leg.thigh, _H);
  const a = leg.a;
  const b = leg.b;
  _u.subVectors(target, _H);
  let d = _u.length();
  const maxR = (a + b) * 0.9995;
  const minR = Math.abs(a - b) + 1e-3;
  const excess = Math.max(0, d - maxR);
  d = Math.min(maxR, Math.max(minR, d));
  _u.normalize();
  // knee direction perpendicular to the hip→target line, toward the pole
  _w.copy(pole).addScaledVector(_u, -pole.dot(_u));
  if (_w.lengthSq() < 1e-8) _w.set(0, 0, 1).addScaledVector(_u, -_u.z);
  _w.normalize();
  const cosA = (a * a + d * d - b * b) / (2 * a * d);
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  // desired knee position
  _K.copy(_H).addScaledVector(_u, a * cosA).addScaledVector(_w, a * sinA);
  // 1) swing the thigh onto the new direction
  rig.modelP(leg.calf, _t0).sub(_H).normalize();
  _t1.subVectors(_K, _H).normalize();
  rig.modelQ(leg.thigh, _q);
  _q2.setFromUnitVectors(_t0, _t1);
  _q.premultiply(_q2);
  // 2) twist about the thigh so the knee hinge matches the plane normal (thigh × knee-forward)
  _n.crossVectors(_t1, _w).normalize();
  pose.getQ(leg.calf, _q2);
  _h.copy(leg.hingeLocal).applyQuaternion(_q2).applyQuaternion(_q); // current hinge (model)
  _h.addScaledVector(_t1, -_h.dot(_t1)).normalize();
  const ang = Math.atan2(_x.crossVectors(_h, _n).dot(_t1), _h.dot(_n));
  _q2.setFromAxisAngle(_t1, ang);
  _q.premultiply(_q2);
  rig.setModelQ(pose, leg.thigh, _q);
  rig.fkSubtree(pose, leg.thigh);
  // 3) bend the calf so the ankle lands on the target
  rig.modelP(leg.calf, _K);
  rig.modelP(leg.foot, _A);
  _t0.subVectors(_A, _K).normalize();
  _t1.subVectors(target, _K).normalize();
  rig.modelQ(leg.calf, _q);
  _q2.setFromUnitVectors(_t0, _t1);
  _q.premultiply(_q2);
  rig.setModelQ(pose, leg.calf, _q);
  rig.fkSubtree(pose, leg.calf);
  // 4) foot flat on the deck along the anchor
  if (soleQ) {
    _q.copy(soleQ).multiply(leg.soleRestInv).multiply(leg.footRestQ);
    rig.setModelQ(pose, leg.foot, _q);
    rig.fkSubtree(pose, leg.foot);
  }
  return excess;
}

/**
 * Arm chain for the same solver: upper arm → forearm → hand. The solver aligns the hinge with
 * (upper-arm direction × elbow-apex direction); in the A-pose the elbow apex points backward
 * (-Z), which gives these model-space hinge axes (measured on the Rocketbox rest skeleton).
 */
export function makeArmChain(rig: Rig, side: 'L' | 'R'): LegChain {
  const up = rig.idx[side === 'L' ? 'upperarmL' : 'upperarmR'];
  const fo = rig.idx[side === 'L' ? 'forearmL' : 'forearmR'];
  const ha = rig.idx[side === 'L' ? 'handL' : 'handR'];
  const pU = rig.restP(up, new THREE.Vector3());
  const pF = rig.restP(fo, new THREE.Vector3());
  const pH = rig.restP(ha, new THREE.Vector3());
  const hingeModel = side === 'L' ? new THREE.Vector3(0.68, 0.72, 0.16) : new THREE.Vector3(0.68, -0.72, -0.16);
  hingeModel.normalize();
  const foRestQ = rig.restQ(fo, new THREE.Quaternion());
  return {
    thigh: up,
    calf: fo,
    foot: ha,
    a: pF.distanceTo(pU),
    b: pH.distanceTo(pF),
    hingeLocal: hingeModel.applyQuaternion(foRestQ.clone().invert()),
    footRestQ: rig.restQ(ha, new THREE.Quaternion()),
    soleRestInv: new THREE.Quaternion(),
    ankleInSole: new THREE.Vector3(),
  };
}
