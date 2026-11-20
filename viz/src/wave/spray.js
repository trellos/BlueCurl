// BlueCurl Swell — analytic wave spray (WP4b): GL points, one draw per spraying front, ≤ SPRAY_PER_FRONT each.
//
// Every particle is a pure function of (front state, its id, t): particle id → kind, lifetime and phase; the
// emission cycle = floor((tl + phase) / period) seeds the rest (hash, no Math.random). Emission time te = start of
// the cycle. The emitter picks one of the front's active zone breaks and a target break phase tauT; inverting
// breakStartTime (linear peel / close-out) gives the crest column u that was at tauT at te, verified with
// bcColumn(u, te) (kills sections mismatches). Position at emission = the lip tip (sigma = BC_SIGMA_LIP) at te from
// bcLocal + the crest x at te (a short history table of crest x, uploaded per frame from the sim's path);
// velocity = lip velocity (finite difference) + a kind-specific kick. Motion: exponential drag toward the wind +
// gravity, closed form. Kinds:
//   0 feather  (55 %)  thrown off the lip during the throw (tau 0.1…0.6), blown back by the offshore wind
//   1 crash    (31 %)  launched at the plunge (tau 0.56…0.85) from the landing lip
//   2 mist     (14 %)  soft puffs rising and growing at the impact (tau 0.6…1.0)
// Shading: two-lobe Henyey–Greenstein 0.7·HG(cosθ, 0.75) + 0.3·HG(cosθ, −0.2) of the low sun; backlit droplets go
// well above the bloom threshold; premultiplied-alpha blending, no depth writes.
import * as THREE from 'three';
import { SKY_GLSL } from '../sky/skyModel.js';
import { AMBIENT_CHUNK } from '../water/waterShading.glsl.js';
import { PROFILE_GLSL } from './profile.glsl.js';
import { FRONT_W } from '../contracts.js';

export const SPRAY_PER_FRONT = 4800;
export const SPRAY_MAX_FRONTS = 6;            // ≤ 28.8k particles
export const XHIST_N = 12;
export const XHIST_DT = 0.3;                  // s; table covers tl − 3.1 … tl + 0.2
export const SPRAY_LIFE_MAX = 3.0;

export function makeSprayGeometry(n = SPRAY_PER_FRONT) {
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) pos[i * 3] = i;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return g;
}

export function createSprayUniforms() {
  return {
    uXHist: { value: new Float32Array(XHIST_N) },
    uXHistT: { value: new THREE.Vector2(0, XHIST_DT) },
    uSprayB: { value: new THREE.Vector4(0, 0, 0, 0) },
    uViewH: { value: 1080 },
  };
}

export function createSprayLookUniforms() {
  return {
    uSprayTune: { value: new THREE.Vector4(SPRAY_PER_FRONT, 1.6, 1.0, 1.0) },  // count, brightness, size, density
    uWind: { value: new THREE.Vector3(5.5, 0.6, 0.0) },                          // offshore (toward +X), m/s
  };
}

const VERT = /* glsl */ `
#define BC_VERTEX_ONLY
uniform float uFrontTime;
uniform float uAlpha;
uniform float uXHist[${XHIST_N}];
uniform vec2 uXHistT;
uniform vec4 uSprayB;
uniform vec4 uSprayTune;
uniform vec3 uWind;
uniform float uViewH;
out vec4 vCol;
flat out float vKind;
flat out float vSeed;
${SKY_GLSL}
${AMBIENT_CHUNK}
${PROFILE_GLSL}

uint spPcg(uint v) { uint s = v * 747796405u + 2891336453u; uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
float spRnd(inout uint s) { s = spPcg(s); return float(s >> 8u) * (1.0 / 16777216.0); }
float spCrestX(float tl) {
  float f = clamp((tl - uXHistT.x) / uXHistT.y, 0.0, ${XHIST_N - 1}.0 - 0.001);
  int i = int(f);
  return mix(uXHist[i], uXHist[i + 1], f - float(i));
}
float spHG(float c, float g) { float g2 = g * g; return (1.0 - g2) / (12.566371 * pow(1.0 + g2 - 2.0 * g * c, 1.5)); }

void main() {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  gl_PointSize = 0.0;
  vCol = vec4(0.0); vKind = 0.0; vSeed = 0.0;
  int nb = int(uSprayB.w + 0.5);
  if (nb <= 0 || uAlpha <= 0.0) return;
  float id = position.x, N = uSprayTune.x, tl = uFrontTime;
  int kind = id < N * 0.55 ? 0 : (id < N * 0.86 ? 1 : 2);
  uint s0 = spPcg(uint(id) * 9781u + 17u);
  float life = kind == 0 ? mix(0.8, 1.5, spRnd(s0)) : kind == 1 ? mix(0.9, 1.7, spRnd(s0)) : mix(1.8, ${SPRAY_LIFE_MAX.toFixed(1)}, spRnd(s0));
  float period = life * 1.12;
  float ph = spRnd(s0) * period;
  float cyc = floor((tl + ph) / period);
  float te = cyc * period - ph;
  float age = tl - te;
  if (age > life || age < 0.0) return;
  uint s = spPcg(uint(id) * 7919u + uint(int(cyc) + 100000) * 104729u);

  int k = min(int(spRnd(s) * float(nb)), nb - 1);
  int bi = int(k == 0 ? uSprayB.x : k == 1 ? uSprayB.y : uSprayB.z);
  vec4 A = uFrontZB[bi * 3], B = uFrontZB[bi * 3 + 1], C = uFrontZB[bi * 3 + 2];
  float Tb = B.z;
  float tauT = kind == 0 ? mix(0.1, 0.6, spRnd(s)) : kind == 1 ? mix(0.56, 0.85, spRnd(s)) : mix(0.6, 1.0, spRnd(s));
  float dtc = te - tauT * Tb - A.x;                     // column start relative to tBreak
  if (dtc < 0.0) return;
  bool clo = C.y > 0.5;
  float sd = clo ? 80.0 * dtc : B.y * dtc;
  if (!clo && sd > B.w) return;
  float sgn = (B.x == 0.0 || clo) ? (spRnd(s) < 0.5 ? -1.0 : 1.0) : B.x;
  float u = A.y + sgn * sd / ${FRONT_W.toFixed(1)} + (spRnd(s) - 0.5) * 1.2 / ${FRONT_W.toFixed(1)};
  if (u < A.z || u > A.w) return;
  BCCol c = bcColumn(u, te);
  if (c.zi != C.w || abs(c.tau - tauT) > 0.15) return;
  float H = c.H;
  float str = kind == 0 ? H * (0.3 + 0.7 * max(c.curl, c.steep)) : H * (0.35 + 0.65 * c.curl);
  float keep = clamp(str * uSprayTune.w * (kind == 2 ? 0.3 : 0.38) - 0.12, 0.0, 1.0);
  if (spRnd(s) > keep) return;

  // emission point: lip tip at te, lip velocity by finite difference
  float th; BCCol c2;
  vec4 P0 = bcLocal(u, BC_SIGMA_LIP, te, th, c2);
  vec4 P1 = bcLocal(u, BC_SIGMA_LIP, te + 0.04, th, c2);
  float xe0 = spCrestX(te), xe1 = spCrestX(te + 0.04);
  float z = BC_FRONT_Z0 + u * BC_FRONT_W;
  vec3 p0 = vec3(xe0 - P0.x, P0.y, z);
  p0.y += bcAmbient(p0.xz, te + uFrontTRef);
  vec3 vl = vec3((xe1 - P1.x) - (xe0 - P0.x), P1.y - P0.y, 0.0) / 0.04;
  float hs = sqrt(max(H, 0.2) / 2.5);
  float r1 = spRnd(s), r2 = spRnd(s), r3 = spRnd(s), r4 = spRnd(s);
  vec3 v0, vw; float kd, gr, size, a0;
  bool veil = kind == 0 && fract(id * 0.618034) < 0.4;    // soft veil puffs blown off the lip
  if (kind == 0) {
    v0 = vl * 0.55 + vec3(mix(0.0, 2.0, r1), mix(1.5, 5.0, r2) * hs, (r3 - 0.5) * 1.6);
    vw = uWind; kd = 1.5; gr = 6.5; size = mix(0.025, 0.07, r4); a0 = 0.9;
    if (veil) { size = mix(0.35, 0.9, r4) * hs * (0.6 + age / life); a0 = 0.1; gr = 2.5; }
  } else if (kind == 1) {
    v0 = vl * 0.3 + vec3(mix(-1.0, -5.0, r1), mix(3.0, 9.5, r2) * hs, (r3 - 0.5) * 5.0);
    vw = uWind * 0.4; kd = 0.8; gr = 9.81; size = mix(0.035, 0.11, r4); a0 = 0.85;
    p0 += vec3(0.0, -0.15 * H, 0.0);
  } else {
    p0 += vec3((r3 - 0.5) * 1.5 * hs, -0.2 * H, (spRnd(s) - 0.5) * 2.0);
    v0 = vec3(mix(-1.0, -3.0, r1), mix(0.8, 2.6, r2) * hs, (spRnd(s) - 0.5) * 1.5);
    vw = uWind * 0.3 + vec3(0.0, 0.3, 0.0); kd = 1.1; gr = 0.25; size = mix(1.2, 2.6, r4) * hs * (0.55 + 0.8 * age / life); a0 = 0.2;
  }
  float e = exp(-kd * age);
  vec3 p = p0 + vw * age + (v0 - vw) * (1.0 - e) / kd - vec3(0.0, gr, 0.0) * (age / kd - (1.0 - e) / (kd * kd));

  float fade = kind == 2 ? smoothstep(0.0, 0.35, age) * (1.0 - smoothstep(0.3 * life, life, age))
                         : smoothstep(0.0, 0.05, age) * (1.0 - smoothstep(0.55 * life, life, age));
  fade *= smoothstep(-0.5, 0.05, p.y - bcAmbient(p.xz, tl + uFrontTRef));
  fade *= uAlpha;
  if (fade <= 0.002) return;

  vec4 mv = viewMatrix * vec4(p, 1.0);
  float dist = max(-mv.z, 0.1);
  size *= uSprayTune.z;
  if (kind < 2 && !veil) size = max(size, dist * 0.0022);
  float px = size * projectionMatrix[1][1] * uViewH * 0.5 / dist;
  // phase of the low sun: cosθ between light travel (−L) and the direction toward the eye
  vec3 V = normalize(cameraPosition - p);
  float cth = dot(-uSunDir, V);
  float phase = 0.7 * spHG(cth, 0.75) + 0.3 * spHG(cth, -0.2);
  bool soft = kind == 2 || veil;
  vec3 rad = uSunColor * phase * uSprayTune.y * 3.0 * (soft ? 0.45 : 1.0) + uSkyAmb * (soft ? 0.8 : 0.7);
  vCol = vec4(rad, a0 * fade);
  vKind = soft ? 2.0 : float(kind);
  vSeed = float(s & 1023u) / 1023.0;
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(px, 1.0, 900.0);
}`;

const FRAG = /* glsl */ `
uniform sampler2D uFoamTex;
in vec4 vCol;
flat in float vKind;
flat in float vSeed;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(q, q);
  if (r2 > 1.0) discard;
  float m;
  if (vKind < 1.5) m = smoothstep(1.0, 0.35, r2);
  else {
    float n = texture(uFoamTex, gl_PointCoord * 0.45 + vec2(vSeed, fract(vSeed * 7.13))).r;
    m = exp(-r2 * 2.5) * (1.0 - r2) * (0.35 + 1.1 * n);
  }
  float a = clamp(vCol.a * m, 0.0, 1.0);
  gl_FragColor = vec4(vCol.rgb * a, a * 0.8);
}`;

export function makeSprayMaterial(waterUniforms, frontUniforms, sprayUniforms, lookUniforms, foamTexUniform) {
  return new THREE.ShaderMaterial({
    name: 'bcSpray',
    uniforms: { ...waterUniforms, ...frontUniforms, ...sprayUniforms, ...lookUniforms, uFoamTex: foamTexUniform },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
}

/** Indices of the zone breaks of `front` that can have live spray at t (≤ 3). Pure. */
export function activeSprayBreaks(front, t, out = []) {
  out.length = 0;
  const br = front.breaks || [];
  for (let b = 0; b < Math.min(3, br.length); b++) {
    const zb = br[b];
    let span;
    if (zb.closeout) span = Math.max(Math.abs(zb.u0 - zb.uPeak), Math.abs(zb.u1 - zb.uPeak)) * FRONT_W / 80;
    else span = (Number.isFinite(zb.peelLen) ? zb.peelLen : 200) / Math.max(zb.vPeel, 0.5);
    const t0 = zb.tBreak + 0.1 * zb.Tb, t1 = zb.tBreak + span + zb.Tb + SPRAY_LIFE_MAX;
    if (t >= t0 && t <= t1) out.push(b);
  }
  return out;
}

/** Fill the crest-x history table: xAt(tLocal) → crest x; table starts at tl − 3.1 s. */
export function fillCrestHistory(xAt, tl, hist, histT) {
  const t0 = tl - (XHIST_N - 2) * XHIST_DT - 0.1;
  for (let i = 0; i < XHIST_N; i++) hist[i] = xAt(t0 + i * XHIST_DT);
  histT.set(t0, XHIST_DT);
}
