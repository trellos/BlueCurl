// BlueCurl Swell — ride planner (WP6a). Pure JS, no three.js. Contract: src/contracts.js "riders".
//
// A ride is planned in WAVE coordinates relative to one committed ZoneBreak zb, ridden in direction rd (±1 along u):
//   s  = (u − uPeak)·FRONT_W·rd           metres from the peak along the peel direction
//   sc = vRef·(t − tBreak)                the linear curl reference (vRef = vPeel; 0 for a close-out)
//   d  = s − sc                           lead ahead of the curl (m); a target phase τ maps to d = −τ·L, L = vPeel·Tb
//   h  ∈ [0,1]                            height on the face: 0 trough … 1 just over the lip line (σ = sigmaOfH(h))
// d(t) and h(t) are seeded cubic Hermite keyframes (Catmull-Rom tangents, flat h at turn apexes), adapted from the
// spike's src/surf/SurfDemo.js CYCLE planner. Action cues (action/actionT for WP6b) are intervals after each knot.
// Animals add a vertical offset: submerged swimming (−depth) and leaps (arcs) — `off(t)`.
import { FRONT_W, breakStartTime, mulberry32, zToU } from '../contracts.js';
import { columnState, evalLocal, ambientGrad } from '../wave/field.js';
import { profileExtents } from '../wave/profile.js';

export const SIG_TOP = 0.40;     // h = 1: just seaward of the lip landmark (σ_lip ≈ 0.463), top of the face
export const SIG_BOT = 0.78;     // h = 0: the trough (σ_trough ≈ 0.80)
export const SIG_BACK = 0.12;    // the back of the wave (kick-out lands here)
export const H_TOE = 0.12;       // the toe of the face: a rider is "caught" when it reaches them
export const sigmaOfH = (h) => SIG_BOT - (SIG_BOT - SIG_TOP) * h;
export const hOfSigma = (s) => (SIG_BOT - s) / (SIG_BOT - SIG_TOP);

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Per-kind takeoff dynamics. glide: max along-crest speed on the face while late (m/s); back: how fast a standing
 *  rider can work back toward the curl (relative to the peel); paddle: paddle-in on the face after the catch (s),
 *  then popDur to stand (≤ ~1 s from the catch to standing); depth: how deep an animal swims inside the face. */
export const KIND_PLAN = {
  surfer:  { glide: 9,  back: 6,  paddle: 0.5,  tauPop: -0.35, popDur: 0.45, depth: 0 },
  dolphin: { glide: 16, back: 10, paddle: 0.35, tauPop: -0.30, popDur: 0.35, depth: 0.45 },
  seal:    { glide: 8,  back: 5,  paddle: 0.45, tauPop: -0.30, popDur: 0.40, depth: 0.2 },
};

/** Planned ride length (s after the pop): [base, jitter]. Long on purpose: the peel end normally ends the ride. */
const RIDE_LEN = { cruise: [13, 1.5], carve: [14, 1.5], tube: [14, 1], porpoise: [12, 1.5], breach: [12, 1.5] };

// ------------------------------------------------------------------ wave frame
/** Wave frame of a ZoneBreak ridden in direction rd. sEnd = where the ride must be over (peel end / zone edge). */
export function waveFrame(zb, rd) {
  const vRef = zb.closeout ? 0 : zb.vPeel;
  const L = (zb.closeout ? 8 : zb.vPeel) * zb.Tb;
  const sEdge = ((rd > 0 ? zb.u1 : zb.u0) - zb.uPeak) * FRONT_W * rd;
  const sStart = ((rd > 0 ? zb.u0 : zb.u1) - zb.uPeak) * FRONT_W * rd;     // negative: zone edge behind the peak
  return { zb, rd, vRef, L, sEdge, sStart, sEnd: zb.closeout ? sEdge : Math.min(zb.peelLen, sEdge) };
}
export const uOfS = (wf, s) => wf.zb.uPeak + (wf.rd * s) / FRONT_W;
export const sOfU = (wf, u) => (u - wf.zb.uPeak) * FRONT_W * wf.rd;
export const curlS = (wf, t) => wf.vRef * (t - wf.zb.tBreak);
/** Break phase of the ridden zone at crest distance s (−Infinity where this zone never breaks). */
export const tauAt = (wf, s, t) => (t - breakStartTime(wf.zb, uOfS(wf, s))) / wf.zb.Tb;

// ------------------------------------------------------------------ style
/** Ride style from the wave (and the rider's kind). */
export function chooseStyle(kind, zb) {
  if (kind === 'seal') return 'breach';
  const bt = zb.closeout ? 0 : zb.quality?.barrelTime ?? 0;
  if (kind === 'dolphin') return zb.curl >= 0.5 && bt >= 0.5 ? 'tube' : 'porpoise';
  if (zb.curl >= 0.5 && bt >= 0.5) return 'tube';            // field.barrel() needs curl ≳ 0.5 for a real tube
  if (zb.steep >= 0.6 && zb.H >= 0.8) return 'carve';
  return 'cruise';
}

// ------------------------------------------------------------------ plan
/**
 * Build a ride plan from the catch (the moment the face reaches the rider).
 * @param {object} o  { wf, kind, style, seed, tC, sC, hC, tauBias=0 }
 * @returns plan { knots[{t,d,h,flat}], acts[{t0,t1,act}], arcs[{t0,t1,hgt}], depth, tPop, tR, tEnd, tube:{t0,t1}|null }
 */
export function buildPlan({ wf, kind, style, seed, tC, sC, hC, tauBias = 0 }) {
  const rng = mulberry32(seed >>> 0);
  const j = (a) => a * (2 * rng() - 1);
  const K = KIND_PLAN[kind] ?? KIND_PLAN.surfer;
  const { L, vRef, zb } = wf;
  const surfer = kind === 'surfer';
  const knots = [], acts = [], arcs = [];
  const dC = sC - curlS(wf, tC);
  knots.push({ t: tC, d: dC, h: hC, flat: false });

  // ---- takeoff: a short paddle-in on the face, then pop. A rider caught far down the line stands up anyway and
  // rides back toward the pocket (the approach below); one caught late races forward along the face.
  const T = K.paddle;
  let dPop;
  if (zb.closeout) dPop = dC - 1.5 * T;
  else {
    const want = -((style === 'tube' ? -0.15 : K.tauPop) + 0.5 * tauBias) * L;
    dPop = want < dC ? Math.max(want, dC - (vRef + K.back) * T) : Math.min(want, dC + (K.glide - vRef) * T);
  }
  const tPop = tC + T;
  knots.push({ t: tPop, d: dPop, h: 0.8, flat: true });
  acts.push({ t0: tC, t1: tPop, act: surfer ? 'paddle' : 'swim' });
  const tR = tPop + K.popDur;
  acts.push({ t0: tPop, t1: tR, act: surfer ? 'pop' : 'swim' });

  // ---- ride keyframes
  let tk = tR;
  const tEnd = tR + RIDE_LEN[style][0] + j(RIDE_LEN[style][1]);
  // forward speed relative to the curl is limited (a rider caught behind it needs time to get back ahead)
  const ddMax = Math.max(4, 0.5 * (zb.closeout ? 8 : vRef)) * (kind === 'dolphin' ? 1.6 : 1);
  const ddBack = (zb.closeout ? 5 : vRef) + K.back;          // working back toward the curl (beyond vRef: reversing)
  const add = (tau, h, act, dur, flat = false, fast = 1) => {
    const d = zb.closeout ? tau : -(tau + tauBias) * L, p = knots[knots.length - 1];
    const need = d > p.d ? (d - p.d) / (ddMax * fast) : (p.d - d) / (ddBack * fast);
    if (tk - p.t < need) { const sh = need - (tk - p.t); tk += sh; acts[acts.length - 1].t1 += sh; }
    knots.push({ t: tk, d, h: clamp(h, 0, 1), flat });
    acts.push({ t0: tk, t1: tk + dur, act });
    tk += dur;
  };
  const leap = (hgt) => { const k = knots[knots.length - 1]; arcs.push({ t0: k.t, t1: tk, hgt }); };
  let tube = null;
  // standing: approach segment (rides back to the pocket when caught far down the line, else a short trim)
  knots.push({ t: tR, d: dPop, h: 0.45, flat: false });
  acts.push({ t0: tR, t1: tR + 0.6, act: surfer ? (dPop > 0.9 * L ? 'cutback' : 'trim') : 'swim' });
  tk = tR + 0.6;

  if (zb.closeout) {
    // nothing to ride: drop and angle down the line until the bore catches up (CLOSEOUT ends it)
    let s = dPop;
    add(s, 0.3, surfer ? 'bottomTurn' : 'swim', 0.8);
    while (tk < tEnd + 2) { s += 5 + j(1); add(s, 0.2 + j(0.08), surfer ? 'trim' : 'swim', 1.0 + j(0.2)); }
  } else if (style === 'cruise') {
    add(-0.35 + j(0.05), 0.22, 'bottomTurn', 1.0 + j(0.1), true);
    while (tk < tEnd + 2) {
      add(-0.45 + j(0.06), 0.66 + j(0.06), 'trim', 1.5 + j(0.3), true);
      add(-0.55 + j(0.06), 0.38 + j(0.06), 'trim', 1.5 + j(0.3), true);
    }
  } else if (style === 'carve') {
    while (tk < tEnd + 2) {
      add(-0.3 + j(0.05), 0.08, 'bottomTurn', 0.75 + j(0.1), true);
      add(-0.48 + j(0.05), 0.97, 'lipHit', 0.55 + j(0.08), true);
      add(-0.62 + j(0.05), 0.55 + j(0.05), 'cutback', 0.9 + j(0.1));
      add(-0.25 + j(0.04), 0.4, 'trim', 0.55 + j(0.08));
    }
  } else if (style === 'tube') {
    // squeeze the tube into what is left of the peel (the rider moves down the line at about vPeel)
    const hold = clamp(zb.quality?.barrelTime ?? 1, 0.8, 2.5);
    const left = (wf.sEnd - 4 - (curlS(wf, tR) + dPop)) / Math.max(1, vRef);
    const q = clamp((left - 0.3) / (3.8 + hold), 0.45, 1);
    const sw = (a) => (surfer ? a : 'swim');
    add(-0.08, 0.12, sw('bottomTurn'), 0.8 * q, true);
    add(0.22, 0.2, sw('crouch'), 1.0 * q, false, 2.5);
    const tIn = tk;
    add(0.52, 0.12, sw('crouch'), hold * q, true, 2.5);       // in the barrel (h low = the tube floor)
    add(0.5, 0.12, sw('crouch'), 1.1 * q, true);              // still inside, racing for the exit
    const tOut = tk;
    add(0.05, 0.35, surfer ? 'trim' : 'jump', 0.9 * q, false, 2.5);   // spat out
    if (!surfer) leap(1.6 + j(0.3));                          // dolphin: spat out with a leap
    tube = { t0: tIn - 0.5, t1: tOut + 0.4 };
    const carve = surfer && zb.steep >= 0.6;
    while (tk < tEnd + 2) {
      if (carve) {
        add(-0.3 + j(0.05), 0.08, 'bottomTurn', 0.75 + j(0.1), true);
        add(-0.5 + j(0.05), 0.95, 'lipHit', 0.55 + j(0.08), true);
        add(-0.65 + j(0.05), 0.55, 'cutback', 0.9 + j(0.1));
        add(-0.3, 0.4, 'trim', 0.55);
      } else if (surfer) {
        add(-0.45 + j(0.06), 0.62 + j(0.05), 'trim', 1.3 + j(0.2), true);
        add(-0.55 + j(0.06), 0.35 + j(0.05), 'trim', 1.3 + j(0.2), true);
      } else {
        add(-0.4 + j(0.06), 0.3, 'swim', 0.9 + j(0.15));
        add(-0.5 + j(0.06), 0.62, 'jump', 1.0 + j(0.15)); leap(1.4 + j(0.4));
      }
    }
  } else if (style === 'porpoise') {
    add(-0.3 + j(0.05), 0.2, 'swim', 0.8 + j(0.1));
    while (tk < tEnd + 2) {
      add(-0.48 + j(0.08), 0.62 + j(0.08), 'jump', 1.0 + j(0.15)); leap(1.3 + 0.25 * zb.H + j(0.3));
      add(-0.35 + j(0.08), 0.28 + j(0.08), 'swim', 0.9 + j(0.2));
      add(-0.55 + j(0.08), 0.5 + j(0.08), 'swim', 0.8 + j(0.2));
    }
  } else {                                                    // breach (seals): bodysurf low with breaches / rolls
    add(-0.3 + j(0.05), 0.18, 'swim', 1.0 + j(0.1));
    let n = 0;
    while (tk < tEnd + 2) {
      add(-0.42 + j(0.06), 0.3 + j(0.06), 'swim', 1.2 + j(0.25));
      if (n++ % 2 === 0) { add(-0.38 + j(0.05), 0.42, 'jump', 0.8 + j(0.1)); leap(0.9 + j(0.25)); }
      else add(-0.36 + j(0.05), 0.24, 'roll', 1.0 + j(0.1));
    }
  }
  knots.push({ t: tk, d: knots[knots.length - 1].d, h: knots[knots.length - 1].h, flat: true });
  return { knots, acts, arcs, depth: K.depth, tC, tPop, tR, tEnd, tube, style, _i: 0, _a: 0 };
}

// ------------------------------------------------------------------ evaluation
const herm = (p0, p1, m0, m1, T, u) => {
  const u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * p0 + (u3 - 2 * u2 + u) * m0 * T + (-2 * u3 + 3 * u2) * p1 + (u3 - u2) * m1 * T;
};
const dherm = (p0, p1, m0, m1, T, u) => {
  const u2 = u * u;
  return ((6 * u2 - 6 * u) * p0 + (3 * u2 - 4 * u + 1) * m0 * T + (-6 * u2 + 6 * u) * p1 + (3 * u2 - 2 * u) * m1 * T) / T;
};
function tangent(K, i, key) {
  const a = K[Math.max(0, i - 1)], c = K[Math.min(K.length - 1, i + 1)];
  if (key === 'h' && K[i].flat) return 0;
  return (c[key] - a[key]) / Math.max(1e-3, c.t - a.t);
}

/** Plan state at t: { d, dd (d'), h, act, actT, off } (off = vertical offset for animals: −depth … leaps). */
export function evalPlan(plan, t, out = {}) {
  const K = plan.knots, n = K.length;
  if (t <= K[0].t) { out.d = K[0].d; out.dd = 0; out.h = K[0].h; }
  else if (t >= K[n - 1].t) { out.d = K[n - 1].d; out.dd = 0; out.h = K[n - 1].h; }
  else {
    let i = Math.min(plan._i, n - 2);
    while (i > 0 && t < K[i].t) i--;
    while (i < n - 2 && t >= K[i + 1].t) i++;
    plan._i = i;
    const a = K[i], b = K[i + 1], T = b.t - a.t, u = (t - a.t) / T;
    const md0 = tangent(K, i, 'd'), md1 = tangent(K, i + 1, 'd');
    out.d = herm(a.d, b.d, md0, md1, T, u);
    out.dd = dherm(a.d, b.d, md0, md1, T, u);
    out.h = clamp(herm(a.h, b.h, tangent(K, i, 'h'), tangent(K, i + 1, 'h'), T, u), 0, 1);
  }
  // action cue
  const A = plan.acts;
  let k = Math.min(plan._a, A.length - 1);
  while (k > 0 && t < A[k].t0) k--;
  while (k < A.length - 1 && t >= A[k].t1) k++;
  plan._a = k;
  const ac = A[k];
  out.act = ac.act;
  out.actT = clamp((t - ac.t0) / Math.max(1e-6, ac.t1 - ac.t0), 0, 1);
  // vertical offset (animals): submerged, leaping on arcs (continuous at the arc ends)
  let off = -plan.depth;
  for (const r of plan.arcs) {
    if (t > r.t0 && t < r.t1) { const p = (t - r.t0) / (r.t1 - r.t0); off = -plan.depth + (r.hgt + plan.depth) * Math.sin(Math.PI * p) ** 2; break; }
  }
  out.off = off;
  out.air = off > 0.05;
  return out;
}

// ------------------------------------------------------------------ cheap sea surface
const SCS = {}, SLQ = {}, SAG = new Float64Array(4);
const SEA_N = 32;
/**
 * Same as field.surfaceHeight (ambient + the highest front's LOWEST crossing at x) with a coarse scan
 * (SEA_N brackets + bisection instead of field's 4·NPTS scan): ~8× cheaper, for bobbing riders every step.
 */
export function seaLevel(fronts, x, z, t) {
  const u = zToU(z);
  let best = -Infinity;
  if (u >= 0 && u <= 1) {
    for (const f of fronts) {
      const cs = columnState(f, u, t, SCS);
      const e = profileExtents(cs.H), xiT = f.x - x;
      if (!(xiT > e.back && xiT < e.front)) continue;
      let lo = Infinity, sa = 0, fa = evalLocal(cs, 0, SLQ).xi - xiT;
      for (let j = 1; j <= SEA_N; j++) {
        const sb = j / SEA_N, fb = evalLocal(cs, sb, SLQ).xi - xiT;
        if ((fa <= 0) !== (fb <= 0)) {
          let a = sa, b = sb, fA = fa;
          for (let it = 0; it < 14; it++) {
            const m = 0.5 * (a + b), fm = evalLocal(cs, m, SLQ).xi - xiT;
            if ((fA <= 0) === (fm <= 0)) { a = m; fA = fm; } else b = m;
          }
          const y = evalLocal(cs, 0.5 * (a + b), SLQ).y;
          if (y < lo) lo = y;
        }
        sa = sb; fa = fb;
      }
      if (lo < Infinity && lo > best) best = lo;
    }
  }
  return ambientGrad(x, z, t, undefined, SAG)[0] + (best > -Infinity ? best : 0);
}
