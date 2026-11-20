// BlueCurl Swell — spot bathymetry (owner WP2).
// depthAt(x, z): metres below mean sea level (negative = land above water). Single source for sea floor
// AND land heights. BATHY_GLSL defines float bcDepth(vec2 xz), the same formula operation for operation
// (analytic: smooth blobs, capsules and smooth min/max, no textures). GPU parity: dev/spot.html?parity=1.
//
// Layout (world: +X east/seaward, +Z north):
//   bay beach along x = xBay(z) ≈ 0 for z −260…−20, the coast curving east far south into a distant headland;
//   northern headland: land for x < xEast(z), z > zSouth(x), rounded SE corner, tip near (115, 95);
//     a low grassy point (~11 m) at the tip and along the south face, rising to a ~40 m bluff to the
//     north-west (east cliff ~35 m north of z≈190); steep rock faces on the sea sides;
//   outer reef: superellipse x 255…335, z 20…240, ~3.4 m deep;  point shelf: ridge along x≈163, z −125…88,
//   ~1.9 m;  inside sandbar: x≈57, z −232…−38, ~0.95 m;  open slope ~28 m by x = 600, 90 m max.

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

/** Bay shoreline x as a function of z (beach x≈0 for z −260…−20, curving out east far south). */
export function xBay(z) {
  const zc = Math.min(z, 100.0) + 140.0;
  const sp = softplus(-(z + 300.0), 60.0);
  const q = (z + 1050.0) / 170.0;
  return -3.2 + 0.00022 * zc * zc + 0.0004 * sp * sp + 140.0 * Math.exp(-(q * q));
}
/** Headland east face x(z): ~105, bulging to ~116 at the tip (z≈95), receding north-west beyond z≈150. */
export function xEast(z) {
  const q = (z - 95.0) / 22.0;
  return 105.0 + 11.0 * Math.exp(-(q * q)) - 0.14 * softplus(z - 150.0, 25.0) + 2.5 * Math.sin(z * 0.061 + 0.4);
}
/** Headland south face z(x). */
export function zSouth(x) { return 60.0 + 3.0 * Math.sin(x * 0.083 + 0.5); }
/** Signed distance-ish to the headland coastline, positive on land. */
export function headlandS(x, z) { return smin(xEast(z) - x, z - zSouth(x), 22.0); }
/** Headland plateau height (m): low point (~11 m) south/east, rising to a ~40 m bluff north-west. */
export function plateauH(x, z) {
  const tx = (x - 122.0) / 60.0, tz = (z - 92.0) / 45.0;
  const tip = 3.0 * Math.exp(-(tx * tx + tz * tz));
  const w = sstep(90.0, 185.0, z - 0.45 * x);
  const roll = 1.6 * Math.sin(x * 0.045 + 0.7) * Math.sin(z * 0.038 + 1.9) + 1.0 * Math.sin(x * 0.11 - z * 0.07);
  return 12.0 + 28.0 * w - tip + roll;
}
/** Cliff profile 0..1 over the distance inland s (m): rock toe, near-vertical face, rounded lip. */
export function cliffF(s) { return 0.2 * sstep(0.0, 2.5, s) + 0.8 * sstep(2.0, 8.5, s); }

/** Open-water / bay depth by distance offshore xs (negative xs = land behind the beach). */
export function bayDepth(xs, z) {
  if (xs >= 0.0) return Math.min(3.0 * (1.0 - Math.exp(-xs / 40.0)) + 0.012 * xs + 0.00005 * xs * xs, 90.0);
  const u = -xs;
  const hills = 75.0 * sstep(70.0, 420.0, u) * (0.72 + 0.28 * Math.sin(z * 0.0061 + 1.0))
    + 18.0 * sstep(30.0, 160.0, u) * (0.55 + 0.45 * Math.sin(z * 0.019 + 0.3));
  return -(2.4 * (1.0 - Math.exp(-u / 22.0)) + hills);
}
/** Outer reef depth (m), superellipse patch around (295, 130). */
export function reefDepth(x, z) {
  const ex = (x - 295.0) / 42.0, ez = (z - 130.0) / 112.0;
  const ex2 = ex * ex, ez2 = ez * ez;
  const r = Math.sqrt(Math.sqrt(ex2 * ex2 + ez2 * ez2));
  const m = Math.max(r - 0.85, 0.0);
  return 3.4 + 0.22 * Math.sin(x * 0.13 + z * 0.05) * Math.sin(z * 0.09 - x * 0.04) + 28.0 * m * m;
}
/** Point shelf depth (m): flat-topped ridge along x≈163 joined to the headland tip. */
export function shelfDepth(x, z) {
  const d = Math.min(segDist(x, z, 163.0, -125.0, 163.0, 88.0), segDist(x, z, 163.0, 88.0, 118.0, 96.0));
  const m = Math.max(d - 9.0, 0.0);
  return 1.9 + 0.2 * Math.sin(x * 0.21 + 1.0) * Math.sin(z * 0.15) + 0.0028 * m * m;
}
/** Inside sandbar depth (m), ridge along x≈57. */
export function barDepth(x, z) {
  const d = segDist(x, z, 57.0, -232.0, 58.0, -38.0);
  const m = Math.max(d - 6.0, 0.0);
  return 0.95 + 0.1 * Math.sin(z * 0.05) + 0.004 * m * m;
}
/** Rock platform around the headland base (m), from the headland distance s (< 0 at sea). */
export function platformDepth(s) { const o = Math.max(-s, 0.0); return 0.5 + 0.06 * o + 0.002 * o * o; }

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
  float zc = min(z, 100.0) + 140.0; float sp = bcSoftplus(-(z + 300.0), 60.0);
  float q = (z + 1050.0) / 170.0;
  return -3.2 + 0.00022 * zc * zc + 0.0004 * sp * sp + 140.0 * exp(-(q * q));
}
float bcXEast(float z) {
  float q = (z - 95.0) / 22.0;
  return 105.0 + 11.0 * exp(-(q * q)) - 0.14 * bcSoftplus(z - 150.0, 25.0) + 2.5 * sin(z * 0.061 + 0.4);
}
float bcZSouth(float x) { return 60.0 + 3.0 * sin(x * 0.083 + 0.5); }
float bcHeadS(vec2 p) { return bcSmin(bcXEast(p.y) - p.x, p.y - bcZSouth(p.x), 22.0); }
float bcPlateau(vec2 p) {
  float tx = (p.x - 122.0) / 60.0, tz = (p.y - 92.0) / 45.0;
  float tip = 3.0 * exp(-(tx * tx + tz * tz));
  float w = bcSstep(90.0, 185.0, p.y - 0.45 * p.x);
  float roll = 1.6 * sin(p.x * 0.045 + 0.7) * sin(p.y * 0.038 + 1.9) + 1.0 * sin(p.x * 0.11 - p.y * 0.07);
  return 12.0 + 28.0 * w - tip + roll;
}
float bcCliff(float s) { return 0.2 * bcSstep(0.0, 2.5, s) + 0.8 * bcSstep(2.0, 8.5, s); }
float bcBayDepth(float xs, float z) {
  if (xs >= 0.0) return min(3.0 * (1.0 - exp(-xs / 40.0)) + 0.012 * xs + 0.00005 * xs * xs, 90.0);
  float u = -xs;
  float hills = 75.0 * bcSstep(70.0, 420.0, u) * (0.72 + 0.28 * sin(z * 0.0061 + 1.0))
    + 18.0 * bcSstep(30.0, 160.0, u) * (0.55 + 0.45 * sin(z * 0.019 + 0.3));
  return -(2.4 * (1.0 - exp(-u / 22.0)) + hills);
}
float bcReef(vec2 p) {
  float ex = (p.x - 295.0) / 42.0, ez = (p.y - 130.0) / 112.0;
  float ex2 = ex * ex, ez2 = ez * ez;
  float r = sqrt(sqrt(ex2 * ex2 + ez2 * ez2));
  float m = max(r - 0.85, 0.0);
  return 3.4 + 0.22 * sin(p.x * 0.13 + p.y * 0.05) * sin(p.y * 0.09 - p.x * 0.04) + 28.0 * m * m;
}
float bcShelf(vec2 p) {
  float d = min(bcSegDist(p, vec2(163.0, -125.0), vec2(163.0, 88.0)), bcSegDist(p, vec2(163.0, 88.0), vec2(118.0, 96.0)));
  float m = max(d - 9.0, 0.0);
  return 1.9 + 0.2 * sin(p.x * 0.21 + 1.0) * sin(p.y * 0.15) + 0.0028 * m * m;
}
float bcBar(vec2 p) {
  float d = bcSegDist(p, vec2(57.0, -232.0), vec2(58.0, -38.0));
  float m = max(d - 6.0, 0.0);
  return 0.95 + 0.1 * sin(p.y * 0.05) + 0.004 * m * m;
}
float bcPlatform(float s) { float o = max(-s, 0.0); return 0.5 + 0.06 * o + 0.002 * o * o; }
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
