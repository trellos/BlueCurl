// Placeholder phase clips, authored procedurally and stored RELATIVE TO THE BOARD (board frame):
//  - paddle: prone crawl-style arm cycle, chest arched, head up, legs together;
//  - pop-up: prone push → chest up → tuck → land in a deep crouch on the pop-up landing anchors.
// No free paddle/pop-up clip exists in the MIT Rocketbox set, and Mixamo needs a login, so these
// are authored key-pose timelines on our own pipeline (doc 05 §8.5 treats the pop-up as the one
// clip-driven action; these stand in until real clips arrive).

import * as THREE from 'three';
import type { Board, Stance } from '../boardkit/board.ts';
import { Pose, type Rig } from './rig.ts';
import { applyOps, type Op } from './keyposes.ts';
import { makeArmChain, solveLeg, type LegChain } from './ik.ts';

const DEG = Math.PI / 180;
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _d = new THREE.Vector3();

export const PADDLE_PERIOD = 1.5; // s per full arm cycle (each arm)
export const POPUP_DURATION = 0.95; // s

function smooth(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

export class Clips {
  private rig: Rig;
  private arms: [LegChain, LegChain]; // [L, R]
  private tmp: Pose;
  private tmp2: Pose;

  constructor(rig: Rig) {
    this.rig = rig;
    this.arms = [makeArmChain(rig, 'L'), makeArmChain(rig, 'R')];
    this.tmp = new Pose(rig.n);
    this.tmp2 = new Pose(rig.n);
  }

  /** Character → board rotation for the prone body: head toward the nose, face down, chest lifted by `arch`. */
  proneOrientation(archDeg: number, out: THREE.Quaternion): THREE.Quaternion {
    return out.setFromAxisAngle(_v.set(1, 0, 0), (90 - archDeg) * DEG);
  }

  /** Aim bone i (toward its child c) along a model-space direction, swing only. */
  private aim(pose: Pose, i: number, c: number, dirModel: THREE.Vector3): void {
    const rig = this.rig;
    rig.modelP(c, _v).sub(rig.modelP(i, _v2)).normalize();
    _q2.setFromUnitVectors(_v, _d.copy(dirModel).normalize());
    rig.modelQ(i, _q).premultiply(_q2);
    rig.setModelQ(pose, i, _q);
    rig.fkSubtree(pose, i);
  }

  /** Prone base: spine arched, head up, legs together and straight-ish. Writes pelvis transform. */
  private proneBase(pose: Pose, board: Board, H: number, archDeg: number, lift: number): THREE.Quaternion {
    const rig = this.rig;
    pose.copy(rig.rest);
    const ops: Op[] = [
      ['spine1', 'x', -9], ['spine2', 'x', -10],
      ['neck', 'x', -22], ['head', 'x', -16],
      ['thighL', 'z', -4], ['thighR', 'z', 4],
      ['calfL', 'x', 8], ['calfR', 'x', 8],
      ['footL', 'x', 35], ['footR', 'x', 35],
    ];
    applyOps(rig, pose, ops);
    const C = this.proneOrientation(archDeg, new THREE.Quaternion());
    const ip = rig.idx.pelvis;
    rig.restQ(ip, _q);
    pose.setQ(ip, _q.premultiply(C));
    const zHips = board.derived.cob.z - 0.03 + 0.04;
    const deck = board.deckFrame(zHips, 0).p;
    pose.setP(ip, _v.set(0, deck.y + 0.11 + lift, zHips));
    rig.fk(pose);
    void H;
    return C;
  }

  /** Paddle cycle at time t (s). */
  paddle(pose: Pose, board: Board, H: number, t: number): void {
    const rig = this.rig;
    const C = this.proneBase(pose, board, H, 9, 0);
    const I = rig.idx;
    for (let k = 0; k < 2; k++) {
      const side = k === 0 ? 1 : -1; // +X = character's left
      const ph = (t / PADDLE_PERIOD + (k === 0 ? 0 : 0.5)) % 1;
      let dir: THREE.Vector3;
      let fore: THREE.Vector3;
      if (ph < 0.55) {
        // pull: overhead (toward the nose) → down through the water beside the rail → to the hip
        const p = ph / 0.55;
        const phi = (165 - 160 * smooth(p)) * DEG;
        const abd = 22 * DEG;
        dir = new THREE.Vector3(side * Math.sin(abd), -Math.cos(phi) * Math.cos(abd), Math.sin(phi) * Math.cos(abd));
        // high-elbow catch: forearm angled deeper into the water mid-pull
        fore = dir.clone().add(new THREE.Vector3(0, 0, 0.7 * Math.sin(Math.PI * p))).normalize();
      } else {
        // recovery: out at the hip, swing forward above the water, wide, elbow bent
        const p = (ph - 0.55) / 0.45;
        const phi = (5 + 160 * smooth(p)) * DEG;
        const abd = (22 + 55 * Math.sin(Math.PI * p)) * DEG;
        dir = new THREE.Vector3(side * Math.sin(abd), -Math.cos(phi) * Math.cos(abd), -0.35 * Math.sin(phi) * Math.cos(abd)).normalize();
        fore = dir.clone().add(new THREE.Vector3(0, -0.2, 0.9 * Math.sin(Math.PI * p))).normalize();
      }
      const up = k === 0 ? I.upperarmL : I.upperarmR;
      const fo = k === 0 ? I.forearmL : I.forearmR;
      const ha = k === 0 ? I.handL : I.handR;
      this.aim(pose, up, fo, dir.applyQuaternion(C));
      this.aim(pose, fo, ha, fore.applyQuaternion(C));
    }
  }

  /**
   * Pop-up at normalised time u ∈ [0, 1]. `ride` holds the landed riding pose (computed by the
   * normal riding path on the pop-up landing anchors); the clip blends into it over the last third.
   */
  popup(pose: Pose, ride: Pose, board: Board, H: number, u: number, stance: Stance): void {
    const rig = this.rig;
    const I = rig.idx;
    const s = stance === 'regular' ? 1 : -1;
    // key A→B: push (chest rises, pelvis stays); B→C: tuck (pelvis lifts, legs come under)
    const push = smooth(u / 0.35);
    const tuck = smooth((u - 0.3) / 0.35);
    const land = smooth((u - 0.6) / 0.4);
    // the push is a back-bend (hips stay down, chest rises), not a whole-body pitch
    const arch = 9 + 8 * push - 4 * tuck;
    const C = this.proneBase(pose, board, H, arch, 0.28 * tuck);
    const ext = push * (1 - 0.8 * tuck);
    applyOps(rig, pose, [
      // not spine0: in the Biped skeleton the thighs hang off Spine, so bending it swings the legs
      ['spine1', 'x', -22 * ext], ['spine2', 'x', -20 * ext],
      ['neck', 'x', 10 * ext], ['head', 'x', 6 * ext],
    ]);
    rig.fk(pose);
    // turn the hips toward the stance side while tucking
    if (tuck > 0) {
      const ip = I.pelvis;
      pose.getQ(ip, _q);
      _q2.setFromAxisAngle(_v.set(0, 0, 1), -s * 70 * DEG * tuck);
      pose.setQ(ip, _q.premultiply(_q2));
      applyOps(rig, pose, [
        ['thighL', 'x', -95 * tuck], ['thighR', 'x', -95 * tuck],
        ['calfL', 'x', 115 * tuck], ['calfR', 'x', 115 * tuck],
      ]);
      rig.fk(pose);
    }
    // hands planted on the pop-up anchors (arm IK), elbows pointing back toward the tail
    const hands = board.anchors().filter((a) => a.name === 'ANC_hand_popup_L' || a.name === 'ANC_hand_popup_R');
    const handW = 1 - land;
    if (handW > 0.01) {
      for (let k = 0; k < 2; k++) {
        const a = hands.find((h) => h.name.endsWith(k === 0 ? '_L' : '_R'))!;
        const target = _v.copy(a.position).add(_v2.set(0, 0.035, -0.07));
        const pole = _d.set(k === 0 ? 0.6 : -0.6, 0.3, -1).normalize();
        solveLeg(rig, pose, this.arms[k], target, pole, null);
      }
    }
    void C;
    // blend into the landed riding pose
    if (land > 0) {
      this.tmp.copy(pose);
      for (let i = 0; i < rig.n; i++) {
        this.tmp.getQ(i, _q);
        ride.getQ(i, _q2);
        _q.slerp(_q2, land);
        pose.setQ(i, _q);
      }
      const ip = I.pelvis;
      this.tmp.getP(ip, _v);
      ride.getP(ip, _v2);
      pose.setP(ip, _v.lerp(_v2, land));
    }
    void this.tmp2;
  }
}
