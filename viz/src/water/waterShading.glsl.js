// Reusable water GLSL: FFT chop sampling and the water optics, shared by the ocean (Ocean.js) and the
// wave renderer (WP4b) so both shade identically.
//
// Adapted from ShoreBreak src/glsl/water.js (CHOP oceanDisp / oceanSlopeLEAN, WATER_SHADE roughReflection /
// smithG1 / shadeWaterFull transmission: thickness, Beer-Lambert absorption, forward scatter
// 0.18 + 0.82·pow(max(dot(-V, L), 0), 5)) and src/glsl/common.js (NOISE, OPTICS), Copyright (c) 2026
// Christopher Canavan, MIT License. The hash routines are David Hoskins' "Hash without Sine" (MIT).
// See viz/THIRD_PARTY.md. Removed for BlueCurl: the phone-camera clip tuning (facet noise, cat's paws,
// Poisson glints, maroon dashes), the screen-space opaque/back-depth passes, swash/milk/silt/toe terms.
//
// Usage (any ShaderMaterial, fragment shader for bcShadeWater):
//   fragmentShader = waterShadingChunk() + `... BcWater w = bcWater(P, N, V); w.thick = myThickness;
//                                            gl_FragColor = vec4(bcShadeWater(w), 1.0); ...`
//   uniforms = { ...app.waterUniforms, ...yours }   (same uniform objects: values stay in sync)
// Every sub-chunk is include-guarded, so including pieces twice is harmless.
import * as THREE from 'three';
import { AMBIENT_GLSL, DEFAULT_CFG } from '../contracts.js';
import { BATHY_GLSL } from '../spot/bathymetry.js';
import { SKY_GLSL, createSkyUniforms } from '../sky/skyModel.js';
import { OCEAN, OCEAN_CHOP } from './OceanFFT.js';

const guard = (name, code) => `\n#ifndef ${name}\n#define ${name}\n${code}\n#endif\n`;

// ---------------------------------------------------------------- noise + optics helpers
export const WATER_COMMON_GLSL = guard('BC_WATER_COMMON', /* glsl */ `
float bcHash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec3  bcHash33(vec3 p3) { p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yxx) * p3.zyx); }
float bcVnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(mix(bcHash12(i), bcHash12(i + vec2(1, 0)), u.x), mix(bcHash12(i + vec2(0, 1)), bcHash12(i + vec2(1, 1)), u.x), u.y);
}
float bcVnoise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n000 = bcHash33(i).x, n100 = bcHash33(i + vec3(1,0,0)).x, n010 = bcHash33(i + vec3(0,1,0)).x, n110 = bcHash33(i + vec3(1,1,0)).x;
  float n001 = bcHash33(i + vec3(0,0,1)).x, n101 = bcHash33(i + vec3(1,0,1)).x, n011 = bcHash33(i + vec3(0,1,1)).x, n111 = bcHash33(i + vec3(1,1,1)).x;
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y), mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
// exact unpolarised Fresnel, air -> water (n = 1.333)
float bcFresnelWater(float cosI) {
  cosI = clamp(cosI, 0.0, 1.0);
  float eta = 1.0 / 1.333;
  float cosT = sqrt(max(1.0 - eta * eta * (1.0 - cosI * cosI), 0.0));
  float rs = (cosI - 1.333 * cosT) / (cosI + 1.333 * cosT);
  float rp = (1.333 * cosI - cosT) / (1.333 * cosI + cosT);
  return clamp(0.5 * (rs * rs + rp * rp), 0.0, 1.0);
}
// Smith shadowing of a ray leaving at elevation tangent tE over a sea of slope std sigS (Beckmann)
float bcSmithG1(float tE, float sigS) {
  if (tE <= 0.0) return 0.0;
  float a = tE / (1.41421 * max(sigS, 1e-3));
  if (a >= 1.6) return 1.0;
  float L = (1.0 - 1.259 * a + 0.396 * a * a) / (3.535 * a + 2.181 * a * a);
  return 1.0 / (1.0 + L);
}
float bcLuma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`);

// ---------------------------------------------------------------- FFT chop (3 cascades)
const rot = (d) => { const a = (d * Math.PI) / 180; return [Math.cos(a), Math.sin(a)]; };
const m2 = ([c, s]) => `mat2(${c.toFixed(7)}, ${s.toFixed(7)}, ${(-s).toFixed(7)}, ${c.toFixed(7)})`;
const RC = OCEAN.ROT.map(rot);

/**
 * Chop sampling. Uniforms: uOceanD / uOceanS (sampler2DArray, layer = cascade): D = (dx, h, dz, 0) m,
 * S = (sx, sz, sx², sz²); uOceanL (vec3 patch sizes m); uOceanAmp (vec4: per-cascade gain xyz, w unused).
 *   vec3 bcChopDisp(vec2 xz, float fp, out vec2 slope)   displacement (dx, h, dz) and mean slope for a
 *                                                         sampling footprint fp (m) — vertex or fragment
 *   vec4 bcChopLEAN(vec2 xz, float lodBias)              fragment only: mean slope (xy) + unresolved slope
 *                                                         variance (zw), anti-aliased by the pixel footprint
 *   vec4 bcChopLEANGrad(vec2 xz, vec2 ex, vec2 ey, float lodBias)   same with an explicit footprint
 */
export const CHOP_GLSL = guard('BC_CHOP', /* glsl */ `
precision highp sampler2DArray;
uniform sampler2DArray uOceanD, uOceanS;
uniform vec3 uOceanL;
uniform vec4 uOceanAmp;
const mat2 BC_OCR0 = ${m2(RC[0])};
const mat2 BC_OCR1 = ${m2(RC[1])};
const mat2 BC_OCR2 = ${m2(RC[2])};
const vec3 BC_OCC2 = vec3(${(RC[0][0] ** 2).toFixed(7)}, ${(RC[1][0] ** 2).toFixed(7)}, ${(RC[2][0] ** 2).toFixed(7)});
vec2 bcOcVar(vec2 v, float c2) { return vec2(c2 * v.x + (1.0 - c2) * v.y, (1.0 - c2) * v.x + c2 * v.y); }

vec3 bcChopDisp(vec2 xz, float fp, out vec2 slope) {
  vec3 d = vec3(0.0); slope = vec2(0.0);
  float lf = log2(max(fp, 1e-4) * ${OCEAN.N}.0) + 0.5;
  float l0 = lf - log2(uOceanL.x), l1 = lf - log2(uOceanL.y), l2 = lf - log2(uOceanL.z);
  vec3 a = uOceanAmp.xyz;
  vec4 D = textureLod(uOceanD, vec3(BC_OCR0 * xz / uOceanL.x, 0.0), l0);
  vec4 S = textureLod(uOceanS, vec3(BC_OCR0 * xz / uOceanL.x, 0.0), l0);
  d.y = D.y * a.x; d.xz = (D.xz * BC_OCR0) * a.x; slope += (S.xy * BC_OCR0) * a.x;
  if (l1 < 8.0) {
    float keep = 1.0 - smoothstep(6.0, 8.0, l1);
    D = textureLod(uOceanD, vec3(BC_OCR1 * xz / uOceanL.y, 1.0), l1); S = textureLod(uOceanS, vec3(BC_OCR1 * xz / uOceanL.y, 1.0), l1);
    d.y += D.y * a.y * keep; d.xz += (D.xz * BC_OCR1) * a.y * keep; slope += (S.xy * BC_OCR1) * a.y * keep;
  }
  if (l2 < 8.0) {
    float keep = 1.0 - smoothstep(6.0, 8.0, l2);
    D = textureLod(uOceanD, vec3(BC_OCR2 * xz / uOceanL.z, 2.0), l2); S = textureLod(uOceanS, vec3(BC_OCR2 * xz / uOceanL.z, 2.0), l2);
    d.y += D.y * a.z * keep; d.xz += (D.xz * BC_OCR2) * a.z * keep; slope += (S.xy * BC_OCR2) * a.z * keep;
  }
  return d;
}

#ifndef BC_VERTEX_ONLY
// The pixel footprint on a far sea is extremely anisotropic; beyond the hardware's anisotropic filter
// the slope texture aliases into hatching, so the footprint's minor axis is widened to keep the ratio <= 6
// (the lost detail becomes LEAN variance: roughness, not noise).
// ex, ey: the pixel footprint (d xz / d screen x, y). bcChopLEAN() takes it from dFdx(xz); pass a smooth
// estimate yourself (bcChopLEANGrad) when xz comes from a displaced mesh whose per-triangle derivatives jump.
vec4 bcChopLEANGrad(vec2 xz, vec2 ex, vec2 ey, float lodBias) {
  float lx = length(ex), ly = length(ey);
  float lmaj = max(max(lx, ly), 1e-6);
  if (lx < lmaj / 6.0) ex = (lx > 1e-7 ? ex / lx : vec2(1.0, 0.0)) * (lmaj / 6.0);
  if (ly < lmaj / 6.0) ey = (ly > 1e-7 ? ey / ly : vec2(0.0, 1.0)) * (lmaj / 6.0);
  float kb = exp2(lodBias); ex *= kb; ey *= kb;
  vec4 s0 = textureGrad(uOceanS, vec3(BC_OCR0 * xz / uOceanL.x, 0.0), BC_OCR0 * ex / uOceanL.x, BC_OCR0 * ey / uOceanL.x);
  vec4 s1 = textureGrad(uOceanS, vec3(BC_OCR1 * xz / uOceanL.y, 1.0), BC_OCR1 * ex / uOceanL.y, BC_OCR1 * ey / uOceanL.y);
  vec4 s2 = textureGrad(uOceanS, vec3(BC_OCR2 * xz / uOceanL.z, 2.0), BC_OCR2 * ex / uOceanL.z, BC_OCR2 * ey / uOceanL.z);
  vec3 a = uOceanAmp.xyz;
  vec2 m = (s0.xy * BC_OCR0) * a.x + (s1.xy * BC_OCR1) * a.y + (s2.xy * BC_OCR2) * a.z;
  vec2 v = bcOcVar(max(s0.zw - s0.xy * s0.xy, 0.0), BC_OCC2.x) * a.x * a.x
         + bcOcVar(max(s1.zw - s1.xy * s1.xy, 0.0), BC_OCC2.y) * a.y * a.y
         + bcOcVar(max(s2.zw - s2.xy * s2.xy, 0.0), BC_OCC2.z) * a.z * a.z;
  return vec4(m, v);
}
vec4 bcChopLEAN(vec2 xz, float lodBias) { return bcChopLEANGrad(xz, dFdx(xz), dFdy(xz), lodBias); }
#endif
`);

export const BATHY_CHUNK = guard('BC_BATHY', BATHY_GLSL);
export const AMBIENT_CHUNK = guard('BC_AMBIENT', AMBIENT_GLSL);

// ---------------------------------------------------------------- water optics
/**
 * struct BcWater { vec3 P; vec3 N; vec3 V; vec2 sig2; float thick; float foam; float glow; }
 *   P world position · N unit shading normal · V unit vector toward the eye
 *   sig2  unresolved slope variance (world x, z), e.g. bcChopLEAN().zw; 0 = only micro roughness
 *   thick optical thickness hint (m) of the water the view ray crosses before leaving through the back
 *         (lip, thin crest); < 0 = trace the refracted ray to the sea floor (bcDepth)
 *   foam  0..1 foam coverage, shaded warm on top · glow 0..1 extra backlit crest in-scatter
 * BcWater bcWater(vec3 P, vec3 N, vec3 V)          defaults (sig2 0, thick -1, foam 0, glow 0)
 * vec3 bcShadeWaterNoHaze(BcWater w)               scene-linear radiance
 * vec3 bcShadeWater(BcWater w)                     + aerial haze toward the horizon (bcHaze)
 * vec3 bcShadeFoam(vec3 N)                         foam radiance (warm-tinted)
 */
export const WATER_SHADE_GLSL = guard('BC_WATER_SHADE', /* glsl */ `
#ifndef BC_VERTEX_ONLY
uniform vec3 uDeepColor;      // in-scatter radiance of optically deep water
uniform vec3 uWaterAtten;     // extinction (1/m)
uniform vec3 uGlowTint;       // colour of sunlight forward-scattered through thin crests / lips
uniform vec3 uBedAlbedo;      // sand / reef albedo
uniform vec4 uWaterOptics;    // x micro roughness (slope std), y glint sparkle gain, z lip glow gain, w sun specular cap
uniform vec4 uWaterOptics2;   // x sea slope std (shadowing of reflected rays), y min glint slope std, z foam warmth, w reflection gain

struct BcWater { vec3 P; vec3 N; vec3 V; vec2 sig2; float thick; float foam; float glow; };
BcWater bcWater(vec3 P, vec3 N, vec3 V) {
  BcWater w; w.P = P; w.N = N; w.V = V; w.sig2 = vec2(0.0); w.thick = -1.0; w.foam = 0.0; w.glow = 0.0; return w;
}

vec3 bcSeaBelow() { return uDeepColor * 1.1 + vec3(0.02, 0.03, 0.03); }
vec3 bcSkyRefl(vec3 d) { return mix(bcSeaBelow(), bcSkyBase(vec3(d.x, max(d.y, 0.0), d.z)), smoothstep(-0.06, 0.01, d.y)); }

// Reflection integrated over the visible slope distribution in the view plane (5 taps).
vec4 bcRoughReflection(vec3 N, vec3 V, float sigV, float sigS) {
  float mu0 = clamp(dot(N, V), -1.0, 1.0);
  vec3 e = V - N * mu0;
  float le = length(e);
  e = le > 1e-5 ? e / le : vec3(0.0, 0.0, 1.0);
  float d0 = asin(mu0);
  float sLo = max(-3.0 * sigV, tan(-d0 + 0.002));
  float sHi = 3.2 * sigV;
  if (sHi <= sLo) { sLo = tan(-d0 + 0.002); sHi = sLo + 0.1; }
  vec3 acc = vec3(0.0); float fAcc = 0.0, wAcc = 0.0;
  float s0 = max(sLo, 0.0);
  float iv = 0.5 / max(sigV * sigV, 1e-6);
  for (int i = 0; i < 5; i++) {
    float s = mix(sLo, sHi, (float(i) + 0.5) / 5.0);
    vec3 n = normalize(N + s * e);
    float mu = dot(n, V);
    if (mu <= 0.0) continue;
    float g = exp(-min((s * s - s0 * s0) * iv, 60.0));
    float w = g * mu / max(dot(n, N), 1e-3);
    vec3 r = reflect(-V, n);
    float F = bcFresnelWater(mu);
    float G = bcSmithG1(r.y / max(length(r.xz), 1e-4), sigS);
    acc += w * F * mix(bcSeaBelow(), bcSkyRefl(r), G);
    fAcc += w * F; wAcc += w;
  }
  if (wAcc < 1e-12) { vec3 r = reflect(-V, N); return vec4(bcSkyRefl(r), bcFresnelWater(max(dot(N, V), 0.0))); }
  return vec4(acc / wAcc, fAcc / wAcc);
}

vec3 bcShadeFoam(vec3 N) {
  float wrap = clamp((dot(N, uSunDir) + 0.8) / 1.8, 0.0, 1.0);
  vec3 albedo = mix(vec3(0.92, 0.94, 0.93), vec3(1.0, 0.90, 0.80), uWaterOptics2.z);
  return albedo * (uSunColor * wrap / 3.14159 + bcSkyAmbient(N) * 1.1);
}

vec3 bcShadeWaterNoHaze(BcWater s) {
  vec3 N = s.N, V = s.V, L = uSunDir;
  if (dot(N, V) < 0.0) N = -N;                    // thin sheets: shade the side facing the eye
  float NoV = max(dot(N, V), 1e-4);
  float micro = uWaterOptics.x;
  vec2 var2 = max(s.sig2, vec2(0.0)) + micro * micro;
  // ---------------- reflection (sky)
  vec3 e = normalize(V - N * dot(N, V) + vec3(0.0, 1e-5, 0.0));
  float sigV = sqrt(var2.x * e.x * e.x + var2.y * e.z * e.z + micro * micro * e.y * e.y);
  vec4 rr = bcRoughReflection(N, V, sigV, uWaterOptics2.x);
  vec3 refl = rr.rgb * uWaterOptics2.w;
  float F = rr.a;
  // ---------------- sun: anisotropic Beckmann lobe with the same slope statistics (the sun path)
  vec3 H = normalize(V + L);
  float NoL = max(dot(N, L), 0.0);
  float cH = max(dot(H, N), 0.05);
  vec3 Ht = H / cH - N;
  vec3 tX = normalize(vec3(1.0, 0.0, 0.0) - N * N.x + vec3(0.0, 1e-5, 0.0));
  vec3 tZ = normalize(cross(tX, N));
  vec2 sl = vec2(dot(Ht, tX), dot(Ht, tZ));
  vec2 varG = max(var2, vec2(uWaterOptics2.y * uWaterOptics2.y));
  float ex = min(0.5 * (sl.x * sl.x / varG.x + sl.y * sl.y / varG.y), 80.0);
  float Dsun = exp(-ex) / (6.2831853 * sqrt(varG.x * varG.y) * cH * cH * cH * cH);
  float Fs = bcFresnelWater(max(dot(V, H), 0.0));
  float sG = sqrt(max(varG.x, varG.y));
  float Gs = bcSmithG1(NoV / sqrt(max(1.0 - NoV * NoV, 1e-4)), sG) * bcSmithG1(NoL / sqrt(max(1.0 - NoL * NoL, 1e-4)), sG);
  vec3 sunMean = uSunColor * min(Dsun * Fs * Gs * 0.25 / max(NoV, 0.05), uWaterOptics.w);
  // world-anchored capillary sparkle (continuous in time, filtered by the pixel footprint)
  float footprint = max(length(dFdx(s.P)), length(dFdy(s.P)));
  float keep = 1.0 - smoothstep(0.03, 0.6, footprint);
  vec3 q = s.P * vec3(3.1, 6.0, 3.1) + vec3(0.11, -0.32, -0.24) * uTime * 3.0;
  float n = 0.68 * bcVnoise3(q) + 0.32 * bcVnoise3(q.yzx * 1.73 + vec3(13.2, 7.1, 21.9));
  float sparkle = pow(max(n, 0.0), 6.0) * 16.0;
  vec3 sunSpec = sunMean * mix(1.0, 0.45 + sparkle * uWaterOptics.y, keep);
  // ---------------- transmission (body colour)
  vec3 sigT = uWaterAtten;
  vec3 Lin = uDeepColor;
  vec3 body;
  vec3 Tr = refract(-V, N, 1.0 / 1.333);
  if (s.thick < 0.0) {
    // refracted ray traced to the sea floor (bathymetry): Beer-Lambert over the bed -> shallow tint
    float depth = bcDepth(s.P.xz);
    float hC = max(s.P.y + depth, 0.0);
    float ty = max(-Tr.y, 0.12);
    float path = hC / ty;
    vec3 T = exp(-sigT * path);
    float cs = sqrt(max(1.0 - (1.0 - L.y * L.y) / (1.333 * 1.333), 0.0));   // refracted sun cosine
    vec3 bedP = s.P + Tr * path;
    float patchy = 0.75 + 0.35 * bcVnoise(bedP.xz * 0.08) + 0.15 * bcVnoise(bedP.xz * 0.6);
    vec3 Tsun = exp(-sigT * hC / max(cs, 0.2));
    vec3 Tsky = exp(-sigT * hC * 1.25);
    vec3 bed = uBedAlbedo * patchy * (uSunColor * cs * Tsun / 3.14159 + uSkyAmb * Tsky * 0.8);
    body = bed * T + Lin * (1.0 - T);
  } else {
    // thin sheet (lip / crest): light leaves through the back; forward-scattered sunlight glows
    float path = s.thick / max(NoV * 0.55 + 0.45, 0.25);
    vec3 T = exp(-sigT * path);
    float phase = 0.18 + 0.82 * pow(max(dot(-V, L), 0.0), 5.0);
    vec3 glow = uGlowTint * bcLuma(uSunColor) * uWaterOptics.z * 0.30 * phase;
    vec3 scatter = mix(Lin, glow, 0.55 * exp(-0.22 * path));
    vec3 behindDir = -V;
    vec3 behind = behindDir.y > 0.0 ? bcSkyBase(behindDir) : Lin;
    body = behind * T + scatter * (1.0 - T);
  }
  // backlit crest in-scatter requested by the caller (wave faces under a thin crest)
  float phaseC = 0.18 + 0.82 * pow(max(dot(-V, L), 0.0), 5.0);
  body += uGlowTint * bcLuma(uSunColor) * uWaterOptics.z * 0.12 * phaseC * clamp(s.glow, 0.0, 1.0);
  vec3 col = body * (1.0 - F) + refl + sunSpec;
  // ---------------- foam
  col = mix(col, bcShadeFoam(normalize(mix(N, vec3(0.0, 1.0, 0.0), 0.3))), clamp(s.foam, 0.0, 1.0));
  return col;
}
vec3 bcShadeWater(BcWater s) { return bcHaze(bcShadeWaterNoHaze(s), s.P); }
#endif
`);

/** Everything the optics need, in dependency order (sky, bathymetry, ambient, chop, helpers, optics). */
export function waterShadingChunk() {
  return SKY_GLSL + WATER_COMMON_GLSL + BATHY_CHUNK + AMBIENT_CHUNK + CHOP_GLSL + WATER_SHADE_GLSL;
}
export const WATER_SHADING_GLSL = waterShadingChunk();

/**
 * Uniform objects used by the chunk. Create ONE set (app.waterUniforms) and spread it into every
 * material: the objects are shared, so a value set once (sun, time, FFT textures) reaches every shader.
 */
export function createWaterUniforms(sky = createSkyUniforms()) {
  const a = DEFAULT_CFG.ambient;
  return {
    ...sky,
    uAmbient: { value: new THREE.Vector4(a.amp, a.period, a.amp2, a.period2) },
    uOceanD: { value: null },
    uOceanS: { value: null },
    uOceanL: { value: new THREE.Vector3(...OCEAN.L) },
    uOceanAmp: { value: new THREE.Vector4(1, 1, 1, 0) },
    uDeepColor: { value: new THREE.Vector3(0.004, 0.034, 0.036) },
    uWaterAtten: { value: new THREE.Vector3(0.42, 0.075, 0.095) },
    uGlowTint: { value: new THREE.Vector3(0.12, 1.0, 0.78) },
    uBedAlbedo: { value: new THREE.Vector3(0.62, 0.55, 0.40) },
    uWaterOptics: { value: new THREE.Vector4(0.06, 1.0, 1.0, 900.0) },
    uWaterOptics2: { value: new THREE.Vector4(0.17, 0.07, 0.6, 0.85) },
  };
}
export { OCEAN_CHOP };
