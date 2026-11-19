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
const SAMPLE_DZ = 0.2;            // rail sample offset (m)
const RAIL_DX = -0.1;              // rails sampled just behind the stance (the widest planing part)
// centreline samples: board-space x (m, + toward the nose) and least-squares weight
const LONG = [[-0.80, 1.0], [-0.45, 1.0], [-0.10, 1.0], [0.25, 0.6], [0.60, 0.2]];

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
const FIXED_POSE = (() => {
  const v = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('pose') : null;
  const p = v ? v.split(',').map(Number) : null;
  return p && p.length === 2 && p.every(Number.isFinite) ? p : null;
})();
const QS = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
const CAM_VIEW = QS.get('cam') || 'chase';
// ?shot=beach|channel|drone[&at=T]: a FIXED spectator camera (no board) placed around the column where
// the curl impacts at time T, so a clip around T shows the wave build, throw its lip and collapse while
// the peel runs past. beach: eye level from the sand; channel: a water photographer on the shoulder,
// looking down the line into the curl; drone: elevated oblique over the line-up.
const SHOT = QS.get('shot');
const SHOT_AT = Number.isFinite(parseFloat(QS.get('at'))) ? parseFloat(QS.get('at')) : 24;

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
    this.view = SHOT ? 'watch' : CAM_VIEW;   // 'chase' | 'side' | 'aerial' | 'watch'
    this.pos = { x: 0, z: 0 };     // focus (the camera's xz) for the swash window (SwashSim._focusX)
    if (SHOT) this.shot = this._shotSetup(SHOT, SHOT_AT);
    this.reset();
  }

  /** switch view at run time: 'chase' | 'side' | 'aerial' or a spectator shot 'beach' | 'channel' | 'drone' */
  setView(v) {
    if (v === 'beach' || v === 'channel' || v === 'drone') { this.shot = this._shotSetup(v, this.shot?.T ?? SHOT_AT); this.view = 'watch'; }
    else this.view = v;
  }
  get viewKey() { return this.view === 'watch' ? this.shot.kind : this.view; }

  /** fixed spectator camera around the column where the curl impacts at time T */
  _shotSetup(kind, T) {
    const e = this.plEvent, dir = Math.sign(e.aR1) || 1;
    const xw = xAtArrival(e, T, 0, this._guess(T, 0));
    const w = waveAt(e, xw, T, true);
    const zA = w.apexZ, zL = w.b.zI;                     // lip apex / landing line at impact
    const H = this.S.height;
    let pos, look;
    if (kind === 'channel') {
      pos = [xw + 20 * dir, 0.6 + 0.35 * H, zL + 3.5];
      look = [xw - 2 * dir, 0.45 * H, zA - 0.5];
    } else if (kind === 'drone') {
      pos = [xw + 16 * dir, 7 + 3 * H, zL + 20];
      look = [xw - 6 * dir, 0, zA - 2];
    } else {   // beach
      pos = [xw + 9 * dir, 2.4, 4.0];
      look = [xw - 5 * dir, 0.5 * H, zA];
    }
    // world focus (mesh LOD, lip-ribbon slots, particles): between the camera and the break
    const f = kind === 'drone' ? 0.6 : 0.35;
    const focus = { x: pos[0] + f * (look[0] - pos[0]), z: pos[2] + f * (look[2] - pos[2]) };
    return { kind, T, xw, zA, zL, dir, pos, look, focus };
  }

  reset() { this.camY = null; this.camPitch = null; this.lastYaw = null; this.tel = null; this.lastT = null; this.prevFwd = this.prevSide = this.prevUp = null; }

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
    // ?pose=alpha,h: hold one position on the wave (evaluation stills, e.g. under the lip)
    if (FIXED_POSE) return { a: FIXED_POSE[0], h: FIXED_POSE[1], phase: 'fixed pose', u: 0 };
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
  xz(t) { const p = this.plan(t); return this.xzAt(t, p.a, p.h, p); }
  /** world (x, z) of wave position (alpha, h) at time t */
  xzAt(t, a, h, p = null) {
    const x = xAtArrival(this.plEvent, t, a, this._guess(t, a));
    const w = waveAt(this.plEvent, x, t, true);
    return [x, w.faceZ(h), p, w];
  }
  _guess(t, a = -0.9) {
    // linear peel: x ~ (t - t0 - alpha rs) * speed; refined by Newton in xAtArrival
    const k = this.event.aR1;
    return (t - this.event.t0 - a * Math.sqrt(this.event.H / 0.45)) / k;
  }
  /** world velocity of the planned path */
  velWorld(t, h = 0.02) {
    const a = this.xz(t - h), b = this.xz(t + h);
    return [(b[0] - a[0]) / (2 * h), (b[1] - a[1]) / (2 * h)];
  }
  /** Velocity relative to the travelling wave: the world velocity minus the wave's propagation
   *  velocity normal to its crest. The peeling pattern moves along the coast at the peel speed and the
   *  crest is oblique to the coast (here ~40 deg: a realistic peel angle), so a rider holding station by
   *  the curl moves through the water ALONG the crest. The board points along this velocity (and the
   *  chase camera follows it); along the world velocity it would cross the face diagonally, nose down. */
  vel(t, h = 0.02) {
    const p = this.plan(t);
    const vw = this.velWorld(t, h);
    const P0 = this.xzAt(t - h, p.a, p.h), P1 = this.xzAt(t + h, p.a, p.h);
    const u = [(P1[0] - P0[0]) / (2 * h), (P1[1] - P0[1]) / (2 * h)];       // pattern velocity here
    const A0 = this.xzAt(t, p.a - 0.02, p.h), A1 = this.xzAt(t, p.a + 0.02, p.h);
    let tx = A1[0] - A0[0], tz = A1[1] - A0[1];                               // crest-parallel direction
    const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
    let nx = -tz, nz = tx; if (nz < 0) { nx = -nx; nz = -nz; }                // crest normal (shoreward)
    const c = u[0] * nx + u[1] * nz;                                          // propagation speed
    return [vw[0] - c * nx, vw[1] - c * nz, c];
  }
  /** smoothed direction of travel (exponentially weighted over the last ~1 s) */
  heading(t) {
    let sx = 0, sz = 0;
    for (let i = 0; i < 11; i++) {
      const w = Math.exp(-i * 0.15 / 0.8);
      const v = this.vel(t - i * 0.15);
      const l = Math.hypot(v[0], v[1]) || 1;
      sx += (w * v[0]) / l; sz += (w * v[1]) / l;
    }
    const l = Math.hypot(sx, sz) || 1;
    return [sx / l, sz / l];
  }
  /** the camera's (x, z) (= the world focus) at time t, deterministic */
  focusAt(t) {
    if (this.view === 'watch') { this.pos.x = this.shot.focus.x; this.pos.z = this.shot.focus.z; return this.pos; }
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
    if (this.view === 'watch') { this._updateWatch(t); return; }
    this.board.group.visible = true;
    const [x, z, plan, wave] = this.xz(t);
    const v = this.vel(t);
    const v2 = this.vel(t + 0.05), v1 = this.vel(t - 0.05);
    const acc = [(v2[0] - v1[0]) / 0.1, (v2[1] - v1[1]) / 0.1];
    const speed = Math.hypot(v[0], v[1]);
    const f = new THREE.Vector3(v[0] / speed, 0, v[1] / speed);
    const r = new THREE.Vector3(-f.z, 0, f.x);          // right of travel (f x up)
    const hd = this.heading(t);
    const cx = x - CAM_BACK * hd[0], cz = z - CAM_BACK * hd[1];
    // ---------------------------------------------------------- contact with the rendered surface
    // Samples along the board's centreline (tail .. nose) and at the rails, placed where those points
    // of the board are (horizontal footprint of last frame's attitude, current heading), plus the
    // camera's xz. The bottom (with its rocker) is fitted to the water heights by weighted least
    // squares: height and pitch from the planing area (tail to mid; the rockered nose weighs little),
    // roll from the rails. The origin then sits DRAFT below the fitted surface.
    const cf = this.prevFwd ? Math.hypot(this.prevFwd.x, this.prevFwd.z) : 1;
    const cs = this.prevSide ? Math.hypot(this.prevSide.x, this.prevSide.z) : 1;
    const at = (dx, dz) => [x + f.x * dx * cf + r.x * dz * cs, z + f.z * dx * cf + r.z * dz * cs];
    const P = LONG.map(([dx]) => at(dx, 0));
    P.push(at(RAIL_DX, -SAMPLE_DZ), at(RAIL_DX, SAMPLE_DZ), [cx, cz]);
    const d = this.probe.sample(renderer, P);
    const wAt = (k) => d[4 * k];
    const nL = LONG.length, hL = wAt(nL), hR = wAt(nL + 1), hCam = wAt(nL + 2);
    const cu = this.prevUp ? this.prevUp.y : 1;
    let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    LONG.forEach(([dx, wk], k) => {
      const yk = wAt(k) - Board.bottomAt(dx) * cu;
      sw += wk; sx += wk * dx; sy += wk * yk; sxx += wk * dx * dx; sxy += wk * dx * yk;
    });
    const den = sw * sxx - sx * sx;
    const pRise = clamp(den > 1e-9 ? (sw * sxy - sx * sy) / den : 0, -0.85, 0.85);   // rise per metre of board
    const y0 = (sy - pRise * sx) / sw;
    const qRise = clamp((hR - hL) / (2 * SAMPLE_DZ), -0.85, 0.85);                 // rise per metre across
    const fwd = f.clone().multiplyScalar(Math.sqrt(1 - pRise * pRise)).setY(pRise);
    const sideS = r.clone().multiplyScalar(Math.sqrt(1 - qRise * qRise)).setY(qRise);
    const n = new THREE.Vector3().crossVectors(sideS, fwd).normalize();
    fwd.addScaledVector(n, -fwd.dot(n)).normalize();
    // carving: the board leans into the turn (lateral acceleration), up to ~24 degrees on the rail
    const aLat = acc[0] * r.x + acc[1] * r.z;
    const bank = clamp(Math.atan2(aLat, CONFIG.g) * 0.6, -0.42, 0.42);
    const up = n.clone().applyAxisAngle(fwd, bank).normalize();   // (+: right rail down)
    const pos = new THREE.Vector3(x, y0 - DRAFT, z);
    this.board.setPose(pos, fwd, up);
    const side = new THREE.Vector3().crossVectors(fwd, up).normalize();
    this.prevFwd = fwd.clone(); this.prevSide = side.clone(); this.prevUp = up.clone();

    // contact metrics: board bottom minus water height at every sample (+: air gap, -: immersed)
    const gapAt = (dx, dz, hw) => pos.clone().addScaledVector(fwd, dx).addScaledVector(side, dz).addScaledVector(up, Board.bottomAt(dx)).y - hw;
    const gl = LONG.map(([dx], k) => gapAt(dx, 0, wAt(k)));
    const gaps = { tail: gl[0], midTail: gl[1], centre: gl[2], midNose: gl[3], nose: gl[4],
      left: gapAt(RAIL_DX, -SAMPLE_DZ, hL), right: gapAt(RAIL_DX, SAMPLE_DZ, hR) };
    const hC = wAt(2), hN = wAt(4), hT = wAt(0);

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
    // diagnostic / evaluation views (?cam=side: from the shoreward side of the face; ?cam=aerial)
    const view = this.view;
    if (view === 'side' || view === 'aerial') {
      const dir = Math.sign(this.event.aR1) || 1;
      if (view === 'side') cam.position.set(x - 1.5 * dir, Math.max(boardY + 0.9, 1.2), z + 7.5);
      else cam.position.set(x - 14 * dir, 11, z + 12);
      cam.lookAt(x + 0.5 * dir, boardY + 0.3, z - 0.5);
    }
    cam.updateMatrixWorld();
    this.pos.x = cx; this.pos.z = cz;

    const yawRate = this.lastYaw === null || dt <= 0 ? 0 : Math.atan2(Math.sin(yaw - this.lastYaw), Math.cos(yaw - this.lastYaw)) / dt;
    this.lastYaw = yaw;
    const xImp = xAtArrival(this.event, t, 0, x);
    const deg = (a) => +(a * 180 / Math.PI).toFixed(2);
    this.tel = {
      t: +t.toFixed(3), phase: plan.phase, alpha: +plan.a.toFixed(3), h: +plan.h.toFixed(3), tn: +wave.tn.toFixed(3),
      aheadOfImpact: +((x - xImp) * Math.sign(this.event.aR1)).toFixed(2),
      board: [+x.toFixed(3), +pos.y.toFixed(3), +z.toFixed(3)], speed: +speed.toFixed(2), worldSpeed: +Math.hypot(...this.velWorld(t)).toFixed(2), waveSpeed: +v[2].toFixed(2),
      headingDeg: deg(Math.atan2(f.z, f.x)), pitchDeg: deg(Math.asin(clamp(fwd.y, -1, 1))), rollDeg: deg(Math.asin(clamp(-side.y, -1, 1))), bankDeg: deg(bank),
      face: { crest: +wave.crestY.toFixed(2), trough: +wave.troughY.toFixed(2), apexZ: +wave.apexZ.toFixed(2) },
      water: { c: +hC.toFixed(3), n: +hN.toFixed(3), t: +hT.toFixed(3), l: +hL.toFixed(3), r: +hR.toFixed(3) },
      gaps: Object.fromEntries(Object.entries(gaps).map(([k, g]) => [k, +g.toFixed(3)])),
      cam: { pos: [+cx.toFixed(2), +camY.toFixed(2), +cz.toFixed(2)], yawDeg: deg(yaw), pitchDeg: deg(this.camPitch), rollDeg: 0, yawRateDeg: deg(yawRate),
        distToBoard: +Math.hypot(cx - x, camY - pos.y, cz - z).toFixed(2), heightAboveBoard: +(camY - pos.y).toFixed(2) },
    };
  }

  _updateWatch(t) {
    const s = this.shot, cam = this.camera;
    this.board.group.visible = false;
    cam.position.fromArray(s.pos);
    cam.up.set(0, 1, 0);
    cam.lookAt(s.look[0], s.look[1], s.look[2]);
    cam.updateMatrixWorld();
    // where the curl (impact, tn = 0) is now, relative to the watched column (+: past it)
    const xImp = xAtArrival(this.event, t, 0, s.xw + (t - s.T) / (this.event.aR1 || 1));
    const w = waveAt(this.event, s.xw, t);
    this.tel = { t: +t.toFixed(3), phase: 'watch:' + s.kind, curlPastColumn: +((xImp - s.xw) * s.dir).toFixed(2),
      columnTn: +w.tn.toFixed(3), columnCrestY: +w.crestY.toFixed(2), cam: { pos: s.pos.map((v) => +v.toFixed(2)), look: s.look.map((v) => +v.toFixed(2)) } };
  }

  telemetry() { return this.tel; }
}
export { arrival, slice };
