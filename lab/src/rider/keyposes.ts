// Authored static key poses, expressed as rotations in CHARACTER space (rest frame: +Z
// forward, +X the character's left, +Y up) so they do not depend on the source skeleton's bone
// axes (3ds Max Biped axes here). Each op rotates a bone about a character-space axis, measured
// in its parent's rest frame:   local' = (P⁻¹ · R(axis, θ) · P) · local,  P = parent rest model rotation.
//
// Legs are not authored: two-bone IK sets them from the board anchors.
// Sign conventions (character space):
//   flex(spine) = +X (bend forward)   twist = +Y (turn toward the character's left)
//   lateral = +Z (bend toward the character's right)
//   arm forward (shoulder flexion) = -X for both arms; arm raise = +Z (left), -Z (right)

import * as THREE from 'three';
import { Pose, type Joint, type Rig } from './rig.ts';

export type Axis = 'x' | 'y' | 'z' | readonly [number, number, number];
export type Op = [Joint, Axis, number]; // degrees

const AX = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
const DEG = Math.PI / 180;
const _P = new THREE.Quaternion();
const _R = new THREE.Quaternion();
const _L = new THREE.Quaternion();
const _ax = new THREE.Vector3();

/** Apply character-space ops to a pose (in place). */
export function applyOps(rig: Rig, pose: Pose, ops: readonly Op[], weight = 1): Pose {
  for (const [j, a, deg] of ops) {
    const i = rig.idx[j];
    const pi = rig.parent[i];
    if (pi >= 0) rig.restQ(pi, _P);
    else _P.identity();
    _R.setFromAxisAngle(typeof a === 'string' ? AX[a] : _ax.set(a[0], a[1], a[2]).normalize(), deg * DEG * weight);
    // P⁻¹ R P
    _R.premultiply(_L.copy(_P).invert()).multiply(_P);
    pose.getQ(i, _L);
    _L.premultiply(_R);
    pose.setQ(i, _L);
  }
  return pose;
}

/**
 * Elbow flexion about the true hinge: the normal of the rest upper-arm/forearm plane
 * (upperarm × forearm in the A-pose, measured from the Rocketbox rest skeleton).
 */
function elbow(side: 'L' | 'R', deg: number): Op[] {
  return side === 'L' ? [['forearmL', [-0.68, -0.72, -0.16], deg]] : [['forearmR', [-0.68, 0.72, 0.16], deg]];
}

// ---------------------------------------------------------------- spine / head / arm sets
// Regular stance: the character faces the toe-side rail, the nose is on the character's LEFT.
// The upper body opens toward the nose (twist +Y), the head looks down the line.

export const CROUCH_TALL: Op[] = [
  ['spine0', 'x', 3], ['spine1', 'x', 4], ['spine2', 'x', 3],
  ['spine0', 'y', 6], ['spine1', 'y', 8], ['spine2', 'y', 9],
  ['neck', 'y', 22], ['head', 'y', 26], ['neck', 'x', -3], ['head', 'x', -2],
];

export const CROUCH_MID: Op[] = [
  ['spine0', 'x', 5], ['spine1', 'x', 10], ['spine2', 'x', 10],
  ['spine0', 'y', 7], ['spine1', 'y', 9], ['spine2', 'y', 10],
  ['neck', 'y', 22], ['head', 'y', 26], ['neck', 'x', -10], ['head', 'x', -8],
];

export const CROUCH_DEEP: Op[] = [
  ['spine0', 'x', 8], ['spine1', 'x', 18], ['spine2', 'x', 18],
  ['spine0', 'y', 8], ['spine1', 'y', 10], ['spine2', 'y', 11],
  ['neck', 'y', 20], ['head', 'y', 24], ['neck', 'x', -22], ['head', 'x', -18],
];

/** Relaxed riding arms: front (nose-side, left) arm forward and slightly out, back arm low and out. */
export const ARMS_RIDE: Op[] = [
  ['upperarmL', 'x', -28], ['upperarmL', 'z', 6],
  ...elbow('L', 28),
  ['upperarmR', 'x', -12], ['upperarmR', 'z', -14],
  ...elbow('R', 32),
];

/** Balance: both arms out to the sides, near horizontal, elbows soft. */
export const ARMS_OUT: Op[] = [
  ['upperarmL', 'z', 38], ['upperarmL', 'x', -12],
  ...elbow('L', 15),
  ['upperarmR', 'z', -38], ['upperarmR', 'x', -12],
  ...elbow('R', 15),
];

/** Recovery: arms high and wide (windmill extreme). */
export const ARMS_HIGH: Op[] = [
  ['upperarmL', 'z', 70], ['upperarmL', 'x', -25],
  ...elbow('L', 25),
  ['upperarmR', 'z', -62], ['upperarmR', 'x', 10],
  ...elbow('R', 35),
];

/** Lead arm: front arm points down the line (toward the nose), back arm trails. */
export const ARMS_LEAD: Op[] = [
  ['upperarmL', 'x', -48], ['upperarmL', 'z', 22],
  ...elbow('L', 12),
  ['upperarmR', 'x', 18], ['upperarmR', 'z', -22],
  ...elbow('R', 22),
];

// ---------------------------------------------------------------- torture-test poses (step 3)
export const TORTURE: Record<string, { crouch: number; ops: Op[]; twistDeg?: number }> = {
  deepCrouch: { crouch: 1.15, ops: [...CROUCH_DEEP, ...ARMS_RIDE] },
  twistArmsOut: {
    crouch: 0.45,
    twistDeg: 45,
    ops: [...CROUCH_MID, ...ARMS_OUT, ['upperarmL', 'z', 6], ['upperarmR', 'z', -6]],
  },
  aerialTuck: {
    crouch: 1.45,
    ops: [
      ...CROUCH_DEEP,
      ['spine1', 'x', 10], ['spine2', 'x', 8],
      ['upperarmL', 'x', -55], ['upperarmL', 'z', -10], ...elbow('L', 35),
      ['upperarmR', 'x', -45], ['upperarmR', 'z', 5], ...elbow('R', 40),
    ],
  },
};

/** Bake ops on top of the rest pose into a new Pose. */
export function bake(rig: Rig, ops: readonly Op[]): Pose {
  return applyOps(rig, new Pose(rig.n).copy(rig.rest), ops);
}

/** Mirror ops for goofy stance (left ↔ right, twist/lateral flipped). */
export function mirrorOps(ops: readonly Op[]): Op[] {
  const sw = (j: Joint): Joint => {
    if (j.endsWith('L')) return (j.slice(0, -1) + 'R') as Joint;
    if (j.endsWith('R')) return (j.slice(0, -1) + 'L') as Joint;
    return j;
  };
  return ops.map(([j, a, d]) => {
    if (typeof a !== 'string') return [sw(j), [a[0], -a[1], -a[2]] as const, d] as Op;
    return [sw(j), a, a === 'x' ? d : -d] as Op;
  });
}

const _a = new THREE.Quaternion();
const _b = new THREE.Quaternion();

/** out = nlerp(a, b, w) per bone, optionally only for a subset of bone indices. */
export function blendPoses(out: Pose, a: Pose, b: Pose, w: number, bones?: readonly number[]): void {
  const n = a.q.length / 4;
  const list = bones ?? Array.from({ length: n }, (_, i) => i);
  for (const i of list) {
    a.getQ(i, _a);
    b.getQ(i, _b);
    _a.slerp(_b, w);
    out.setQ(i, _a);
  }
}
