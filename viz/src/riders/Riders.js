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
// Determinism: fixed steps, state = f(cfg, swell history); seeded by hash01/mulberry32; no Math.random.
// Every RideEvent is a fresh object (the camera rig de-duplicates by identity). frontId / zi stay set from
// POSITION until the rider starts RETURN.
import { RIDERS, ZONES, DT, FRONT_W, uToZ, zToU, hash01, breakStartTime, ambientHeight } from '../contracts.js';
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
const TRAIL_EVERY = 2, TRAIL_DT = TRAIL_EVERY * DT, TRAIL_N = 128;   // position trail for wakes (≈ 2.1 s)         // s, transition smoothing of the position
const TAU_CLOSE = 0.85;      // the break overtook the rider
const HOP = { surfer: 0.7, dolphin: 2.0, seal: 0.8 };
const ACC = { surfer: 4, dolphin: 14, seal: 7 };          // m/s², paddling / swimming acceleration

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
    this.riders = RIDERS.map((R) => {
      const zi = ZONES.findIndex((Z) => Z.key === R.zones[0]);
      const h = homes[R.id][zi];
      const r = {
        id: R.id, kind: R.kind, name: R.name, color: R.color, zones: R.zones.slice(),
        state: 'LINEUP', style: null, action: 'idle', actionT: 0,
        pos: { x: h.x, y: ambientHeight(h.x, h.z, 0), z: h.z }, fwd: { x: 1, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 },
        speed: 0, frontId: null, zi: -1, u: zToU(h.z), sigma: 0, tube: false,
        prevAction: 'idle', prevActionT: 0, actionStart: 0,
        trail: { dt: TRAIL_DT, n: TRAIL_N, count: 0, head: -1, t: 0, xyz: new Float32Array(TRAIL_N * 3) },
      };
      this._b.push({
        homes: homes[R.id], homeZi: zi, coolUntil: 0, idle: null, idleN: 0, wx: h.x, wz: h.z,
        ride: null, tState: 0, seg: null, mv: { x: 0, z: 0 }, lastV: { x: 0, y: 0, z: 0 }, err: { x: 0, y: 0, z: 0 }, cont: false, prev: null, vs: { x: 0, y: 0, z: 0 }, lean: 0,
      });
      return r;
    });
  }

  // ------------------------------------------------------------------ step
  step(t, dt, swell) {
    this.t = t;
    const seed = this.cfg?.seed ?? 1;
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
      [tier1, tier2, tier3][tier - 1].push({ r, b, opt, w: fit(r.kind, zb) * opt.reach });
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
    }
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

  // ------------------------------------------------------------------ LINEUP
  _lineup(r, b, t, swell, seed) {
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
    const off = r.kind === 'dolphin' ? -0.4 : r.kind === 'seal' ? -0.15 : 0;
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
    b.homeZi = pickHome(r, b, b.wx, b.wz, this.riders.map((rr, i) => ({ r: rr, b: this._b[i] })));
    b.ride = null;
    r.frontId = null; r.zi = -1; r.style = null; r.tube = false;
    this._setState(r, b, 'RETURN', t);
  }

  _return(r, b, t, dt, swell) {
    const h = b.homes[b.homeZi];
    const dx = h.x - b.wx, dz = h.z - b.wz, dist = Math.hypot(dx, dz);
    const el = t - b.tState;
    if (dist < 0.6) {
      b.coolUntil = t + KINDS[r.kind].cool; b.idle = null;
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
    } else if (r.kind === 'seal') { act = 'swim'; off = -0.15; }
    return { x: b.wx, y: this._surf(swell, b.wx, b.wz, t) + off, z: b.wz, act, actT, carry: 0, n: null, air,
      pitch: r.kind === 'dolphin' };
  }
}

const CS = {}, LQ = {}, PT = {}, EP = {}, IDLE = {}, CR = [];
