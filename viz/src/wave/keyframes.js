// BlueCurl Swell — wave cross-section keyframes (WP4a). Plain ES module, no three.js import.
//
// Each key is an authored 2D curve in NORMALISED units (multiples of the column height H):
//   x = xi / H  (xi > 0 shoreward, world -X), y = height / H. Core extent x ∈ [-CORE_BACK, +CORE_FRONT].
// The curve runs from the seaward back (A) over the crest (B) to the lip tip (C), back along the lip
// underside and down the face / tube wall to the trough (D) and out to the shoreward end (E).
// Overhang is allowed (x non-monotonic between C and D). Both ends are flat runs at y = 0.
//
// Every key is resampled to NPTS points with a FIXED number of points per landmark segment
// (A→B, B→C, C→D, D→E), equal arc length inside each segment. Point i of every key and every family
// therefore describes the same feature (crest, lip tip, tube wall …) so keys blend point-wise, and the
// lip/tube segments get most of the points (the mesh is refined around the lip for free when sigma is
// sampled uniformly).
//
// Families (blended by shape, see profile.js): 0 WALL (curl 0, steep face, feathering lip),
// 1 PLUNGE (curl 1, thrown lip, round barrel), 2 SPILL (mush 1, soft rounded roller, no overhang).
//
// KEY_DATA layout (what the GPU sees, RGBA32F texture KEY_TEX_W × KEY_TEX_H, NearestFilter):
//   texel (i, fam * NKEY + k) = (x, y, thick, 0)   — i = point index, k = key index.
// thick = water-sheet thickness along the inward normal (normalised, capped at THICK_CAP).

export const NPTS = 96;
export const NKEY = 12;
export const NFAM = 3;
export const FAM_WALL = 0, FAM_PLUNGE = 1, FAM_SPILL = 2;
export const CORE_BACK = 6;    // normalised back extent  (x = -6)
export const CORE_FRONT = 5;   // normalised front extent (x = +5)
export const THICK_CAP = 2.5;  // normalised thickness cap

/** Break phase of each key. -1 approach swell · 0 peaking · steepen · throw start · throw · plunge ·
 *  tube hold · crash · foam nose · 1 collapse (whitewater bore) · re-form · 2 = swell again (identical to key 0). */
export const KEY_TAUS = [-1, 0, 0.12, 0.24, 0.36, 0.5, 0.66, 0.8, 0.88, 1.0, 1.5, 2.0];

/** Point indices of the landmarks A, B (crest), C (lip tip), D (trough), E. */
export const LANDMARKS = [0, 24, 44, 76, 95];
export const SIGMA_CREST = LANDMARKS[1] / (NPTS - 1);
export const SIGMA_LIP = LANDMARKS[2] / (NPTS - 1);
export const SIGMA_TROUGH = LANDMARKS[3] / (NPTS - 1);

export const KEY_TEX_W = NPTS;
export const KEY_TEX_H = NFAM * NKEY;

// ------------------------------------------------------------------ authored control points
// [x, y] or [x, y, 'B'|'C'|'D'] (A and E are the first and last points).
const BACK = [[-6, 0], [-5.5, 0], [-5, 0]];
const FRONT = [[4.2, 0], [4.6, 0], [5, 0]];
const key = (...mid) => [...BACK, ...mid, ...FRONT];

const SWELL = key(
  [-4.2, 0.03], [-3.2, 0.14], [-2.2, 0.36], [-1.2, 0.6], [-0.5, 0.71], [0, 0.73, 'B'], [0.45, 0.7],
  [0.9, 0.6, 'C'], [1.5, 0.38], [2.1, 0.14], [2.7, 0.0], [3.3, -0.05, 'D'], [3.8, -0.02]);
const PEAK = key(
  [-4.2, 0.04], [-3.2, 0.16], [-2.2, 0.4], [-1.2, 0.66], [-0.5, 0.8], [0, 0.85, 'B'], [0.35, 0.82],
  [0.7, 0.72, 'C'], [1.1, 0.45], [1.5, 0.16], [1.95, -0.06], [2.5, -0.13, 'D'], [3.2, -0.07], [3.8, -0.01]);
const STEEPEN = key(
  [-4.2, 0.05], [-3.2, 0.18], [-2.2, 0.43], [-1.2, 0.72], [-0.5, 0.9], [0.05, 0.96, 'B'], [0.4, 0.93],
  [0.65, 0.82, 'C'], [0.8, 0.6], [0.88, 0.36], [1.0, 0.12], [1.25, -0.08], [1.8, -0.2, 'D'], [2.6, -0.15],
  [3.5, -0.05]);
const COLLAPSE = key(
  [-4.2, 0.04], [-3.2, 0.12], [-2.2, 0.25], [-1.2, 0.38], [-0.3, 0.46], [0.5, 0.5, 'B'], [1.1, 0.47],
  [1.6, 0.4, 'C'], [2.1, 0.28], [2.5, 0.14], [2.9, 0.03], [3.3, -0.03, 'D'], [3.8, -0.01]);
const REFORM = key(
  [-4.2, 0.03], [-3.2, 0.12], [-2.2, 0.28], [-1.2, 0.45], [-0.4, 0.55], [0.2, 0.58, 'B'], [0.7, 0.55],
  [1.2, 0.46, 'C'], [1.8, 0.3], [2.4, 0.12], [3.0, 0.0], [3.5, -0.04, 'D'], [3.9, -0.01]);

const BACK_HI = [[-4.2, 0.05], [-3.2, 0.2], [-2.2, 0.46], [-1.2, 0.78], [-0.5, 0.96]];

const PLUNGE_KEYS = [
  SWELL, PEAK, STEEPEN,
  key(...BACK_HI, [0.05, 1.02, 'B'], [0.5, 1.0], [0.85, 0.9], [1.02, 0.76, 'C'], [0.86, 0.74], [0.62, 0.68],
    [0.5, 0.5], [0.5, 0.28], [0.6, 0.06], [0.85, -0.12], [1.4, -0.24, 'D'], [2.3, -0.18], [3.3, -0.07]),
  key(...BACK_HI, [0.05, 1.04, 'B'], [0.6, 1.06], [1.05, 0.98], [1.35, 0.82], [1.5, 0.62, 'C'], [1.38, 0.68],
    [1.15, 0.8], [0.85, 0.85], [0.58, 0.78], [0.4, 0.6], [0.32, 0.38], [0.36, 0.15], [0.52, -0.05],
    [0.85, -0.2], [1.45, -0.27, 'D'], [2.3, -0.2], [3.3, -0.08]),
  key(...BACK_HI, [0.1, 1.02, 'B'], [0.75, 1.05], [1.35, 0.95], [1.75, 0.7], [1.95, 0.38], [2.0, 0.08, 'C'],
    [1.9, 0.2], [1.75, 0.48], [1.5, 0.7], [1.15, 0.82], [0.8, 0.82], [0.5, 0.7], [0.3, 0.5], [0.24, 0.28],
    [0.3, 0.06], [0.5, -0.12], [0.95, -0.24], [1.6, -0.28, 'D'], [2.4, -0.22], [3.3, -0.1]),
  // hold: the tube stays wide open while the lip reaches the trough
  key(...BACK_HI, [0.12, 1.0, 'B'], [0.8, 1.03], [1.42, 0.92], [1.85, 0.66], [2.08, 0.34], [2.14, 0.04, 'C'],
    [2.03, 0.16], [1.88, 0.45], [1.62, 0.68], [1.25, 0.8], [0.88, 0.8], [0.56, 0.68], [0.36, 0.48], [0.3, 0.26],
    [0.36, 0.04], [0.56, -0.14], [1.0, -0.25], [1.7, -0.28, 'D'], [2.5, -0.22], [3.4, -0.1]),
  key([-4.2, 0.05], [-3.2, 0.18], [-2.2, 0.4], [-1.2, 0.66], [-0.4, 0.8], [0.2, 0.84, 'B'], [0.85, 0.85],
    [1.45, 0.72], [1.9, 0.45], [2.15, 0.15], [2.22, -0.04, 'C'], [2.1, 0.06], [1.92, 0.2], [1.68, 0.3],
    [1.42, 0.32], [1.22, 0.26], [1.1, 0.14], [1.12, 0.01], [1.3, -0.09], [1.7, -0.15], [2.0, -0.16, 'D'],
    [2.5, -0.11], [3.0, -0.02], [3.5, 0.02]),
  key([-4.2, 0.05], [-3.2, 0.17], [-2.2, 0.36], [-1.2, 0.56], [-0.4, 0.68], [0.3, 0.7, 'B'], [0.95, 0.68],
    [1.5, 0.58], [1.9, 0.44], [2.12, 0.28], [2.22, 0.18, 'C'], [2.14, 0.12], [1.92, 0.1], [1.62, 0.08], [1.38, 0.04],
    [1.3, -0.04], [1.45, -0.13], [1.85, -0.14], [2.3, -0.11], [2.8, -0.06], [3.3, -0.05, 'D'], [3.8, -0.02]),
  // ^ foam nose: the tube has flattened to a sliver under the lip; it slides out under the tip into the bore
  COLLAPSE, REFORM, SWELL,
];

const WALL_LATE = key(...BACK_HI, [0.05, 0.97, 'B'], [0.45, 0.96], [0.8, 0.88], [0.98, 0.74, 'C'], [0.9, 0.67],
  [0.84, 0.57], [0.84, 0.4], [0.87, 0.22], [0.96, 0.05], [1.15, -0.08], [1.7, -0.2, 'D'], [2.5, -0.14], [3.4, -0.05]);
const WALL_KEYS = [
  SWELL, PEAK, STEEPEN,
  key(...BACK_HI, [0.0, 1.02, 'B'], [0.35, 1.0], [0.58, 0.9, 'C'], [0.62, 0.72], [0.6, 0.5], [0.62, 0.28],
    [0.72, 0.06], [0.95, -0.12], [1.5, -0.24, 'D'], [2.4, -0.17], [3.4, -0.06]),
  key(...BACK_HI, [0.0, 1.03, 'B'], [0.4, 1.02], [0.68, 0.92], [0.78, 0.8, 'C'], [0.68, 0.76], [0.58, 0.64],
    [0.56, 0.45], [0.6, 0.24], [0.72, 0.04], [0.98, -0.14], [1.55, -0.25, 'D'], [2.4, -0.18], [3.4, -0.07]),
  WALL_LATE, WALL_LATE,
  key([-4.2, 0.05], [-3.2, 0.17], [-2.2, 0.38], [-1.2, 0.6], [-0.4, 0.76], [0.2, 0.82, 'B'], [0.7, 0.8],
    [1.18, 0.6, 'C'], [1.1, 0.53], [1.1, 0.42], [1.2, 0.26], [1.38, 0.1], [1.65, -0.02], [2.1, -0.12, 'D'], [2.8, -0.09], [3.6, -0.02]),
  key([-4.2, 0.05], [-3.2, 0.16], [-2.2, 0.34], [-1.2, 0.52], [-0.4, 0.62], [0.35, 0.66, 'B'], [0.95, 0.62],
    [1.4, 0.5, 'C'], [1.75, 0.34], [2.05, 0.18], [2.4, 0.04], [2.9, -0.07, 'D'], [3.6, -0.02]),
  COLLAPSE, REFORM, SWELL,
];

const BACK_SOFT = [[-4.2, 0.04], [-3.2, 0.16], [-2.2, 0.38], [-1.2, 0.64], [-0.4, 0.8]];
const SPILL_LATE = key(...BACK_SOFT, [0.35, 0.8, 'B'], [0.8, 0.79], [1.18, 0.7], [1.32, 0.6, 'C'], [1.29, 0.54],
  [1.33, 0.46], [1.62, 0.33], [2.0, 0.19], [2.45, 0.05], [3.0, -0.07, 'D'], [3.6, -0.03]);
const SPILL_KEYS = [
  SWELL,
  key([-4.2, 0.04], [-3.2, 0.15], [-2.2, 0.38], [-1.2, 0.63], [-0.5, 0.77], [0, 0.82, 'B'], [0.4, 0.79],
    [0.8, 0.7, 'C'], [1.25, 0.46], [1.7, 0.2], [2.2, 0.0], [2.8, -0.09, 'D'], [3.5, -0.04]),
  key(...BACK_SOFT, [0.1, 0.86, 'B'], [0.5, 0.82], [0.9, 0.7, 'C'], [1.3, 0.48], [1.75, 0.22], [2.2, 0.0],
    [2.8, -0.1, 'D'], [3.5, -0.05]),
  key(...BACK_SOFT, [0.15, 0.88, 'B'], [0.55, 0.87], [0.92, 0.79], [1.06, 0.7, 'C'], [1.03, 0.64], [1.08, 0.56], [1.35, 0.42], [1.72, 0.24], [2.15, 0.06],
    [2.8, -0.1, 'D'], [3.5, -0.05]),
  key(...BACK_SOFT, [0.25, 0.86, 'B'], [0.7, 0.85], [1.08, 0.76], [1.22, 0.66, 'C'], [1.19, 0.6], [1.23, 0.52], [1.5, 0.38], [1.88, 0.22], [2.3, 0.06],
    [2.9, -0.08, 'D'], [3.5, -0.04]),
  SPILL_LATE, SPILL_LATE,
  key([-4.2, 0.04], [-3.2, 0.14], [-2.2, 0.32], [-1.2, 0.52], [-0.4, 0.64], [0.45, 0.68, 'B'], [0.95, 0.66],
    [1.32, 0.58], [1.46, 0.49, 'C'], [1.43, 0.43], [1.48, 0.36], [1.8, 0.25], [2.2, 0.13], [2.65, 0.03], [3.2, -0.05, 'D'], [3.7, -0.02]),
  key([-4.2, 0.04], [-3.2, 0.13], [-2.2, 0.28], [-1.2, 0.45], [-0.4, 0.55], [0.5, 0.6, 'B'], [1.05, 0.57],
    [1.5, 0.48, 'C'], [1.95, 0.33], [2.4, 0.16], [2.85, 0.03], [3.3, -0.04, 'D'], [3.8, -0.01]),
  COLLAPSE, REFORM, SWELL,
];

// Plunge proportions: the throw/crash keys are authored generously and pulled in by a monotone x-warp around the
// tube wall, x' = x + (k-1)(x-c)·(1-s²)², s = (x-c)/L (compact: the flat ends stay put), so that at full curl the
// lip throws ≈ 1.1–1.4 H beyond the tube wall. Monotone in x (k ≥ 0.5) → no key can self-intersect from it.
export const PLUNGE_K = 0.4, PLUNGE_C = 0.3, PLUNGE_L = 3.6;
const plungeWarp = (k) => k.map((p) => {
  const s = (p[0] - PLUNGE_C) / PLUNGE_L, w = Math.abs(s) < 1 ? (1 - s * s) ** 2 : 0;
  return [p[0] + (PLUNGE_K - 1) * (p[0] - PLUNGE_C) * w, p[1], ...p.slice(2)];
});
for (let k = 3; k <= 8; k++) PLUNGE_KEYS[k] = plungeWarp(PLUNGE_KEYS[k]);

export const AUTHORED = [WALL_KEYS, PLUNGE_KEYS, SPILL_KEYS];

// ------------------------------------------------------------------ build: spline → landmark resample → thickness
function centripetal(p0, p1, p2, p3, n) {
  // centripetal Catmull-Rom segment p1→p2, n samples (excluding p2)
  const d = (a, b) => Math.max(1e-6, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])));
  const t0 = 0, t1 = t0 + d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3);
  const out = [];
  for (let s = 0; s < n; s++) {
    const t = t1 + (t2 - t1) * (s / n);
    const L = (pa, pb, ta, tb) => [
      ((tb - t) * pa[0] + (t - ta) * pb[0]) / (tb - ta), ((tb - t) * pa[1] + (t - ta) * pb[1]) / (tb - ta)];
    const A1 = L(p0, p1, t0, t1), A2 = L(p1, p2, t1, t2), A3 = L(p2, p3, t2, t3);
    const B1 = L(A1, A2, t0, t2), B2 = L(A2, A3, t1, t3);
    out.push(L(B1, B2, t1, t2));
  }
  return out;
}

function densify(ctrl, per = 32) {
  const P = ctrl.map((c) => [c[0], c[1]]);
  const n = P.length;
  const ext0 = [2 * P[0][0] - P[1][0], 2 * P[0][1] - P[1][1]];
  const extN = [2 * P[n - 1][0] - P[n - 2][0], 2 * P[n - 1][1] - P[n - 2][1]];
  const pts = [], lm = {};
  for (let j = 0; j < n - 1; j++) {
    if (ctrl[j][2]) lm[ctrl[j][2]] = pts.length;
    const seg = centripetal(j > 0 ? P[j - 1] : ext0, P[j], P[j + 1], j + 2 < n ? P[j + 2] : extN, per);
    for (const q of seg) pts.push(q);
  }
  pts.push(P[n - 1]);
  lm.A = 0; lm.E = pts.length - 1;
  return { pts, lm };
}

function resampleSegment(pts, i0, i1, count) {
  // returns count+1 points (both ends) equally spaced in arc length along pts[i0..i1]
  const cum = [0];
  for (let i = i0 + 1; i <= i1; i++) cum.push(cum[cum.length - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = cum[cum.length - 1], out = [];
  let j = 0;
  for (let s = 0; s <= count; s++) {
    const target = (total * s) / count;
    while (j < cum.length - 2 && cum[j + 1] < target) j++;
    const f = cum[j + 1] > cum[j] ? Math.min(1, Math.max(0, (target - cum[j]) / (cum[j + 1] - cum[j]))) : 0;
    const a = pts[i0 + j], b = pts[i0 + j + 1];
    out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
  }
  return out;
}

function resampleKey(ctrl) {
  const { pts, lm } = densify(ctrl);
  const names = ['A', 'B', 'C', 'D', 'E'];
  for (const k of names) if (lm[k] === undefined) throw new Error('keyframes: missing landmark ' + k);
  const out = [];
  for (let s = 0; s < 4; s++) {
    const seg = resampleSegment(pts, lm[names[s]], lm[names[s + 1]], LANDMARKS[s + 1] - LANDMARKS[s]);
    if (s > 0) seg.shift();
    out.push(...seg);
  }
  // exact flat ends (y = 0 for the two outermost points → zero end slope in the evaluator)
  out[0][1] = 0; out[1][1] = 0; out[NPTS - 1][1] = 0; out[NPTS - 2][1] = 0;
  return out;
}

function raySeg(ox, oy, dx, dy, ax, ay, bx, by) {
  const ex = bx - ax, ey = by - ay, den = dx * ey - dy * ex;
  if (Math.abs(den) < 1e-12) return Infinity;
  const wx = ax - ox, wy = ay - oy;
  const t = (wx * ey - wy * ex) / den, s = (wx * dy - wy * dx) / den;
  return t > 1e-5 && s >= 0 && s <= 1 ? t : Infinity;
}

function thickness(P) {
  const n = P.length, out = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)];
    let tx = b[0] - a[0], ty = b[1] - a[1];
    const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
    const nx = ty, ny = -tx;                     // inward (into the water)
    let best = THICK_CAP;
    for (let j = 0; j < n - 1; j++) {
      if (j >= i - 2 && j <= i + 1) continue;
      const d = raySeg(P[i][0], P[i][1], nx, ny, P[j][0], P[j][1], P[j + 1][0], P[j + 1][1]);
      if (d < best) best = d;
    }
    out[i] = best;
  }
  return out;
}

/** Resampled keys: RESAMPLED[fam][k] = [[x,y], …] (NPTS points). */
export const RESAMPLED = AUTHORED.map((fam) => fam.map(resampleKey));

/** RGBA32F texture data (see layout above). */
export const KEY_DATA = (() => {
  const d = new Float32Array(KEY_TEX_W * KEY_TEX_H * 4);
  for (let f = 0; f < NFAM; f++) for (let k = 0; k < NKEY; k++) {
    const P = RESAMPLED[f][k], th = thickness(P), row = f * NKEY + k;
    for (let i = 0; i < NPTS; i++) {
      const o = (row * KEY_TEX_W + i) * 4;
      d[o] = P[i][0]; d[o + 1] = P[i][1]; d[o + 2] = th[i]; d[o + 3] = 0;
    }
  }
  return d;
})();
