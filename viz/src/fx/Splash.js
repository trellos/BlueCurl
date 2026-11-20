// BlueCurl Swell — massive note splash (WP13). One instanced draw: NS splash slots × KS particles, every particle a
// closed-form function of (splash params, k, age) in the vertex shader (no per-frame state):
//   k   0..159  jet       tall water column: blobs launched straight up at a spread of speeds (G, vJet as splashMath)
//   k 160..279  crown     sheet thrown out at 50–75° from a ring round the base
//   k 280..447  drops     heavy droplets shed from the jet top, motion-stretched, backlit sparkle
//   k 448..495  mist      big soft sprites rising and drifting, glowing gold against the dawn sun
//   k 496..511  foam      flat on the water: expanding ring, central patch, blotches where the crown lands
// Lit by the low dawn sun behind (Henyey-Greenstein forward scattering → golden translucent rims), a flash of the
// note's lane colour inside the base of the column. Premultiplied 'over' blending (white water occludes).
import * as THREE from 'three';
import { HASH_GLSL } from './Particles.js';
import { PREMULT } from './Sprites.js';
import { SPLASH } from './splashMath.js';

export const NS = 32;              // splash slots (newest win)
export const KS = 512;             // particles per splash
const f = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));

const VERT = /* glsl */ `
#define NS ${NS}
#define KS ${KS}
uniform vec4 uS0[NS];   // x, water y, z, t0
uniform vec4 uS1[NS];   // H (m), S (lateral scale), seed, g (m/s²)
uniform vec4 uS2[NS];   // lane rgb, lane flash gain
uniform float uTime;
uniform float uPxM;
uniform vec3 uSunDir;
uniform vec3 uSunC;    // day cycle: sun colour on white water (dawn 1.0, 0.72, 0.45; follows the sun, 0 below the horizon)
uniform vec3 uAmbC;    // sky light on white water (dawn 1.0, 0.95, 0.9; follows the sky ambient)
uniform float uGain;   // 1/exposure for the emissive note flash / sparkle
out vec2 vQ;
out vec4 vCol;          // body colour × coverage, coverage
out vec3 vRim;          // backlit rim colour × coverage (blobs: edges glow where the sun shines through)
out vec3 vSunV;         // toward-the-sun, view space
flat out int vMode;     // 0 blob, 1 streak, 2 foam ring, 3 foam patch
out float vSeed;
${HASH_GLSL}
void cull() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vQ = vec2(0.0); vCol = vec4(0.0); vRim = vec3(0.0); vSunV = vec3(0.0); vMode = 0; vSeed = 0.0; }
void main() {
  int id = gl_InstanceID, slot = id / KS, k = id - slot * KS;
  vec4 s0 = uS0[slot], s1 = uS1[slot], s2 = uS2[slot];
  float age = uTime - s0.w;
  if (s1.x <= 0.0 || age < 0.0 || age > ${f(SPLASH.life)}) { cull(); return; }
  float H = s1.x, S = s1.y, G = s1.w;
  int seed = int(s1.z + 0.5);
  float r0 = hash01(seed, k, 0), r1 = hash01(seed, k, 1), r2 = hash01(seed, k, 2), r3 = hash01(seed, k, 3);
  float r4 = hash01(seed, k, 4), r5 = hash01(seed, k, 5);
  float vJ = sqrt(2.0 * G * H);
  vec3 p = vec3(0.0), vel = vec3(0.0);
  float size = 1.0, cover = 0.8, bright = 1.0, minPx = 1.5, flash = 0.0, sparkle = 0.0;
  int mode = 0;
  float az = 6.2831853 * r2;
  vec2 dir = vec2(cos(az), sin(az));
  if (k < 160) {                                        // ---- jet
    float ta = age - 0.10 * r4 * r4;
    float vy = vJ * mix(0.16, 1.0, pow(r0, 1.25));
    float tl = 2.0 * vy / G;
    if (ta < 0.0 || ta > tl) { cull(); return; }
    float top = vy / vJ;
    // a spire: wide churning base, narrow fast top; falling water spreads into a curtain
    float fall = max(0.0, ta - vy / G);
    float rad = (0.2 + 1.0 * sqrt(r1)) * S * (1.0 - 0.7 * top) + (0.15 + 0.6 * r1) * S * ta + (0.6 + 1.6 * r1) * S * fall;
    p = vec3(dir.x * rad, vy * ta - 0.5 * G * ta * ta, dir.y * rad);
    vel = vec3(0.0, vy - G * ta, 0.0);
    float u = ta / tl;
    size = S * (0.75 + 0.9 * r3) * mix(1.6, 0.5, top) * (0.8 + 0.5 * u);
    cover = mix(0.95, 0.75, top * top) * (1.0 - smoothstep(0.7, 1.0, u));
    bright = 0.9 + 0.35 * r5;
    flash = exp(-ta / 0.35) * (1.0 - top * 0.6);
    minPx = 2.0;
  } else if (k < 280) {                                 // ---- crown sheet
    float ta = age - 0.04 * r4;
    float el = mix(0.85, 1.3, r1);
    float sp = sqrt(G * H) * mix(0.42, 0.72, r0);
    float vy = sp * sin(el);
    float tl = 2.0 * vy / G;
    if (ta < 0.0 || ta > tl) { cull(); return; }
    float rad = 0.9 * S + sp * cos(el) * ta;
    p = vec3(dir.x * rad, vy * ta - 0.5 * G * ta * ta, dir.y * rad);
    vel = vec3(dir.x * sp * cos(el), vy - G * ta, dir.y * sp * cos(el));
    float u = ta / tl;
    size = S * (0.55 + 0.6 * r3) * (0.8 + 0.6 * u);
    cover = 0.55 * (1.0 - smoothstep(0.75, 1.0, u));
    bright = 1.0 + 0.3 * r5;
    minPx = 1.6;
  } else if (k < 448) {                                 // ---- drops (shed from the jet top)
    float d = 0.55 * r4 * r4;
    float y0 = max(0.0, vJ * d - 0.5 * G * d * d);
    float ta = age - d;
    float sp = sqrt(G * H) * mix(0.3, 0.9, r0);
    float el = mix(0.45, 1.4, r1);
    vec3 v0 = vec3(dir.x * sp * cos(el), sp * sin(el), dir.y * sp * cos(el));
    float tl = (v0.y + sqrt(v0.y * v0.y + 2.0 * G * y0)) / G;
    if (ta < 0.0 || ta > tl) { cull(); return; }
    p = vec3(0.0, y0, 0.0) + v0 * ta + vec3(0.0, -0.5 * G * ta * ta, 0.0);
    p.xz += dir * 0.6 * S;
    vel = v0 + vec3(0.0, -G * ta, 0.0);
    size = S * mix(0.16, 0.36, r3);
    cover = 0.9 * (1.0 - smoothstep(0.85, 1.0, ta / tl));
    bright = 1.2 + 0.6 * r5;
    sparkle = step(0.55, r5) * (0.55 + 0.45 * sin(ta * (18.0 + 20.0 * r3) + 6.283 * r2));
    mode = 1;
    minPx = 1.3;
  } else if (k < 496) {                                 // ---- mist
    float ta = age - 0.12 - 0.6 * r4;
    float life = 2.0 + 1.8 * r3;
    if (ta < 0.0 || ta > life) { cull(); return; }
    float u = ta / life;
    float rad = (1.0 + 5.0 * r1) * S * (0.4 + 1.0 - exp(-ta / 1.2));
    float yy = H * mix(0.08, 0.75, r0) * smoothstep(0.0, 0.9, ta + 0.2) + 1.2 * ta;
    p = vec3(dir.x * rad - 1.4 * ta, yy, dir.y * rad + 0.4 * ta);
    size = S * (1.6 + 2.2 * r2) * (0.6 + 0.8 * u);
    cover = 0.07 * smoothstep(0.0, 0.25, u) * (1.0 - smoothstep(0.4, 1.0, u));
    bright = 1.0;
    minPx = 3.0;
  } else {                                              // ---- foam on the water
    int j = k - 496;
    p.y = 0.12;
    if (j == 0) {                                       // expanding ring
      size = S * (3.0 + 15.0 * (1.0 - exp(-age / 1.1)));
      cover = 0.75 * exp(-age / 2.0);
      mode = 2;
    } else if (j == 1) {                                // churned patch at the base
      size = S * (2.5 + 7.0 * (1.0 - exp(-age / 0.7)));
      cover = 0.85 * exp(-age / 2.4);
      mode = 3;
    } else {                                            // blotches where the crown comes down
      float ta = age - (0.7 + 0.9 * r0);
      if (ta < 0.0) { cull(); return; }
      float rad = S * (3.0 + 9.0 * r1);
      p.xz = dir * rad;
      size = S * (1.6 + 2.2 * r3) * (0.7 + 0.6 * (1.0 - exp(-ta / 0.6)));
      cover = 0.7 * smoothstep(0.0, 0.15, ta) * exp(-ta / 1.6);
      mode = 3;
    }
    bright = 1.0;
    minPx = 2.0;
  }
  if (cover < 0.004) { cull(); return; }
  vec3 wp = s0.xyz + p;
  vec4 mv = modelViewMatrix * vec4(wp, 1.0);
  float depth = max(1.0, -mv.z);
  float pxm = uPxM * depth;
  float hw = max(size, minPx * pxm);
  // sub-pixel shrink: spread the coverage instead of blowing it up
  cover *= min(1.0, (size / hw) * 1.5 + 0.4);
  if (mode == 0) {                                      // clump, stretched along its motion (streaky water)
    vec4 m1 = modelViewMatrix * vec4(wp - vel * 0.11, 1.0);
    vec2 d = mv.xy - m1.xy;
    float len = min(length(d), 2.5 * hw);
    vec2 ax = len > 1e-4 ? normalize(d) : vec2(0.0, 1.0);
    mv.xy += ax * position.y * (hw + 0.5 * len) + vec2(-ax.y, ax.x) * position.x * hw;
  } else if (mode == 1) {                               // velocity-stretched streak (motion blur ~45 ms)
    vec4 m1 = modelViewMatrix * vec4(wp - vel * 0.045, 1.0);
    vec2 d = mv.xy - m1.xy;
    float len = length(d);
    vec2 ax = len > 1e-4 ? d / len : vec2(0.0, 1.0);
    vec2 sd = vec2(-ax.y, ax.x);
    vec2 c = 0.5 * (mv.xy + m1.xy);
    mv.xy = c + ax * position.x * (0.5 * len + hw) + sd * position.y * hw;
  } else {                                              // flat on the water
    vec3 fp = wp + vec3(position.x * size, 0.0, position.y * size);
    mv = modelViewMatrix * vec4(fp, 1.0);
  }
  mv.z += min(3.0, 0.01 * depth);
  gl_Position = projectionMatrix * mv;
  vQ = position.xy;
  vMode = mode;
  vSeed = float(seed % 997) * 0.37 + float(k) * 1.31;

  // ---- lighting: sky/ambient white water + forward-scattered sun (we look toward the sunrise: backlit)
  vec3 V = normalize(wp - cameraPosition);
  float mu = dot(V, normalize(uSunDir));
  float g = 0.6;
  float hg = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * mu, 1.5);   // 0.25 … 16 (×4π normalised)
  hg = min(hg, 3.0);                                   // no white blow-out in the sun-glare column
  float glare = smoothstep(0.93, 0.995, mu);           // looking straight into the sun: tone the body down
  vec3 amb = uAmbC;                                    // sky on white water (dawn: warm)
  vec3 sunC = uSunC;
  float thin = mode == 1 ? 1.0 : (k < 280 ? 0.6 : 0.9); // jet blobs are thick: less light through
  vec3 col = amb * (1.3 * bright * (1.0 - 0.3 * glare)) + sunC * hg * 0.12 * thin;
  vec3 rim = sunC * hg * 0.45 * thin;
  if (k >= 448 && k < 496) { col = amb * 1.0 + sunC * hg * 0.4; rim = vec3(0.0); } // mist: scattered sunlight
  if (mode == 1) { col += sunC * hg * 0.2; rim = vec3(0.0); }
  if (mode >= 2) { col = vec3(0.95, 0.97, 0.98) * 1.35 * dot(amb, vec3(0.333)) + sunC * 0.1 * hg; rim = vec3(0.0); }
  col += s2.rgb * s2.a * flash * 2.6 * uGain;                  // the note's colour lighting the column base
  col += vec3(1.0, 0.86, 0.6) * sparkle * (2.0 + 2.5 * min(1.0, hg * 0.2)) * uGain;
  // near fade (PiP / close cams): don't flood the frame
  float nf = smoothstep(4.0, 16.0, depth);
  vCol = vec4(col * cover * nf, cover * nf);
  vRim = rim * cover * nf;
  vSunV = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
}`;

const FRAG = /* glsl */ `
in vec2 vQ;
in vec4 vCol;
in vec3 vRim;
in vec3 vSunV;
flat in int vMode;
in float vSeed;
float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
}
void main() {
  vec2 q = vQ;
  float r2 = dot(q, q), a;
  vec3 col = vCol.rgb;
  if (vMode == 0) {                       // lumpy water clump: fake sphere normal, shadowed front, glowing backlit rim
    float n = vnoise(q * 3.0 + vSeed);
    float rr = r2 + 0.4 * (n - 0.5);
    if (rr > 1.0) discard;
    a = smoothstep(1.0, 0.2, rr);
    vec3 nn = vec3(q, sqrt(max(0.0, 1.0 - min(r2, 1.0))));
    float lit = 0.8 + 0.2 * dot(nn, vSunV) + 0.25 * (n - 0.5);
    float edge = pow(1.0 - nn.z, 1.3);
    col = col * lit + vRim * (0.45 + 0.9 * edge);
  } else if (vMode == 1) {                // streak
    a = exp(-q.y * q.y * 3.5) * (1.0 - q.x * q.x);
  } else {
    float r = sqrt(r2);
    if (r > 1.0) discard;
    float n = vnoise(q * 7.0 + vSeed) * 0.6 + vnoise(q * 17.0 - vSeed) * 0.4;
    if (vMode == 2) { float d = (r - 0.82) / 0.13; a = exp(-d * d) * smoothstep(0.25, 0.7, n + 0.15 * (1.0 - r)); }
    else a = smoothstep(1.0, 0.35, r) * smoothstep(0.3, 0.75, n + 0.25 * (1.0 - r));
  }
  a = clamp(a, 0.0, 1.0);
  gl_FragColor = vec4(col * a, clamp(vCol.a * a, 0.0, 0.95));
}`;

export class Splash {
  constructor() {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.instanceCount = 0;
    this.geometry = g;
    const arr = () => Array.from({ length: NS }, () => new THREE.Vector4());
    this.uniforms = { uS0: { value: arr() }, uS1: { value: arr() }, uS2: { value: arr() }, uTime: { value: 0 },
      uPxM: { value: 0.001 }, uSunDir: { value: new THREE.Vector3(0.99, 0.1, -0.06) },
      uSunC: { value: new THREE.Vector3(1.0, 0.72, 0.45) }, uAmbC: { value: new THREE.Vector3(1.0, 0.95, 0.9) }, uGain: { value: 1 } };
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, uniforms: this.uniforms,
      transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide, ...PREMULT,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 19;
    this.n = 0;
  }
  begin() { this.n = 0; }
  /** sp = splashParams; y = water height; seed int; col = lane rgb; gain = lane flash gain. */
  add(sp, y, seed, col, gain) {
    if (this.n >= NS) return false;
    const i = this.n++;
    this.uniforms.uS0.value[i].set(sp.x, y, sp.z, sp.t0);
    this.uniforms.uS1.value[i].set(sp.H, sp.S, seed, sp.g);
    this.uniforms.uS2.value[i].set(col[0], col[1], col[2], gain);
    return true;
  }
  /**
   * Day cycle: gain = 1/exposure (emissive flash / sparkles); sunK / skyK = sun / sky light relative to dawn (lit white
   * water, scene-linear like the sea's foam); sunTint / skyTint = hue relative to dawn; sunUp 0..1 (above the horizon).
   */
  setLight(gain = 1, sunK = 1, skyK = 1, sunTint = [1, 1, 1], skyTint = [1, 1, 1], sunUp = 1) {
    const u = this.uniforms;
    u.uGain.value = gain;
    u.uSunC.value.set(1.0 * sunTint[0], 0.72 * sunTint[1], 0.45 * sunTint[2]).multiplyScalar(sunK * sunUp);
    u.uAmbC.value.set(1.0 * skyTint[0], 0.95 * skyTint[1], 0.9 * skyTint[2]).multiplyScalar(skyK);
  }
  end(t, pxm, sunDir) {
    for (let i = this.n; i < NS; i++) this.uniforms.uS1.value[i].x = 0;
    this.uniforms.uTime.value = t;
    this.uniforms.uPxM.value = pxm;
    if (sunDir) this.uniforms.uSunDir.value.copy(sunDir);
    this.geometry.instanceCount = this.n * KS;
  }
  dispose() { this.geometry.dispose(); this.material.dispose(); }
}
