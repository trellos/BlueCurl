// BlueCurl Swell — swept-profile cross-section evaluator (WP4a). Mirrored 1:1 in profile.glsl.js.
//
// profile(tau, sigma, H, shape={steep,curl,mush}) → { xi, y, dxi, dy, thick }   (metres)
//   tau   break phase (contracts.localTau): -1 approach swell → 0 peaking → throw/plunge → 1 collapse →
//         2 re-formed swell (== tau -1). Clamped to [-1, 2]. C1 in tau (non-uniform cubic Hermite over keys).
//   sigma ∈ [0,1] seaward back → crest → lip tip → lip underside / tube wall → trough → shoreward front.
//         C1 in sigma (uniform Catmull-Rom over the NPTS key points). sigma is lip-refined by construction:
//         sigma ∈ [0.25, 0.80] covers crest, lip and tube (see keyframes.LANDMARKS).
//   xi    > 0 shoreward (world -X). dxi, dy = d/dsigma. thick = water-sheet thickness (m) along the inward
//         normal, capped at THICK_CAP·H (lip translucency hint; approximate under the horizontal warps).
//
// Shape: families are blended point-wise: wPLUNGE = curl(1-mush)², wSPILL = mush, wWALL = 1 - wPLUNGE - wSPILL
//   (mush kills the curl faster than it softens, which keeps every blend free of self-intersection).
//   steep compresses (1) or widens (0) the crest/face horizontally around x = STEEP_C:
//   x' = x + (kS-1)(x-c)·exp(-((x-c)/R)²), kS = 1.3 - 0.55·steep (monotone, so no self-intersection).
//
// Extents (metres): core horizontal unit Sx = sqrt(H² + 1) (aspect-true for big waves, a wider lump for
//   small ones), plus cubic tails so that xi(sigma=0) = -(18 + 4.5H) and xi(sigma=1) = 12 + 3.8H while that
//   exceeds the core (always for H ≤ 10 m).  H = 0.3: -19.4 … +13.1;  H = 1: -22.5 … +15.8;
//   H = 3: -31.5 … +23.4;  H = 6: -45 … +34.8.  Both ends: y = 0, dy/dsigma = 0.
//   W(x) = Sx·x - Bb·(-x/6)³ (x<0) | Sx·x + Bf·(x/5)³ (x≥0), Bb = max(0, back - 6Sx), Bf = max(0, front - 5Sx).

import { NPTS, NKEY, KEY_TAUS, KEY_DATA, KEY_TEX_W, CORE_BACK, CORE_FRONT, THICK_CAP } from './keyframes.js';

export const STEEP_C = 0.6, STEEP_R = 1.6;
export const extentBack = (H) => 18 + 4.5 * H;
export const extentFront = (H) => 12 + 3.8 * H;
export const coreScale = (H) => Math.sqrt(H * H + 1);

/** World xi of the two profile ends for column height H: { back (negative), front }. */
export function profileExtents(H) {
  const Sx = coreScale(H);
  const Bb = Math.max(0, extentBack(H) - Sx * CORE_BACK), Bf = Math.max(0, extentFront(H) - Sx * CORE_FRONT);
  return { back: -Sx * CORE_BACK - Bb, front: Sx * CORE_FRONT + Bf };
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Scratch (single-threaded, reused): tau weights / key indices and sigma weights / point indices.
const TW = new Float64Array(4), TK = new Int32Array(4), SW = new Float64Array(4), SD = new Float64Array(4), SI = new Int32Array(4);

function tauWeights(tau) {
  tau = Math.min(2, Math.max(-1, tau));
  let k = 0;
  while (k < NKEY - 2 && tau >= KEY_TAUS[k + 1]) k++;
  const t0 = KEY_TAUS[k], t1 = KEY_TAUS[k + 1], h = t1 - t0;
  const s = (tau - t0) / h, s2 = s * s, s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
  const a = k > 0 ? (h10 * h) / (t1 - KEY_TAUS[k - 1]) : 0;
  const b = k + 1 < NKEY - 1 ? (h11 * h) / (KEY_TAUS[k + 2] - t0) : 0;
  TW[0] = -a; TW[1] = h00 - b; TW[2] = h01 + a; TW[3] = b;
  TK[0] = Math.max(0, k - 1); TK[1] = k; TK[2] = k + 1; TK[3] = Math.min(NKEY - 1, k + 2);
}

function sigmaWeights(sigma) {
  const f = clamp01(sigma) * (NPTS - 1);
  const i = Math.min(Math.floor(f), NPTS - 2), s = f - i, s2 = s * s, s3 = s2 * s;
  SW[0] = 0.5 * (-s3 + 2 * s2 - s); SW[1] = 0.5 * (3 * s3 - 5 * s2 + 2);
  SW[2] = 0.5 * (-3 * s3 + 4 * s2 + s); SW[3] = 0.5 * (s3 - s2);
  SD[0] = 0.5 * (-3 * s2 + 4 * s - 1); SD[1] = 0.5 * (9 * s2 - 10 * s); SD[2] = 0.5 * (-9 * s2 + 8 * s + 1); SD[3] = 0.5 * (3 * s2 - 2 * s);
  SI[0] = Math.max(0, i - 1); SI[1] = i; SI[2] = i + 1; SI[3] = Math.min(NPTS - 1, i + 2);
}

/**
 * Normalised (key-unit) blended point before the steep / world warps: writes
 * out[0..5] = x, y, dx/dsigma, dy/dsigma, thick (key units).
 */
export function profileKeyUnits(out, tau, sigma, curl, mush) {
  curl = clamp01(curl); mush = clamp01(mush);
  const wf1 = curl * (1 - mush) * (1 - mush), wf2 = mush, wf0 = 1 - wf1 - wf2;
  tauWeights(tau); sigmaWeights(sigma);
  let x = 0, y = 0, dx = 0, dy = 0, th = 0;
  for (let a = 0; a < 4; a++) {
    const wt = TW[a];
    if (wt === 0) continue;
    for (let b = 0; b < 4; b++) {
      const ws = wt * SW[b], wd = wt * SD[b];
      let px = 0, py = 0, pt = 0;
      for (let f = 0; f < 3; f++) {
        const wf = f === 0 ? wf0 : f === 1 ? wf1 : wf2;
        const o = ((f * NKEY + TK[a]) * KEY_TEX_W + SI[b]) * 4;
        px += wf * KEY_DATA[o]; py += wf * KEY_DATA[o + 1]; pt += wf * KEY_DATA[o + 2];
      }
      x += ws * px; y += ws * py; th += ws * pt; dx += wd * px; dy += wd * py;
    }
  }
  out[0] = x; out[1] = y; out[2] = dx * (NPTS - 1); out[3] = dy * (NPTS - 1); out[4] = th;
  return out;
}

const KU = new Float64Array(5);

/** Allocation-free core: writes out = { xi, y, dxi, dy, thick } and returns it. */
export function profileInto(out, tau, sigma, H, steep, curl, mush) {
  profileKeyUnits(KU, tau, sigma, curl, mush);
  // steep warp (key units)
  const kS = 1.3 - 0.55 * clamp01(steep);
  const v = (KU[0] - STEEP_C) / STEEP_R, e = Math.exp(-v * v);
  const xs = KU[0] + (kS - 1) * (KU[0] - STEEP_C) * e;
  const dS = 1 + (kS - 1) * e * (1 - 2 * v * v);
  // world warp
  const Hc = Math.max(0, H);
  const Sx = Math.sqrt(Hc * Hc + 1);
  let W, dW;
  if (xs < 0) {
    const Bb = Math.max(0, 18 + 4.5 * Hc - Sx * CORE_BACK), q = -xs / CORE_BACK;
    W = Sx * xs - Bb * q * q * q; dW = Sx + (3 * Bb * q * q) / CORE_BACK;
  } else {
    const Bf = Math.max(0, 12 + 3.8 * Hc - Sx * CORE_FRONT), q = xs / CORE_FRONT;
    W = Sx * xs + Bf * q * q * q; dW = Sx + (3 * Bf * q * q) / CORE_FRONT;
  }
  out.xi = W;
  out.y = Hc * KU[1];
  out.dxi = dW * dS * KU[2];
  out.dy = Hc * KU[3];
  out.thick = Hc * Math.min(THICK_CAP, Math.max(0, KU[4]));
  return out;
}

export function profile(tau, sigma, H, shape = {}) {
  return profileInto({ xi: 0, y: 0, dxi: 0, dy: 0, thick: 0 }, tau, sigma, H,
    shape.steep ?? 0.5, shape.curl ?? 0.5, shape.mush ?? 0);
}
