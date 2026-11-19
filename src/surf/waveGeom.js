// CPU mirror of the breaker geometry (glsl/breaker.js) for one event: where the crest, the face and
// the trough of the analytic profile are at (x, t). Used to PLAN the board's path on the wave (which
// part of the face to be on); the board's actual height and attitude come from the GPU probe of the
// rendered surface (SurfProbe.js), which also contains the wind sea, the shallow-water residual and
// the other events.
import { brkTiming } from '../core/schedule.js';
import { brkStageJS } from '../glsl/breaker.js';

const HREF = 0.45;
const BRK_TEND = 0.85, BRK_HOLD = 0.5, BRK_HOLD_R = 0.15;
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
// GLSL smoothstep (also for edge0 > edge1, as the shaders use it)
const sstep = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/** Slice of event e at x: brkTiming plus the per-slice values brkAt() derives. smooth: without the
 *  0.45 m closing staircase (the planned path must not follow it; the probe gives the real surface). */
export function slice(e, x, smooth = false) {
  const b = brkTiming(e, x);
  if (smooth) { b.ti -= b.stair; b.D = Math.max(b.D - b.stair, 0); }
  b.s = b.H / HREF;
  b.hold = BRK_HOLD * (1 - sstep(0.3, 0.5, e.style));
  return b;
}
/** brkTnLip: normalised stage time of the thrown lip / approach */
export function tnLip(b, t) {
  const Dn = b.D / b.rs;
  const a = (t - b.ti) / b.rs + Dn;
  const Ts = -0.47 - 0.6 * Dn;
  return a - Dn * sstep(Ts, Ts + Math.max(1.6 * Dn, 1e-3), a);
}
/** brkTn: the heightfield's stage clock (a spilling crest holds after the impact) */
export function tnOf(b, t) {
  const tn = tnLip(b, t);
  if (!(tn >= 0 && b.hold > 1e-9)) return tn;
  const a = 0.6 * b.hold, w = Math.max(0.8 * b.hold, 1e-4);
  const u = clamp((tn - a) / w, 0, 1);
  const I = w * u * u * u * (1 - 0.5 * u) + Math.max(tn - a - w, 0);
  return BRK_HOLD_R * tn + (1 - BRK_HOLD_R) * I;
}
/** brkArrival: the smooth arrival clock (no staircase, no stand) */
export const arrival = (b, t) => (t - b.ti + b.D) / b.rs;

function fcos(u) { u = clamp(u, 0, 1); return 0.5 + 0.5 * Math.cos(Math.PI * u); }
function fsteep(u, uw, hw, m, p) {
  u = clamp(u, 0, 1);
  if (u < uw) { const r = u / uw; return hw + (1 - hw) * Math.pow(Math.max(1 - Math.pow(r, p), 1e-5), 1 / p); }
  return hw * Math.pow(Math.max((1 - u) / (1 - uw), 0), m);
}
/** front-face position xi (normalised by s) where the face is at height fraction h (1 crest, 0 trough) */
export function frontXi(g, h) {
  let lo = 0, hi = 1;
  for (let k = 0; k < 20; k++) {
    const u = 0.5 * (lo + hi);
    const F = fcos(u) * (1 - g.st) + fsteep(u, g.uw, g.hw, g.m, g.p) * g.st;
    if (F > h) lo = u; else hi = u;
  }
  return 0.5 * (lo + hi) * g.lf;
}

function frontXiInv(g, u) {   // height fraction lost at front-face fraction u (0 apex .. 1 toe)
  return 1 - (fcos(u) * (1 - g.st) + fsteep(u, g.uw, g.hw, g.m, g.p) * g.st);
}

/** Wave geometry of event e at (x, t): stage, apex, crest / trough heights and the z of face
 *  position h (1 apex, 0 toe; h < 0: that many front-face lengths beyond the toe, in the trough). */
export function waveAt(e, x, t, smooth = false) {
  const b = slice(e, x, smooth);
  const tn = tnOf(b, t);
  const g = brkStageJS(Math.max(tn, -6.0));
  const k = b.s * (1 - sstep(-0.8, -2.0, tn)) + b.rs * sstep(-0.8, -2.0, tn);
  const amp = (1 - sstep(0.6, BRK_TEND, tn)) * (e.strength ?? 1);
  const A = [b.zI + g.za * k, g.ya * b.s * amp];
  return {
    b, tn, g, amp, apexZ: A[0], crestY: A[1], troughY: g.yt * b.s * amp,
    // position across the face, linear from the apex (h = 1) to the toe (h = 0) and beyond (h < 0, in
    // the trough). (Not the height fraction: the profile flattens at the toe and the crest, where z
    // would run off to the ends of the face for a small change of height.)
    faceZ(h) { return A[0] + (1 - h) * g.lf * b.s; },
    heightFrac(h) { return h >= 1 ? 1 : h <= 0 ? 0 : 1 - frontXiInv(g, 1 - h); },
  };
}

/** A copy of event e for path planning: the bounded along-crest detail (timing wobble, landing-line
 *  waviness and height variation at 1-6 m scales) removed; the peel and its slow modulation kept. */
export function planningEvent(e) { return { ...e, wobble: 0, waviness: 0, hvar: 0 }; }

/** x where event e's arrival clock reads `target` at time t (Newton on the smooth arrival clock). */
export function xAtArrival(e, t, target, guess) {
  const k = e.aR1 || 1e-3;   // linear peel slowness (s/m)
  let x = guess ?? (t - e.t0 - target * Math.sqrt(e.H / HREF)) / k;
  for (let i = 0; i < 6; i++) {
    const f = arrival(slice(e, x), t) - target;
    const h = 0.05;
    const df = (arrival(slice(e, x + h), t) - arrival(slice(e, x - h), t)) / (2 * h);
    if (Math.abs(df) < 1e-6) break;
    const step = clamp(f / df, -20, 20);
    x -= step;
    if (Math.abs(step) < 1e-5) break;
  }
  return x;
}
