// Front shimmer ribbons (WP5): one camera-facing ribbon per front along its crest (x = crest x, z across FRONT_W,
// y ≈ crest height). Additive, depth-tested with a bias toward the camera, no depth write, so it reads on top of the
// plain ocean now and on top of the wave mesh later. Brightness: per-vertex core/halo HDR levels from the front's
// energy, recent-impulse pulse and glow[col]; the fragment shader adds a travelling shimmer and glints.
import * as THREE from 'three';
import { PREMULT } from './Sprites.js';

export const RIB_PTS = 97;           // points along the crest
export const MAX_RIBBONS = 8;

const VERT = /* glsl */ `
in vec3 aTan;
in vec4 aLev;     // core HDR, halo HDR, warm 0..1, side (-1/+1)
in vec3 aW;       // halo half-width (m), min half-width (px), crest coordinate (m along z)
uniform float uPxM;
out vec4 vLev;
out float vV;
out float vS;
void main() {
  vec4 c0 = modelViewMatrix * vec4(position, 1.0);
  float pxm = uPxM * max(1.0, -c0.z);
  float hw = max(aW.x, aW.y * pxm);
  vec3 side = normalize(cross(aTan, cameraPosition - position));
  vec4 mv = modelViewMatrix * vec4(position + side * hw * aLev.w, 1.0);
  mv.z += min(12.0, 0.025 * -c0.z);
  gl_Position = projectionMatrix * mv;
  vLev = aLev;
  vV = aLev.w;
  vS = aW.z;
}`;

const FRAG = /* glsl */ `
in vec4 vLev;
in float vV;
in float vS;
uniform float uTime;
void main() {
  float v = vV, t = uTime, s = vS;
  // travelling shimmer along the crest + sharp glints
  float sh = 0.62 + 0.38 * sin(s * 0.19 - t * 4.3 + 3.0 * sin(s * 0.043 + t * 1.1));
  // irregular glints drifting along the crest: hashed 3 m cells, each twinkling with its own phase
  float sc = s * 0.33 + t * 2.2, cell = floor(sc), fr = fract(sc);
  float hh = fract(sin(cell * 12.9898 + 4.1) * 43758.5453);
  float gl = smoothstep(0.82, 1.0, hh) * pow(max(0.0, sin(3.14159 * fr)), 6.0) * (0.5 + 0.5 * sin(t * 9.0 + hh * 40.0));
  float core = exp(-v * v * 45.0);
  float halo = exp(-v * v * 4.0) * (1.0 - smoothstep(0.75, 1.0, abs(v)));
  vec3 cyan = vec3(0.06, 0.7, 1.0), gold = vec3(1.0, 0.45, 0.05);
  vec3 cc = mix(vec3(0.3, 0.85, 1.0), vec3(1.0, 0.68, 0.25), vLev.z);
  vec3 hc = mix(cyan, gold, vLev.z);
  vec3 col = cc * vLev.x * core * (sh + 2.2 * gl) + hc * vLev.y * halo * (0.75 + 0.25 * sh);
  gl_FragColor = vec4(col, clamp(0.35 * core * min(1.0, vLev.x) + 0.18 * halo * min(1.0, vLev.y * 2.0), 0.0, 0.7));
}`;

export class Shimmer {
  constructor() {
    const n = MAX_RIBBONS * RIB_PTS * 2;
    const g = new THREE.BufferGeometry();
    const mk = (k) => { const a = new THREE.BufferAttribute(new Float32Array(n * k), k); a.setUsage(THREE.DynamicDrawUsage); return a; };
    this.aPos = mk(3); this.aTan = mk(3); this.aLev = mk(4); this.aW = mk(3);
    g.setAttribute('position', this.aPos); g.setAttribute('aTan', this.aTan); g.setAttribute('aLev', this.aLev); g.setAttribute('aW', this.aW);
    const idx = [];
    for (let r = 0; r < MAX_RIBBONS; r++) {
      for (let i = 0; i < RIB_PTS - 1; i++) {
        const a = (r * RIB_PTS + i) * 2, b = a + 2;
        idx.push(a, a + 1, b + 1, a, b + 1, b);
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
  /** Reserve a ribbon; returns a writer (i, x, y, z, core, halo, warm, halfWidth, minPx) or null when full. */
  ribbon() {
    if (this.n >= MAX_RIBBONS) return null;
    return this.n++;
  }
  /** Set point i of ribbon r. */
  set(r, i, x, y, z, tx, tz, core, halo, warm, hw, minPx) {
    const tl = Math.hypot(tx, tz) || 1;
    for (let sd = 0; sd < 2; sd++) {
      const v = (r * RIB_PTS + i) * 2 + sd;
      this.aPos.array.set([x, y, z], v * 3);
      this.aTan.array.set([tx / tl, 0, tz / tl], v * 3);
      this.aLev.array.set([core, halo, warm, sd ? 1 : -1], v * 4);
      this.aW.array.set([hw, minPx, z], v * 3);
    }
  }
  end(t, pxm) {
    this.uniforms.uTime.value = t;
    this.uniforms.uPxM.value = pxm;
    const nv = this.n * RIB_PTS * 2;
    for (const a of [this.aPos, this.aTan, this.aLev, this.aW]) {
      a.clearUpdateRanges();
      if (nv) { a.addUpdateRange(0, nv * a.itemSize); a.needsUpdate = true; }
    }
    this.geometry.setDrawRange(0, this.n * (RIB_PTS - 1) * 6);
  }
  dispose() { this.geometry.dispose(); this.material.dispose(); }
}
