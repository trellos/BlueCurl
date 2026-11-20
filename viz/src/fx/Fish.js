// BlueCurl Swell — beat fish (WP15): instanced reef fish seen THROUGH the water, plus their soft shadows on the bed.
//
// The fish is drawn after the (opaque) sea as a premultiplied overlay at its real underwater position, but its depth
// is taken where the view ray crosses the water surface (+ a margin over the chop): the sea never hides it, anything
// above the water (riders, wave faces, foam, land) still does, and nothing pokes through the surface. Its colour is
// what the water would show if the fish were the sea bed: sunlight refracted down to it and attenuated by the water
// above it (Beer–Lambert with the sea's own uWaterAtten), a flickering caustic net on its back, sky light from above,
// then the view path through the water (deep colour in-scatter) and the surface Fresnel. The silhouette is soft
// (fades as the surface turns edge-on), a wobble of the refracting surface shifts it a little.
// Sun / sky / water colours are the shared waterUniforms (driven by app.sun through the day cycle).
import * as THREE from 'three';
import { PREMULT } from './Sprites.js';
import { WATER_COMMON_GLSL, AMBIENT_CHUNK } from '../water/waterShading.glsl.js';
import { SKY_GLSL } from '../sky/skyModel.js';

export const MAX_FISH = 16;

/**
 * Fish geometry, length 1 (+X forward, head at x = +0.5), +Y up, +Z right. Attributes: aT 0 (snout) … 1 (tail tip),
 * aM material: 0 body, 1 fin (accent), 2 eye, 3 pectoral fin (flaps).
 */
export function makeFishGeometry() {
  const pos = [], nrm = [], at = [], am = [];
  const push = (p, n, t, m) => { pos.push(p[0], p[1], p[2]); nrm.push(n[0], n[1], n[2]); at.push(t); am.push(m); };
  const tri = (a, b, c, n, m) => { for (const p of [a, b, c]) push(p, n, (0.5 - p[0]) / 1.06, m); };
  // body: elliptic rings from the snout (x 0.5) to the tail root (x −0.36)
  const NS = 14, NR = 12;
  const ring = [];
  for (let i = 0; i <= NS; i++) {
    const u = i / NS, x = 0.5 - 0.86 * u;
    const prof = Math.pow(Math.sin(Math.PI * Math.min(1, Math.pow(u, 0.62) * 0.93 + 0.035)), 0.85);
    const hh = Math.max(0.03, 0.2 * prof), hw = Math.max(0.022, 0.105 * prof);
    const yc = 0.015 * Math.sin(Math.PI * u);              // slight hump
    const r = [];
    for (let j = 0; j < NR; j++) {
      const a = (j / NR) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      const n = [0, s / hh, c / hw], nl = Math.hypot(...n);
      r.push({ p: [x, yc + hh * s, hw * c], n: [n[0] / nl, n[1] / nl, n[2] / nl] });
    }
    ring.push(r);
  }
  for (let i = 0; i < NS; i++) for (let j = 0; j < NR; j++) {
    const a = ring[i][j], b = ring[i][(j + 1) % NR], c = ring[i + 1][(j + 1) % NR], d = ring[i + 1][j];
    for (const [p, q, r] of [[a, d, c], [a, c, b]]) for (const v of [p, q, r]) push(v.p, v.n, (0.5 - v.p[0]) / 1.06, 0);
  }
  // snout cap
  const tip = [0.53, 0.0, 0];
  for (let j = 0; j < NR; j++) { const a = ring[0][j], b = ring[0][(j + 1) % NR]; push(tip, [1, 0, 0], 0, 0); push(b.p, b.n, 0.03, 0); push(a.p, a.n, 0.03, 0); }
  // eyes
  for (const sd of [-1, 1]) {
    const ex = 0.36, ey = 0.05, ez = sd * 0.07, r = 0.028;
    for (let k = 0; k < 8; k++) {
      const a0 = (k / 8) * Math.PI * 2, a1 = ((k + 1) / 8) * Math.PI * 2;
      tri([ex, ey, ez + sd * 0.004], [ex + r * Math.cos(a0), ey + r * Math.sin(a0), ez], [ex + r * Math.cos(a1), ey + r * Math.sin(a1), ez], [0, 0, sd], 2);
    }
  }
  // fins (thin, two-sided by the shader): dorsal, anal, forked tail, pectorals
  const up = [0, 0, 1];
  tri([0.28, 0.17, 0], [-0.3, 0.06, 0], [-0.12, 0.3, 0], up, 1);
  tri([0.28, 0.17, 0], [-0.12, 0.3, 0], [0.12, 0.27, 0], up, 1);
  tri([0.02, -0.16, 0], [-0.3, -0.06, 0], [-0.2, -0.24, 0], up, 1);
  tri([-0.34, 0.035, 0], [-0.58, 0.23, 0], [-0.47, 0.0, 0], up, 1);
  tri([-0.34, -0.035, 0], [-0.47, 0.0, 0], [-0.58, -0.23, 0], up, 1);
  tri([-0.34, 0.035, 0], [-0.47, 0.0, 0], [-0.34, -0.035, 0], up, 1);
  for (const sd of [-1, 1]) tri([0.24, -0.06, sd * 0.09], [0.06, -0.08, sd * 0.24], [0.1, -0.06, sd * 0.09], [0, 1, 0], 3);
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('aT', new THREE.Float32BufferAttribute(at, 1));
  g.setAttribute('aM', new THREE.Float32BufferAttribute(am, 1));
  return g;
}

// surface plane used for the depth of everything under it: ambient swell + this margin (covers the FFT chop)
const SURFACE_GLSL = /* glsl */ `
float fishSurfaceY(vec2 xz) { return bcAmbient(xz, uTime); }
// clip-space z/w of the point where the ray camera → W crosses the surface plane (+ margin)
float fishSurfaceDepth(vec3 W) {
  vec3 C = cameraPosition;
  float ys = fishSurfaceY(W.xz) + 0.8;
  vec3 S = W;
  if (C.y > ys && W.y < ys) S = C + (W - C) * ((C.y - ys) / (C.y - W.y));
  vec4 cs = projectionMatrix * viewMatrix * vec4(S, 1.0);
  return cs.z / cs.w;
}
// refraction wobble of the surface above (a few cm, slow)
vec2 fishWobble(vec3 W) {
  return 0.2 * vec2(sin(0.85 * W.z + 2.2 * uTime + 0.6 * sin(0.5 * W.x - 1.1 * uTime)),
                     sin(0.8 * W.x - 1.8 * uTime + 1.3 + 0.6 * sin(0.45 * W.z + 0.9 * uTime)));
}`;

const FISH_VERT = /* glsl */ `
uniform float uTime;
${AMBIENT_CHUNK}
${SURFACE_GLSL}
in float aT;
in float aM;
in vec4 iP;    // x, z, depth below the surface (m), length (m)
in vec4 iH;    // heading x, heading z, pitch, bend (1/m)
in vec4 iW;    // tail phase, amplitude, alpha, bands (0/1)
in vec3 iC;    // body albedo
in vec3 iA;    // accent albedo
out vec3 vW;
out vec3 vN;
out vec3 vAlb;
out float vAlpha;
out float vFin;
out float vSurf;
void main() {
  vec3 p = position, n = normal;
  float s = aT;
  // swimming wave: lateral displacement growing toward the tail (≈ 0.85 waves per body)
  float k = 5.3;
  float A = iW.y * (0.012 + 0.16 * s * s);
  float ph = iW.x - k * s;
  float lat = A * sin(ph);
  float dlat = -A * k * cos(ph) - iW.y * 0.32 * s * sin(ph);    // d(lat)/d(s)
  // body bend from the turn (circle through the centre: offset = κ d² / 2, d in metres)
  float d = p.x * iP.w;
  lat += 0.5 * iH.w * d * d / iP.w;
  dlat += -iH.w * d * 1.06;
  p.z += lat;
  float rot = atan(dlat / 1.06);
  n.xz = mat2(cos(rot), sin(rot), -sin(rot), cos(rot)) * n.xz;
  if (aM > 2.5) p.y += 0.07 * sin(iW.x * 0.5 + p.z * 3.0) * (abs(p.z) - 0.09) / 0.15;   // pectoral flap
  // basis: heading (with pitch), up, right
  float cp = cos(iH.z), sp = sin(iH.z);
  vec3 f = normalize(vec3(iH.x * cp, sp, iH.y * cp));
  vec3 r = normalize(cross(f, vec3(0.0, 1.0, 0.0)));
  vec3 u = cross(r, f);
  vec3 C = vec3(iP.x, 0.0, iP.y);
  C.y = fishSurfaceY(C.xz) - iP.z;
  vec3 W = C + iP.w * (f * p.x + u * p.y + r * p.z);
  W.xz += fishWobble(W);
  vW = W;
  vN = normalize(f * n.x + u * n.y + r * n.z);
  // albedo: body / fins in the accent colour / clownfish bands / pale belly / dark eye
  vec3 alb = iC;
  if (aM > 0.5 && aM < 1.5) alb = iA;
  if (aM > 2.5) alb = mix(iC, iA, 0.6);
  float band = iW.w * (smoothstep(0.035, 0.0, abs(s - 0.2)) + smoothstep(0.04, 0.0, abs(s - 0.5)) + smoothstep(0.03, 0.0, abs(s - 0.76)));
  alb = mix(alb, iA, clamp(band, 0.0, 1.0) * step(aM, 0.5));
  if (aM < 0.5) alb = mix(alb, vec3(0.92, 0.9, 0.82), 0.2 * smoothstep(-0.04, -0.16, position.y));
  alb *= mix(1.0, 0.62, smoothstep(0.04, 0.19, position.y));     // countershaded: darker back
  if (aM > 1.5 && aM < 2.5) alb = vec3(0.02);
  vAlb = alb;
  vAlpha = iW.z;
  vFin = (aM > 0.5 && aM < 1.5) || aM > 2.5 ? 1.0 : 0.0;
  vSurf = fishSurfaceY(W.xz);
  gl_Position = projectionMatrix * viewMatrix * vec4(W, 1.0);
  gl_Position.z = fishSurfaceDepth(W) * gl_Position.w;
}`;

const FISH_FRAG = /* glsl */ `
${SKY_GLSL}
${WATER_COMMON_GLSL}
uniform vec3 uDeepColor;
uniform vec3 uWaterAtten;
in vec3 vW;
in vec3 vN;
in vec3 vAlb;
in float vAlpha;
in float vFin;
in float vSurf;
// caustic net: sharp bright ridges where two drifting noise layers cross
float fishCaustic(vec2 p, float t) {
  float a = bcVnoise(p * 0.55 + vec2(0.31 * t, 0.23 * t));
  float b = bcVnoise(p * 0.55 * 1.37 + vec2(-0.27 * t, 0.19 * t) + 7.3);
  float c = 1.0 - abs(a - b);
  return pow(c, 9.0);
}
void main() {
  vec3 V = normalize(cameraPosition - vW);
  vec3 N = normalize(vN);
  float nv = dot(N, V);
  if (nv < 0.0) N = -N;
  vec3 L = normalize(uSunDir);
  vec3 sigT = uWaterAtten * 1.5;      // a little murkier than the open sea: the fish takes on the water colour
  float dep = max(vSurf - vW.y, 0.02);
  // sunlight refracted into the water and attenuated down to the fish
  float cs = sqrt(max(1.0 - (1.0 - L.y * L.y) / (1.333 * 1.333), 0.0));
  vec3 Lw = normalize(vec3(L.x / 1.333, max(cs, 0.15), L.z / 1.333));
  float sunUp = smoothstep(-0.05, 0.08, L.y);
  vec3 Tsun = exp(-sigT * dep / max(cs, 0.25)) * sunUp;
  vec3 Tsky = exp(-sigT * dep * 1.25);
  float dif = clamp(dot(N, Lw) * 0.75 + 0.25, 0.0, 1.0);
  float caus = fishCaustic(vW.xz, uTime) * smoothstep(-0.2, 0.6, N.y);
  vec3 lit = vAlb * (uSunColor * Tsun * dif * (0.5 + 3.2 * caus) / 3.14159
                   + uSkyAmb * Tsky * (0.45 + 0.4 * N.y) + uDeepColor * 2.0);
  // view path up through the water (refracted), deep-water in-scatter, surface Fresnel
  float cosI = clamp(V.y, 0.02, 1.0);
  float sinT = sqrt(1.0 - cosI * cosI) / 1.333, cosT = sqrt(1.0 - sinT * sinT);
  vec3 T = exp(-sigT * dep / cosT);
  vec3 col = lit * T + uDeepColor * (1.0 - T);
  float F = bcFresnelWater(cosI);
  col = bcHaze(col, vW);
  // soft silhouette (no hard edge through the water), slightly dark rim
  float edge = vFin > 0.5 ? 0.75 : smoothstep(0.02, 0.4, abs(nv));
  col *= mix(0.6, 1.0, edge);
  // the water itself shows through a little (dst): the fish takes on the sea's colour
  float a = vAlpha * (1.0 - F) * mix(0.15, 0.72, edge) * (vFin > 0.5 ? 0.75 : 1.0);
  gl_FragColor = vec4(col * a, a);
}`;

const SHADOW_VERT = /* glsl */ `
uniform float uTime;
${AMBIENT_CHUNK}
${SURFACE_GLSL}
in vec4 iP;    // bed x, bed y, bed z, length
in vec4 iH;    // heading x, heading z, strength, -
out vec2 vQ;
out float vK;
void main() {
  vec3 f = vec3(iH.x, 0.0, iH.y), r = vec3(-iH.y, 0.0, iH.x);
  vec3 W = iP.xyz + iP.w * (f * position.x * 0.62 + r * position.y * 0.24);
  W.xz += fishWobble(W) * 1.6;
  vQ = position.xy;
  vK = iH.z;
  gl_Position = projectionMatrix * viewMatrix * vec4(W, 1.0);
  gl_Position.z = fishSurfaceDepth(W) * gl_Position.w;
}`;
const SHADOW_FRAG = /* glsl */ `
in vec2 vQ;
in float vK;
void main() {
  float r2 = dot(vQ, vQ);
  float a = vK * exp(-r2 * 2.2) * (1.0 - smoothstep(0.75, 1.0, r2));
  gl_FragColor = vec4(0.0, 0.0, 0.0, a);
}`;

export class Fish {
  /** waterUniforms: app.waterUniforms (shared sun / sky / water uniforms). */
  constructor(waterUniforms = null) {
    const mk = (n, k) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(n * k), k); a.setUsage(THREE.DynamicDrawUsage); return a; };
    const g = makeFishGeometry();
    this.aP = mk(MAX_FISH, 4); this.aH = mk(MAX_FISH, 4); this.aW = mk(MAX_FISH, 4); this.aC = mk(MAX_FISH, 3); this.aA = mk(MAX_FISH, 3);
    g.setAttribute('iP', this.aP); g.setAttribute('iH', this.aH); g.setAttribute('iW', this.aW); g.setAttribute('iC', this.aC); g.setAttribute('iA', this.aA);
    g.instanceCount = 0;
    this.geometry = g;
    const wu = waterUniforms || {};
    const own = (k, v) => wu[k] || { value: v };
    this.uniforms = {
      ...wu,
      uTime: own('uTime', 0), uAmbient: own('uAmbient', new THREE.Vector4(0.22, 12, 0.12, 17)),
      uSunDir: own('uSunDir', new THREE.Vector3(0.99, 0.1, -0.06)), uSunColor: own('uSunColor', new THREE.Vector3(3, 2, 1.2)),
      uSkyAmb: own('uSkyAmb', new THREE.Vector3(0.3, 0.25, 0.25)), uDeepColor: own('uDeepColor', new THREE.Vector3(0.004, 0.034, 0.036)),
      uWaterAtten: own('uWaterAtten', new THREE.Vector3(0.42, 0.075, 0.095)),
    };
    this.material = new THREE.ShaderMaterial({ vertexShader: FISH_VERT, fragmentShader: FISH_FRAG, uniforms: this.uniforms,
      transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide, ...PREMULT });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.name = 'fish';
    // bed shadows
    const sg = new THREE.InstancedBufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    sg.setIndex([0, 1, 2, 0, 2, 3]);
    this.sP = mk(MAX_FISH, 4); this.sH = mk(MAX_FISH, 4);
    sg.setAttribute('iP', this.sP); sg.setAttribute('iH', this.sH);
    sg.instanceCount = 0;
    this.shadowGeometry = sg;
    this.shadowMaterial = new THREE.ShaderMaterial({ vertexShader: SHADOW_VERT, fragmentShader: SHADOW_FRAG,
      uniforms: { uTime: this.uniforms.uTime, uAmbient: this.uniforms.uAmbient },
      transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide, ...PREMULT });
    this.shadow = new THREE.Mesh(sg, this.shadowMaterial);
    this.shadow.frustumCulled = false;
    this.shadow.renderOrder = 2;
    this.shadow.name = 'fishShadow';
    this.group = new THREE.Group();
    this.group.add(this.shadow, this.mesh);
    this.n = 0;
  }

  begin() { this.n = 0; }

  /** p = fishPose(), f = fish record, bed = { x, y, z } of its shadow, k = shadow strength. */
  add(p, f, bed, k) {
    if (this.n >= MAX_FISH || !(p.alpha > 0.002)) return;
    const i = this.n++;
    this.aP.array.set([p.x, p.z, p.depth, f.len], i * 4);
    this.aH.array.set([p.hx, p.hz, p.pitch, p.bend], i * 4);
    this.aW.array.set([p.tail, p.amp, p.alpha, f.accent === f.body ? 0 : (f.bands ? 1 : 0)], i * 4);
    this.aC.array.set(f.body, i * 3);
    this.aA.array.set(f.accent, i * 3);
    this.sP.array.set([bed.x, bed.y, bed.z, f.len], i * 4);
    this.sH.array.set([p.hx, p.hz, k, 0], i * 4);
  }

  end() {
    const up = (attrs, n) => { for (const a of attrs) { a.clearUpdateRanges(); if (n) { a.addUpdateRange(0, n * a.itemSize); a.needsUpdate = true; } } };
    up([this.aP, this.aH, this.aW, this.aC, this.aA, this.sP, this.sH], this.n);
    this.geometry.instanceCount = this.n;
    this.shadowGeometry.instanceCount = this.n;
    this.mesh.visible = this.n > 0;
    this.shadow.visible = this.n > 0;
  }

  dispose() { this.geometry.dispose(); this.material.dispose(); this.shadowGeometry.dispose(); this.shadowMaterial.dispose(); }
}
