// BlueCurl Swell — wave sheet material (WP4b): swept-profile placement (WP4a's PROFILE_GLSL) + FFT chop + the
// shared water optics (WP1) + stylised thin-sheet transmission (backlit lip) + analytic foam (foam.glsl.js).
//
// Vertex: grid attribute position = (u, sigma, 0). Each of the three profile evaluations (centre, u ± DU) is shaped
// by wvShape(): front alpha (blend to the plain ambient sea), a taper at the crest ends, and the per-front clip
// window [uClip.x, uClip.y] in xi (midpoint to the neighbouring fronts; heights ease to 0 over the band, rows
// beyond collapse onto the cut, the first/last row is pinned to the window edge so every column spans the same
// footprint as the ocean mask). The analytic sigma tangent includes the shaping, so normals stay exact.
// FFT chop: identical sampling to Ocean.js (footprint, distance fades, depth calming), faded out on the raised
// face / lip (vChop) so the mesh edges equal the surrounding ocean.
//
// Fragment: base = bcShadeWaterNoHaze with thick = −1 (the ocean's own path → seamless at the edges); plus a
// transmission term for thin raised water: turquoise through the lip, green-cyan through the face, scaled by a
// forward-scatter phase toward the sun and Beer-Lambert in the profile thickness; plus foam (warm, translucent).
// Back side of the sheet: the normal is flipped toward the viewer.
import * as THREE from 'three';
import { SKY_GLSL } from '../sky/skyModel.js';
import { WATER_COMMON_GLSL, BATHY_CHUNK, AMBIENT_CHUNK, CHOP_GLSL, waterShadingChunk } from '../water/waterShading.glsl.js';
import { PROFILE_GLSL } from './profile.glsl.js';
import { FOAM_GLSL } from './foam.glsl.js';

export const WAVE_COLS = 256;     // grid columns along the crest (≈ 1.22 m)
export const WAVE_ROWS = 64;      // grid rows along the profile (sigma, uniform: key points are lip-refined)

/** Shared (u, sigma) grid: WAVE_COLS × WAVE_ROWS vertices, two triangles per cell. */
export function makeWaveGeometry(nu = WAVE_COLS, ns = WAVE_ROWS) {
  const pos = new Float32Array(nu * ns * 3);
  for (let j = 0; j < ns; j++) {
    for (let i = 0; i < nu; i++) {
      const k = (j * nu + i) * 3;
      pos[k] = i / (nu - 1); pos[k + 1] = j / (ns - 1); pos[k + 2] = 0;
    }
  }
  const idx = new Uint32Array((nu - 1) * (ns - 1) * 6);
  let t = 0;
  for (let j = 0; j < ns - 1; j++) {
    for (let i = 0; i < nu - 1; i++) {
      const a = j * nu + i, b = a + 1, c = a + nu, d = c + 1;
      idx[t++] = a; idx[t++] = c; idx[t++] = b;
      idx[t++] = b; idx[t++] = c; idx[t++] = d;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return g;
}

/** Look parameters (shared uniform objects, tune live via WaveMesh.look). */
export function createWaveLookUniforms() {
  return {
    uWvLook: { value: new THREE.Vector4(1.5, 0.16, 0.55, 1.15) },   // lip glow, face glow, foam backlight, foam gain
    uLipTint: { value: new THREE.Vector3(0.10, 1.0, 0.78) },       // turquoise (thin lip)
    uFaceTint: { value: new THREE.Vector3(0.02, 0.62, 0.48) },     // jade / green-cyan (face, tube wall)
    uFoamTune: { value: new THREE.Vector4(9.0, 3.0, 1.0, 0.8) },   // tile m, trail decay s, coverage gain, lip-line gain
    uFoamTex: { value: null },
    uWvDebug: { value: 0 },       // dev: 1 base water, 2 transmission, 3 foam, 4 normal, 5 sigma/tau, 6 path
  };
}

/** Per-front uniforms (one set per pool slot). keyTex shared. */
export function createFrontUniforms(keyTex, colsTex) {
  return {
    uKeyTex: { value: keyTex },
    uFrontCols: { value: colsTex },
    uFrontZB: { value: new Float32Array(36) },
    uFrontNZB: { value: 0 },
    uFrontX: { value: 0 },
    uFrontTRef: { value: 0 },
    uFrontTime: { value: 0 },
    uFrontVX: { value: 0 },
    uAlpha: { value: 1 },
    uClip: { value: new THREE.Vector4(-60, 60, 0.5, 0.5) },
    uEndTaper: { value: 24 },
  };
}

const VERT = /* glsl */ `
#define BC_VERTEX_ONLY
uniform float uFrontTime;
uniform float uFrontVX;
uniform float uAlpha;
uniform vec4 uClip;        // xiMin, xiMax (local, m), band at xiMin, band at xiMax
uniform float uEndTaper;   // m, height taper at the crest ends
uniform vec2 uChopFade;    // = ocean's
out vec3 vP;
out vec2 vXZ;
out vec3 vN;
out vec4 vA;   // tau (clamped), tauU (unclamped), zi, H
out vec4 vB;   // xi, yl, thick, sigma
out vec4 vC;   // curl, mush, Tb, chop weight
${SKY_GLSL}
${WATER_COMMON_GLSL}
${BATHY_CHUNK}
${AMBIENT_CHUNK}
${CHOP_GLSL}
${PROFILE_GLSL}

#define WV_DU (0.5 / float(BC_NCOLS))
float wvSS(float e0, float e1, float x, out float d) {
  float h = e1 - e0, t = clamp((x - e0) / h, 0.0, 1.0);
  d = (t > 0.0 && t < 1.0) ? 6.0 * t * (1.0 - t) / h : 0.0;
  return t * t * (3.0 - 2.0 * t);
}
// shape a local sample P = (xi, y, dxi/ds, dy/ds): alpha, end taper eu, clip window
vec4 wvShape(vec4 P, float eu, float sg) {
  float db, df;
  float wb = wvSS(uClip.x, uClip.x + uClip.z, P.x, db);
  float wf = 1.0 - wvSS(uClip.y - uClip.w, uClip.y, P.x, df); df = -df;
  float w = wb * wf, dw = db * wf + wb * df;
  float k = eu * uAlpha;
  float y = P.y * w * k;
  float dy = (P.w * w + P.y * dw * P.z) * k;
  bool inside = P.x > uClip.x && P.x < uClip.y;
  float xi = clamp(P.x, uClip.x, uClip.y);
  float dxi = inside ? P.z : 0.0;
  if (sg <= 0.0) xi = uClip.x;
  if (sg >= 1.0) xi = uClip.y;
  return vec4(xi, y, dxi, dy);
}
vec4 wvLocal(float u, float sg, float tl, out float thick, out BCCol col) {
  vec4 P = bcLocal(u, sg, tl, thick, col);
  float dz = min(u, 1.0 - u) * BC_FRONT_W;
  return wvShape(P, smoothstep(0.0, uEndTaper, dz), sg);
}

void main() {
  float u = position.x, sg = position.y, tl = uFrontTime;
  BCCol col, cp, cm; float th, tp, tm;
  vec4 P = wvLocal(u, sg, tl, th, col);
  // u tangent: forward difference over one column-texel span (the piecewise-linear cols then give a continuous
  // slope; WP4a's tiny BC_DU baseline shows the texel kinks as glint stripes). Reuses the centre sample: 2 evals.
  vec4 Pp = wvLocal(u + 2.0 * WV_DU, sg, tl, tp, cp);
  vec4 Pm = P;
  float x = uFrontX - P.x, z = BC_FRONT_Z0 + u * BC_FRONT_W;
  float A = bcAmbient(vec2(x, z), uTime);
  vec3 g = bcAmbientGrad(vec2(x, z), uTime);
  float dxiU = (Pp.x - Pm.x) / (2.0 * WV_DU), dyU = (Pp.y - Pm.y) / (2.0 * WV_DU);
  vec3 ts = vec3(-P.z, P.w - g.x * P.z, 0.0);
  vec3 tu = vec3(-dxiU, dyU - g.x * dxiU + g.y * BC_FRONT_W, BC_FRONT_W);
  vec3 n = cross(ts, tu);
  float nl = length(n);
  n = nl > 1e-6 * BC_FRONT_W ? n / nl : normalize(vec3(-g.x, 1.0, -g.y));

  float Tb = 2.5;
  for (int b = 0; b < 3; b++) { if (b < uFrontNZB && uFrontZB[b * 3 + 2].w == col.zi) Tb = uFrontZB[b * 3 + 1].z; }
  float tauU = col.zi < 0.0 ? col.tau : (tl - col.tStart) / Tb;

  // FFT chop exactly as the ocean samples it, faded out on the raised face / lip
  vec3 Pw = vec3(x, P.y + A, z);
  float dist = length(Pw.xz - cameraPosition.xz);
  float brk = smoothstep(-0.35, 0.1, col.tau) * (1.0 - smoothstep(1.2, 1.8, col.tau));
  float faceR = smoothstep(BC_SIGMA_CREST - 0.08, BC_SIGMA_CREST, sg) * (1.0 - smoothstep(BC_SIGMA_TROUGH - 0.1, BC_SIGMA_TROUGH - 0.02, sg));
  float chopW = smoothstep(0.55, 0.85, n.y) * (1.0 - brk * faceR);
  vec2 sl;
  vec3 d = bcChopDisp(Pw.xz, max(0.35, 0.014 * dist), sl);
  float cw = smoothstep(0.05, 1.2, bcDepth(Pw.xz));
  d *= (1.0 - smoothstep(uChopFade.x, uChopFade.y, dist)) * cw * chopW;
  d.xz *= 1.0 - smoothstep(uChopFade.x * 0.25, uChopFade.x, dist);

  vP = Pw + d;
  vXZ = Pw.xz;
  vN = n;
  vA = vec4(col.tau, tauU, col.zi, col.H);
  vB = vec4(P.x, P.y, th, sg);
  vC = vec4(col.curl, col.mush, Tb, chopW);
  gl_Position = projectionMatrix * viewMatrix * vec4(vP, 1.0);
}`;

const FRAG = /* glsl */ `
uniform float uLeanBias;
uniform float uAlpha;
uniform float uFrontVX;
uniform vec4 uClip;
uniform vec4 uWvLook;
uniform vec3 uLipTint;
uniform vec3 uFaceTint;
uniform int uWvDebug;
in vec3 vP;
in vec2 vXZ;
in vec3 vN;
in vec4 vA;
in vec4 vB;
in vec4 vC;
${waterShadingChunk()}
${FOAM_GLSL}

float wvHG(float c, float g) { float g2 = g * g; return (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * c, 1.5); }

void main() {
  vec3 V = normalize(cameraPosition - vP);
  vec3 N = normalize(vN);
  vec3 Nv = dot(N, V) < 0.0 ? -N : N;            // back side of the sheet: flipped normal
  // chop slopes / variance like the ocean (footprint from the view ray on the mean sea plane)
  vec3 rd = -V;
  float tPl = cameraPosition.y / max(-rd.y, 0.004);
  vec2 xzFlat = cameraPosition.xz + rd.xz * tPl;
  float cw = smoothstep(0.05, 1.2, bcDepth(vXZ) + vP.y) * vC.w;
  vec3 Ns = Nv;
  vec2 sig2 = vec2(0.0);
  if (cw > 1e-3 && Nv.y > 0.2) {
    vec4 lean = bcChopLEANGrad(vXZ, dFdx(xzFlat), dFdy(xzFlat), uLeanBias);
    Ns = normalize(Nv / Nv.y + vec3(-lean.x, 0.0, -lean.y) * cw);
    sig2 = lean.zw * cw * cw;
  }
  // smooth breaking water still has some roughness: spreads the sun lobe on the lip (no per-column glint bands)
  float brkF = 1.0 - vC.w;
  sig2 += vec2(0.03) * brkF;
  BcWater w = bcWater(vP, Ns, V);
  w.sig2 = sig2;
  vec3 col = bcShadeWaterNoHaze(w);
  // on breaking water keep sun glints below the lip glow (no isolated 'headlight' highlights on the curl)
  col = mix(col, col * min(1.0, 3.5 / max(bcLuma(col), 1e-3)), brkF);

  // ---- light transmitted through thin raised water (backlit lip / face)
  float tau = vA.x, tauU = vA.y, H = vA.w, xi = vB.x, yl = vB.y, th = vB.z, sg = vB.w;
  float Hs = max(H * uAlpha, 0.3);
  float elev = smoothstep(0.06, 0.4, yl / Hs) * smoothstep(0.25, 1.0, H * uAlpha);
  float NoV = abs(dot(N, V));
  // light path through the sheet: along the view and along the (low) sun; a swell crest is thin along its normal
  // but long along the sun's grazing ray, so only lips and steep faces transmit
  float NoL = abs(dot(N, uSunDir));
  float path = 0.5 * th / max(NoV * 0.6 + 0.4, 0.3) + 0.5 * th / max(NoL, 0.12);
  float cosS = dot(-V, uSunDir);
  float ph = 0.22 + 0.78 * wvHG(cosS, 0.55) / wvHG(1.0, 0.55);
  float backlit = mix(0.4, 1.0, smoothstep(0.2, -0.3, dot(Nv, uSunDir)));
  float sunL = bcLuma(uSunColor);
  float F = bcFresnelWater(NoV);
  vec3 tint = mix(uLipTint, uFaceTint, smoothstep(0.4, 3.5, path));
  float trans = uWvLook.x * exp(-path * 0.5) + uWvLook.y * exp(-path * 0.22);
  col += tint * sunL * trans * ph * backlit * elev * (1.0 - F);

  // ---- foam
  float lipLine, fshade;
  float fc = wvFoam(tauU, sg, xi, yl, H, vC.x, vC.y, vC.z, uFrontVX, vP, Nv, uClip.x, uAlpha, uTime, lipLine, fshade);
  if (fc > 0.0) {
    vec3 Nf = normalize(mix(Nv, vec3(0.0, 1.0, 0.0), 0.35));
    float phF = 0.3 + 0.7 * wvHG(cosS, 0.35) / wvHG(1.0, 0.35);
    vec3 warm = vec3(1.0, 0.86, 0.72);
    vec3 fcol = bcShadeFoam(Nf) * uWvLook.w + uSunColor * warm * uWvLook.z * phF;
    fcol *= fshade * (1.0 + lipLine);
    col = mix(col, fcol, fc);
  }
  if (uWvDebug == 1) col = bcShadeWaterNoHaze(w);
  else if (uWvDebug == 2) col = tint * sunL * trans * ph * backlit * elev * (1.0 - F);
  else if (uWvDebug == 3) col = vec3(fc, lipLine, 0.0);
  else if (uWvDebug == 4) col = Nv * 0.5 + 0.5;
  else if (uWvDebug == 5) col = vec3(sg, clamp(tau, 0.0, 1.0), vC.w);
  else if (uWvDebug == 6) col = vec3(path / 10.0, th / 10.0, elev);
  else if (uWvDebug == 7) col = (any(isnan(col)) || any(isinf(col))) ? vec3(1e4, 0.0, 0.0) : (max(col.r, max(col.g, col.b)) > 8.0 ? vec3(0.0, 0.0, 1e4) : col * 0.2);
  gl_FragColor = vec4(uWvDebug > 0 ? col : bcHaze(col, vP), 1.0);
}`;

/** One material per pool slot; uniforms = shared water + look + this front's. */
export function makeWaveMaterial(waterUniforms, lookUniforms, frontUniforms, extra = {}) {
  return new THREE.ShaderMaterial({
    name: 'bcWave',
    uniforms: { ...waterUniforms, ...lookUniforms, ...frontUniforms, ...extra },
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.DoubleSide,
    polygonOffset: true,          // wins depth ties with the ocean in the strip where both coincide (mesh edges)
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
  });
}
