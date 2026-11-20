// BlueCurl Swell — rider simulation (WP6a). Contract: src/contracts.js "riders". Pure JS (no three.js).
//
// States: LINEUP → POSITION → TAKEOFF → RIDE → KICKOUT | CLOSEOUT → RETURN → LINEUP.
//  - LINEUP: idle at a home spot a little seaward of a zone's break line (brain.js: sit/paddle, circle/surface,
//    float/roll/dive), bobbing on field.surfaceHeight.
//  - On a ZoneBreak commit, free riders of that zone compete (fit × reachability, hash(frontId, zi, seed)); up to two
//    riders of different kinds take the wave. POSITION: paddle/swim (≤ vPos) to a takeoff spot timed so the face
//    reaches them shortly before the curl does.
//  - TAKEOFF starts when the face reaches the rider (the catch, 'takeoff' event): paddle on the face (or race from
//    behind) until the curl is just behind, then pop. RIDE follows the seeded keyframe plan (plan.js) in wave
//    coordinates; world pos / normal come from field.sampleFront.
//  - KICKOUT over the back at the end of the peel / planned length; CLOSEOUT (wipe/dive) when the break overtakes
//    the rider (τ > 0.85 at the rider, e.g. on a close-out). 'rideEnd' carries the outcome. RETURN to a lineup.
// Presence (milestone 2, contract "riders"): the number of riders in the water follows beat.level. ASHORE riders are
// out of the scene; ENTER paddles (surfers, from the bay beach) or swims (animals, from open sea seaward of their
// lineup) to the lineup, arriving exactly on the downbeat of measure enterIndex + cfg.beat.entryMeasures (progress is
// measured in measures, so a bpm change mid-entry still lands on that downbeat). Riders asked to leave finish their
// ride first, then LEAVE over entryMeasures measures (an ENTERing rider turns round and goes back the way it came,
// taking as long as it had swum) and become ASHORE. Without a beat (step(t, dt, swell)) every rider is present.
// Determinism: fixed steps, state = f(cfg, swell history, beat history); seeded by hash01/mulberry32; no Math.random.
// Every RideEvent is a fresh object (the camera rig de-duplicates by identity). frontId / zi stay set from
// POSITION until the rider starts RETURN.
import { RIDERS, ZONES, ENTRY_ORDER, DT, FRONT_W, uToZ, zToU, hash01, breakStartTime, ambientHeight } from '../contracts.js';
import { sampleFront, barrel, columnState, evalLocal, crossings } from '../wave/field.js';
import { profileInto } from '../wave/profile.js';
import { pathSpline, pathEval } from '../sim/swell.js';
import { depthAt } from '../spot/bathymetry.js';
import {
  waveFrame, uOfS, sOfU, curlS, tauAt, faceSigma, chooseStyle, buildPlan, evalPlan, sigmaOfH, H_TOE, SIG_BACK, seaLevel,
} from './plan.js';
import { KIND_PLAN } from './plan.js';
import { KINDS, homeSpots, fit, weightedPick, pickHome, idleStep } from './brain.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (s) => { s = clamp(s, 0, 1); return s * s * (3 - 2 * s); };
const KO_T = 0.9;            // s, kick-out
const CO_T = 1.8;            // s, close-out wipe (attached for CO_ATTACH, then tumbling free)
const CO_ATTACH = 0.6;
const ERR_TAU = 0.2;
const CATCH_EASE = 0.5;      // s, paddle speed → wave speed at the catch
const SHARE = 0.75;          // wave-choice weight factor per ride already taken (spreads the waves around)
const RESTLESS = 40;         // s in a lineup without a wave before a rider tries its other zone (+ 0..15 s seeded)
const restAt = (id, t, seed) => t + RESTLESS + 15 * hash01(id, Math.round(t * 8), seed + 5);
const CATCH_DH = 4;        // 1/s, max rate of the face lift h during the catch ease
const TRAIL_EVERY = 2, TRAIL_DT = TRAIL_EVERY * DT, TRAIL_N = 128;   // position trail for wakes (≈ 2.1 s)         // s, transition smoothing of the position
const TAU_CLOSE = 0.85;      // the break overtook the rider
const HOP = { surfer: 0.7, dolphin: 2.0, seal: 0.8, turtle: 0.5 };
const ACC = { surfer: 4, dolphin: 14, seal: 7, turtle: 4 };          // m/s², paddling / swimming acceleration
const SWIM_OFF = { surfer: 0, dolphin: -0.4, seal: -0.15, turtle: -0.2 };   // swimming depth (vertical offset)
// ENTER / LEAVE last exactly entryMeasures measures, so the distance is what is chosen: a plausible average speed per
// kind × that duration. Surfers start from (end at) the nearest shore — beach or headland rocks — when it is within
// SHORE_SLACK × that distance, otherwise that far out toward it; animals surface / dive that far seaward.
export const TRAVEL_V = { surfer: 2.8, dolphin: 7, seal: 4, turtle: 3 };   // m/s average
const SHORE_SLACK = 1.35;
const measureLenOf = (cfg) => { const bpm = +cfg?.bpm; return 240 / (Number.isFinite(bpm) && bpm > 0 ? clamp(bpm, 1, 1000) : 120); };
const PRESENT_IDLE = new Set(['LINEUP', 'RETURN', 'POSITION']);   // can leave right away (no ride in progress)
const SWIMMING = new Set(['LINEUP', 'POSITION', 'RETURN', 'ENTER', 'LEAVE', 'ASHORE']);   // on the sea surface
/** Entry / exit easing: gentle start and landing (velocity 0.4× average at both ends, 1.3× peak). */
const easeIO = (p) => 0.4 * p + 0.6 * smooth(p);

/** Nearest shore from (x, z) within maxD: { x, z (last point with ≥ 0.3 m of water), d } on 72 rays, or the ray
 *  direction toward the nearest shore found within 250 m ({ dx, dz, d: Infinity } if it is beyond maxD). */
export function nearestShore(x, z, maxD) {
  let best = null;
  for (let k = 0; k < 72; k++) {
    const a = (k / 72) * 2 * Math.PI, dx = Math.cos(a), dz = Math.sin(a);
    const lim = Math.min(250, best ? best.d : 250);
    for (let s = 0.5; s <= lim; s += 0.5) {
      if (depthAt(x + dx * s, z + dz * s) < 0.3) { best = { dx, dz, d: s }; break; }
    }
  }
  if (!best) return { dx: -1, dz: 0, d: Infinity };
  if (best.d > maxD) return { dx: best.dx, dz: best.dz, d: Infinity };
  const s = Math.max(0, best.d - 0.5);
  return { x: x + best.dx * s, z: z + best.dz * s, dx: best.dx, dz: best.dz, d: s };
}
/**
 * Where a rider comes from / goes to, `dist` m (= TRAVEL_V × duration) from (x, z): surfers the nearest beach /
 * rocks if within SHORE_SLACK·dist, else dist toward it; animals dist out to sea (seaward ± ~23°, seeded by h).
 */
export function exitPoint(kind, x, z, dist, h = 0.5) {
  if (kind === 'surfer') {
    const s = nearestShore(x, z, SHORE_SLACK * dist);
    return Number.isFinite(s.d) ? { x: s.x, z: s.z } : { x: x + s.dx * dist, z: z + s.dz * dist };
  }
  for (const a of [(h - 0.5) * 0.8, 0]) {
    const p = { x: x + dist * Math.cos(a), z: z + dist * Math.sin(a) };
    if (depthAt(p.x, p.z) > 3 || a === 0) return p;
  }
}

export class Riders {
  constructor(cfg) { this.cfg = cfg; this.reset(); }

  reset() {
    const seed = this.cfg?.seed ?? 1;
    this.t = 0;
    this.events = [];
    this.rides = [];          // ride log: one summary per ride (tools/rides-report.mjs, tests)
    this._seen = new Set();
    this._rideN = 0;
    const homes = homeSpots(seed);
    this._b = [];
    this._beat = null;
    this._beatSeen = 0;         // last beat measure index processed
    this._level = 1;            // last beat level seen
    this.riders = RIDERS.map((R) => {
      const zi = ZONES.findIndex((Z) => Z.key === R.zones[0]);
      // entry lineup: the rider's first zone (surfers paddle there from the beach, animals swim in from open sea)
      const ezi = zi;
      const eh = homes[R.id][ezi];
      // where it waits ashore (recomputed at the enter for the then measure length)
      const spawn = exitPoint(R.kind, eh.x, eh.z, TRAVEL_V[R.kind] * this.entryMeasures * measureLenOf(this.cfg), hash01(R.id, 77, seed));
      const inAtStart = R.id === ENTRY_ORDER[0];
      const h = inAtStart ? homes[R.id][zi] : spawn;
      const r = {
        id: R.id, kind: R.kind, name: R.name, color: R.color, zones: R.zones.slice(),
        state: inAtStart ? 'LINEUP' : 'ASHORE', present: inAtStart, enterT: inAtStart ? 0 : null, arriveT: inAtStart ? 0 : null, exitT: null,
        style: null, action: 'idle', actionT: 0,
        pos: { x: h.x, y: ambientHeight(h.x, h.z, 0), z: h.z }, fwd: { x: 1, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 },
        speed: 0, frontId: null, zi: -1, u: zToU(h.z), sigma: 0, tube: false,
        prevAction: 'idle', prevActionT: 0, actionStart: 0,
        trail: { dt: TRAIL_DT, n: TRAIL_N, count: 0, head: -1, t: 0, xyz: new Float32Array(TRAIL_N * 3) },
      };
      this._b.push({
        homes: homes[R.id], homeZi: inAtStart ? zi : ezi, firstZi: zi, entryZi: ezi, spawn,
        enterIdx: null, arriveIdx: null, leaving: false, path: null,
        coolUntil: 0, restAt: restAt(R.id, 0, seed), idle: null, idleN: 0, wx: h.x, wz: h.z,
        ride: null, tState: 0, seg: null, mv: { x: 0, z: 0 }, lastV: { x: 0, y: 0, z: 0 }, err: { x: 0, y: 0, z: 0 }, cont: false, prev: null, vs: { x: 0, y: 0, z: 0 }, lean: 0,
      });
      return r;
    });
  }

  // ------------------------------------------------------------------ step
  step(t, dt, swell, beat = null) {
    this.t = t;
    const seed = this.cfg?.seed ?? 1;
    // 0. presence: arrivals, flocks, joiners / leavers from the beat level
    this._beat = beat;
    this._presence(t, swell, beat);
    // 1. new zone breaks → wave choice
    for (const f of swell.fronts) {
      for (const zb of f.breaks) {
        const key = f.id * 8 + zb.zi;
        if (this._seen.has(key)) continue;
        this._seen.add(key);
        this._choose(t, f, zb, swell, seed);
      }
    }
    if (this._seen.size > 256) {
      const alive = new Set(swell.fronts.map((f) => f.id));
      for (const k of this._seen) if (!alive.has(Math.floor(k / 8))) this._seen.delete(k);
    }
    // 2. riders
    for (let i = 0; i < this.riders.length; i++) this._stepRider(this.riders[i], this._b[i], t, dt, swell, seed);
    // 3. position trail (sim-stepped, every TRAIL_DT)
    if (Math.round(t / DT) % TRAIL_EVERY === 0) {
      for (const r of this.riders) {
        const T = r.trail;
        T.head = (T.head + 1) % T.n; T.count = Math.min(T.n, T.count + 1); T.t = t;
        T.xyz[T.head * 3] = r.pos.x; T.xyz[T.head * 3 + 1] = r.pos.y; T.xyz[T.head * 3 + 2] = r.pos.z;
      }
    }
    // 4. event ring
    let cut = 0;
    while (cut < this.events.length && (this.events[cut].t < t - 60 || this.events.length - cut > 256)) cut++;
    if (cut) this.events.splice(0, cut);
  }

  // ------------------------------------------------------------------ presence
  get entryMeasures() { return Math.max(1, Math.round(this.cfg?.beat?.entryMeasures ?? 4)); }

  _presence(t, swell, beat) {
    if (!beat) {                                        // no beat clock: everyone is in the water (legacy / tests)
      this.riders.forEach((r, i) => {
        if (r.state !== 'ASHORE') return;
        const b = this._b[i], h = b.homes[b.firstZi];
        b.homeZi = b.firstZi; b.wx = h.x; b.wz = h.z; b.idle = null; b.restAt = restAt(r.id, t, this.cfg?.seed ?? 1);
        r.present = true; r.enterT = r.arriveT = t;
        this._setState(r, b, 'LINEUP', t); b.cont = false;
      });
      return;
    }
    // downbeats since the last step (normally 0 or 1); a beat without an event ring gets synthesised ones
    const downs = [];
    if (beat.measure > this._beatSeen) {
      for (let idx = this._beatSeen + 1; idx <= beat.measure; idx++) {
        const ev = (beat.events || []).find((e) => e.type === 'downbeat' && e.index === idx);
        downs.push(ev ?? { index: idx, t: idx === beat.measure ? beat.measureT0 : undefined,
          change: idx === beat.measure ? Math.sign(beat.level - this._level) : 0 });
      }
      this._beatSeen = beat.measure;
    }
    this._level = beat.level;
    // 1. arrivals (a flock when the level changed on the very downbeat of the arrival)
    this.riders.forEach((r, i) => {
      const b = this._b[i];
      if (r.state !== 'ENTER' || beat.measure < b.arriveIdx) return;
      const h = b.homes[b.homeZi];
      b.wx = h.x; b.wz = h.z; b.idle = null; b.coolUntil = t + 1; b.path = null; b.restAt = restAt(r.id, t, this.cfg?.seed ?? 1);
      const db = downs.find((d) => d.index === b.arriveIdx);
      r.arriveT = db?.t ?? beat.measureT0;
      this._setState(r, b, 'LINEUP', t);
      const pos = { x: h.x, y: this._surf(swell, h.x, h.z, t), z: h.z };
      this._emit({ t, type: 'arrive', riderId: r.id, pos });
      if (db && db.change) this._emit({ t, type: 'flock', riderId: r.id, pos });
    });
    // 2. who should be in the water: the first `level` of ENTRY_ORDER (so joiners in order, leavers LIFO)
    const n = clamp(Math.round(beat.level), 1, this.riders.length);
    for (let k = 0; k < ENTRY_ORDER.length; k++) {
      const id = ENTRY_ORDER[k], r = this.riders[id], b = this._b[id];
      if (!r) continue;
      if (k < n) {
        if (b.leaving) b.leaving = false;                                   // still riding: simply stays
        else if (r.state === 'ASHORE' || r.state === 'LEAVE') this._startEnter(r, b, t, swell, beat);
      } else if (r.state !== 'ASHORE' && r.state !== 'LEAVE' && !b.leaving) {
        if (r.state === 'ENTER') this._startLeave(r, b, t, Math.max(0.5, t - r.enterT));   // turn round
        else if (PRESENT_IDLE.has(r.state)) this._startLeave(r, b, t, this.entryMeasures * beat.measureLen);
        else b.leaving = true;                                              // finish the ride / kick-out first
      }
    }
  }

  _startEnter(r, b, t, swell, beat) {
    b.homeZi = b.entryZi;
    const h = b.homes[b.homeZi];
    b.enterIdx = beat.measure; b.arriveIdx = beat.measure + this.entryMeasures;
    const arriveT = this._predictArrive(b, beat);
    if (r.state === 'ASHORE') {
      // (re)appear where this entry's duration makes a plausible swim / paddle (hidden until now: no smoothing)
      const sp = exitPoint(r.kind, h.x, h.z, TRAVEL_V[r.kind] * Math.max(0.5, arriveT - t), hash01(r.id, 77, this.cfg?.seed ?? 1));
      b.wx = sp.x; b.wz = sp.z; b.spawn = sp;
    }
    b.path = { x0: b.wx, z0: b.wz, x1: h.x, z1: h.z };
    b.ride = null; b.leaving = false; b.idle = null; b.nRides = 0;
    r.frontId = null; r.zi = -1; r.style = null; r.tube = false;
    const wasAshore = r.state === 'ASHORE';
    r.present = true; r.enterT = t; r.exitT = null; r.arriveT = arriveT;
    this._setState(r, b, 'ENTER', t);
    if (wasAshore) { b.cont = false; b.prev = null; b.err.x = b.err.y = b.err.z = 0; b.rawY = null; b.mv.x = b.mv.z = 0; }
    this._emit({ t, type: 'enter', riderId: r.id, pos: { x: b.wx, y: this._surf(swell, b.wx, b.wz, t), z: b.wz } });
  }

  /** Time of the downbeat of measure b.arriveIdx from the current measure and the bpm for the measures after it. */
  _predictArrive(b, beat) {
    const k = b.arriveIdx - beat.measure;
    if (k <= 0) return beat.measureT0;
    const bpm = +this.cfg?.bpm;
    const next = 240 / (Number.isFinite(bpm) && bpm > 0 ? clamp(bpm, 1, 1000) : 120);
    return beat.measureT0 + beat.measureLen + (k - 1) * next;
  }

  _startLeave(r, b, t, dur) {
    // turning round on the way in: straight back to where it came from (same speed); otherwise the nearest shore /
    // open sea at a plausible distance for the duration
    const e = r.state === 'ENTER' && b.path ? { x: b.path.x0, z: b.path.z0 }
      : exitPoint(r.kind, b.wx, b.wz, TRAVEL_V[r.kind] * dur, hash01(r.id, Math.round(t * 8), (this.cfg?.seed ?? 1) + 9));
    b.path = { x0: b.wx, z0: b.wz, x1: e.x, z1: e.z, t0: t, dur };
    r.exitT = t + dur;
    b.ride = null; b.leaving = false; b.enterIdx = b.arriveIdx = null;
    r.frontId = null; r.zi = -1; r.style = null; r.tube = false;
    this._setState(r, b, 'LEAVE', t);
    this._emit({ t, type: 'leave', riderId: r.id, pos: { x: r.pos.x, y: r.pos.y, z: r.pos.z } });
  }

  /** Swim / paddle motion of ENTER and LEAVE: position along b.path at progress p, with the travel animation. */
  _travel(r, b, t, swell, p) {
    const P = b.path, e = easeIO(clamp(p, 0, 1));
    b.wx = P.x0 + (P.x1 - P.x0) * e; b.wz = P.z0 + (P.z1 - P.z0) * e;
    r.u = zToU(b.wz); r.sigma = 0;
    const el = t - b.tState;
    let off = SWIM_OFF[r.kind] ?? 0, act = r.kind === 'surfer' ? 'paddle' : 'swim', actT = (el / 1.1) % 1, air = false;
    if (r.kind === 'dolphin') {                       // porpoising across open water: a low leap every 1.6 s
      const c = (el % 1.6) / 1.6;
      if (c < 0.45 && p > 0.05 && p < 0.9) { act = 'jump'; actT = c / 0.45; off = -0.4 + 1.5 * Math.sin(Math.PI * actT) ** 2; air = off > 0; }
    }
    return { x: b.wx, y: this._surf(swell, b.wx, b.wz, t) + off, z: b.wz, act, actT, carry: 0, n: null, air,
      pitch: r.kind === 'dolphin' };
  }

  _enter(r, b, t, swell) {
    const beat = this._beat;
    // progress in measures: continuous across downbeats and exactly 1 on the arrival downbeat whatever the bpm does
    const m = beat ? beat.measure - b.enterIdx + clamp((t - beat.measureT0) / beat.measureLen, 0, 1) : 0;
    if (beat) r.arriveT = this._predictArrive(b, beat);
    return this._travel(r, b, t, swell, m / (b.arriveIdx - b.enterIdx));
  }

  _leave(r, b, t, swell) {
    const P = b.path, p = (t - P.t0) / P.dur;
    if (p >= 1) {
      b.wx = P.x1; b.wz = P.z1; b.path = null;
      r.present = false;
      this._setState(r, b, 'ASHORE', t);
      this._emit({ t, type: 'gone', riderId: r.id, pos: { x: b.wx, y: this._surf(swell, b.wx, b.wz, t), z: b.wz } });
      return null;
    }
    return this._travel(r, b, t, swell, p);
  }

  _ashore(r, b, t, swell) {
    r.u = zToU(b.wz); r.sigma = 0; r.style = null; r.tube = false;
    return { x: b.wx, y: this._surf(swell, b.wx, b.wz, t) + Math.min(0, SWIM_OFF[r.kind] ?? 0), z: b.wz, act: 'idle', actT: 0,
      carry: 0, n: null, pitch: false };
  }

  /**
   * Rider position `age` seconds ago (0 = now), linearly interpolated along the sim-stepped trail; clamped to the
   * oldest stored sample (TRAIL_N · TRAIL_DT ≈ 2.1 s). Writes out = {x,y,z} and returns it.
   */
  trail(id, age, out = { x: 0, y: 0, z: 0 }) {
    const r = this.riders[id], T = r.trail;
    const tq = this.t - Math.max(0, age);
    if (T.count === 0 || tq >= T.t) {                         // between the newest sample and now
      const a = T.count ? T.t : this.t, w = this.t > a ? (tq - a) / (this.t - a) : 1;
      const k = T.head * 3, px = T.count ? T.xyz[k] : r.pos.x, py = T.count ? T.xyz[k + 1] : r.pos.y, pz = T.count ? T.xyz[k + 2] : r.pos.z;
      out.x = px + (r.pos.x - px) * w; out.y = py + (r.pos.y - py) * w; out.z = pz + (r.pos.z - pz) * w;
      return out;
    }
    const f = Math.min((T.t - tq) / T.dt, T.count - 1), i = Math.floor(f), w = f - i;
    const ia = ((T.head - i) % T.n + T.n) % T.n, ib = ((T.head - Math.min(i + 1, T.count - 1)) % T.n + T.n) % T.n;
    out.x = T.xyz[ia * 3] + (T.xyz[ib * 3] - T.xyz[ia * 3]) * w;
    out.y = T.xyz[ia * 3 + 1] + (T.xyz[ib * 3 + 1] - T.xyz[ia * 3 + 1]) * w;
    out.z = T.xyz[ia * 3 + 2] + (T.xyz[ib * 3 + 2] - T.xyz[ia * 3 + 2]) * w;
    return out;
  }

  _emit(ev) { this.events.push({ ...ev }); }

  _setState(r, b, s, t) {
    r.state = s; b.tState = t; b.cont = true;
    if (s === 'POSITION') { b.mv.x = b.lastV.x; b.mv.z = b.lastV.z; }   // carry on from the idle motion
    else if (s === 'RETURN') { b.mv.x = 0; b.mv.z = 0; }
  }

  // ------------------------------------------------------------------ wave choice
  _choose(t, f, zb, swell, seed) {
    const tier1 = [], tier2 = [], tier3 = [];
    for (let i = 0; i < this.riders.length; i++) {
      const r = this.riders[i], b = this._b[i];
      if (!r.zones.includes(zb.zone)) continue;
      let tier = 0;
      if (r.state === 'LINEUP') { if (b.homeZi === zb.zi) tier = t >= b.coolUntil ? 1 : 2; }
      else if (r.state === 'RETURN') {
        // paddling back out through the zone: may turn and take an inside section
        const u = zToU(b.wz), h = b.homes[b.homeZi];
        if (u > zb.u0 && u < zb.u1 && (b.homeZi === zb.zi || Math.hypot(h.x - b.wx, h.z - b.wz) <= 25)) tier = 2;
      }
      // last resort: anyone of this zone paddling around inside who can still get on it (a late, inside take-off)
      if (!tier && (r.state === 'RETURN' || r.state === 'LINEUP') && b.wx > ZONES[zb.zi].lineX - 58) tier = 3;
      if (!tier) continue;
      const opt = this._option(r, b, f, zb, t, null);
      if (!opt) continue;
      if (tier === 2 && opt.tauEst > 0.05) tier = 3;                       // too late for a clean take-off
      if (tier === 3 && (opt.tauEst > 0.45 || b.wx <= ZONES[zb.zi].lineX - 58)) continue;
      // share the waves: every ride already taken costs a little weight (keeps the lineup's last arrivals riding)
      [tier1, tier2, tier3][tier - 1].push({ r, b, opt, w: fit(r.kind, zb) * opt.reach * SHARE ** (b.nRides ?? 0) });
    }
    // tier 2 (in cool-down / nearly back) and tier 3 (late, from inside) only when nobody fresh can go
    if (!tier1.length && !tier2.length) for (const c of tier3) if (c.opt.tauEst > 0.05) c.w = Math.max(c.w, 1e-3);
    const C = tier1.length ? tier1 : tier2.length ? tier2 : tier3;
    if (!C.length) return;
    const k = zb.zi * 13;
    const p1 = weightedPick(C, hash01(f.id, k + 1, seed));
    this._assign(p1, f, zb, t, 0, seed);
    const C2 = C.filter((c) => c.r.kind !== p1.r.kind);
    if (!C2.length) return;
    const p2 = weightedPick(C2, hash01(f.id, k + 2, seed));
    // keep someone in reserve for the next waves of the set that look like they will break here
    let spare = 0;
    for (const c of [...tier1, ...tier2, ...tier3]) if (c !== p1 && c !== p2 && c.opt.reach >= 0.1) spare++;
    if (spare < this._upcoming(swell, f, zb.zi)) return;
    if (hash01(f.id, k + 3, seed) < clamp(0.3 + 0.5 * p2.w, 0, 0.85)) {
      const opt = this._option(p2.r, p2.b, f, zb, t, p1.opt);
      if (opt) this._assign({ ...p2, opt }, f, zb, t, 1, seed);
    }
  }

  /** Takeoff option for rider r on (f, zb): target spot, catch time, reachability ∈ (0,1]. null if impossible. */
  _option(r, b, f, zb, t, other) {
    const ur = zToU(b.wz);
    // the face must still be seaward of the rider
    const cs = columnState(f, clamp(ur, 0, 1), t, CS);
    if (f.x - evalLocal(cs, sigmaOfH(H_TOE), LQ).xi <= b.wx + 0.3) return null;
    if (depthAt(b.wx, b.wz) < 0.8) return null;
    const ds = (ur - zb.uPeak);
    const rd = zb.dir !== 0 ? zb.dir : Math.abs(ds) * 312 > 2 ? Math.sign(ds) : hash01(f.id, r.id, 5) < 0.5 ? -1 : 1;
    const wf = waveFrame(zb, rd);
    const sr = sOfU(wf, ur);
    let sLo, sHi;
    if (zb.closeout) { sLo = wf.sStart + 4; sHi = wf.sEdge - 6; }
    else { sLo = 3; sHi = Math.max(sLo, Math.min(wf.sEnd - 14, 50)); }
    // head up the line toward the peak as far as positioning allows: the earlier the take-off, the longer the ride
    const vP0 = KINDS[r.kind].vPos, avail0 = Math.max(0.5, zb.tBreak - 0.8 - t);
    let sT = zb.closeout ? clamp(sr, sLo, sHi) : clamp(Math.min(sr, Math.max(sLo, sr - 0.9 * vP0 * avail0)), sLo, sHi);
    if (other && other.wf.rd === rd && Math.abs(sT - other.sT) < 9) {      // second rider: keep apart
      const a = other.sT + 9, c = other.sT - 9;
      sT = a <= sHi + 6 && (Math.abs(a - sr) < Math.abs(c - sr) || c < sLo - 6) ? a : c;
    }
    const uT = uOfS(wf, sT);
    const tS = breakStartTime(zb, uT);
    if (!Number.isFinite(tS)) return null;
    const tauW = r.kind === 'surfer' ? -0.65 : -0.55;
    const tCatch = Math.max(t + 0.4, tS + tauW * zb.Tb);
    const sp = pathSpline(f.travel ?? this.cfg?.travel ?? 14);
    const X = pathEval(sp, tCatch - f.tPoint).x;
    profileInto(PT, tauW, sigmaOfH(H_TOE), zb.H, zb.steep, zb.curl, zb.mush);
    let xT = X - PT.xi;
    const zT = uToZ(uT);
    if (depthAt(xT, zT) < 1.5) xT = b.wx;
    const avail = tCatch - t;
    const vPos = KINDS[r.kind].vPos;
    const vNeed = Math.hypot(xT - b.wx, zT - b.wz) / avail;
    // where the face will actually meet the rider: along the crest as far as positioning gets them, at about their x
    const sGet = sr + clamp(sT - sr, -vPos * avail, vPos * avail);
    const late = Math.max(0, KIND_PLAN[r.kind].glide - wf.vRef) * 2;    // what racing along the face can make up
    if (!zb.closeout && sGet < sLo - 6 - late) return null;              // stuck behind the peak
    if (!zb.closeout && wf.sEnd - sGet < 10) return null;                 // would catch it where the peel ends
    const tGet = breakStartTime(zb, uOfS(wf, sGet));
    const tPass = this._passTime(sp, f, t, b.wx + Math.max(0, xT - b.wx) * 0.5, PT.xi);
    const tauEst = Number.isFinite(tGet) ? (tPass - tGet) / zb.Tb : -3;
    const reach = Math.exp(-Math.max(0, vNeed - vPos) / vPos) * Math.exp(-Math.max(0, Math.abs(sT - sr) - vPos * avail - 6) / 8)
      * Math.exp(-Math.max(0, tauEst + 0.1) / 0.2) * Math.exp(-Math.max(0, -tauEst - 2.5) / 1.5)
      * (zb.closeout ? 1 : 0.3 + 0.7 * clamp((wf.sEnd - sGet) / Math.max(1, wf.sEnd), 0, 1));   // peel left to ride
    return { wf, sT, xT, zT, tCatch, tauEst, reach: Math.max(reach, 1e-3) };
  }

  /** Fronts arriving within the next 6 s whose energy says they will break in zone zi (DESIGN: H formula). */
  _upcoming(swell, f, zi) {
    const Z = ZONES[zi];
    let n = 0;
    for (const g of swell.fronts) {
      if (g === f || g.tPoint <= f.tPoint || g.tPoint > f.tPoint + 6 || g.breaks.some((b) => b.zi === zi)) continue;
      let E = 0;
      for (let c = 0; c < g.energy.length; c++) { const u = (c + 0.5) / g.energy.length; if (u >= Z.u0 && u <= Z.u1) E += g.energy[c]; }
      if (Z.Hscale * (0.35 + 2.4 * (1 - Math.exp(-E / 6))) >= Z.Hbreak) n++;
    }
    return n;
  }

  /** Time the face toe (xi ahead of the crest) reaches world x, from the front's crest path. */
  _passTime(sp, f, t, x, xi) {
    let a = t, c = t + 12;
    for (let i = 0; i < 30; i++) { const m = 0.5 * (a + c); if (pathEval(sp, m - f.tPoint).x - xi > x) a = m; else c = m; }
    return 0.5 * (a + c);
  }

  _assign(c, f, zb, t, slot, seed) {
    const { r, b, opt } = c;
    b.ride = {
      id: ++this._rideN, front: f, frontId: f.id, zb, zi: zb.zi, wf: opt.wf, slot, opt,
      style: chooseStyle(r.kind, zb), seed: (hash01(f.id, zb.zi * 7 + r.id, seed) * 4294967296) >>> 0,
      plan: null, dAdj: 0, tTakeoff: null, maxH: 0, barrelS: 0, barrelSent: false, s: 0, sigma: 0, h: 0, vS: 0,
    };
    r.frontId = f.id; r.zi = zb.zi;
    this._setState(r, b, 'POSITION', t);
  }

  // ------------------------------------------------------------------ per-rider
  _stepRider(r, b, t, dt, swell, seed) {
    let raw = null;
    for (let guard = 0; guard < 4 && !raw; guard++) {
      switch (r.state) {
        case 'LINEUP': raw = this._lineup(r, b, t, swell, seed); break;
        case 'POSITION': raw = this._position(r, b, t, dt, swell); break;
        case 'TAKEOFF': case 'RIDE': raw = this._ride(r, b, t, dt, swell); break;
        case 'KICKOUT': raw = this._kickout(r, b, t, swell); break;
        case 'CLOSEOUT': raw = this._closeout(r, b, t, dt, swell); break;
        case 'ASHORE': raw = this._ashore(r, b, t, swell); break;
        case 'ENTER': raw = this._enter(r, b, t, swell); break;
        case 'LEAVE': raw = this._leave(r, b, t, swell); break;
        default: raw = this._return(r, b, t, dt, swell); break;
      }
    }
    // position with transition smoothing
    if (b.cont) {
      b.cont = false;
      // continue from where the last step's motion was heading (no stall frame at the switch)
      if (b.prev) {
        b.err.x = b.prev.x + b.lastV.x * dt - raw.x; b.err.y = b.prev.y + b.lastV.y * dt - raw.y; b.err.z = b.prev.z + b.lastV.z * dt - raw.z;
      }
    } else if (b.rawY != null && SWIMMING.has(r.state) && Math.abs(raw.y - b.rawY) > 0.2) {
      // swimming / paddling on the sea surface: a jump of the surface under the rider (a breaking front's face or
      // bore reaching it) is absorbed and eased out like a transition instead of popping the rider in one step
      b.err.y += b.rawY - raw.y;
    }
    b.rawY = raw.y;
    const k = Math.exp(-dt / ERR_TAU);
    const p = r.pos;
    p.x = raw.x + b.err.x; p.y = raw.y + b.err.y; p.z = raw.z + b.err.z;
    b.err.x *= k; b.err.y *= k; b.err.z *= k;
    const seg = raw.seg ?? r.state;
    if (raw.act !== r.action || seg !== b.seg) {
      r.prevAction = r.action; r.prevActionT = r.actionT; r.actionStart = t; b.seg = seg;
    }
    r.action = raw.act; r.actionT = raw.actT;
    this._orient(r, b, raw, dt);
    b.prev = { x: p.x, y: p.y, z: p.z };
  }

  /** fwd / up / speed from the motion: fwd along the velocity relative to the moving wave, up from the surface. */
  _orient(r, b, raw, dt) {
    const p = r.pos;
    let vx = 0, vy = 0, vz = 0;
    if (b.prev) { vx = (p.x - b.prev.x) / dt; vy = (p.y - b.prev.y) / dt; vz = (p.z - b.prev.z) / dt; }
    r.speed = Math.hypot(vx, vy, vz);
    b.lastV.x = vx; b.lastV.y = vy; b.lastV.z = vz;
    const a = 1 - Math.exp(-dt / 0.1);
    const vs = b.vs;
    vs.x += (vx - raw.carry - vs.x) * a; vs.y += (vy - vs.y) * a; vs.z += (vz - vs.z) * a;
    // up target
    let ux = 0, uy = 1, uz = 0;
    if (raw.n) { ux = 0.55 * raw.n.x; uy = 0.55 * raw.n.y + 0.45; uz = 0.55 * raw.n.z; }
    let l = Math.hypot(ux, uy, uz); ux /= l; uy /= l; uz /= l;
    // fwd target
    let fx = vs.x, fy = raw.pitch ? vs.y : 0, fz = vs.z;
    if (raw.n && !raw.air) { const d = fx * raw.n.x + fy * raw.n.y + fz * raw.n.z; fx -= d * raw.n.x; fy -= d * raw.n.y; fz -= d * raw.n.z; }
    l = Math.hypot(fx, fy, fz);
    const f = r.fwd;
    const px = f.x, py = f.y, pz = f.z;
    if (l > 0.4) {
      fx /= l; fy /= l; fz /= l;
      // pitch limit: a board never points more than ~27° down/up the face (animals ~50° on leaps)
      const lim = r.kind === 'surfer' ? 0.45 : 0.75;
      if (Math.abs(fy) > lim) { const hl = Math.hypot(fx, fz) || 1e-6, k = Math.sqrt(1 - lim * lim) / hl; fx *= k; fz *= k; fy = Math.sign(fy) * lim; }
    } else if (raw.face) { fx = raw.face[0]; fy = 0; fz = raw.face[1]; }
    else { fx = f.x; fy = raw.pitch ? f.y : 0; fz = f.z; }
    // turn more slowly when barely moving relative to the wave (a stalled cutback must not snap around)
    const af = 1 - Math.exp(-dt / (0.1 + 0.3 * Math.max(0, 1 - l / 6)));
    let nx = f.x + (fx - f.x) * af, ny = f.y + (fy - f.y) * af, nz = f.z + (fz - f.z) * af;
    l = Math.hypot(nx, ny, nz);
    if (l < 1e-3) { nx = f.x - f.z * 0.05; ny = f.y; nz = f.z + f.x * 0.05; l = Math.hypot(nx, ny, nz); }
    f.x = nx / l; f.y = ny / l; f.z = nz / l;
    // up ⟂ fwd
    let d = ux * f.x + uy * f.y + uz * f.z;
    ux -= d * f.x; uy -= d * f.y; uz -= d * f.z;
    l = Math.hypot(ux, uy, uz) || 1; ux /= l; uy /= l; uz /= l;
    // bank into turns while riding (turn rate about up, lean = atan(ω v / g))
    let lean = 0;
    if (raw.bank) {
      const cx = py * f.z - pz * f.y, cy = pz * f.x - px * f.z, cz = px * f.y - py * f.x;
      const w = (cx * ux + cy * uy + cz * uz) / dt;
      lean = clamp(-Math.atan((w * Math.hypot(vs.x, vs.z)) / 9.81), -0.55, 0.55);
    }
    b.lean += (lean - b.lean) * (1 - Math.exp(-dt / 0.15));
    const rx = f.y * uz - f.z * uy, ry = f.z * ux - f.x * uz, rz = f.x * uy - f.y * ux;   // right = fwd × up
    const c = Math.cos(b.lean), s = Math.sin(b.lean);
    r.up.x = ux * c + rx * s; r.up.y = uy * c + ry * s; r.up.z = uz * c + rz * s;
  }

  /** Move the world position toward a desired horizontal velocity with a per-kind acceleration limit. */
  _steer(r, b, vx, vz, dt) {
    const aMax = ACC[r.kind] * dt;
    let ax = vx - b.mv.x, az = vz - b.mv.z;
    const l = Math.hypot(ax, az);
    if (l > aMax) { ax *= aMax / l; az *= aMax / l; }
    b.mv.x += ax; b.mv.z += az;
    b.wx += b.mv.x * dt; b.wz += b.mv.z * dt;
  }

  _surf(swell, x, z, t) { return seaLevel(swell.fronts, x, z, t); }

  /** Riders in the water and staying (for lineup crowding). */
  _inWater() {
    const out = [];
    this.riders.forEach((r, i) => { if (r.present && r.state !== 'LEAVE' && !this._b[i].leaving) out.push({ r, b: this._b[i] }); });
    return out;
  }

  // ------------------------------------------------------------------ LINEUP
  _lineup(r, b, t, swell, seed) {
    // restless: no wave here for a long while → paddle / swim over to the rider's other zone (if any)
    if (t >= b.restAt) {
      b.restAt = restAt(r.id, t, seed);
      const zi = pickHome(r, b, b.wx, b.wz, this._inWater(), b.homeZi);
      if (zi !== b.homeZi) { b.homeZi = zi; this._setState(r, b, 'RETURN', t); return null; }
    }
    const o = idleStep(r, b, t, seed, IDLE);
    b.wx = o.x; b.wz = o.z;
    r.style = null; r.tube = false; r.u = zToU(o.z); r.sigma = 0;
    return { x: o.x, y: this._surf(swell, o.x, o.z, t) + o.off, z: o.z, act: o.act, actT: o.actT, seg: `i${b.idleN}`,
      carry: 0, n: null, face: o.face, pitch: r.kind !== 'surfer' };
  }

  // ------------------------------------------------------------------ POSITION
  _position(r, b, t, dt, swell) {
    const R = b.ride, f = R.front;
    if (!swell.fronts.includes(f) || t > R.opt.tCatch + 5) { this._toReturn(r, b, t, null); return null; }
    // catch: the toe of the face has reached the rider
    const u = clamp(zToU(b.wz), 0, 1);
    const cs = columnState(f, u, t, CS);
    if (f.x - evalLocal(cs, sigmaOfH(H_TOE), LQ).xi <= b.wx) { this._catch(r, b, t); return null; }
    const o = R.opt, dx = o.xT - b.wx, dz = o.zT - b.wz, dist = Math.hypot(dx, dz);
    // along the crest first (that is what decides where the face picks the rider up), then across
    const vP = KINDS[r.kind].vPos, tl0 = Math.max(0.3, o.tCatch - t);
    const vz = clamp(dz / tl0, -vP, vP), vxMax = Math.sqrt(Math.max(0, vP * vP - vz * vz));
    const vx = clamp(dx / tl0, -vxMax, vxMax);
    this._steer(r, b, vx, vz, dt);
    const tl = o.tCatch - t;
    const off = SWIM_OFF[r.kind] ?? 0;
    return { x: b.wx, y: this._surf(swell, b.wx, b.wz, t) + off, z: b.wz,
      act: r.kind === 'surfer' ? 'paddle' : 'swim', actT: ((t - b.tState) / 1.1) % 1,
      carry: 0, n: null, face: tl < 1.5 ? [-1, 0] : null, pitch: false };
  }

  _catch(r, b, t) {
    const R = b.ride, f = R.front, wf = R.wf;
    const u = clamp(zToU(b.wz), 0.001, 0.999);
    // h on the face where it meets the rider (x grows with h on the face)
    const cs = columnState(f, u, t, CS);
    let lo = H_TOE, hi = 1;
    for (let i = 0; i < 24; i++) {
      const m = 0.5 * (lo + hi);
      if (f.x - evalLocal(cs, faceSigma(cs, m), LQ).xi < b.wx) lo = m; else hi = m;
    }
    const hC = 0.5 * (lo + hi);
    R.plan = buildPlan({ wf, kind: r.kind, style: R.style, seed: R.seed, tC: t, sC: sOfU(wf, u), hC,
      tauBias: R.slot ? -0.25 : 0 });
    R.tTakeoff = t;
    b.nRides = (b.nRides ?? 0) + 1;
    R.c0 = { x: b.wx, z: b.wz, u, vx: b.lastV.x, vz: b.lastV.z };
    r.style = R.style;
    this._setState(r, b, 'TAKEOFF', t);
    this._emit({ t, type: 'takeoff', riderId: r.id, frontId: R.frontId, zi: R.zi });
  }

  // ------------------------------------------------------------------ TAKEOFF / RIDE
  _ride(r, b, t, dt, swell) {
    const R = b.ride, f = R.front, wf = R.wf, P = R.plan;
    if (!swell.fronts.includes(f)) { this._end(r, b, t, 'kickout'); this._toReturn(r, b, t, null); return null; }
    const e = evalPlan(P, t, EP);
    // shoulder / flat water: a column too small to ride → work back toward the pocket (or kick out, below)
    const Hmin = Math.max(0.5, 0.4 * wf.zb.H), dMin = 0.12 * wf.L;
    let weak = false;
    if (r.state === 'RIDE' && !wf.zb.closeout) {
      const cH = columnState(f, clamp(uOfS(wf, curlS(wf, t) + e.d + R.dAdj), 0.001, 0.999), t, CS).H;
      if (cH < Hmin) {
        weak = true;
        const back = KIND_PLAN[r.kind].back;
        R.dAdj = Math.max(R.dAdj - back * dt, Math.min(0, dMin - e.d));
      }
    }
    const s = curlS(wf, t) + e.d + R.dAdj;
    const u = clamp(uOfS(wf, s), 0.001, 0.999);
    const tau = tauAt(wf, s, t);
    let h = e.h;
    // catch: ease from the paddling motion to the wave over CATCH_EASE s — the face lifts the rider (h rises at the
    // paddle-extrapolated x) while the plan takes over
    let uu = u;
    const tc = t - P.tC;
    if (tc < CATCH_EASE && R.c0) {
      const w = smooth(tc / CATCH_EASE), c0 = R.c0;
      const uF = clamp(c0.u + (c0.vz * tc) / FRONT_W, 0.001, 0.999);
      uu = uF + (u - uF) * w;
      const xF = c0.x + c0.vx * tc, cs = columnState(f, uu, t, CS);
      let lo = 0, hi = 1;
      for (let i = 0; i < 18; i++) { const m = 0.5 * (lo + hi); if (f.x - evalLocal(cs, faceSigma(cs, m), LQ).xi < xF) lo = m; else hi = m; }
      h = 0.5 * (lo + hi) + (h - 0.5 * (lo + hi)) * w;
      // a near-vertical face makes h(x) ill-conditioned: never let the lift jump (≤ CATCH_DH per second)
      if (R._hT != null && Math.abs(R._hT - (t - dt)) < 1e-6) h = clamp(h, R.h - CATCH_DH * dt, R.h + CATCH_DH * dt);
    }
    if (tau > 0.2) h = Math.min(h, 1 - 0.75 * smooth((tau - 0.2) / 0.2));     // never on the lip's underside
    const sigma = faceSigma(columnState(f, uu, t, CS), h);
    const sm = sampleFront(f, uu, sigma, t);
    // offset (animals): along the normal blended with up
    let ox = sm.nx, oy = sm.ny + 1, oz = sm.nz;
    const ol = Math.hypot(ox, oy, oz) || 1;
    const x = sm.x + (ox / ol) * e.off, y = sm.y + (oy / ol) * e.off, z = sm.z + (oz / ol) * e.off;
    R.dh = R.plan === P && R._hT === t - dt ? (h - R.h) / dt : 0; R._hT = t;
    R.s = s; R.h = h; R.sigma = sigma; R.vS = wf.vRef + e.dd - (weak ? KIND_PLAN[r.kind].back : 0); R.u = uu;
    r.u = uu; r.sigma = sigma;
    if (r.state === 'TAKEOFF' && t >= P.tR) { r.state = 'RIDE'; b.tState = t; }
    if (sm.H > R.maxH) R.maxH = sm.H;
    // barrel
    r.tube = false;
    if (tau > 0.35 && tau < 0.9) {
      const br = barrel(f, u, t);
      if (br && Math.hypot(x - br.x, y - br.y, z - br.z) < 1.6 * br.r + 0.4) {
        r.tube = true;
        R.barrelS += dt;
        if (!R.barrelSent) { R.barrelSent = true; this._emit({ t, type: 'barrel', riderId: r.id, frontId: R.frontId, zi: R.zi }); }
      }
    }
    // end of ride
    if (tau > TAU_CLOSE) { R.why = 'overtaken'; this._end(r, b, t, 'closeout'); return null; }
    if (r.state === 'RIDE') {
      R.why = t >= P.tEnd ? 'planned' : weak && e.d + R.dAdj <= dMin + 0.01 ? 'flat' : s >= wf.sEnd - 2.5 && (t > P.tR + 2 || e.dd > -0.5 * wf.vRef) ? 'peelEnd' : u <= 0.01 || u >= 0.99 ? 'edge'
        : f.x < 15 ? 'shore' : depthAt(x, z) < 0.35 ? 'shallow' : null;
      if (R.why) { this._end(r, b, t, 'kickout'); return null; }
    }
    return { x, y, z, act: e.act, actT: e.actT, seg: `r${R.id}:${P._a}`, carry: f.vx, n: { x: sm.nx, y: sm.ny, z: sm.nz },
      air: e.air, pitch: r.kind !== 'surfer' || e.air, bank: r.state === 'RIDE' && !e.air };
  }

  _end(r, b, t, outcome) {
    const R = b.ride;
    R.outcome = outcome; R.tEnd = t; R.t0 = t; R.s0 = R.s; R.sig0 = R.sigma; R.h0 = R.h;
    R.vS = clamp(R.vS, 0, 20);
    this._emit({ t, type: 'rideEnd', riderId: r.id, frontId: R.frontId, zi: R.zi, outcome });
    this.rides.push({
      ride: R.id, riderId: r.id, name: r.name, kind: r.kind, frontId: R.frontId, set: R.front.set, k: R.front.k,
      zi: R.zi, zone: R.zb.zone, style: R.style, slot: R.slot, tTakeoff: R.tTakeoff, tEnd: t, outcome,
      maxH: R.maxH, barrelS: R.barrelS, H: R.zb.H, tStand: R.plan ? R.plan.tR : null, why: R.why ?? 'front',
    });
    if (this.rides.length > 1000) this.rides.splice(0, this.rides.length - 1000);
    r.tube = false;
    this._setState(r, b, outcome === 'closeout' ? 'CLOSEOUT' : 'KICKOUT', t);   // cont: absorbs an animal's leap offset
  }

  // ------------------------------------------------------------------ KICKOUT
  _kickout(r, b, t, swell) {
    const R = b.ride, f = R.front;
    const p = (t - R.t0) / KO_T;
    if (p >= 1 || !swell.fronts.includes(f)) { this._toReturn(r, b, t, r.pos); return null; }
    // the rider stops being carried (velocity decays over ~0.3 s) and the wave passes beneath: ride up over
    // the top of it with a hop, landing on its back
    if (!R.ko) R.ko = { x: r.pos.x, z: r.pos.z, vx: b.lastV.x, vz: b.lastV.z };
    const k = 0.3 * (1 - Math.exp(-(t - R.t0) / 0.3));
    const x = R.ko.x + R.ko.vx * k, z = R.ko.z + R.ko.vz * k;
    const u = clamp(zToU(z), 0.001, 0.999);
    const cs = columnState(f, u, t, CS);
    crossings(cs, f.x - x, 0, 1, CR);
    let top = -Infinity;
    for (const y of CR) if (y > top) top = y;
    if (top === -Infinity) top = 0;
    const y = top + ambientHeight(x, z, t, this.cfg?.ambient) + HOP[r.kind] * Math.sin(Math.PI * p) ** 2;   // eases in and out
    r.u = u; r.sigma = SIG_BACK;
    return { x, y, z, act: r.kind === 'surfer' ? 'kickout' : 'jump', actT: p, carry: 0, n: null, air: p > 0.03, pitch: true };
  }

  // ------------------------------------------------------------------ CLOSEOUT
  _closeout(r, b, t, dt, swell) {
    const R = b.ride, f = R.front;
    const el = t - R.t0, act = r.kind === 'surfer' ? 'wipe' : 'dive', actT = clamp(el / CO_T, 0, 1);
    if (el >= CO_T) { this._toReturn(r, b, t, r.pos); return null; }
    if (el < CO_ATTACH && swell.fronts.includes(f)) {
      const pA = el / CO_ATTACH;
      const s = R.s0 + R.vS * el * 0.5;
      const u = clamp(uOfS(R.wf, s), 0.001, 0.999);
      const sm = sampleFront(f, u, sigmaOfH(R.h0 * (1 - pA)), t);
      r.u = u;
      R.cv = { x: f.vx * 0.8, z: R.wf.rd * R.vS * 0.3 };
      b.wx = sm.x; b.wz = sm.z;
      return { x: sm.x, y: sm.y - 0.9 * smooth(pA), z: sm.z, act, actT, carry: f.vx,
        n: { x: sm.nx, y: sm.ny, z: sm.nz }, air: false, pitch: true };
    }
    // tumbling free: carried shoreward by the bore, slowing; surfacing
    if (!R.cv) R.cv = { x: 0, z: 0 };
    b.wx += R.cv.x * dt; b.wz += R.cv.z * dt;
    const k = Math.exp(-dt / 0.5); R.cv.x *= k; R.cv.z *= k;
    const pB = (el - CO_ATTACH) / (CO_T - CO_ATTACH);
    return { x: b.wx, y: this._surf(swell, b.wx, b.wz, t) - 0.9 * (1 - smooth(pB)), z: b.wz, act, actT,
      carry: 0, n: null, pitch: true };
  }

  // ------------------------------------------------------------------ RETURN
  _toReturn(r, b, t, pos) {
    if (pos) { b.wx = pos.x; b.wz = pos.z; }
    if (b.leaving) {                                   // asked to leave during the ride: now head out of the scene
      this._startLeave(r, b, t, this.entryMeasures * (this._beat?.measureLen ?? 2));
      return;
    }
    b.homeZi = pickHome(r, b, b.wx, b.wz, this._inWater());
    b.ride = null;
    r.frontId = null; r.zi = -1; r.style = null; r.tube = false;
    this._setState(r, b, 'RETURN', t);
  }

  _return(r, b, t, dt, swell) {
    const h = b.homes[b.homeZi];
    const dx = h.x - b.wx, dz = h.z - b.wz, dist = Math.hypot(dx, dz);
    const el = t - b.tState;
    if (dist < 0.6) {
      b.coolUntil = t + KINDS[r.kind].cool; b.idle = null; b.restAt = restAt(r.id, t, this.cfg?.seed ?? 1);
      this._setState(r, b, 'LINEUP', t);
      return null;
    }
    const v = KINDS[r.kind].vRet * Math.min(1, 0.3 + el) * Math.min(1, 0.4 + dist / 4);
    this._steer(r, b, (dx / dist) * Math.min(v, dist / dt), (dz / dist) * Math.min(v, dist / dt), dt);
    r.u = zToU(b.wz);
    let off = 0, act = 'paddle', actT = (el / 1.1) % 1, air = false;
    if (r.kind === 'dolphin') {                       // porpoising: a low leap every 1.6 s
      const c = (el % 1.6) / 1.6;
      if (c < 0.45) { act = 'jump'; actT = c / 0.45; off = -0.4 + 1.7 * clamp((dist - 2) / 4, 0, 1) * Math.sin(Math.PI * actT) ** 2; air = off > 0; }
      else { act = 'swim'; actT = c; off = -0.4; }
    } else if (r.kind === 'seal' || r.kind === 'turtle') { act = 'swim'; off = SWIM_OFF[r.kind]; }
    return { x: b.wx, y: this._surf(swell, b.wx, b.wz, t) + off, z: b.wz, act, actT, carry: 0, n: null, air,
      pitch: r.kind === 'dolphin' };
  }
}

const CS = {}, LQ = {}, PT = {}, EP = {}, IDLE = {}, CR = [];
