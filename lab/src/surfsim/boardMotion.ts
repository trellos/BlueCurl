// Board motion through the world (lab version). Ours by decision (docs/research README).
//
// Two layers, both advanced in fixed 120 Hz ticks:
//  1. A PLANNED path on the stand-in wave face, integrated LOOKAHEAD seconds ahead of the
//     present. Maneuvers are commitments to a heading program; committing re-integrates the
//     future from the commit's start time, so the board follows ~0.2 s after the body starts
//     the maneuver (instant onset). The rider reads planned specific force ahead in time.
//  2. A PERTURBATION layer: mass-spring offsets for pitch, roll, yaw and heave, driven by
//     manual sliders, impulse buttons and wave chop. These are the unplanned disturbances.
//
// Kinematics (v, a, omega) come from the plan (exact differences of our own path) plus the
// perturbation states, so no noisy differentiation of rendered poses is needed.

import * as THREE from 'three';
import { SIM_DT } from '../core/clock.ts';
import { MassSpring } from '../core/springs.ts';
import { WaveFace } from './waveFace.ts';

export type ManeuverKind = 'trim' | 'pump' | 'bottomTurn' | 'topTurn' | 'cutback' | 'chop';
export type MotionMode = 'generator' | 'manual';

const G = 9.81;
const DEG = Math.PI / 180;
export const LOOKAHEAD = 0.6; // s of planned path kept ahead of the present
const AHEAD_TICKS = Math.round(LOOKAHEAD / SIM_DT);
const RING = 512;

interface PlanState {
  t: number;
  x: number;
  z: number;
  theta: number; // heading in the horizontal plane: 0 = +X (down the line), +90° = +Z (down the face)
  v: number; // speed (m/s)
  // maneuver program state
  man: ManeuverKind;
  manStart: number;
  phase: number;
  phaseStart: number;
  thetaRef: number;
  w: number; // turn rate (rad/s), slew-limited so lateral acceleration rolls in and out
}

export interface BoardState {
  /** Board frame origin in world (boardkit frame: rocker-table plane, stringer, mid-length). */
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  /** World velocity, acceleration of the board origin. */
  velocity: THREE.Vector3;
  accel: THREE.Vector3;
  /** World angular velocity (rad/s) and angular acceleration. */
  omega: THREE.Vector3;
  alpha: THREE.Vector3;
  /** Planned-only acceleration and orientation (for the planned/disturbance split). */
  accelPlan: THREE.Vector3;
  quatPlan: THREE.Quaternion;
  /** Speed (m/s), heading angle (rad), position across the face (0 crest .. 1 toe). */
  speed: number;
  heading: number;
  faceU: number;
  maneuver: ManeuverKind;
}

function makeBoardState(): BoardState {
  return {
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    velocity: new THREE.Vector3(),
    accel: new THREE.Vector3(),
    omega: new THREE.Vector3(),
    alpha: new THREE.Vector3(),
    accelPlan: new THREE.Vector3(),
    quatPlan: new THREE.Quaternion(),
    speed: 0,
    heading: 0,
    faceU: 0,
    maneuver: 'trim',
  };
}

export interface ManualInputs {
  pitchDeg: number;
  rollDeg: number;
  yawDeg: number;
  heave: number;
}

export interface MotionParams {
  trimSpeed: number;
  /** Trim line target, fraction of the face from crest (0) to toe (1). */
  trimLine: number;
  /** Planned rail engagement: 0 = deck flat on the face, 1 = deck normal along apparent up. */
  railFollow: number;
  /** Chop forcing gain on the perturbation layer. */
  chopGain: number;
  /** Delay between a maneuver commit (body onset) and the board starting it (s). */
  boardLag: number;
}

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _f = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _side = new THREE.Vector3();
const _up = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p0 = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _nArr = [0, 0, 0];

export class BoardMotion {
  readonly wave: WaveFace;
  mode: MotionMode = 'generator';
  params: MotionParams = { trimSpeed: 7.5, trimLine: 0.42, railFollow: 0.55, chopGain: 1, boardLag: 0.2 };
  manual: ManualInputs = { pitchDeg: 0, rollDeg: 0, yawDeg: 0, heave: 0 };
  /** Bottom draft: how far the rocker-table plane sits below the local surface (m). */
  draft = 0.025;

  // plan ring buffer (index = tick mod RING)
  private ring: PlanState[] = [];
  private headTick = 0; // tick index of the newest planned sample
  private nowTick = 0;
  private pending: { kind: ManeuverKind; startTick: number } | null = null;
  private chopBoostUntil = 0;

  // perturbation layer
  readonly pPitch = new MassSpring();
  readonly pRoll = new MassSpring();
  readonly pYaw = new MassSpring();
  readonly pHeave = new MassSpring();
  private impulse = { pitch: 0, roll: 0, yaw: 0, heave: 0, surge: 0 };
  private surge = new MassSpring();

  readonly state: BoardState = makeBoardState();
  private prevQ = new THREE.Quaternion();
  private prevOmega = new THREE.Vector3();

  constructor(wave: WaveFace) {
    this.wave = wave;
    for (let i = 0; i < RING; i++) this.ring.push(this.blank());
    this.reset();
  }

  private blank(): PlanState {
    return { t: 0, x: 0, z: 0, theta: 0, v: 0, man: 'trim', manStart: 0, phase: 0, phaseStart: 0, thetaRef: 0, w: 0 };
  }

  reset(): void {
    const Wf = this.wave.faceWidth;
    const s0 = this.ring[0];
    Object.assign(s0, this.blank());
    s0.z = this.params.trimLine * Wf;
    s0.v = this.params.trimSpeed;
    this.headTick = 0;
    this.nowTick = 0;
    this.pending = null;
    for (const s of [this.pPitch, this.pRoll, this.pYaw, this.pHeave, this.surge]) s.reset();
    // backfill the past (straight-line extrapolation) so differences at t = 0 are clean
    for (let k = 1; k <= 16; k++) {
      const sp = this.at(-k);
      Object.assign(sp, s0);
      sp.t = -k * SIM_DT;
      sp.x = s0.x - s0.v * k * SIM_DT;
    }
    this.lastHeaveV = this.lastSurgeV = this.heaveAcc = this.surgeAcc = 0;
    while (this.headTick < AHEAD_TICKS + 2) this.integrateHead();
    this.prevQ.identity();
    this.evaluate(0, true);
  }

  private at(tick: number): PlanState {
    return this.ring[((tick % RING) + RING) % RING];
  }

  /** Request a maneuver. The board starts it `boardLag` s from now; returns its start time. */
  commit(kind: ManeuverKind): number {
    const startTick = this.nowTick + Math.round(this.params.boardLag / SIM_DT);
    if (kind === 'chop') {
      this.chopBoostUntil = (this.nowTick + Math.round(3 / SIM_DT)) * SIM_DT;
      return startTick * SIM_DT;
    }
    // rewind the plan to the start tick and re-integrate with the new program
    if (startTick <= this.headTick) {
      this.headTick = startTick;
      const s = this.at(startTick);
      s.man = kind;
      s.manStart = s.t;
      s.phase = 0;
      s.phaseStart = s.t;
      s.thetaRef = s.theta;
      while (this.headTick < this.nowTick + AHEAD_TICKS) this.integrateHead();
    } else {
      this.pending = { kind, startTick };
    }
    return startTick * SIM_DT;
  }

  impulseKick(kind: 'bump' | 'decel' | 'lateral'): void {
    if (kind === 'bump') {
      this.impulse.heave += 0.9;
      this.impulse.pitch += 1.6;
    } else if (kind === 'decel') {
      this.impulse.surge -= 2.2;
      this.impulse.pitch -= 1.2;
    } else {
      this.impulse.roll += 1.8;
      this.impulse.yaw += 0.9;
    }
  }

  /** Heading program: target heading and turn-radius limit for a plan state. */
  private steer(s: PlanState, Wf: number): { target: number; gMax: number; thrust: number } {
    const P = this.params;
    const u = s.z / Wf; // 0 crest .. 1 toe
    const trimTarget = Math.max(-25 * DEG, Math.min(25 * DEG, 0.35 * (P.trimLine - u) * Wf));
    const tau = s.t - s.manStart;
    const tp = s.t - s.phaseStart;
    // guards: never ride over the crest or far out onto the flats (a rider would turn first)
    if (u < 0.24 && s.theta < 0 && !(s.man === 'topTurn' && s.phase === 0)) return { target: 35 * DEG, gMax: 1.7, thrust: 0 };
    if (u > 1.25 && s.theta > -5 * DEG) return { target: -35 * DEG, gMax: 1.4, thrust: 0 };
    switch (s.man) {
      case 'pump': {
        const T = 1.15;
        const ph = Math.sin((2 * Math.PI * tau) / T);
        if (tau > 3 * T) this.endManeuver(s);
        return { target: trimTarget + 17 * DEG * ph, gMax: 0.9, thrust: ph > 0 ? 2.2 * ph : 0.4 * ph };
      }
      case 'bottomTurn': {
        if (s.phase === 0) {
          if (u > 1.0 || tp > 2.4) this.nextPhase(s);
          return { target: 42 * DEG, gMax: 0.35, thrust: 0 };
        }
        if (s.phase === 1) {
          if (u < 0.62 || tp > 2.0) this.nextPhase(s);
          return { target: -55 * DEG, gMax: 1.6, thrust: 0 };
        }
        if (tp > 1.0) this.endManeuver(s);
        return { target: 8 * DEG, gMax: 1.3, thrust: 0 };
      }
      case 'topTurn': {
        if (s.phase === 0) {
          if (u < 0.26 || tp > 2.0) this.nextPhase(s);
          return { target: -45 * DEG, gMax: 0.8, thrust: 0 };
        }
        if (s.phase === 1) {
          if (s.theta > 40 * DEG || tp > 1.2) this.nextPhase(s);
          return { target: 60 * DEG, gMax: 2.0, thrust: 0 };
        }
        if (tp > 0.9) this.endManeuver(s);
        return { target: trimTarget, gMax: 0.7, thrust: 0 };
      }
      case 'cutback': {
        if (s.phase === 0) {
          if (u < 0.3 || tp > 1.8) this.nextPhase(s);
          return { target: -28 * DEG, gMax: 0.6, thrust: 0 };
        }
        if (s.phase === 1) {
          if (s.theta > 160 * DEG || tp > 2.5) this.nextPhase(s);
          return { target: 172 * DEG, gMax: 1.4, thrust: 0.5 };
        }
        if (s.phase === 2) {
          if (s.theta < 15 * DEG || tp > 2.8) this.nextPhase(s);
          return { target: 5 * DEG, gMax: 1.3, thrust: 0.3 };
        }
        if (tp > 0.6) this.endManeuver(s);
        return { target: trimTarget, gMax: 0.7, thrust: 0 };
      }
      default:
        return { target: trimTarget, gMax: 0.5, thrust: 0 };
    }
  }

  private nextPhase(s: PlanState): void {
    s.phase++;
    s.phaseStart = s.t;
  }

  private endManeuver(s: PlanState): void {
    s.man = 'trim';
    s.phase = 0;
    s.manStart = s.t;
    s.phaseStart = s.t;
    // unwrap heading back near zero after a full cutback
    s.theta = Math.atan2(Math.sin(s.theta), Math.cos(s.theta));
  }

  /** Advance the newest plan sample by one tick. */
  private integrateHead(): void {
    const s0 = this.at(this.headTick);
    const s1 = this.at(this.headTick + 1);
    Object.assign(s1, s0);
    if (this.pending && this.pending.startTick === this.headTick + 1) {
      s1.man = this.pending.kind;
      s1.manStart = s1.t + SIM_DT;
      s1.phase = 0;
      s1.phaseStart = s1.manStart;
      s1.thetaRef = s1.theta;
      this.pending = null;
    }
    const dt = SIM_DT;
    const P = this.params;
    const Wf = this.wave.faceWidth;
    const st = this.steer(s1, Wf);
    // heading control: desired turn rate limited by the lateral-g budget (a = v·w), and the turn
    // rate itself slew-limited (angular acceleration) so rail engagement rolls in and out
    const wMax = (st.gMax * G) / Math.max(3, s1.v);
    let wDes = (st.target - s1.theta) / 0.3;
    wDes = Math.max(-wMax, Math.min(wMax, wDes));
    const aMax = 7; // rad/s^2
    s1.w += Math.max(-aMax * dt, Math.min(aMax * dt, wDes - s1.w));
    s1.theta += s1.w * dt;
    // speed: gravity along the path on the face, relax to trim speed, thrust
    const dx = Math.cos(s1.theta);
    const dz = Math.sin(s1.theta);
    const e = 0.05;
    const hx = (this.wave.profile(s1.x + e, s1.z) - this.wave.profile(s1.x - e, s1.z)) / (2 * e);
    const hz = (this.wave.profile(s1.x, s1.z + e) - this.wave.profile(s1.x, s1.z - e)) / (2 * e);
    const slope = hx * dx + hz * dz;
    const dv = -0.55 * G * slope + (P.trimSpeed - s1.v) / 2.2 + st.thrust;
    s1.v = Math.max(2.5, Math.min(13, s1.v + dv * dt));
    s1.x += s1.v * dx * dt;
    s1.z += s1.v * dz * dt;
    s1.t = s0.t + dt;
    this.headTick++;
  }

  /** Planned board origin position at a plan sample (swell surface, no chop). */
  private planPos(s: PlanState, out: THREE.Vector3): THREE.Vector3 {
    return out.set(s.x, this.wave.profile(s.x, s.z) - this.draft, s.z);
  }

  /** Planned acceleration at tick k (exact second difference of our own plan). */
  planAccel(k: number, out: THREE.Vector3): THREE.Vector3 {
    const D = SIM_DT * 4;
    const kk = Math.min(k, this.headTick - 4);
    this.planPos(this.at(kk - 4), _p0);
    this.planPos(this.at(kk), _p1);
    this.planPos(this.at(kk + 4), _p2);
    return out.copy(_p2).addScaledVector(_p1, -2).add(_p0).multiplyScalar(1 / (D * D));
  }

  /** Planned orientation at tick k: deck normal blends the face normal with apparent up. */
  planQuat(k: number, aPlan: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
    const s = this.at(k);
    const kk = Math.min(k, this.headTick - 1);
    this.planPos(this.at(kk + 1), _p2);
    this.planPos(this.at(kk - 1), _p0);
    _fwd.subVectors(_p2, _p0);
    if (_fwd.lengthSq() < 1e-10) _fwd.set(Math.cos(s.theta), 0, Math.sin(s.theta));
    _fwd.normalize();
    this.wave.profileNormal(s.x, s.z, _nArr);
    _n.set(_nArr[0], _nArr[1], _nArr[2]);
    _f.copy(aPlan).y += G; // specific force direction (apparent up)
    const fMag = _f.length();
    _f.normalize();
    // lateral acceleration magnitude decides how much the board goes on rail
    _side.crossVectors(_n, _fwd).normalize();
    const aLat = Math.abs(aPlan.dot(_side));
    const k01 = Math.min(1, aLat / 6);
    // near weightlessness (cresting) the apparent-up direction is meaningless: follow the face
    const wf = Math.min(1, Math.max(0, (fMag - 0.25 * G) / (0.5 * G)));
    const w = this.params.railFollow * (0.25 + 0.75 * k01) * wf * wf * (3 - 2 * wf);
    _up.copy(_n).multiplyScalar(1 - w).addScaledVector(_f, w).normalize();
    // small planing angle of attack: nose up ~2.5°
    _side.crossVectors(_up, _fwd).normalize(); // +X (left rail) = up × forward
    _fwd.crossVectors(_side, _up).normalize();
    _m.makeBasis(_side, _up, _fwd);
    out.setFromRotationMatrix(_m);
    _q2.setFromAxisAngle(_side.set(1, 0, 0), -2.5 * DEG);
    return out.multiply(_q2);
  }

  tick(t: number): void {
    this.nowTick++;
    while (this.headTick < this.nowTick + AHEAD_TICKS) this.integrateHead();
    // perturbations (fixed step)
    const dt = SIM_DT;
    const s = this.at(this.nowTick);
    const M = this.manual;
    const chopBoost = t < this.chopBoostUntil ? 4 : 1;
    let cp = 0;
    let cr = 0;
    let ch = 0;
    if (this.mode === 'generator') {
      // chop forcing: height differences nose-tail and rail-rail of the chop field
      const c = Math.cos(s.theta);
      const sn = Math.sin(s.theta);
      const hN = this.wave.chopHeight(s.x + 0.7 * c, s.z + 0.7 * sn, t);
      const hT = this.wave.chopHeight(s.x - 0.6 * c, s.z - 0.6 * sn, t);
      const hL = this.wave.chopHeight(s.x + 0.22 * sn, s.z - 0.22 * c, t);
      const hR = this.wave.chopHeight(s.x - 0.22 * sn, s.z + 0.22 * c, t);
      const g = this.params.chopGain * chopBoost;
      cp = (Math.atan2(hN - hT, 1.3) / DEG) * g;
      cr = (Math.atan2(hL - hR, 0.44) / DEG) * g;
      ch = 0.5 * (hN + hT) * g;
    }
    const imp = this.impulse;
    // impulses are velocity kicks (deg/s or m/s scaled)
    this.pPitch.v += imp.pitch * 40;
    this.pRoll.v += imp.roll * 40;
    this.pYaw.v += imp.yaw * 40;
    this.pHeave.v += imp.heave;
    this.surge.v += imp.surge;
    imp.pitch = imp.roll = imp.yaw = imp.heave = imp.surge = 0;
    this.pPitch.step(0, 2.2, 0.45, dt, M.pitchDeg + cp);
    this.pRoll.step(0, 2.0, 0.4, dt, M.rollDeg + cr);
    this.pYaw.step(0, 1.6, 0.6, dt, M.yawDeg);
    this.pHeave.step(0, 2.4, 0.5, dt, M.heave + ch);
    this.surge.step(0, 1.2, 0.8, dt, 0);
    this.recordPerturbAcc();
    this.evaluate(t, false);
  }

  private evaluate(t: number, first: boolean): void {
    const S = this.state;
    const k = this.nowTick;
    const s = this.at(k);
    S.maneuver = s.man;
    S.speed = this.mode === 'manual' ? 0 : s.v;
    S.heading = s.theta;
    S.faceU = s.z / this.wave.faceWidth;

    if (this.mode === 'manual') {
      S.position.set(0, 0, 0);
      S.accelPlan.set(0, 0, 0);
      S.quatPlan.identity();
      // board points down the line (+X): board +Z -> world +X
      S.quatPlan.setFromAxisAngle(_v.set(0, 1, 0), Math.PI / 2);
    } else {
      this.planPos(s, S.position);
      this.planAccel(k, S.accelPlan);
      this.planQuat(k, S.accelPlan, S.quatPlan);
    }
    // perturbations in the board frame: pitch about +X (nose up = negative rotation about +X
    // in a right-handed frame with +Z forward and +Y up), roll about +Z, yaw about +Y
    _e.set(-this.pPitch.x * DEG, this.pYaw.x * DEG, this.pRoll.x * DEG, 'YXZ');
    _q.setFromEuler(_e);
    S.quaternion.copy(S.quatPlan).multiply(_q);
    _up.set(0, 1, 0).applyQuaternion(S.quaternion);
    S.position.addScaledVector(_up, this.pHeave.x);
    _fwd.set(0, 0, 1).applyQuaternion(S.quaternion);
    S.position.addScaledVector(_fwd, this.surge.x);

    // kinematics: plan velocity/accel + perturbation accelerations
    if (this.mode === 'manual') {
      S.velocity.set(0, 0, 0);
    } else {
      this.planPos(this.at(k + 1), _p2);
      this.planPos(this.at(k - 1), _p0);
      S.velocity.subVectors(_p2, _p0).multiplyScalar(1 / (2 * SIM_DT));
    }
    // accelerations of the perturbation springs (exact velocity change over their last step)
    S.accel.copy(S.accelPlan);
    S.accel.addScaledVector(_up, this.heaveAcc);
    S.accel.addScaledVector(_fwd, this.surgeAcc);

    // angular velocity from orientation change (backward difference over one tick)
    if (first) {
      this.prevQ.copy(S.quaternion);
      S.omega.set(0, 0, 0);
      S.alpha.set(0, 0, 0);
    } else {
      _q2.copy(S.quaternion).multiply(_q.copy(this.prevQ).invert());
      if (_q2.w < 0) {
        _q2.x = -_q2.x;
        _q2.y = -_q2.y;
        _q2.z = -_q2.z;
        _q2.w = -_q2.w;
      }
      const sinHalf = Math.hypot(_q2.x, _q2.y, _q2.z);
      const ang = 2 * Math.atan2(sinHalf, _q2.w);
      if (sinHalf > 1e-9) _v.set(_q2.x, _q2.y, _q2.z).multiplyScalar(ang / sinHalf / SIM_DT);
      else _v.set(0, 0, 0);
      // light smoothing: one-tick differences of orientation are noisy, and alpha doubly so
      S.omega.lerp(_v, 0.5);
      _p0.subVectors(S.omega, this.prevOmega).multiplyScalar(1 / SIM_DT);
      S.alpha.lerp(_p0, 0.15);
      this.prevQ.copy(S.quaternion);
    }
    this.prevOmega.copy(S.omega);
  }

  private lastHeaveV = 0;
  private lastSurgeV = 0;
  private heaveAcc = 0;
  private surgeAcc = 0;

  /** Called by tick after the spring steps to record their accelerations. */
  private recordPerturbAcc(): void {
    this.heaveAcc = (this.pHeave.v - this.lastHeaveV) / SIM_DT;
    this.surgeAcc = (this.surge.v - this.lastSurgeV) / SIM_DT;
    this.lastHeaveV = this.pHeave.v;
    this.lastSurgeV = this.surge.v;
  }

  /** Planned specific force (apparent up, world) `lead` seconds ahead of now. */
  plannedForceAhead(lead: number, out: THREE.Vector3): THREE.Vector3 {
    if (this.mode === 'manual') return out.set(0, G, 0);
    const k = this.nowTick + Math.max(0, Math.min(AHEAD_TICKS - 5, Math.round(lead / SIM_DT)));
    this.planAccel(k, out);
    out.y += G;
    return out;
  }

  /** Planned board orientation `lead` seconds ahead. */
  plannedQuatAhead(lead: number, out: THREE.Quaternion): THREE.Quaternion {
    if (this.mode === 'manual') return out.copy(this.state.quatPlan);
    const k = this.nowTick + Math.max(0, Math.min(AHEAD_TICKS - 5, Math.round(lead / SIM_DT)));
    this.planAccel(k, _v);
    return this.planQuat(k, _v, out);
  }

  /** Planned path points for the debug overlay (world), every `step` ticks from now. */
  plannedPath(out: THREE.Vector3[], step = 6): number {
    let n = 0;
    for (let k = this.nowTick; k <= this.headTick && n < out.length; k += step) {
      this.planPos(this.at(k), out[n]);
      n++;
    }
    return n;
  }

  get nowTickIndex(): number {
    return this.nowTick;
  }
}
