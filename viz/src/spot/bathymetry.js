// BlueCurl Swell — spot bathymetry (owner WP2).
// depthAt(x, z): metres below mean sea level (negative = land above water). Single source for sea floor
// AND land heights. BATHY_GLSL defines float bcDepth(vec2 xz), the same formula operation for operation
// (analytic: smooth blobs, capsules and smooth min/max, no textures). GPU parity: dev/spot.html?parity=1.
//
// Geometry is derived from contracts (ZONES break lines + crest ranges, FRONT_Z0); K = point line / 165 is
// the horizontal scale relative to the first layout (K = 0.6 now) and sizes widths, falloffs and smoothing.
// World: +X east/seaward, +Z north.
//   bay beach along x = xBay(z) ≈ 0 for z FRONT_Z0 … −20K, the coast curving east far south;
//   northern headland: land for x < xEast(z) (~0.63·pointX), z > zSouth(x) (~⅔ of the point's north end),
//     tip near (0.7·pointX, pointZ1 + 3); a low grassy point (~10 m) at the tip/south face rising to a
//     ~32 m bluff north-west (east cliff ~30 m); steep rock faces on the sea sides;
//   outer reef: superellipse around the outer line, ~4 m on it;  point shelf: flat-topped ridge along the
//   point line joined to the tip, ~2.2 m;  inside sandbar along the inside line, ~1 m;
//   open slope: ~10 m at the outer line, ~25 m by x ≈ 400, 90 m max.
import { ZONES, FRONT_Z0, uToZ } from '../contracts.js';

const zone = (key) => ZONES.find((z) => z.key === key);
const OUT = zone('outer'), PT = zone('point'), IN = zone('inside');
const K = PT.lineX / 165;
const zOut0 = uToZ(OUT.u0), zOut1 = uToZ(OUT.u1);
const zPt0 = uToZ(PT.u0), zPt1 = uToZ(PT.u1);
const zIn0 = uToZ(IN.u0), zIn1 = uToZ(IN.u1);

/** Derived layout constants (also exported for layout / tests). */
export const SPOT = {
  K,
  beachZ0: FRONT_Z0, beachZ1: -20 * K,
  beachMid: (FRONT_Z0 - 20 * K) / 2,
  headX: 0.63 * PT.lineX,                 // east face x (land x < ~0.66·pointX)
  headZ: (2 / 3) * zPt1,                  // south face z
  tipX: 0.7 * PT.lineX, tipZ: zPt1 + 3,   // tip of the point
  reefX: OUT.lineX - 3, reefZ: (zOut0 + zOut1) / 2, reefRx: 30, reefRz: 0.56 * (zOut1 - zOut0), reefTop: 4.0,
  shelfX: PT.lineX - 1, shelfZ0: zPt0 - 3, shelfZ1: zPt1 - 1, shelfTop: 2.2,
  barX0: IN.lineX + 1, barZ0: zIn0 + 2, barX1: IN.lineX + 2, barZ1: zIn1 - 2, barTop: 1.0,
  lowH: 10.0, highH: 32.0,
};
const S = SPOT;
const C = {
  // bay
  bA: 0.0012 * K / (K * K) * 0.367,         // curvature of the beach arc → x≈0 at both ends of the beach
  bOff: 0, bClampZ: 100 * K, bSouth: -300 * K, bSouthK: 60 * K, bSouthA: 0.0004 / K,
  bBumpZ: -1050 * K, bBumpW: 170 * K, bBumpA: 140 * K,
  // headland
  eTip: S.tipX - S.headX, eTipW: 22 * K, eRecZ: S.tipZ + 55 * K, eRecK: 25 * K,
  sWav: 3 * K, headK: 22 * K,
  rampZ0: 90 * K, rampZ1: 185 * K,
  // floors
  d0: 3.5, d0L: 20.0, d1: 0.02, d2: 0.00009,
  hillA: 60.0, hillU0: 70 * K, hillU1: 420 * K, hill2A: 14.0, hill2U0: 30 * K, hill2U1: 160 * K,
  reefC: 18.0, shelfFlat: 9 * K, shelfC: 0.0028 / (K * K), barFlat: 6 * K, barC: 0.004 / (K * K),
  platA: 0.06 / K, platB: 0.002 / (K * K),
};
// beach arc: xBay(beachZ0) = xBay(beachZ1) = 0 exactly
C.bOff = -0.00037 * (S.beachZ0 - S.beachMid) * (S.beachZ0 - S.beachMid);
C.bA = 0.00037;

const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const sstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const smin = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };
const smax = (a, b, k) => -smin(-a, -b, k);
const softplus = (a, k) => Math.max(a, 0) + k * Math.log(1 + Math.exp(-Math.abs(a) / k));
function segDist(px, pz, ax, az, bx, bz) {
  const abx = bx - ax, abz = bz - az;
  const h = clamp(((px - ax) * abx + (pz - az) * abz) / (abx * abx + abz * abz), 0, 1);
  const dx = px - ax - abx * h, dz = pz - az - abz * h;
  return Math.sqrt(dx * dx + dz * dz);
}

/** Bay shoreline x as a function of z (beach x≈0 along the bay, curving out east far south). */
export function xBay(z) {
  const zc = Math.min(z, C.bClampZ) - S.beachMid;
  const sp = softplus(-(z - C.bSouth), C.bSouthK);
  const q = (z - C.bBumpZ) / C.bBumpW;
  return C.bOff + C.bA * zc * zc + C.bSouthA * sp * sp + C.bBumpA * Math.exp(-(q * q));
}
/** Headland east face x(z), bulging out to the tip, receding north-west further north. */
export function xEast(z) {
  const q = (z - S.tipZ) / C.eTipW;
  return S.headX + C.eTip * Math.exp(-(q * q)) - 0.14 * softplus(z - C.eRecZ, C.eRecK) + 1.5 * Math.sin(z * (0.061 / K) + 0.4);
}
/** Headland south face z(x). */
export function zSouth(x) { return S.headZ + C.sWav * Math.sin(x * (0.083 / K) + 0.5); }
/** Signed distance-ish to the headland coastline, positive on land. */
export function headlandS(x, z) { return smin(xEast(z) - x, z - zSouth(x), C.headK); }
/** Headland plateau height (m): low point south/east, rising to a high bluff north-west. */
export function plateauH(x, z) {
  const tx = (x - S.tipX - 4 * K) / (60 * K), tz = (z - S.tipZ + 3 * K) / (45 * K);
  const tip = 3.0 * Math.exp(-(tx * tx + tz * tz));
  const w = sstep(C.rampZ0, C.rampZ1, z - 0.45 * x);
  const roll = 1.4 * Math.sin(x * (0.045 / K) + 0.7) * Math.sin(z * (0.038 / K) + 1.9) + 0.8 * Math.sin(x * (0.11 / K) - z * (0.07 / K));
  return S.lowH + (S.highH - S.lowH) * w - tip + roll;
}
/** Cliff profile 0..1 over the distance inland s (m): rock toe, near-vertical face, rounded lip. */
export function cliffF(s) { return 0.2 * sstep(0.0, 2.0, s) + 0.8 * sstep(1.5, 7.0, s); }

/** Open-water / bay depth by distance offshore xs (negative xs = land behind the beach). */
export function bayDepth(xs, z) {
  if (xs >= 0.0) return Math.min(C.d0 * (1.0 - Math.exp(-xs / C.d0L)) + C.d1 * xs + C.d2 * xs * xs, 90.0);
  const u = -xs;
  const hills = C.hillA * sstep(C.hillU0, C.hillU1, u) * (0.72 + 0.28 * Math.sin(z * (0.0061 / K) + 1.0))
    + C.hill2A * sstep(C.hill2U0, C.hill2U1, u) * (0.55 + 0.45 * Math.sin(z * (0.019 / K) + 0.3));
  return -(2.4 * (1.0 - Math.exp(-u / (22.0 * K))) + hills);
}
/** Outer reef depth (m), superellipse patch around the outer line. */
export function reefDepth(x, z) {
  const ex = (x - S.reefX) / S.reefRx, ez = (z - S.reefZ) / S.reefRz;
  const ex2 = ex * ex, ez2 = ez * ez;
  const r = Math.sqrt(Math.sqrt(ex2 * ex2 + ez2 * ez2));
  const m = Math.max(r - 0.85, 0.0);
  return S.reefTop + 0.22 * Math.sin(x * (0.13 / K) + z * (0.05 / K)) * Math.sin(z * (0.09 / K) - x * (0.04 / K)) + C.reefC * m * m;
}
/** Point shelf depth (m): flat-topped ridge along the point line joined to the headland tip. */
export function shelfDepth(x, z) {
  const d = Math.min(segDist(x, z, S.shelfX, S.shelfZ0, S.shelfX, S.shelfZ1), segDist(x, z, S.shelfX, S.shelfZ1, S.tipX + 2.0, S.tipZ + 1.0));
  const m = Math.max(d - C.shelfFlat, 0.0);
  return S.shelfTop + 0.2 * Math.sin(x * (0.21 / K) + 1.0) * Math.sin(z * (0.15 / K)) + C.shelfC * m * m;
}
/** Inside sandbar depth (m), ridge along the inside line. */
export function barDepth(x, z) {
  const d = segDist(x, z, S.barX0, S.barZ0, S.barX1, S.barZ1);
  const m = Math.max(d - C.barFlat, 0.0);
  return S.barTop + 0.1 * Math.sin(z * (0.05 / K)) + C.barC * m * m;
}
/** Rock platform around the headland base (m), from the headland distance s (< 0 at sea). */
export function platformDepth(s) { const o = Math.max(-s, 0.0); return 0.5 + C.platA * o + C.platB * o * o; }

/** All parts (for materials / debug); parts.depth === depthAt(x, z). */
export function bathyParts(x, z) {
  const xs = x - xBay(z);
  const bay = bayDepth(xs, z), reef = reefDepth(x, z), shelf = shelfDepth(x, z), bar = barDepth(x, z);
  const s = headlandS(x, z), plat = platformDepth(s);
  let D = smin(bay, reef, 2.0);
  D = smin(D, shelf, 2.0);
  D = smin(D, bar, 1.5);
  D = smin(D, plat, 3.0);
  const P = plateauH(x, z);
  const head = P * cliffF(Math.max(s, 0.0)) + 2.0 * Math.min(s, 0.0);
  const y = smax(-D, head, 2.0);
  return { xs, bay, reef, shelf, bar, plat, s, P, head, D, y, depth: -y };
}

export function depthAt(x, z) {
  const xs = x - xBay(z);
  let D = smin(bayDepth(xs, z), reefDepth(x, z), 2.0);
  D = smin(D, shelfDepth(x, z), 2.0);
  D = smin(D, barDepth(x, z), 1.5);
  const s = headlandS(x, z);
  D = smin(D, platformDepth(s), 3.0);
  const head = plateauH(x, z) * cliffF(Math.max(s, 0.0)) + 2.0 * Math.min(s, 0.0);
  return -smax(-D, head, 2.0);
}

// ---------------------------------------------------------------- GLSL mirror (constants baked from JS)
const f = (v) => { let s = Number(v).toPrecision(10); if (!/[.e]/.test(s)) s += '.0'; return `(${s})`; };
export const BATHY_GLSL = /* glsl */ `
float bcSstep(float e0, float e1, float x) { float t = clamp((x - e0) / (e1 - e0), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
float bcSmin(float a, float b, float k) { float h = max(k - abs(a - b), 0.0) / k; return min(a, b) - h * h * k * 0.25; }
float bcSmax(float a, float b, float k) { return -bcSmin(-a, -b, k); }
float bcSoftplus(float a, float k) { return max(a, 0.0) + k * log(1.0 + exp(-abs(a) / k)); }
float bcSegDist(vec2 p, vec2 a, vec2 b) {
  vec2 ab = b - a; float h = clamp(dot(p - a, ab) / dot(ab, ab), 0.0, 1.0);
  vec2 d = p - a - ab * h; return sqrt(dot(d, d));
}
float bcXBay(float z) {
  float zc = min(z, ${f(C.bClampZ)}) - ${f(S.beachMid)};
  float sp = bcSoftplus(-(z - ${f(C.bSouth)}), ${f(C.bSouthK)});
  float q = (z - ${f(C.bBumpZ)}) / ${f(C.bBumpW)};
  return ${f(C.bOff)} + ${f(C.bA)} * zc * zc + ${f(C.bSouthA)} * sp * sp + ${f(C.bBumpA)} * exp(-(q * q));
}
float bcXEast(float z) {
  float q = (z - ${f(S.tipZ)}) / ${f(C.eTipW)};
  return ${f(S.headX)} + ${f(C.eTip)} * exp(-(q * q)) - 0.14 * bcSoftplus(z - ${f(C.eRecZ)}, ${f(C.eRecK)}) + 1.5 * sin(z * ${f(0.061 / K)} + 0.4);
}
float bcZSouth(float x) { return ${f(S.headZ)} + ${f(C.sWav)} * sin(x * ${f(0.083 / K)} + 0.5); }
float bcHeadS(vec2 p) { return bcSmin(bcXEast(p.y) - p.x, p.y - bcZSouth(p.x), ${f(C.headK)}); }
float bcPlateau(vec2 p) {
  float tx = (p.x - ${f(S.tipX)} - ${f(4 * K)}) / ${f(60 * K)}, tz = (p.y - ${f(S.tipZ)} + ${f(3 * K)}) / ${f(45 * K)};
  float tip = 3.0 * exp(-(tx * tx + tz * tz));
  float w = bcSstep(${f(C.rampZ0)}, ${f(C.rampZ1)}, p.y - 0.45 * p.x);
  float roll = 1.4 * sin(p.x * ${f(0.045 / K)} + 0.7) * sin(p.y * ${f(0.038 / K)} + 1.9) + 0.8 * sin(p.x * ${f(0.11 / K)} - p.y * ${f(0.07 / K)});
  return ${f(S.lowH)} + ${f(S.highH - S.lowH)} * w - tip + roll;
}
float bcCliff(float s) { return 0.2 * bcSstep(0.0, 2.0, s) + 0.8 * bcSstep(1.5, 7.0, s); }
float bcBayDepth(float xs, float z) {
  if (xs >= 0.0) return min(${f(C.d0)} * (1.0 - exp(-xs / ${f(C.d0L)})) + ${f(C.d1)} * xs + ${f(C.d2)} * xs * xs, 90.0);
  float u = -xs;
  float hills = ${f(C.hillA)} * bcSstep(${f(C.hillU0)}, ${f(C.hillU1)}, u) * (0.72 + 0.28 * sin(z * ${f(0.0061 / K)} + 1.0))
    + ${f(C.hill2A)} * bcSstep(${f(C.hill2U0)}, ${f(C.hill2U1)}, u) * (0.55 + 0.45 * sin(z * ${f(0.019 / K)} + 0.3));
  return -(2.4 * (1.0 - exp(-u / ${f(22.0 * K)})) + hills);
}
float bcReef(vec2 p) {
  float ex = (p.x - ${f(S.reefX)}) / ${f(S.reefRx)}, ez = (p.y - ${f(S.reefZ)}) / ${f(S.reefRz)};
  float ex2 = ex * ex, ez2 = ez * ez;
  float r = sqrt(sqrt(ex2 * ex2 + ez2 * ez2));
  float m = max(r - 0.85, 0.0);
  return ${f(S.reefTop)} + 0.22 * sin(p.x * ${f(0.13 / K)} + p.y * ${f(0.05 / K)}) * sin(p.y * ${f(0.09 / K)} - p.x * ${f(0.04 / K)}) + ${f(C.reefC)} * m * m;
}
float bcShelf(vec2 p) {
  float d = min(bcSegDist(p, vec2(${f(S.shelfX)}, ${f(S.shelfZ0)}), vec2(${f(S.shelfX)}, ${f(S.shelfZ1)})),
                bcSegDist(p, vec2(${f(S.shelfX)}, ${f(S.shelfZ1)}), vec2(${f(S.tipX + 2.0)}, ${f(S.tipZ + 1.0)})));
  float m = max(d - ${f(C.shelfFlat)}, 0.0);
  return ${f(S.shelfTop)} + 0.2 * sin(p.x * ${f(0.21 / K)} + 1.0) * sin(p.y * ${f(0.15 / K)}) + ${f(C.shelfC)} * m * m;
}
float bcBar(vec2 p) {
  float d = bcSegDist(p, vec2(${f(S.barX0)}, ${f(S.barZ0)}), vec2(${f(S.barX1)}, ${f(S.barZ1)}));
  float m = max(d - ${f(C.barFlat)}, 0.0);
  return ${f(S.barTop)} + 0.1 * sin(p.y * ${f(0.05 / K)}) + ${f(C.barC)} * m * m;
}
float bcPlatform(float s) { float o = max(-s, 0.0); return 0.5 + ${f(C.platA)} * o + ${f(C.platB)} * o * o; }
// metres below mean sea level (negative = land above water); identical to depthAt() in bathymetry.js
float bcDepth(vec2 xz) {
  float xs = xz.x - bcXBay(xz.y);
  float D = bcSmin(bcBayDepth(xs, xz.y), bcReef(xz), 2.0);
  D = bcSmin(D, bcShelf(xz), 2.0);
  D = bcSmin(D, bcBar(xz), 1.5);
  float s = bcHeadS(xz);
  D = bcSmin(D, bcPlatform(s), 3.0);
  float head = bcPlateau(xz) * bcCliff(max(s, 0.0)) + 2.0 * min(s, 0.0);
  return -bcSmax(-D, head, 2.0);
}
`;
