// Rider v0: pose synthesis + balance model + IK, on our own Float32Array pose pipeline.
//
// Fixed-rate part (tick, 120 Hz): balance springs driven by the board's specific force
//   f_B = R_Bᵀ (a_s − g), split into planned (read AHEAD from our own board plan → the body
//   leads) and disturbance (lags, through an under-damped COM spring with stability-dependent
//   damping, latency and pink force noise). Graded recovery: arms out → stumble step → fall.
// Render-rate part (frame): key-pose blend → pelvis placement along the body-up axis →
//   FK → two-bone leg IK onto the board anchors → head stabilisation → write bones.

import * as THREE from 'three';
import { AsymSpring, damp, MassSpring, Spring1 } from '../core/springs.ts';
import { makePinkNoise, mulberry32 } from '../core/clock.ts';
import type { Board, Stance } from '../boardkit/board.ts';
import type { BoardMotion, ManeuverKind } from '../surfsim/boardMotion.ts';
import { Pose, type Rig } from './rig.ts';
import {
  applyOps, ARMS_HIGH, ARMS_LEAD, ARMS_OUT, ARMS_RIDE, bake, blendPoses, CROUCH_DEEP, CROUCH_MID, CROUCH_TALL,
  mirrorOps, TORTURE, type Op,
} from './keyposes.ts';
import { ankleTarget, frameFrom, makeLegChain, solveLeg, type LegChain } from './ik.ts';
import { Clips, POPUP_DURATION } from './clips.ts';

const G = 9.81;
const DEG = Math.PI / 180;

export interface RiderParams {
  /** Anticipation lead (s): how far ahead the body reads the planned apparent gravity. */
  leadTime: number;
  /** Blend of apparent-up vs deck normal for the body axis (κ). */
  kappa: number;
  /** COM spring frequency (Hz) and gain on disturbance specific force. */
  comHz: number;
  lagGain: number;
  /** Intent crouch 0 tall .. 1 deep. */
  crouchIntent: number;
  /** Manual overrides (negative = off). */
  stabilityOverride: number;
  performanceOverride: number;
  /** Head roll levelling toward the horizon (0..1). */
  horizonLevel: number;
  /** Enable layers. */
  ik: boolean;
  balance: boolean;
  head: boolean;
  noise: boolean;
  torture: '' | 'deepCrouch' | 'twistArmsOut' | 'aerialTuck';
}

export const defaultRiderParams: RiderParams = {
  leadTime: 0.22,
  kappa: 0.85,
  comHz: 2.0,
  lagGain: 0.9,
  crouchIntent: 0.42,
  stabilityOverride: -1,
  performanceOverride: -1,
  horizonLevel: 0.8,
  ik: true,
  balance: true,
  head: true,
  noise: true,
  torture: '',
};

export type Phase = 'ride' | 'paddle' | 'popup';

export interface StreamPacket {
  t: number;
  magnitude: number;
  stability: number;
  events: string[];
}

interface Step {
  foot: 0 | 1; // 0 back, 1 front
  t0: number;
  dur: number;
  from: THREE.Vector3;
  to: THREE.Vector3;
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _qInv = new THREE.Quaternion();
const _fw = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export class Rider {
  readonly rig: Rig;
  p: RiderParams = { ...defaultRiderParams };
  stance: Stance = 'regular';
  board: Board;
  readonly pose: Pose;
  private keys!: { tall: Pose; mid: Pose; deep: Pose; ride: Pose; out: Pose; high: Pose; lead: Pose };
  private tmpA: Pose;
  private tmpB: Pose;
  private armBones: number[] = [];
  private spineBones: number[] = [];
  readonly legs: [LegChain, LegChain]; // [back, front]
  private anchors!: { back: { p: THREE.Vector3; q: THREE.Quaternion }; front: { p: THREE.Vector3; q: THREE.Quaternion } };
  private nominal!: { back: THREE.Vector3; front: THREE.Vector3 };

  // ------------------------------------------------ balance state (tick rate)
  readonly fB = new THREE.Vector3(0, G, 0);
  readonly fPlanLeadB = new THREE.Vector3(0, G, 0);
  readonly fDistB = new THREE.Vector3();
  readonly bodyUp = new THREE.Vector3(0, 1, 0);
  /** Body axis spring state in the WORLD frame (inertia lives in the world, not on the board). */
  private bodyUpW = new THREE.Vector3(0, 1, 0);
  readonly comX = new MassSpring(); // lateral (board X)
  readonly comZ = new MassSpring(); // fore/aft (board Z)
  readonly crouch = new AsymSpring(0.05, 0.22, 0.42, 0.42);
  readonly armsOut = new AsymSpring(0.04, 0.5, 0, 0);
  readonly armsHigh = new AsymSpring(0.05, 0.6, 0, 0);
  readonly lead = new AsymSpring(0.05, 0.35, 0, 0);
  readonly twist = new Spring1(0);
  readonly gaze = new THREE.Vector3(0, 0, 1);
  stability = 0.85;
  performance = 0.5;
  private stabTarget = 0.85;
  private perfTarget = 0.5;
  balanceError = 0;
  eCom = 0;
  eTilt = 0;
  private distDelay: Float32Array = new Float32Array(64 * 3);
  private distHead = 0;
  private noiseX = makePinkNoise(11);
  private noiseZ = makePinkNoise(29);
  private rng = mulberry32(5);
  private impulses: Array<{ t0: number; fx: number; fz: number; dip: number }> = [];
  private time = 0;
  private dipSpring = new Spring1(0);
  private step: Step | null = null;
  private stepArmed = true;
  private returnAt = 0;
  fallen = 0; // 0 riding, >0 seconds since fall
  private fallDir = new THREE.Vector3();
  private overThreshold = 0;
  // phases (paddle → pop-up → ride), with a dead blend from the last output pose on switches
  phase: Phase = 'ride';
  private phaseT0 = 0;
  private clips: Clips;
  private lastOut: Pose;
  private blendFromT = -1;
  /** Auto pop-up time after paddling starts (s), or 0 for manual. */
  autoPopup = 0;
  // metrics
  footErrorMm: [number, number] = [0, 0];
  leanDeg = 0;
  leanTheoryDeg = 0;
  readonly comB = new THREE.Vector3();

  constructor(rig: Rig, board: Board) {
    this.rig = rig;
    this.board = board;
    this.pose = new Pose(rig.n).copy(rig.rest);
    this.tmpA = new Pose(rig.n);
    this.tmpB = new Pose(rig.n);
    const I = rig.idx;
    this.armBones = [I.clavL, I.upperarmL, I.forearmL, I.handL, I.clavR, I.upperarmR, I.forearmR, I.handR];
    this.spineBones = [I.spine0, I.spine1, I.spine2, I.neck, I.head];
    this.legs = [makeLegChain(rig, 'R'), makeLegChain(rig, 'L')];
    this.clips = new Clips(rig);
    this.lastOut = new Pose(rig.n).copy(rig.rest);
    this.setStance('regular');
  }

  setStance(s: Stance): void {
    this.stance = s;
    const m = (ops: Op[]) => (s === 'regular' ? ops : mirrorOps(ops));
    const r = this.rig;
    this.keys = {
      tall: bake(r, m(CROUCH_TALL)),
      mid: bake(r, m(CROUCH_MID)),
      deep: bake(r, m(CROUCH_DEEP)),
      ride: bake(r, m(ARMS_RIDE)),
      out: bake(r, m(ARMS_OUT)),
      high: bake(r, m(ARMS_HIGH)),
      lead: bake(r, m(ARMS_LEAD)),
    };
    // regular: left foot forward → front leg = L, back = R
    this.legs.splice(0, 2, ...(s === 'regular' ? [makeLegChain(r, 'R'), makeLegChain(r, 'L')] : [makeLegChain(r, 'L'), makeLegChain(r, 'R')]) as [LegChain, LegChain]);
    this.setBoard(this.board);
  }

  setBoard(b: Board): void {
    this.board = b;
    const H = 1.82;
    const st = b.stance(H, this.stance);
    this.anchors = {
      back: { p: st.back.position.clone(), q: st.back.quaternion.clone() },
      front: { p: st.front.position.clone(), q: st.front.quaternion.clone() },
    };
    this.nominal = { back: st.back.position.clone(), front: st.front.position.clone() };
  }

  reset(): void {
    this.comX.reset();
    this.comZ.reset();
    this.crouch.reset(this.p.crouchIntent);
    this.armsOut.reset(0);
    this.armsHigh.reset(0);
    this.lead.reset(0);
    this.twist.reset(0);
    this.bodyUp.set(0, 1, 0);
    this.bodyUpW.set(NaN, 0, 0);
    this.impulses.length = 0;
    this.step = null;
    this.fallen = 0;
    this.overThreshold = 0;
    this.time = 0;
    this.distDelay.fill(0);
    this.dipSpring.reset(0);
    this.anchors.back.p.copy(this.nominal.back);
    this.anchors.front.p.copy(this.nominal.front);
    this.stabTarget = 0.85;
    this.perfTarget = 0.5;
    this.stability = this.stabTarget;
    this.performance = this.perfTarget;
    this.phase = 'ride';
    this.blendFromT = -1;
  }

  setPhase(ph: Phase): void {
    if (ph === this.phase) return;
    this.lastOut.copy(this.pose);
    this.blendFromT = this.time;
    this.phase = ph;
    this.phaseT0 = this.time;
    if (ph === 'popup') {
      this.crouch.reset(0.95);
      // pop-up landing: back foot lands ~7 cm forward of its riding spot, then shuffles back
      const n = this.nominal.back;
      this.anchors.back.p.copy(this.board.deckFrame(n.z + 0.07, n.x).p);
      this.anchors.front.p.copy(this.nominal.front);
      this.returnAt = this.time + POPUP_DURATION + 0.7;
    }
    if (ph === 'paddle') this.fallen = 0;
  }

  // ------------------------------------------------ inputs
  onPacket(pk: StreamPacket): void {
    const prevS = this.stabTarget;
    this.stabTarget = Math.min(1, Math.max(0, pk.stability));
    this.perfTarget = Math.min(1, Math.max(0, pk.magnitude));
    // instant onset: a drop in stability shows on the next frame as an arm flick and knee dip
    const drop = prevS - this.stabTarget;
    if (drop > 0.08) this.kick(drop * 2.5, 'bad');
    for (const e of pk.events) {
      if (e === 'bad') this.kick(1, 'bad');
      else if (e === 'great') this.kick(0.6, 'great');
      else if (e === 'wipeout') this.fall();
    }
  }

  /** A maneuver was committed: body onset now (the board follows ~0.2 s later). */
  onManeuver(kind: ManeuverKind): void {
    if (kind === 'chop') return;
    // compression and lead-arm onset; the twist/axis lead comes from the plan read ahead
    this.dipSpring.v += 1.6;
    this.lead.s.v += 6;
  }

  kick(strength: number, kind: 'bad' | 'great'): void {
    if (kind === 'bad') {
      const a = this.rng() * Math.PI * 2;
      this.impulses.push({ t0: this.time, fx: Math.cos(a) * 15 * strength, fz: Math.sin(a) * 20 * strength, dip: 0.12 * strength });
      this.armsOut.s.v += 5 * strength;
      this.dipSpring.v += 1.2 * strength;
    } else {
      this.armsHigh.s.v += 2 * strength;
    }
  }

  fall(): void {
    if (this.fallen > 0) return;
    this.fallen = 1e-3;
    this.fallDir.set(this.comX.x, 0, this.comZ.x);
    if (this.fallDir.lengthSq() < 1e-6) this.fallDir.set(this.stance === 'regular' ? 1 : -1, 0, 0);
    this.fallDir.normalize();
  }

  // ------------------------------------------------ fixed-rate balance update
  tick(dt: number, motion: BoardMotion): void {
    this.time += dt;
    const P = this.p;
    const S = motion.state;
    // stream state through dampers (medium/slow)
    const sT = P.stabilityOverride >= 0 ? P.stabilityOverride : this.stabTarget;
    const pT = P.performanceOverride >= 0 ? P.performanceOverride : this.perfTarget;
    this.stability = damp(this.stability, sT, 0.35, dt);
    this.performance = damp(this.performance, pT, 1.5, dt);
    const stab = this.stability;
    const perf = this.performance;

    if (this.fallen > 0) {
      this.fallen += dt;
      if (this.fallen > 3) this.reset();
      return;
    }
    if (this.phase === 'paddle' && this.autoPopup > 0 && this.time - this.phaseT0 >= this.autoPopup) this.setPhase('popup');
    if (this.phase === 'popup' && this.time - this.phaseT0 >= POPUP_DURATION) {
      this.phase = 'ride';
      this.lastOut.copy(this.pose);
      this.blendFromT = this.time;
    }

    // specific force in the board frame at the stance point
    _qInv.copy(S.quaternion).invert();
    const mid = _v.addVectors(this.anchors.back.p, this.anchors.front.p).multiplyScalar(0.5);
    const r = mid.applyQuaternion(S.quaternion); // world offset board origin → stance
    const wxr = _v2.crossVectors(S.omega, r);
    const aS = _v3.crossVectors(S.alpha, r).add(_fw.crossVectors(S.omega, wxr)).add(S.accel);
    aS.y += G;
    this.fB.copy(aS).applyQuaternion(_qInv);
    // disturbance = what the plan did not command: the perturbation layer's translational
    // accelerations (heave, surge, impulses). The plan's own rotation acting on the stance
    // offset is planned, so it is not a disturbance.
    const lead = P.leadTime * (0.7 + 0.6 * perf);
    this.fDistB.subVectors(S.accel, S.accelPlan).applyQuaternion(_qInv);
    motion.plannedForceAhead(lead, this.fPlanLeadB).applyQuaternion(_qInv);

    // body axis: apparent up read ahead, blended with the deck normal
    // (near weightlessness the direction of f is meaningless, so it gets less weight; and the
    // body axis never tilts more than ~55° from the deck normal)
    const fMag = this.fPlanLeadB.length();
    const k = P.balance ? P.kappa * smoothstep(0.25 * G, 0.75 * G, fMag) : 0;
    _v.copy(this.fPlanLeadB).normalize().multiplyScalar(k).addScaledVector(UP, 1 - k).normalize();
    // spring in the world frame, then back to the board frame
    _v.applyQuaternion(S.quaternion);
    if (Number.isNaN(this.bodyUpW.x)) this.bodyUpW.copy(_v);
    const hU = 0.07;
    this.bodyUpW.x = damp(this.bodyUpW.x, _v.x, hU, dt);
    this.bodyUpW.y = damp(this.bodyUpW.y, _v.y, hU, dt);
    this.bodyUpW.z = damp(this.bodyUpW.z, _v.z, hU, dt);
    this.bodyUpW.normalize();
    this.bodyUp.copy(this.bodyUpW).applyQuaternion(_qInv);
    // never more than ~55° from the deck normal
    const maxTilt = 55 * DEG;
    if (this.bodyUp.y < Math.cos(maxTilt)) {
      const h = Math.hypot(this.bodyUp.x, this.bodyUp.z);
      this.bodyUp.set((this.bodyUp.x / h) * Math.sin(maxTilt), Math.cos(maxTilt), (this.bodyUp.z / h) * Math.sin(maxTilt));
    }

    // disturbance → COM (with reaction latency that grows as stability drops)
    const latency = 0.08 + 0.14 * (1 - stab);
    const nDelay = Math.min(63, Math.round(latency / dt));
    const D = this.distDelay;
    this.distHead = (this.distHead + 1) % 64;
    D[this.distHead * 3] = this.fDistB.x;
    D[this.distHead * 3 + 2] = this.fDistB.z;
    const rd = ((this.distHead - nDelay) % 64 + 64) % 64;
    let fx = -D[rd * 3] * P.lagGain;
    let fz = -D[rd * 3 + 2] * P.lagGain;
    // pink force noise: perturb forces, not poses
    if (P.noise) {
      const A = 0.5 + (16 - 0.5) * (1 - stab) * (1 - stab);
      fx += A * this.noiseX(this.time);
      fz += A * 0.7 * this.noiseZ(this.time);
    }
    // impulse envelopes (attack ~70 ms, decay ~500 ms)
    let dip = 0;
    for (let i = this.impulses.length - 1; i >= 0; i--) {
      const im = this.impulses[i];
      const tt = this.time - im.t0;
      if (tt > 1.5) {
        this.impulses.splice(i, 1);
        continue;
      }
      const env = Math.min(1, tt / 0.07) * Math.exp(-Math.max(0, tt - 0.07) / 0.5);
      fx += im.fx * env;
      fz += im.fz * env;
      dip += im.dip * env;
    }
    if (!P.balance) fx = fz = 0;
    const zeta = 0.55 + 0.45 * stab;
    const f0 = P.comHz * (0.8 + 0.4 * perf) * (0.65 + 0.35 * stab);
    this.comX.step(fx, f0, zeta, dt);
    this.comZ.step(fz, f0 * 0.8, zeta, dt);

    // crouch: intent + g-load + dips
    const gLoad = this.fB.length() / G;
    const intent = P.crouchIntent + 0.1 * (perf - 0.5);
    this.dipSpring.step(0, 0.12, dt);
    const cT = intent + 0.35 * Math.max(0, gLoad - 1) + dip + Math.max(0, this.dipSpring.x) * 0.15 + 0.25 * smoothstep(0.3, 0.6, this.balanceError);
    this.crouch.step(Math.min(1.1, cT), dt);

    // twist + lead arm from the planned heading change ahead (shoulders open into the turn)
    motion.plannedQuatAhead(lead + 0.1, _q);
    _q2.copy(S.quatPlan).invert().multiply(_q); // planned rotation ahead, in the board frame
    _fw.set(0, 0, 1).applyQuaternion(_q2);
    const yawAhead = Math.atan2(_fw.x, _fw.z);
    this.twist.step(Math.max(-40 * DEG, Math.min(40 * DEG, 1.3 * yawAhead)), 0.08, dt);
    this.lead.step(Math.min(1, Math.abs(yawAhead) / (25 * DEG)), dt);
    // gaze: planned travel direction ahead, in the board frame
    _v.copy(S.velocity);
    if (_v.lengthSq() < 0.5) _v.set(0, 0, 1).applyQuaternion(S.quaternion);
    _v.normalize().applyQuaternion(_qInv).applyAxisAngle(UP, yawAhead * 0.8);
    _v.y = 0;
    if (_v.lengthSq() < 1e-6) _v.set(0, 0, 1);
    _v.normalize();
    this.gaze.lerp(_v, 1 - Math.exp(-dt / 0.12)).normalize();

    // balance error: COM excursion vs support, and body axis vs actual apparent up
    // only the UNPLANNED part counts: the body leading a planned turn is skill, not imbalance.
    // (A vector magnitude, not an angle: near weightlessness the direction of f is undefined.)
    // tangential only: vertical (heave) disturbances are absorbed by the knees, not a balance threat
    const unplanned = Math.hypot(this.fDistB.x, this.fDistB.z);
    const eCom = Math.hypot(this.comX.x / 0.14, this.comZ.x / 0.22);
    this.eCom = eCom;
    this.eTilt = unplanned / (0.65 * G);
    this.balanceError = Math.max(eCom, this.eTilt);
    const e = this.balanceError;
    this.armsOut.step(Math.min(1, smoothstep(0.25, 0.6, e) + 0.45 * (1 - stab)), dt);
    this.armsHigh.step(smoothstep(0.55, 0.85, e), dt);

    // stumble step (hysteresis) and return step
    if (!this.step) {
      if (e > 0.6 && this.stepArmed) {
        this.stepArmed = false;
        const foot: 0 | 1 = this.comZ.x < 0 ? 0 : 1;
        const a = foot === 0 ? this.anchors.back.p : this.anchors.front.p;
        const d = _v.set(this.comX.x, 0, this.comZ.x).multiplyScalar(1.1);
        if (d.length() > 0.14) d.setLength(0.14);
        const to = a.clone().add(d);
        to.copy(this.board.deckFrame(to.z, Math.max(-0.2, Math.min(0.2, to.x))).p);
        this.step = { foot, t0: this.time, dur: 0.3, from: a.clone(), to };
        this.returnAt = this.time + 1.6;
      } else if (e < 0.45) this.stepArmed = true;
      if (!this.step && this.returnAt > 0 && this.time > this.returnAt && e < 0.4) {
        // shuffle back to the nominal stance
        const foot: 0 | 1 = this.anchors.back.p.distanceTo(this.nominal.back) > this.anchors.front.p.distanceTo(this.nominal.front) ? 0 : 1;
        const a = foot === 0 ? this.anchors.back.p : this.anchors.front.p;
        const n = foot === 0 ? this.nominal.back : this.nominal.front;
        if (a.distanceTo(n) > 0.01) this.step = { foot, t0: this.time, dur: 0.35, from: a.clone(), to: n.clone() };
        else this.returnAt = 0;
      }
    }
    if (this.step && this.time - this.step.t0 >= this.step.dur) {
      (this.step.foot === 0 ? this.anchors.back.p : this.anchors.front.p).copy(this.step.to);
      this.step = null;
    }
    // fall: sustained error, or the planner says wipeout
    this.overThreshold = e > 0.85 ? this.overThreshold + dt : 0;
    if (this.overThreshold > 0.15) this.fall();
  }

  // ------------------------------------------------ render-rate pose
  /** Build the pose for this frame (model space = board frame) and write the bones. */
  update(motion: BoardMotion): void {
    const rig = this.rig;
    const P = this.p;
    const pose = this.pose;
    const K = this.keys;
    const tort = P.torture ? TORTURE[P.torture] : null;
    const s = this.stance === 'regular' ? 1 : -1;
    if (this.phase === 'paddle') {
      this.clips.paddle(pose, this.board, 1.82, this.time - this.phaseT0);
      this.finish();
      return;
    }

    // 1) key-pose synthesis: crouch blend (spine/head), arm sets
    const c = tort ? tort.crouch : this.crouch.x;
    pose.copy(rig.rest);
    if (c < 0.5) blendPoses(pose, K.tall, K.mid, c / 0.5, this.spineBones);
    else blendPoses(pose, K.mid, K.deep, Math.min(1, (c - 0.5) / 0.5), this.spineBones);
    this.tmpA.copy(K.ride);
    blendPoses(this.tmpA, this.tmpA, K.lead, Math.min(1, Math.max(0, this.lead.x)), this.armBones);
    blendPoses(this.tmpA, this.tmpA, K.out, Math.min(1, Math.max(0, this.armsOut.x)), this.armBones);
    blendPoses(this.tmpA, this.tmpA, K.high, Math.min(1, Math.max(0, this.armsHigh.x)), this.armBones);
    for (const i of this.armBones) {
      this.tmpA.getQ(i, _q);
      pose.setQ(i, _q);
    }
    if (tort) {
      pose.copy(rig.rest);
      applyOps(rig, pose, s > 0 ? tort.ops : mirrorOps(tort.ops));
    }
    // procedural twist distribution (shoulders open into the turn), on top of the key poses
    const tw = (tort?.twistDeg ? tort.twistDeg * DEG * s : this.twist.x) / DEG;
    if (Math.abs(tw) > 0.01) {
      applyOps(rig, pose, [
        ['spine0', 'y', tw * 0.15],
        ['spine1', 'y', tw * 0.25],
        ['spine2', 'y', tw * 0.3],
        ['neck', 'y', tw * 0.15],
        ['head', 'y', tw * 0.15],
      ]);
    }

    // 2) pelvis: along the body axis above the feet, offset by the COM lag
    const up = tort ? UP : this.bodyUp;
    const back = this.anchors.back;
    const front = this.anchors.front;
    const feetMid = _v.addVectors(back.p, front.p).multiplyScalar(0.5);
    if (this.step) {
      const k = Math.min(1, (this.time - this.step.t0) / this.step.dur);
      const sp = this.step.from.clone().lerp(this.step.to, smoothstep(0, 1, k));
      sp.y += Math.sin(Math.PI * k) * 0.07;
      (this.step.foot === 0 ? this.stepPos(0, sp) : this.stepPos(1, sp));
    }
    const ph = 0.8 - 0.36 * Math.min(1.5, c);
    const pelvisPos = _v2.copy(feetMid).addScaledVector(up, ph);
    pelvisPos.x += P.balance ? this.comX.x : 0;
    pelvisPos.z += P.balance ? this.comZ.x : 0;
    // character → board: face the toe side (regular: -X), hips open ~15° toward the nose
    const yaw = (-s * 90 + s * 15) * DEG;
    const hinge = (6 + 22 * Math.min(1.3, c)) * DEG;
    _q.setFromUnitVectors(UP, up);
    _q2.setFromAxisAngle(UP, yaw);
    _q.multiply(_q2);
    _q2.setFromAxisAngle(_v3.set(1, 0, 0), hinge);
    _q.multiply(_q2);
    let fallTilt = 0;
    if (this.fallen > 0) {
      // placeholder fall (ragdoll later): topple toward the COM excursion, drop off the board
      const k = Math.min(1, this.fallen / 0.9);
      fallTilt = k * k * 80 * DEG;
      _q2.setFromAxisAngle(_v3.set(this.fallDir.z, 0, -this.fallDir.x).normalize(), -fallTilt);
      _q.premultiply(_q2);
      pelvisPos.addScaledVector(this.fallDir, 0.6 * k * k).y -= 0.9 * k * k;
    }
    const ip = rig.idx.pelvis;
    rig.restQ(ip, _q2);
    _q.multiply(_q2);
    pose.setQ(ip, _q);
    pose.setP(ip, pelvisPos);
    rig.fk(pose);
    this.comB.copy(pelvisPos);

    // 3) leg IK onto the anchors (feet locked); lower the pelvis if a target is out of reach
    if (P.ik && this.fallen === 0) {
      const targets = [this.footTarget(0), this.footTarget(1)];
      let lower = 0;
      for (let li = 0; li < 2; li++) {
        const leg = this.legs[li];
        const T = ankleTarget(leg, targets[li].p, targets[li].q, _v3);
        const H = rig.modelP(leg.thigh, _fw);
        const maxR = (leg.a + leg.b) * 0.985;
        const dvec = T.clone().sub(H);
        const dl = dvec.length();
        if (dl > maxR) {
          // smallest s >= 0 with |dvec + s·up| = maxR (lowering the pelvis by s along up)
          const b2 = dvec.dot(up);
          const cc = dl * dl - maxR * maxR;
          const disc = b2 * b2 - cc;
          lower = Math.max(lower, disc >= 0 ? -b2 - Math.sqrt(disc) : -b2);
        }
      }
      if (lower > 0) {
        pelvisPos.addScaledVector(up, -Math.min(0.5, lower));
        pose.setP(ip, pelvisPos);
        rig.fk(pose);
      }
      for (let li = 0; li < 2; li++) {
        const leg = this.legs[li];
        const tgt = targets[li];
        const T = ankleTarget(leg, tgt.p, tgt.q, _v3);
        // knee pole: front knee over the toes; back knee driven in toward the nose
        const toe = _fw.set(0, 0, 1).applyQuaternion(tgt.q);
        if (li === 0) toe.add(_v.set(0, 0, 0.9)).normalize();
        toe.addScaledVector(up, 0.15).normalize();
        solveLeg(rig, pose, leg, T, toe, tgt.q);
      }
    }

    // 4) head: gaze down the line, roll mostly level with the horizon (board frame)
    if (P.head && this.fallen === 0) this.stabiliseHead(motion);

    if (this.phase === 'popup') {
      this.tmpB.copy(pose);
      this.clips.popup(pose, this.tmpB, this.board, 1.82, (this.time - this.phaseT0) / POPUP_DURATION, this.stance);
    }
    this.finish();
  }

  /** Dead blend from the last output pose after a phase switch (half-life ~60 ms), then write. */
  private finish(): void {
    const rig = this.rig;
    const pose = this.pose;
    if (this.blendFromT >= 0) {
      const tt = this.time - this.blendFromT;
      const w = Math.exp((-tt * Math.LN2) / 0.06);
      if (w < 0.01) this.blendFromT = -1;
      else {
        for (let i = 0; i < rig.n; i++) {
          pose.getQ(i, _q);
          this.lastOut.getQ(i, _q2);
          _q.slerp(_q2, w);
          pose.setQ(i, _q);
        }
        const ip = rig.idx.pelvis;
        pose.getP(ip, _v);
        this.lastOut.getP(ip, _v2);
        pose.setP(ip, _v.lerp(_v2, w));
      }
    }
    rig.write(pose);
  }

  private stepPos(foot: 0 | 1, p: THREE.Vector3): void {
    (foot === 0 ? this.anchors.back.p : this.anchors.front.p).copy(p);
  }

  private footTarget(i: 0 | 1): { p: THREE.Vector3; q: THREE.Quaternion } {
    return i === 0 ? this.anchors.back : this.anchors.front;
  }

  private stabiliseHead(motion: BoardMotion): void {
    const rig = this.rig;
    const pose = this.pose;
    const ih = rig.idx.head;
    const inn = rig.idx.neck;
    // world up in the board frame
    _qInv.copy(motion.state.quaternion).invert();
    const worldUpB = _v.set(0, 1, 0).applyQuaternion(_qInv);
    const upT = _v2.copy(this.bodyUp).lerp(worldUpB, this.p.horizonLevel).normalize();
    const fwdT = _v3.copy(this.gaze);
    // desired head model rotation = frame(gaze, up) · head rest rotation (rest char frame = identity)
    frameFrom(fwdT, upT, _q);
    rig.restQ(ih, _q2);
    _q.multiply(_q2);
    // correction relative to the current head, spread 40% neck / 60% head
    rig.modelQ(ih, _q2);
    const delta = _q2.invert().premultiply(_q); // desired · current⁻¹
    const dNeck = new THREE.Quaternion().slerp(delta, 0.4);
    rig.modelQ(inn, _q).premultiply(dNeck);
    rig.setModelQ(pose, inn, _q);
    rig.fkSubtree(pose, inn);
    // head takes the rest of the way (full target)
    frameFrom(fwdT, upT, _q);
    rig.restQ(ih, _q2);
    _q.multiply(_q2);
    rig.modelQ(ih, _q2);
    _q2.slerp(_q, 0.92);
    rig.setModelQ(pose, ih, _q2);
    rig.fkSubtree(pose, ih);
  }

  /** Measure foot contact error (mm) from three.js bone world matrices (independent of our FK). */
  measureFootError(boardWorld: THREE.Matrix4): void {
    for (let li = 0; li < 2; li++) {
      const leg = this.legs[li];
      const bone = this.rig.bones[leg.foot];
      const tgt = this.footTarget(li as 0 | 1);
      // ankle world position should equal boardWorld · ankleTarget
      const want = ankleTarget(leg, tgt.p, tgt.q, new THREE.Vector3()).applyMatrix4(boardWorld);
      const got = new THREE.Vector3().setFromMatrixPosition(bone.matrixWorld);
      this.footErrorMm[li] = (this.step && this.step.foot === li) || this.phase !== 'ride' || this.blendFromT >= 0 ? NaN : got.distanceTo(want) * 1000;
    }
  }
}
