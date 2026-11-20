// Front shimmer (WP5): light ON the water along each charged front's crest, a sun-glint style sparkly band of
// brightened water (not a line or beam). One flat band per front lying on the surface, three vertices across the
// crest (seaward edge, crest, shoreward edge), soft gaussian profile across, tapered ends, no hard edges.
// Per crest point (from Fx.js): glow level (soft brightening), glint level (sparkle density/brightness), tint,
// band half-width (m) and a fade (energy, break, depth, inside-the-point). The fragment shader draws twinkling
// glints in world space with LOD by screen footprint, so they stay sparkly from 50 m to the horizon.
// Premultiplied 'over' blending with low coverage, depth-tested with a bias toward the camera, no depth write.
import * as THREE from 'three';
import { PREMULT } from './Sprites.js';

export const RIB_PTS = 129;          // points along the crest (≈ 2.4 m apart)
export const MAX_RIBBONS = 10;
const ACROSS = 3;

const VERT = /* glsl */ `
in vec4 aLev;     // glow HDR, glint HDR, side (-1 seaward, 0 crest, +1 shoreward), fade
in vec3 aCol;     // tint
in vec2 aW;       // band half-width (m), extra half-width per metre of distance (keeps the band ≥ a few px far away)
uniform float uPxM;
out vec4 vLev;
out vec3 vCol;
out vec2 vXZ;
out float vNear;
void main() {
  vec3 p = position;
  float dist = length(cameraPosition - p);
  float hw = max(aW.x, aW.y * dist);
  // +side = shoreward = −x: the band spills down the face toward the viewer (glitter), less on the back
  p.x -= aLev.z * hw * (aLev.z > 0.0 ? 1.0 : 0.35);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  mv.z += min(10.0, 0.02 * -mv.z);
  gl_Position = projectionMatrix * mv;
  vLev = aLev;
  vCol = aCol;
  vXZ = p.xz;
  vNear = smoothstep(25.0, 80.0, dist);             // a close follow cam (PiP) sees no band
}`;

const FRAG = /* glsl */ `
in vec4 vLev;
in vec3 vCol;
in vec2 vXZ;
in float vNear;
uniform float uTime;
float h21(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
// twinkling glints on a jittered grid of cell size c (m)
float glintAt(vec2 p, float c, float t) {
  vec2 q = p / c, i = floor(q), f = fract(q) - 0.5;
  float h = h21(i), h2 = h21(i + 17.3);
  vec2 o = (vec2(h, h2) - 0.5) * 0.6;
  float d = length(f - o);
  float tw = max(0.0, sin(t * (5.0 + 7.0 * h2) + h * 40.0));
  return step(0.55, h) * smoothstep(0.32, 0.0, d) * tw * tw;
}
void main() {
  float v = vLev.z, fade = vLev.w * vNear;
  if (fade < 1e-3) discard;
  float t = uTime;
  // soft band across the crest (slightly brighter on the shoreward face)
  float across = exp(-v * v * (v < 0.0 ? 6.0 : 3.2)) * (1.0 - smoothstep(0.85, 1.0, abs(v)));
  // glint LOD from the screen footprint (keeps glints ~2-4 px wide at any distance)
  vec2 fw = fwidth(vXZ);
  float lod = log2(max(max(fw.x, fw.y) * 3.0 / 0.9, 1.0));
  float l0 = floor(lod), lf = lod - l0, c0 = 0.9 * exp2(l0);
  vec2 drift = vec2(0.0, t * 1.4);
  float g = mix(glintAt(vXZ + drift, c0, t), glintAt(vXZ + drift, 2.0 * c0, t), lf);
  // broken-up brightening: travelling shimmer × coarse patches, so the band never reads as a flat slab
  float shim = 0.6 + 0.4 * sin(vXZ.y * 0.21 - t * 3.7 + 2.5 * sin(vXZ.y * 0.05 + t * 0.9));
  vec2 pc = vXZ * vec2(0.08, 0.05) + vec2(0.0, t * 0.2), pi = floor(pc), pf = smoothstep(0.0, 1.0, fract(pc));
  float patches = mix(mix(h21(pi), h21(pi + vec2(1, 0)), pf.x), mix(h21(pi + vec2(0, 1)), h21(pi + vec2(1, 1)), pf.x), pf.y);
  shim *= 0.45 + 0.8 * patches;
  vec3 glowC = vCol * vLev.x * across * shim;
  vec3 glintC = mix(vCol, vec3(1.0, 0.97, 0.9), 0.5) * vLev.y * g * across;
  vec3 col = (glowC + glintC) * fade;
  float cover = clamp(0.05 * across * min(1.0, vLev.x) + 0.5 * g * across * min(1.0, vLev.y * 0.5), 0.0, 0.6) * fade;
  gl_FragColor = vec4(col, cover);
}`;

export class Shimmer {
  constructor() {
    const n = MAX_RIBBONS * RIB_PTS * ACROSS;
    const g = new THREE.BufferGeometry();
    const mk = (k) => { const a = new THREE.BufferAttribute(new Float32Array(n * k), k); a.setUsage(THREE.DynamicDrawUsage); return a; };
    this.aPos = mk(3); this.aLev = mk(4); this.aCol = mk(3); this.aW = mk(2);
    g.setAttribute('position', this.aPos); g.setAttribute('aLev', this.aLev); g.setAttribute('aCol', this.aCol); g.setAttribute('aW', this.aW);
    const idx = [];
    for (let r = 0; r < MAX_RIBBONS; r++) {
      for (let i = 0; i < RIB_PTS - 1; i++) {
        for (let k = 0; k < ACROSS - 1; k++) {
          const a = (r * RIB_PTS + i) * ACROSS + k, b = a + ACROSS;
          idx.push(a, a + 1, b + 1, a, b + 1, b);
        }
      }
    }
    g.setIndex(idx);
    g.setDrawRange(0, 0);
    this.geometry = g;
    this.uniforms = { uPxM: { value: 0.001 }, uTime: { value: 0 } };
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
  /** Reserve a band index, or null when full. */
  ribbon() { return this.n < MAX_RIBBONS ? this.n++ : null; }
  /**
   * Point i of band r: crest point (x, yCrest, z), edge height, glow + glint HDR, tint, fade, half-width (m) and
   * half-width per metre of camera distance.
   */
  set(r, i, x, y, yEdge, z, glow, glint, cr, cg, cb, fade, hw, hwPerM) {
    const P = this.aPos.array, L = this.aLev.array, C = this.aCol.array, Wd = this.aW.array;
    for (let k = 0; k < ACROSS; k++) {
      const v = (r * RIB_PTS + i) * ACROSS + k, side = k - 1;
      P[v * 3] = x; P[v * 3 + 1] = side === 0 ? y : yEdge; P[v * 3 + 2] = z;
      L[v * 4] = glow; L[v * 4 + 1] = glint; L[v * 4 + 2] = side; L[v * 4 + 3] = fade;
      C[v * 3] = cr; C[v * 3 + 1] = cg; C[v * 3 + 2] = cb;
      Wd[v * 2] = hw; Wd[v * 2 + 1] = hwPerM;
    }
  }
  end(t, pxm) {
    this.uniforms.uTime.value = t;
    this.uniforms.uPxM.value = pxm;
    const nv = this.n * RIB_PTS * ACROSS;
    for (const a of [this.aPos, this.aLev, this.aCol, this.aW]) {
      a.clearUpdateRanges();
      if (nv) { a.addUpdateRange(0, nv * a.itemSize); a.needsUpdate = true; }
    }
    this.geometry.setDrawRange(0, this.n * (RIB_PTS - 1) * (ACROSS - 1) * 6);
  }
  dispose() { this.geometry.dispose(); this.material.dispose(); }
}
