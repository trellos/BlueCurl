// BlueCurl Swell — GLSL mirror of profile.js + contracts.breakStartTime/localTau + field.sampleFront (WP4a).
// Same math as the JS (float32 vs float64). test/wave-parity.mjs: GPU vs JS < 1e-3 m position, < 1e-3 normal.
//
// =============================================== WP4b QUICK START (everything the renderer needs) ===============
// EXPORTS: PROFILE_GLSL (string), packFront(front, tRef, out?), makeKeyTextureSpec(), UNIFORM_NAMES, MAX_BREAKS = 3.
//
// ONCE (shared by all fronts):
//   const ks = makeKeyTextureSpec();   // { data: Float32Array, width: 96, height: 36 }
//   keyTex = new THREE.DataTexture(ks.data, ks.width, ks.height, THREE.RGBAFormat, THREE.FloatType);
//   keyTex.minFilter = keyTex.magFilter = THREE.NearestFilter; keyTex.generateMipmaps = false; keyTex.needsUpdate = true;
//   Mesh grid: attribute (u, sigma), e.g. 200 columns in u ∈ [0,1] × 64 rows in sigma ∈ [0,1], UNIFORM steps — the
//   key points are already concentrated on crest/lip/tube (sigma 0.25…0.80). Draw double-sided (tube interior).
//   Shader source: AMBIENT_GLSL (contracts.js) first, then PROFILE_GLSL. WebGL2 / GLSL ES 3.00, any stage.
//
// PER FRONT (one material / uniform set per alive FrontState), EVERY FRAME at sim time t:
//   tRef = front.tPoint (any value near t works; keeps float32 times small)
//   pk = packFront(front, tRef, pk)          // reuses pk's arrays when passed
//   colsTex.image.data.set(pk.cols); colsTex.needsUpdate = true   // NCOLS×1 RGBA32F DataTexture, NearestFilter
//   uniforms:
//     sampler2D uKeyTex      keyTex (shared)
//     sampler2D uFrontCols   colsTex: texel c = (H m, steep, curl, mush) of column c, which sits at u = (c+0.5)/NCOLS
//     vec4  uFrontZB[9]      pk.zb (Float32Array 36) — break b (zone order) uses vec4s 3b..3b+2:
//                              [tBreak - tRef, uPeak, u0, u1]  [dir, vPeel, Tb, peelLen]  [backLen, closeout 0|1, sections, zi]
//                              (Infinity stored as 1e30)
//     int   uFrontNZB        pk.nzb (0..3)
//     float uFrontX          pk.frontX = front.x at t
//     float uFrontTRef       pk.tRef
//     float uFrontTime       (yours) t - tRef, computed in JS doubles — pass it as the tl argument below
//     vec4  uAmbient         (cfg.ambient.amp, .period, .amp2, .period2)  — from AMBIENT_GLSL
//   front.alpha (horizon fade-in / shore fade-out) is NOT applied here: fade it in the material.
//
// VERTEX SHADER:
//   BCSample s = bcSampleFront(u, sigma, uFrontTime);
//   gl_Position = projectionMatrix * viewMatrix * vec4(s.pos, 1.0);   // s.pos is WORLD space: no model matrix
//   BCSample { vec3 pos;   world position incl. ambient swell (x = uFrontX - xi, z = FRONT_Z0 + u·FRONT_W)
//              vec3 nrm;   unit normal pointing out of the water (down into the tube under a thrown lip)
//              float tau;  break phase (contracts.localTau): <0 approach, 0..1 break, 1..2 re-form
//              float zi;   zone index of that phase (-1 = not broken yet)
//              float H;    column height (m)
//              float thick;water-sheet thickness along -nrm (m), capped at 2.5·H — feed shadeWater's thickHint
//              float xi;   cross-section coordinate (m, + shoreward)   float yl;  height without ambient (m) }
//   Cost: 3 column evaluations (centre + u±DU for the normal), 48 texelFetch each (96 while re-forming into a
//   later zone). Foam/spray helpers: BC_SIGMA_CREST / BC_SIGMA_LIP (lip tip) / BC_SIGMA_TROUGH, bcColumn(u, tl).
//
// LOWER-LEVEL FUNCTIONS
//   float  bcBreakStart(int b, float u)                 contracts.breakStartTime (local time, BC_NEVER = never)
//   vec3   bcLocalTau(float u, float tl)                 contracts.localTau → (tau, zi, tStart)
//   BCCol  bcColumn(float u, float tl)                   cols + tau + shape phase (field.columnState)
//   vec4   bcProfile(float tau, float sigma, float H, vec3 shape)   → (xi, y, dxi/dsigma, dy/dsigma), metres
//   void   bcProfileFull(tau, sigma, H, shape, out vec4 P, out float thick)
//   vec4   bcLocal(float u, float sigma, float tl, out float thick, out BCCol col)  (field.evalLocal)
// CPU side: field.js (sampleFront / surfaceHeight / barrel / lip) is the exact JS mirror for riders and camera.
// ===============================================================================================================

import { NCOLS, FRONT_W, FRONT_Z0 } from '../contracts.js';
import { NPTS, NKEY, NFAM, KEY_TAUS, KEY_DATA, KEY_TEX_W, KEY_TEX_H, CORE_BACK, CORE_FRONT, THICK_CAP,
  SIGMA_CREST, SIGMA_LIP, SIGMA_TROUGH } from './keyframes.js';
import { STEEP_C, STEEP_R, CURL_LO, CURL_HI } from './profile.js';
import { DU } from './field.js';

const f = (v) => { const s = String(v); return /[.eE]/.test(s) ? s : s + '.0'; };

export const MAX_BREAKS = 3;
export const NEVER = 1e30;
export const UNIFORM_NAMES = ['uKeyTex', 'uFrontCols', 'uFrontZB', 'uFrontNZB', 'uFrontX', 'uFrontTRef', 'uAmbient'];

/** Key texture spec (create a THREE.DataTexture from it: RGBAFormat, FloatType, NearestFilter, no mipmaps). */
export function makeKeyTextureSpec() { return { data: KEY_DATA, width: KEY_TEX_W, height: KEY_TEX_H }; }

/**
 * Pack one FrontState for the uniforms above.
 * zb: Float32Array(36) — per break b: [tBreak - tRef, uPeak, u0, u1], [dir, vPeel, Tb, peelLen],
 *     [backLen, closeout ? 1 : 0, sections, zi]  (Infinity → 1e30)
 * cols: Float32Array(NCOLS*4) RGBA for the NCOLS×1 texture (front.cols itself, not copied).
 */
export function packFront(front, tRef = 0, out = null) {
  const o = out || { zb: new Float32Array(MAX_BREAKS * 12), nzb: 0, cols: null, frontX: 0, tRef: 0 };
  const fin = (v) => (Number.isFinite(v) ? v : v > 0 ? NEVER : -NEVER);
  o.zb.fill(0);
  const n = Math.min(MAX_BREAKS, front.breaks.length);
  for (let b = 0; b < n; b++) {
    const zb = front.breaks[b], k = b * 12;
    o.zb[k] = zb.tBreak - tRef; o.zb[k + 1] = zb.uPeak; o.zb[k + 2] = zb.u0; o.zb[k + 3] = zb.u1;
    o.zb[k + 4] = zb.dir; o.zb[k + 5] = zb.vPeel; o.zb[k + 6] = zb.Tb; o.zb[k + 7] = fin(zb.peelLen);
    o.zb[k + 8] = fin(zb.backLen); o.zb[k + 9] = zb.closeout ? 1 : 0; o.zb[k + 10] = zb.sections; o.zb[k + 11] = zb.zi;
  }
  o.nzb = n; o.cols = front.cols; o.frontX = front.x; o.tRef = tRef;
  return o;
}

export const PROFILE_GLSL = /* glsl */ `
// ---- BlueCurl swept-profile wave (WP4a) ----
uniform sampler2D uKeyTex;
uniform sampler2D uFrontCols;
uniform vec4 uFrontZB[${MAX_BREAKS * 3}];
uniform int uFrontNZB;
uniform float uFrontX;
uniform float uFrontTRef;

#define BC_NPTS ${NPTS}
#define BC_NKEY ${NKEY}
#define BC_NFAM ${NFAM}
#define BC_NCOLS ${NCOLS}
#define BC_FRONT_W ${f(FRONT_W)}
#define BC_FRONT_Z0 ${f(FRONT_Z0)}
#define BC_NEVER 1.0e30
#define BC_DU ${f(DU)}
#define BC_SIGMA_CREST ${f(SIGMA_CREST)}
#define BC_SIGMA_LIP ${f(SIGMA_LIP)}
#define BC_SIGMA_TROUGH ${f(SIGMA_TROUGH)}
const float BC_KEY_TAU[${NKEY}] = float[${NKEY}](${KEY_TAUS.map(f).join(', ')});

struct BCCol { float H; float steep; float curl; float mush; float tau; float zi; float tStart; float tauA; float tauB; float wB; };
struct BCSample { vec3 pos; vec3 nrm; float tau; float zi; float H; float thick; float xi; float yl; };

float bcBreakStart(int b, float u) {
  vec4 A = uFrontZB[b * 3], B = uFrontZB[b * 3 + 1], C = uFrontZB[b * 3 + 2];
  if (u < A.z || u > A.w) return BC_NEVER;
  float ds = (u - A.y) * BC_FRONT_W;
  if (C.y > 0.5) return A.x + abs(ds) / 80.0;
  float s = B.x == 0.0 ? abs(ds) : ds * B.x;
  if (s < 0.0) { float back = -s; return back > C.x ? BC_NEVER : A.x + back / (0.5 * B.y); }
  if (s > B.w) return BC_NEVER;
  if (C.z > 1.0) {
    float w = 6.2831853 / (B.w / C.z);                     // smooth monotone staircase (contracts)
    return A.x + (s - 0.75 * sin(w * s) / w) / B.y;
  }
  return A.x + s / B.y;
}

BCCol bcColumn(float u, float tl) {
  BCCol c;
  float fc = clamp(u * float(BC_NCOLS) - 0.5, 0.0, float(BC_NCOLS - 1));
  int i = min(int(floor(fc)), BC_NCOLS - 2);
  float s = fc - float(i);
  vec4 c0 = texelFetch(uFrontCols, ivec2(i, 0), 0), c1 = texelFetch(uFrontCols, ivec2(i + 1, 0), 0);
  vec4 cv = c0 * (1.0 - s) + c1 * s;
  c.H = cv.x; c.steep = cv.y; c.curl = cv.z; c.mush = cv.w;
  float ts[${MAX_BREAKS}];
  float best = -1.0, tStart = BC_NEVER;
  for (int b = 0; b < ${MAX_BREAKS}; b++) {
    ts[b] = BC_NEVER;
    if (b >= uFrontNZB) break;
    ts[b] = bcBreakStart(b, u);
    if (ts[b] <= tl && (best < 0.0 || ts[b] > tStart)) { best = uFrontZB[b * 3 + 2].w; tStart = ts[b]; }
  }
  c.tauB = 0.0; c.wB = 0.0;
  if (best < 0.0) {
    float nx = BC_NEVER, Tb = 2.5;
    for (int b = 0; b < ${MAX_BREAKS}; b++) {
      if (b >= uFrontNZB) break;
      if (ts[b] < nx) { nx = ts[b]; Tb = uFrontZB[b * 3 + 1].z; }
    }
    c.tau = nx < 1.0e29 ? max(-1.0, (tl - nx) / Tb) : -1.0;
    c.zi = -1.0; c.tStart = nx;
  } else {
    float Tb = 2.5;
    for (int b = ${MAX_BREAKS - 1}; b >= 0; b--) {          // first break with zi == best (Array.find)
      if (b < uFrontNZB && uFrontZB[b * 3 + 2].w == best) Tb = uFrontZB[b * 3 + 1].z;
    }
    c.tau = min(2.0, (tl - tStart) / Tb); c.zi = best; c.tStart = tStart;
    float nx = BC_NEVER, Tn = 2.5;
    for (int b = 0; b < ${MAX_BREAKS}; b++) {
      if (b >= uFrontNZB) break;
      if (ts[b] > tl && ts[b] < nx) { nx = ts[b]; Tn = uFrontZB[b * 3 + 1].z; }
    }
    if (nx < 1.0e29) {
      float tn = (tl - nx) / Tn;
      if (tn > -1.0) { float w = tn + 1.0; c.tauB = tn; c.wB = w * w * (3.0 - 2.0 * w); }
    }
  }
  c.tauA = c.tau;
  return c;
}

vec3 bcLocalTau(float u, float tl) { BCCol c = bcColumn(u, tl); return vec3(c.tau, c.zi, c.tStart); }

void bcProfileFull(float tau, float sigma, float H, vec3 shape, out vec4 P, out float thick) {
  float steep = clamp(shape.x, 0.0, 1.0), curl = clamp(shape.y, 0.0, 1.0), mush = clamp(shape.z, 0.0, 1.0);
  float pm = max(0.0, 1.0 - 2.0 * mush), wf1 = smoothstep(${f(CURL_LO)}, ${f(CURL_HI)}, curl) * pm * pm, wf2 = mush, wf0 = 1.0 - wf1 - wf2;
  // tau: non-uniform cubic Hermite over keys (zero tangent at both end keys)
  tau = clamp(tau, -1.0, 2.0);
  int k = 0;
  for (int j = 0; j < BC_NKEY - 2; j++) { if (tau >= BC_KEY_TAU[j + 1]) k = j + 1; }
  float t0 = BC_KEY_TAU[k], t1 = BC_KEY_TAU[k + 1], h = t1 - t0;
  float s = (tau - t0) / h, s2 = s * s, s3 = s2 * s;
  float h00 = 2.0 * s3 - 3.0 * s2 + 1.0, h10 = s3 - 2.0 * s2 + s, h01 = -2.0 * s3 + 3.0 * s2, h11 = s3 - s2;
  float a = k > 0 ? (h10 * h) / (t1 - BC_KEY_TAU[max(k - 1, 0)]) : 0.0;
  float bb = k + 1 < BC_NKEY - 1 ? (h11 * h) / (BC_KEY_TAU[min(k + 2, BC_NKEY - 1)] - t0) : 0.0;
  vec4 TW = vec4(-a, h00 - bb, h01 + a, bb);
  ivec4 TK = ivec4(max(0, k - 1), k, k + 1, min(BC_NKEY - 1, k + 2));
  // sigma: uniform Catmull-Rom over key points (clamped ends)
  float fs = clamp(sigma, 0.0, 1.0) * float(BC_NPTS - 1);
  int i = min(int(floor(fs)), BC_NPTS - 2);
  float q = fs - float(i), q2 = q * q, q3 = q2 * q;
  vec4 SW = 0.5 * vec4(-q3 + 2.0 * q2 - q, 3.0 * q3 - 5.0 * q2 + 2.0, -3.0 * q3 + 4.0 * q2 + q, q3 - q2);
  vec4 SD = 0.5 * vec4(-3.0 * q2 + 4.0 * q - 1.0, 9.0 * q2 - 10.0 * q, -9.0 * q2 + 8.0 * q + 1.0, 3.0 * q2 - 2.0 * q);
  ivec4 SI = ivec4(max(0, i - 1), i, i + 1, min(BC_NPTS - 1, i + 2));
  float x = 0.0, y = 0.0, dx = 0.0, dy = 0.0, th = 0.0;
  for (int ta = 0; ta < 4; ta++) {
    float wt = TW[ta];
    for (int sb = 0; sb < 4; sb++) {
      float ws = wt * SW[sb], wd = wt * SD[sb];
      vec3 p = wf0 * texelFetch(uKeyTex, ivec2(SI[sb], TK[ta]), 0).xyz
             + wf1 * texelFetch(uKeyTex, ivec2(SI[sb], BC_NKEY + TK[ta]), 0).xyz
             + wf2 * texelFetch(uKeyTex, ivec2(SI[sb], 2 * BC_NKEY + TK[ta]), 0).xyz;
      x += ws * p.x; y += ws * p.y; th += ws * p.z; dx += wd * p.x; dy += wd * p.y;
    }
  }
  dx *= float(BC_NPTS - 1); dy *= float(BC_NPTS - 1);
  // steep warp
  float kS = (1.3 - 0.55 * steep) * (1.0 - wf1) + wf1;
  float v = (x - ${f(STEEP_C)}) / ${f(STEEP_R)}, e = exp(-v * v);
  float xs = x + (kS - 1.0) * (x - ${f(STEEP_C)}) * e;
  float dS = 1.0 + (kS - 1.0) * e * (1.0 - 2.0 * v * v);
  // world warp
  float Hc = max(0.0, H);
  float Sx = sqrt(Hc * Hc + 1.0);
  float W, dW;
  if (xs < 0.0) {
    float Bb = max(0.0, 18.0 + 4.5 * Hc - Sx * ${f(CORE_BACK)}), qq = -xs / ${f(CORE_BACK)};
    W = Sx * xs - Bb * qq * qq * qq; dW = Sx + (3.0 * Bb * qq * qq) / ${f(CORE_BACK)};
  } else {
    float Bf = max(0.0, 12.0 + 3.8 * Hc - Sx * ${f(CORE_FRONT)}), qq = xs / ${f(CORE_FRONT)};
    W = Sx * xs + Bf * qq * qq * qq; dW = Sx + (3.0 * Bf * qq * qq) / ${f(CORE_FRONT)};
  }
  P = vec4(W, Hc * y, dW * dS * dx, Hc * dy);
  thick = Hc * min(${f(THICK_CAP)}, max(0.0, th));
}

vec4 bcProfile(float tau, float sigma, float H, vec3 shape) {
  vec4 P; float th; bcProfileFull(tau, sigma, H, shape, P, th); return P;
}

vec4 bcLocal(float u, float sigma, float tl, out float thick, out BCCol col) {
  col = bcColumn(u, tl);
  vec3 shape = vec3(col.steep, col.curl, col.mush);
  vec4 P; bcProfileFull(col.tauA, sigma, col.H, shape, P, thick);
  if (col.wB > 0.0) {
    vec4 Q; float tq; bcProfileFull(col.tauB, sigma, col.H, shape, Q, tq);
    float w = col.wB, vv = 1.0 - w;
    P = P * vv + Q * w; thick = thick * vv + tq * w;
  }
  return P;
}

vec3 bcAmbientGrad(vec2 xz, float t) {     // (dA/dx, dA/dz, unused) — gradient of bcAmbient
  float k1 = 6.2831853 / (9.81 * uAmbient.y * uAmbient.y / 6.2831853);
  float k2 = 6.2831853 / (9.81 * uAmbient.w * uAmbient.w / 6.2831853);
  float c1 = uAmbient.x * cos(k1 * (xz.x + 0.12 * xz.y) + 6.2831853 / uAmbient.y * t);
  float c2 = uAmbient.z * cos(k2 * (xz.x - 0.3 * xz.y) + 6.2831853 / uAmbient.w * t + 1.3);
  return vec3(k1 * c1 + k2 * c2, 0.12 * k1 * c1 - 0.3 * k2 * c2, 0.0);
}

BCSample bcSampleFront(float u, float sigma, float tl) {
  BCSample r; BCCol col, cp, cm; float th, tp, tm;
  vec4 P = bcLocal(u, sigma, tl, th, col);
  vec4 Pp = bcLocal(u + BC_DU, sigma, tl, tp, cp);
  vec4 Pm = bcLocal(u - BC_DU, sigma, tl, tm, cm);
  float tAbs = tl + uFrontTRef;
  float x = uFrontX - P.x, z = BC_FRONT_Z0 + u * BC_FRONT_W;
  float A = bcAmbient(vec2(x, z), tAbs);
  vec3 g = bcAmbientGrad(vec2(x, z), tAbs);
  float dxiU = (Pp.x - Pm.x) / (2.0 * BC_DU), dyU = (Pp.y - Pm.y) / (2.0 * BC_DU);
  vec3 ts = vec3(-P.z, P.w - g.x * P.z, 0.0);
  vec3 tu = vec3(-dxiU, dyU - g.x * dxiU + g.y * BC_FRONT_W, BC_FRONT_W);
  vec3 n = cross(ts, tu);
  float nl = length(n);
  r.nrm = nl > 0.0 ? n / nl : vec3(0.0, 1.0, 0.0);
  r.pos = vec3(x, P.y + A, z);
  r.tau = col.tau; r.zi = col.zi; r.H = col.H; r.thick = th; r.xi = P.x; r.yl = P.y;
  return r;
}
`;
