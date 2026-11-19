import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { waveAt, xAtArrival, arrival, slice, planningEvent } from './waveGeom.js';
import { Board } from './Board.js';

// Autonomous surfing demonstration: a shortboard ridden on the peeling wave (event 0 of the surf
// schedule) along a continuous, deterministic trajectory, plus a chase camera.
//
// The trajectory is planned in WAVE coordinates, as pure functions of time (so seeks and captures are
// deterministic and the simulation can be warmed up ahead of the board):
//   alpha(t): the wave's smooth arrival clock at the board (glsl/breaker.js brkArrival): how far ahead
//             of the curl the board is (-0.3: in the pocket under the lip, -1: ~10 m down the line);
//   h(t):     the position across the face: 1 crest (apex), 0 toe, < 0 out in the trough.
// Both are interpolated through keyframes of a repeating manoeuvre cycle whose values and durations are
// jittered per cycle (seeded): cruise -> climb toward the crest -> descend -> sweeping bottom turn in
// the trough -> back up to the upper face -> cruise ...
// World (x, z) then follow from the wave geometry (waveGeom.js); the height and attitude come from the
// GPU probe of the RENDERED surface at the nose, tail, rails and centre (SurfProbe.js).

const DRAFT = 0.022;               // the planing bottom sits this far below the mean surface at the stance
const CAM_BACK = 4.0, CAM_UP = 2.0;
const SAMPLE_DX = 0.75, SAMPLE_DZ = 0.2;   // nose / tail and rail sample offsets (m)

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

// keyframe kinds of one manoeuvre cycle; the interval AFTER each knot is named by `phase`
// (the crest line is oblique: further down the line the face stands further out, ~9 m per unit of
//  alpha, so the descent and the bottom turn hold alpha nearly constant - racing ahead while dropping
//  would cancel the cross-shore excursion that makes the turn sweep)
const CYCLE = [
  { kind: 'upper', phase: 'cruise', a: -0.80, ja: 0.05, h: 0.70, jh: 0.07, d: 2.2, jd: 1.4 },
  { kind: 'mid', phase: 'climb', a: -0.86, ja: 0.05, h: 0.52, jh: 0.07, d: 1.5, jd: 0.5 },
  { kind: 'crest', phase: 'descend', a: -0.76, ja: 0.03, h: 0.90, jh: 0.04, d: 1.0, jd: 0.25, flat: true },
  { kind: 'trough', phase: 'bottom turn', a: -0.78, ja: 0.03, h: -0.45, jh: 0.1, d: 1.2, jd: 0.3, flat: true },
  { kind: 'turned', phase: 'return', a: -0.76, ja: 0.03, h: 0.25, jh: 0.06, d: 0.95, jd: 0.25 },
];
const T_START = -40;

export class SurfDemo {
  constructor({ schedule, probe, shared, camera }) {
    this.S = CONFIG.surf;
    this.schedule = schedule;
    this.event = schedule.events[0];          // the ridden wave (rendered)
    this.plEvent = planningEvent(this.event);  // its smoothed copy for path planning
    this.probe = probe;
    this.camera = camera;
    this.board = new Board(shared);
    this.knots = [];
    this.pos = { x: 0, z: 0 };     // focus (the camera's xz) for the swash window (SwashSim._focusX)
    this.reset();
  }

  reset() { this.camY = null; this.camPitch = null; this.lastYaw = null; this.tel = null; this.lastT = null; }

  // ---------------------------------------------------------------- keyframes (lazy, deterministic)
  _knot(i) {
    while (this.knots.length <= i) {
      const n = this.knots.length;
      const c = CYCLE[n % CYCLE.length];
      const r = mulberry32(Math.round(this.S.seed) * 1000003 + n * 7919);
      const j = () => 2 * r() - 1;
      const t = n === 0 ? T_START : this.knots[n - 1].t + this.knots[n - 1].d;
      // every few cycles a deeper set-up: closer to the curl, higher on the face
      const big = Math.floor(n / CYCLE.length) % 3 === 2 ? 1 : 0;
      this.knots.push({ t, kind: c.kind, phase: c.phase, flat: !!c.flat,
        a: c.a + c.ja * j() + (c.kind === 'crest' ? 0.08 * big : 0),
        h: clamp(c.h + c.jh * j() + (c.kind === 'crest' ? 0.04 * big : 0), -0.2, 0.95),
        d: c.d + c.jd * r() });
    }
    return this.knots[i];
  }
  _seg(t) {
    // knot interval containing t (knots grow forward only; seeks before T_START clamp)
    let i = this._lastSeg ?? 0;
    while (i > 0 && t < this._knot(i).t) i--;
    while (this._knot(i + 1).t <= t) i++;
    this._lastSeg = i;
    return i;
  }
  /** (alpha, h, phase) at time t: piecewise cubic Hermite through the knots */
  plan(t) {
    t = Math.max(t, T_START);
    const i = this._seg(t);
    const k0 = this._knot(Math.max(i - 1, 0)), k1 = this._knot(i), k2 = this._knot(i + 1), k3 = this._knot(i + 2);
    const T = k2.t - k1.t, u = (t - k1.t) / T;
    const tan = (p, a, c, flat) => (flat ? 0 : (c[p] - a[p]) / Math.max(c.t - a.t, 1e-3));
    const herm = (p) => {
      const m1 = tan(p, k0, k2, p === 'h' && k1.flat) * T, m2 = tan(p, k1, k3, p === 'h' && k2.flat) * T;
      const u2 = u * u, u3 = u2 * u;
      return (2 * u3 - 3 * u2 + 1) * k1[p] + (u3 - 2 * u2 + u) * m1 + (-2 * u3 + 3 * u2) * k2[p] + (u3 - u2) * m2;
    };
    return { a: herm('a'), h: herm('h'), phase: k1.phase, u };
  }

  /** board origin (x, z) on the wave at t (the analytic plan, no probe) */
  xz(t) {
    const p = this.plan(t);
    const x = xAtArrival(this.plEvent, t, p.a, this._guess(t));
    const w = waveAt(this.plEvent, x, t, true);
    return [x, w.faceZ(p.h), p, w];
  }
  _guess(t) {
    // linear peel: x ~ (t - t0 + ...) * speed; refined by Newton in xAtArrival
    const k = this.event.aR1;
    return (t - this.event.t0 + 0.9 * Math.sqrt(this.event.H / 0.45)) / k;
  }
  vel(t, h = 0.02) {
    const a = this.xz(t - h), b = this.xz(t + h);
    return [(b[0] - a[0]) / (2 * h), (b[1] - a[1]) / (2 * h)];
  }
  /** smoothed direction of travel (exponentially weighted over the last ~1 s) */
  heading(t) {
    let sx = 0, sz = 0;
    for (let i = 0; i < 16; i++) {
      const w = Math.exp(-i * 0.1 / 0.6);
      const v = this.vel(t - i * 0.1);
      const l = Math.hypot(v[0], v[1]) || 1;
      sx += (w * v[0]) / l; sz += (w * v[1]) / l;
    }
    const l = Math.hypot(sx, sz) || 1;
    return [sx / l, sz / l];
  }
  /** the camera's (x, z) (= the world focus) at time t, deterministic */
  focusAt(t) {
    const [x, z] = this.xz(t), hd = this.heading(t);
    this.pos.x = x - CAM_BACK * hd[0]; this.pos.z = z - CAM_BACK * hd[1];
    return this.pos;
  }

  // ---------------------------------------------------------------- per rendered frame
  update(renderer, t) {
    // smoothing runs on simulation time (deterministic captures; paused = frozen)
    if (this.lastT !== null && (t < this.lastT - 1e-6 || t > this.lastT + 1.0)) this.reset();
    const dt = this.lastT === null ? 0 : t - this.lastT;
    this.lastT = t;
    const [x, z, plan, wave] = this.xz(t);
    const v = this.vel(t);
    const v2 = this.vel(t + 0.05), v1 = this.vel(t - 0.05);
    const acc = [(v2[0] - v1[0]) / 0.1, (v2[1] - v1[1]) / 0.1];
    const speed = Math.hypot(v[0], v[1]);
    const f = new THREE.Vector3(v[0] / speed, 0, v[1] / speed);
    const r = new THREE.Vector3(-f.z, 0, f.x);          // right of travel (f x up)
    const hd = this.heading(t);
    const cx = x - CAM_BACK * hd[0], cz = z - CAM_BACK * hd[1];
    // probe: centre, nose, tail, left, right, camera, then the metric points
    const P = [[x, z], [x + SAMPLE_DX * f.x, z + SAMPLE_DX * f.z], [x - SAMPLE_DX * f.x, z - SAMPLE_DX * f.z],
      [x - SAMPLE_DZ * r.x, z - SAMPLE_DZ * r.z], [x + SAMPLE_DZ * r.x, z + SAMPLE_DZ * r.z], [cx, cz]];
    const d = this.probe.sample(renderer, P);
    const hC = d[0], hN = d[4], hT = d[8], hL = d[12], hR = d[16], hCam = d[20];
    // surface slope along / across the direction of travel -> surface normal
    const sf = (hN - hT) / (2 * SAMPLE_DX), sr = (hR - hL) / (2 * SAMPLE_DZ);
    const n = new THREE.Vector3(0, 1, 0).addScaledVector(f, -sf).addScaledVector(r, -sr).normalize();
    // carving: the board leans into the turn (lateral acceleration), up to ~25 degrees on the rail
    const aLat = acc[0] * r.x + acc[1] * r.z;
    const bank = clamp(Math.atan2(aLat, CONFIG.g) * 0.6, -0.42, 0.42);
    const fwd = f.clone().addScaledVector(n, -f.dot(n)).normalize();
    const up = n.clone().applyAxisAngle(fwd, bank).normalize();   // (+: right rail down)
    const pos = new THREE.Vector3(x, hC - DRAFT, z);
    this.board.setPose(pos, fwd, up);

    // contact: board bottom vs the water at the four outer samples (positive = air gap)
    const side = new THREE.Vector3().crossVectors(fwd, up).normalize();
    const gap = (dx, dz, hw) => {
      const p = pos.clone().addScaledVector(fwd, dx).addScaledVector(side, dz).addScaledVector(up, Board.bottomAt(dx));
      return p.y - hw;
    };
    const gaps = { nose: gap(SAMPLE_DX, 0, hN), tail: gap(-SAMPLE_DX, 0, hT), left: gap(0, -SAMPLE_DZ, hL), right: gap(0, SAMPLE_DZ, hR) };

    // ---------------------------------------------------------- chase camera
    const boardY = pos.y;
    const kY = this.camY === null ? 1 : 1 - Math.exp(-dt / 0.45);
    this.camY = this.camY === null ? boardY + CAM_UP : this.camY + (boardY + CAM_UP - this.camY) * kY;
    const camY = Math.max(this.camY, hCam + 0.8);
    const cam = this.camera;
    cam.position.set(cx, camY, cz);
    // look a little ahead of the board along the smoothed heading; level horizon (no roll)
    const tx = x + 2.5 * hd[0], tz = z + 2.5 * hd[1], ty = boardY + 0.15;
    const dx = tx - cx, dy = ty - camY, dz = tz - cz;
    const yaw = Math.atan2(-dx, -dz);
    const pitchT = Math.atan2(dy, Math.hypot(dx, dz));
    const kP = this.camPitch === null ? 1 : 1 - Math.exp(-dt / 0.3);
    this.camPitch = this.camPitch === null ? pitchT : this.camPitch + (pitchT - this.camPitch) * kP;
    cam.rotation.order = 'YXZ';
    cam.rotation.set(this.camPitch, yaw, 0);
    cam.updateMatrixWorld();
    this.pos.x = cx; this.pos.z = cz;

    const yawRate = this.lastYaw === null || dt <= 0 ? 0 : Math.atan2(Math.sin(yaw - this.lastYaw), Math.cos(yaw - this.lastYaw)) / dt;
    this.lastYaw = yaw;
    const xImp = xAtArrival(this.event, t, 0, x);
    const deg = (a) => +(a * 180 / Math.PI).toFixed(2);
    this.tel = {
      t: +t.toFixed(3), phase: plan.phase, alpha: +plan.a.toFixed(3), h: +plan.h.toFixed(3), tn: +wave.tn.toFixed(3),
      aheadOfImpact: +((x - xImp) * Math.sign(this.event.aR1)).toFixed(2),
      board: [+x.toFixed(3), +pos.y.toFixed(3), +z.toFixed(3)], speed: +speed.toFixed(2),
      headingDeg: deg(Math.atan2(f.z, f.x)), pitchDeg: deg(Math.asin(clamp(fwd.y, -1, 1))), rollDeg: deg(Math.asin(clamp(-side.y, -1, 1))), bankDeg: deg(bank),
      face: { crest: +wave.crestY.toFixed(2), trough: +wave.troughY.toFixed(2), apexZ: +wave.apexZ.toFixed(2) },
      water: { c: +hC.toFixed(3), n: +hN.toFixed(3), t: +hT.toFixed(3), l: +hL.toFixed(3), r: +hR.toFixed(3) },
      gaps: Object.fromEntries(Object.entries(gaps).map(([k, g]) => [k, +g.toFixed(3)])),
      cam: { pos: [+cx.toFixed(2), +camY.toFixed(2), +cz.toFixed(2)], yawDeg: deg(yaw), pitchDeg: deg(this.camPitch), rollDeg: 0, yawRateDeg: deg(yawRate),
        distToBoard: +Math.hypot(cx - x, camY - pos.y, cz - z).toFixed(2), heightAboveBoard: +(camY - pos.y).toFixed(2) },
    };
  }

  telemetry() { return this.tel; }
}
export { arrival, slice };
