// Dawn-patrol sky model: one analytic GLSL function shared by the sky dome, the water's reflections,
// the aerial haze and the environment map, so every surface sees the same sky.
//
// Structure (sun lobe / aureole terms, sky reflection used by the water) follows ShoreBreak's
// src/glsl/common.js SKY chunk and src/sky/skyModel.js skyAureole(), Copyright (c) 2026 Christopher
// Canavan, MIT License (see viz/THIRD_PARTY.md). The colours are new: a warm, saturated sunrise
// with the sun ~6° up, east-south-east, behind the swell as seen from the headland.
import * as THREE from 'three';

// Compass azimuth (deg clockwise from north = +Z, east = +X) and elevation of the sun.
export const SUN = { elevationDeg: 6.0, azimuthDeg: 108.0 };

/** Unit vector toward the sun (world: +X east, +Y up, +Z north). */
export function sunDirection(sun = SUN, out = new THREE.Vector3()) {
  const el = THREE.MathUtils.degToRad(sun.elevationDeg), az = THREE.MathUtils.degToRad(sun.azimuthDeg);
  return out.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).normalize();
}

// Scene-linear radiometry (exposure 1 → the post maps ~0.18 to mid grey).
export const SUN_COLOR = [3.6, 1.75, 0.62];      // low sun: red/orange after a long air path
export const SKY_AMB = [0.30, 0.25, 0.33];       // diffuse sky radiance seen by an up-facing surface

export function createSkyUniforms() {
  return {
    uSunDir: { value: sunDirection() },
    uSunColor: { value: new THREE.Vector3(...SUN_COLOR) },
    uSkyAmb: { value: new THREE.Vector3(...SKY_AMB) },
    // x: overall sky gain, y: cloud amount, z: haze e-folding distance (m), w: max haze
    uSkyTune: { value: new THREE.Vector4(1.0, 1.0, 3800.0, 0.7) },
    uTime: { value: 0 },
  };
}

// Requires nothing but the uniforms below. Guarded so several chunks can include it.
export const SKY_GLSL = /* glsl */ `
#ifndef BC_SKY_GLSL
#define BC_SKY_GLSL
uniform vec3 uSunDir;     // unit, toward the sun
uniform vec3 uSunColor;   // sun irradiance (Lambert: albedo * uSunColor * NoL / PI)
uniform vec3 uSkyAmb;     // sky ambient radiance for an up-facing white Lambertian surface
uniform vec4 uSkyTune;    // x gain, y cloud amount, z haze distance (m), w max haze
uniform float uTime;

// Clear-sky radiance in direction d (no clouds, no sun disc): what the water reflects.
vec3 bcSkyBase(vec3 d) {
  float h = max(d.y, 0.0);
  vec2 hd = d.xz / max(length(d.xz), 1e-5);
  vec2 hs = uSunDir.xz / max(length(uSunDir.xz), 1e-5);
  float side = 0.5 + 0.5 * dot(hd, hs);                    // 1 toward the sun's azimuth, 0 away
  float g = acos(clamp(dot(d, uSunDir), -1.0, 1.0));       // angle to the sun (rad)
  // horizon band: hot gold-orange under the sun, through coral to dusty magenta / lilac behind
  vec3 hzSun  = vec3(3.10, 1.05, 0.20);
  vec3 hzMid  = vec3(1.15, 0.36, 0.20);
  vec3 hzAnti = vec3(0.36, 0.17, 0.30);
  float sideK = smoothstep(0.5, 1.0, side);
  vec3 hz = mix(mix(hzAnti, hzMid, smoothstep(0.0, 0.65, side)), hzSun, sideK * sideK);
  // mid sky: amber toward the sun, violet behind; zenith: deep dawn blue
  vec3 mid = mix(vec3(0.10, 0.07, 0.20), vec3(0.95, 0.36, 0.20), pow(side, 3.0));
  vec3 zen = vec3(0.022, 0.045, 0.15);
  vec3 c = mix(hz, mid, 1.0 - exp(-h * 11.0));
  c = mix(c, zen, 1.0 - exp(-h * 3.0));
  // Mie aureole around the low sun (forward-peaked aerosol scattering)
  c += uSunColor * (0.55 * exp(-g / 0.03) + 0.20 * exp(-g / 0.11) + 0.07 * exp(-g / 0.40));
  // slight darkening just above the horizon away from the sun (Earth's shadow / Belt of Venus)
  float belt = exp(-pow((degrees(asin(h)) - 3.0) / 3.0, 2.0)) * (1.0 - side);
  c *= 1.0 - 0.25 * belt;
  c += vec3(0.20, 0.08, 0.14) * exp(-pow((degrees(asin(h)) - 8.0) / 5.0, 2.0)) * (1.0 - side);   // pink band above it
  return c * uSkyTune.x;
}

// Sky radiance below the horizon (only reachable past the rim of the sea, or by reflected rays
// going down): the horizon haze, darkened.
vec3 bcSkyBelow(vec3 d) {
  vec3 hz = bcSkyBase(normalize(vec3(d.x, 0.0, d.z)));
  return mix(hz, hz * 0.35, smoothstep(0.0, 0.08, -d.y));
}

float bcSkyHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float bcSkyNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(bcSkyHash(i), bcSkyHash(i + vec2(1, 0)), u.x), mix(bcSkyHash(i + vec2(0, 1)), bcSkyHash(i + vec2(1, 1)), u.x), u.y);
}
float bcSkyFbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * bcSkyNoise(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p; a *= 0.5; }
  return s;
}

// Stylised dawn clouds: streaky altocumulus decks lit from below by the low sun. Returns rgb (radiance)
// and alpha (coverage).
vec4 bcClouds(vec3 d) {
  if (d.y < 0.002 || uSkyTune.y <= 0.0) return vec4(0.0);
  vec2 q = d.xz / (d.y + 0.035);                              // flat cloud layer
  q = mat2(0.80, 0.60, -0.60, 0.80) * q;
  vec2 drift = vec2(0.004, 0.0015) * uTime;
  float n = bcSkyFbm(q * vec2(0.55, 2.4) + drift);
  float n2 = bcSkyFbm(q * vec2(1.7, 5.0) - drift * 1.7 + 7.3);
  // decks: a band low over the horizon and patchy higher streaks
  float band = smoothstep(0.015, 0.06, d.y) * (1.0 - smoothstep(0.16, 0.45, d.y));
  float hi = smoothstep(0.16, 0.30, d.y) * (1.0 - smoothstep(0.55, 0.9, d.y));
  float cover = clamp(band * 0.9 + hi * 0.6, 0.0, 1.0) * uSkyTune.y;
  float dens = smoothstep(0.56, 0.80, n * 0.75 + n2 * 0.35) * cover;
  if (dens <= 0.0) return vec4(0.0);
  float g = acos(clamp(dot(d, uSunDir), -1.0, 1.0));
  // undersides: lit by the sun from below the deck -> hot pink-gold toward the sun, violet behind
  vec2 hd = d.xz / max(length(d.xz), 1e-5), hs = uSunDir.xz / max(length(uSunDir.xz), 1e-5);
  float side = 0.5 + 0.5 * dot(hd, hs);
  vec3 under = mix(vec3(0.075, 0.035, 0.10), vec3(0.95, 0.26, 0.12), pow(side, 2.5));
  under = mix(under, vec3(0.55, 0.16, 0.28), 0.35 * smoothstep(0.08, 0.3, d.y) * (1.0 - side));  // magenta high decks
  // gold lining: thin edges close to the sun glow (forward scattering through thin cloud)
  float thin = 1.0 - smoothstep(0.0, 0.7, dens);
  vec3 lining = uSunColor * (2.2 * exp(-g / 0.12) + 0.45 * exp(-g / 0.40)) * thin * thin;
  vec3 col = under * (0.6 + 0.6 * n2) + lining;
  return vec4(col * uSkyTune.x, clamp(dens * 1.3, 0.0, 0.97));
}

#ifndef BC_VERTEX_ONLY
// Full sky (dome): base + clouds; disc = 1 adds the sun disc (enlarged, stylised). Fragment only.
vec3 bcSky(vec3 d, float disc) {
  if (d.y < 0.0) return bcSkyBelow(d);
  vec3 c = bcSkyBase(d);
  float g = acos(clamp(dot(d, uSunDir), -1.0, 1.0));
  const float RS = 0.0085;                                   // ~1° disc radius (stylised, real 0.27°)
  float pxA = max(fwidth(g), 1e-5);
  float sd = 1.0 - smoothstep(RS - pxA, RS + pxA, g);
  float limb = sqrt(max(1.0 - (g / RS) * (g / RS), 0.0));
  // horizon extinction: the disc reddens and dims toward the horizon
  c += disc * uSunColor * vec3(1.0, 0.92, 0.8) * 45.0 * sd * (0.55 + 0.45 * limb);
  vec4 cl = bcClouds(d);
  c = mix(c, cl.rgb, cl.a);
  return c;
}
#endif

// Diffuse sky irradiance / PI for normal N (upper hemisphere dominated, slight warm sea bounce).
vec3 bcSkyAmbient(vec3 N) {
  vec3 ground = vec3(0.05, 0.06, 0.07);
  return mix(ground, uSkyAmb, 0.55 + 0.45 * N.y);
}

// Aerial perspective toward the horizon: distant surfaces fade into the horizon colour of their azimuth.
vec3 bcHaze(vec3 col, vec3 P) {
  vec3 dv = P - cameraPosition;
  float dist = length(dv);
  float f = (1.0 - exp(-dist / uSkyTune.z)) * uSkyTune.w;
  vec3 dir = dv / max(dist, 1e-4);
  vec3 hz = bcSkyBase(normalize(vec3(dir.x, max(dir.y, 0.0) * 0.5 + 0.004, dir.z)));
  return mix(col, hz, f);
}
#endif
`;
