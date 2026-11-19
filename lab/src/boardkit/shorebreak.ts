// Conversion between the ShoreBreak surf-spike board frame and the BlueCurl board frame,
// so the two efforts can be merged later.
//
// ShoreBreak (branch claude/trusting-pascal-l7a99k, src/surf/Board.js): +x nose, +y deck up,
// +z right rail; origin on the bottom at the widest point (the stance centre).
// BlueCurl (glTF-style): +Z nose, +Y deck normal, +X left rail; origin on the stringer on the
// rocker-table plane at mid-length.
//
// Rotation: BlueCurl = Ry(-90°) · ShoreBreak, i.e. (x, y, z)_SB → (−z, y, x)_BC. Proper
// rotation (det +1). The origin offset is the ShoreBreak origin expressed in BlueCurl
// coordinates: (0, bottom height under the widest point, z of the widest point).

import * as THREE from 'three';
import type { Board } from './board.ts';

/** Rotation taking ShoreBreak board-frame vectors to BlueCurl board-frame vectors. */
export const Q_SB_TO_BC = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2);
export const Q_BC_TO_SB = Q_SB_TO_BC.clone().invert();

/** ShoreBreak origin in the BlueCurl frame for a given board (widest point, on the bottom). */
export function shoreBreakOrigin(b: Board, out = new THREE.Vector3()): THREE.Vector3 {
  const zw = b.spec.outline.widePointFromCentre;
  return out.set(0, b.bottomHeight(zw, 0), zw);
}

export function pointSBtoBC(p: THREE.Vector3, b: Board, out = new THREE.Vector3()): THREE.Vector3 {
  return out.copy(p).applyQuaternion(Q_SB_TO_BC).add(shoreBreakOrigin(b, _o));
}

export function pointBCtoSB(p: THREE.Vector3, b: Board, out = new THREE.Vector3()): THREE.Vector3 {
  return out.copy(p).sub(shoreBreakOrigin(b, _o)).applyQuaternion(Q_BC_TO_SB);
}

/**
 * A ShoreBreak world pose of its board object (position of its origin, orientation of its
 * frame) → the world pose of a BlueCurl board object for the same physical board.
 */
export function poseSBtoBC(
  posSB: THREE.Vector3,
  quatSB: THREE.Quaternion,
  b: Board,
  outPos = new THREE.Vector3(),
  outQuat = new THREE.Quaternion(),
): { position: THREE.Vector3; quaternion: THREE.Quaternion } {
  // world_from_BC = world_from_SB · SB_from_BC ; SB_from_BC rotation = Q_BC_TO_SB
  outQuat.copy(quatSB).multiply(Q_BC_TO_SB);
  // BC origin in SB coords = pointBCtoSB(0)
  pointBCtoSB(_z.set(0, 0, 0), b, _t);
  outPos.copy(_t).applyQuaternion(quatSB).add(posSB);
  return { position: outPos, quaternion: outQuat };
}

const _o = new THREE.Vector3();
const _z = new THREE.Vector3();
const _t = new THREE.Vector3();
