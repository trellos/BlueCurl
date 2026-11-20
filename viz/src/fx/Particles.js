// Analytic GPU particles (WP5). One instanced draw: NE emitter slots × PARTICLES_PER_EMITTER camera-facing quads.
// Each particle's position is evaluated in the vertex shader from (emitter origin, emit time, seed, k, t) with the
// closed-form trajectory of fxMath.particleLocal (mirrored 1:1 below). No per-frame state, no dt integration.
import * as THREE from 'three';
import { PARTICLE, PARTICLES_PER_EMITTER } from './fxMath.js';
import { PREMULT } from './Sprites.js';

export const NE = 48;                                       // emitter slots (≤ 15 360 particles)

const f = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));
const kindGLSL = (P, i) => `
  if (kind == ${i}) { sp0 = ${f(P.speed[0])}; sp1 = ${f(P.speed[1])}; el0 = ${f(P.elev[0])}; el1 = ${f(P.elev[1])};
    drag = ${f(P.drag)}; g = ${f(P.g)}; lf0 = ${f(P.life[0])}; lf1 = ${f(P.life[1])}; sz0 = ${f(P.size[0])}; sz1 = ${f(P.size[1])};
    along = ${f(P.along)}; I0 = ${f(P.I[0])}; I1 = ${f(P.I[1])}; }`;

export const HASH_GLSL = /* glsl */ `
// contracts.hash01 in GLSL (uint multiply wraps like Math.imul)
float hash01(int a, int b, int c) {
  uint h = (uint(a) * 0x27d4eb2du) ^ (uint(b) * 0x165667b1u) ^ (uint(c) * 0x9e3779b1u);
  h = (h ^ (h >> 15u)) * 0x85ebca6bu; h = (h ^ (h >> 13u)) * 0xc2b2ae35u; h ^= h >> 16u;
  return min(float(h) / 4294967296.0, 0.99999994);
}`;

const VERT = /* glsl */ `
#define NE ${NE}
#define NP ${PARTICLES_PER_EMITTER}
uniform vec4 uE0[NE];   // origin xyz (world), t0
uniform vec4 uE1[NE];   // size (style), seed, kind, count
uniform vec4 uE2[NE];   // rgb tint (warm), accent mix
uniform float uTime;
uniform float uPxM;     // metres per pixel at 1 m view depth
out vec2 vQ;
out vec3 vCol;
${HASH_GLSL}
void main() {
  int id = gl_InstanceID, slot = id / NP, k = id - slot * NP;
  vec4 e0 = uE0[slot], e1 = uE1[slot];
  float age = uTime - e0.w;
  int kind = int(e1.z + 0.5), seed = int(e1.y + 0.5);
  float size = e1.x;
  if (float(k) >= e1.w || age < 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vQ = vec2(0.0); vCol = vec3(0.0); return; }
  float sp0, sp1, el0, el1, drag, g, lf0, lf1, sz0, sz1, along, I0, I1;
  ${PARTICLE.map(kindGLSL).join('\n')}
  float r0 = hash01(seed, k, 0), r1 = hash01(seed, k, 1), r2 = hash01(seed, k, 2), r3 = hash01(seed, k, 3);
  float r4 = hash01(seed, k, 4), r5 = hash01(seed, k, 5), r6 = hash01(seed, k, 6);
  float sc = 0.55 + 0.45 * size;
  float speed = mix(sp0, sp1, r0 * r0 * 0.6 + r0 * 0.4) * sc;
  float el = mix(el0, el1, r1), az = 6.283185307 * r2;
  float life = mix(lf0, lf1, r3) * (0.7 + 0.3 * size);
  float a = age - 0.06 * r4;
  if (a < 0.0 || a >= life) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vQ = vec2(0.0); vCol = vec3(0.0); return; }
  float ce = cos(el);
  vec3 v = vec3(speed * ce * cos(az), speed * sin(el), speed * ce * sin(az) * along);
  float e = (1.0 - exp(-drag * a)) / drag;
  vec3 p = vec3(v.x * e, (v.y + g / drag) * e - g * a / drag, v.z * e);
  float fl = clamp(a / life, 0.0, 1.0);
  float bright = mix(I0, I1, r6) * pow(1.0 - fl, 1.5);
  float psize = mix(sz0, sz1, r5) * (0.6 + 0.4 * size);
  // twinkle (deterministic in t)
  bright *= 0.55 + 0.45 * sin(a * (16.0 + 22.0 * r5) + 6.283 * r3);
  vec4 mv = modelViewMatrix * vec4(e0.xyz + p, 1.0);
  float pxm = uPxM * max(1.0, -mv.z);
  float hw = max(psize, 1.6 * pxm);
  bright *= min(1.0, psize / hw * 1.6 + 0.35);                       // keep sub-pixel sparkles from blowing out
  mv.xy += position.xy * hw;
  mv.z += min(6.0, 0.02 * -mv.z);                                    // slight depth bias toward the camera
  gl_Position = projectionMatrix * mv;
  vQ = position.xy;
  vec4 e2 = uE2[slot];
  // burst: the lane colour, a few pale sparkles (e2.a = fraction kept saturated); splash: white-cyan
  vec3 c = kind == 1 ? mix(vec3(0.75, 0.95, 1.0), vec3(1.0), r6) : mix(e2.rgb, mix(e2.rgb, vec3(1.0, 0.95, 0.85), 0.55), step(e2.a, r6));
  vCol = c * bright * smoothstep(6.0, 30.0, -mv.z);
}`;

const FRAG = /* glsl */ `
uniform float uGain;   // day cycle: 1 / post exposure
in vec2 vQ;
in vec3 vCol;
void main() {
  float r2 = dot(vQ, vQ);
  if (r2 > 1.0) discard;
  float a = exp(-r2 * 5.0) + 0.6 * exp(-r2 * 30.0);
  gl_FragColor = vec4(vCol * a * uGain, clamp(0.5 * a * min(1.0, dot(vCol, vec3(0.5))), 0.0, 0.7) * min(1.0, uGain));
}`;

export class Particles {
  constructor() {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.instanceCount = 0;
    this.geometry = g;
    const arr = () => Array.from({ length: NE }, () => new THREE.Vector4());
    this.uniforms = { uE0: { value: arr() }, uE1: { value: arr() }, uE2: { value: arr() }, uTime: { value: 0 }, uPxM: { value: 0.001 }, uGain: { value: 1 } };
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, uniforms: this.uniforms,
      transparent: true, depthWrite: false, depthTest: true, ...PREMULT,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
    this.n = 0;
  }
  begin() { this.n = 0; }
  /** Add an emitter; returns false when the slots are full. */
  add(x, y, z, t0, size, seed, kind, count, rgb, accentMix) {
    if (this.n >= NE) return false;
    const i = this.n++;
    this.uniforms.uE0.value[i].set(x, y, z, t0);
    this.uniforms.uE1.value[i].set(size, seed, kind, count);
    this.uniforms.uE2.value[i].set(rgb[0], rgb[1], rgb[2], accentMix);
    return true;
  }
  end(t, pxm) {
    for (let i = this.n; i < NE; i++) this.uniforms.uE1.value[i].w = 0;
    this.uniforms.uTime.value = t;
    this.uniforms.uPxM.value = pxm;
    // draw only the used slots
    this.geometry.instanceCount = this.n * PARTICLES_PER_EMITTER;
  }
  dispose() { this.geometry.dispose(); this.material.dispose(); }
}
