// Rear chase camera (doc 01 §2.2, doc 10 §3.5). Spring-damped follow of a point on the
// board-heading frame H: distance 5 m back, 2 m up, 45° vertical FOV, level horizon with a
// partial roll pass-through, yaw lag 0.3–0.5 s. Rectilinear only. The same class is meant to
// ship in the visualization.

import * as THREE from 'three';
import { damp, dampAngle, Spring1, wrapPi } from '../core/springs.ts';

export interface ChaseParams {
  distance: number;
  height: number;
  fovDeg: number;
  /** Yaw lag time constant (s). */
  yawLag: number;
  /** Height lag time constant (s). */
  heightLag: number;
  /** Fraction of the board's roll (in the heading frame) passed to the camera. */
  rollFollow: number;
  /** Aim point above the board deck (m). */
  aimHeight: number;
  /** Aim point ahead of the board along the heading (m). */
  aimAhead: number;
}

export const defaultChase: ChaseParams = {
  distance: 5,
  height: 2,
  fovDeg: 45,
  yawLag: 0.4,
  heightLag: 0.2,
  rollFollow: 0.2,
  aimHeight: 0.9,
  aimAhead: 1.5,
};

export interface ChaseSubject {
  position: THREE.Vector3;
  /** Horizontal heading direction (unit, y = 0). */
  heading: THREE.Vector3;
  /** Board roll about the heading axis (rad, + = right rail down as seen from behind). */
  roll: number;
}

const LN2 = Math.LN2;

export class ChaseCamera {
  p: ChaseParams = { ...defaultChase };
  readonly camera: THREE.PerspectiveCamera;
  private yaw = 0;
  private y = new Spring1();
  private px = 0;
  private pz = 0;
  private roll = 0;
  private initialized = false;
  private tmp = new THREE.Vector3();
  private aim = new THREE.Vector3();

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(this.p.fovDeg, aspect, 0.05, 6000);
  }

  reset(): void {
    this.initialized = false;
  }

  update(s: ChaseSubject, dt: number): void {
    const p = this.p;
    const targetYaw = Math.atan2(s.heading.x, s.heading.z);
    if (!this.initialized) {
      this.yaw = targetYaw;
      this.y.reset(s.position.y);
      this.px = s.position.x;
      this.pz = s.position.z;
      this.roll = s.roll * p.rollFollow;
      this.initialized = true;
    }
    // halflife = time constant * ln2
    this.yaw = dampAngle(this.yaw, targetYaw, p.yawLag * LN2, dt);
    this.yaw = wrapPi(this.yaw);
    this.y.step(s.position.y, p.heightLag * LN2, dt);
    // the board position itself is followed tightly (tiny smoothing removes chop jitter)
    this.px = damp(this.px, s.position.x, 0.03, dt);
    this.pz = damp(this.pz, s.position.z, 0.03, dt);
    this.roll = damp(this.roll, s.roll * p.rollFollow, 0.12, dt);

    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    const cam = this.camera;
    cam.position.set(this.px - fx * p.distance, this.y.x + p.height, this.pz - fz * p.distance);
    this.aim.set(this.px + fx * p.aimAhead, this.y.x + p.aimHeight, this.pz + fz * p.aimAhead);
    // level horizon with partial roll: rotate world up about the view axis
    this.tmp.subVectors(this.aim, cam.position).normalize();
    cam.up.set(0, 1, 0).applyAxisAngle(this.tmp, -this.roll);
    cam.lookAt(this.aim);
    if (cam.fov !== p.fovDeg) {
      cam.fov = p.fovDeg;
      cam.updateProjectionMatrix();
    }
  }
}
