// Instanced HDR glow sprites (WP5): impact flashes and glows, rings on the water, crest streaks, splash rings.
// One instanced draw, additive, depth-tested (with a bias toward the camera) but not depth-writing.
//
// Per instance:
//   iPos  xyz world centre
//   iA    xyz world half-axis A, w = mode (0 billboard, 1 axis ribbon: A along world, width across view, 2 flat: A, B = A×up)
//   iB    x half-width (m), y min half-width (px), z depth bias (m), w shape (0 glow, 1 flare, 2 ring, 3 streak)
//   iC    rgb (HDR), w shape param (ring radius fraction)
import * as THREE from 'three';

export const SHAPE_GLOW = 0, SHAPE_FLARE = 1, SHAPE_RING = 2, SHAPE_STREAK = 3;
export const MODE_BILLBOARD = 0, MODE_AXIS = 1, MODE_FLAT = 2;
export const MAX_SPRITES = 512;
/** rgb·1 + dst·(1 − a): additive light plus a coverage term that tints/darkens the background. */
export const PREMULT = {
  blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
  blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
};

const VERT = /* glsl */ `
in vec3 iPos;
in vec4 iA;
in vec4 iB;
in vec4 iC;
uniform float uPxM;
out vec2 vQ;
out vec4 vC;
flat out int vShape;
void main() {
  int mode = int(iA.w + 0.5);
  vec4 mv;
  vec4 c0 = modelViewMatrix * vec4(iPos, 1.0);
  float pxm = uPxM * max(1.0, -c0.z);
  float hw = max(iB.x, iB.y * pxm);
  if (mode == 0) {
    mv = c0;
    mv.xy += position.xy * hw;
  } else if (mode == 1) {
    vec3 axis = iA.xyz;
    vec3 side = normalize(cross(axis, cameraPosition - iPos));
    vec3 al = axis * max(1.0, (iB.y * pxm * 2.0) / max(length(axis), 1e-3));
    mv = modelViewMatrix * vec4(iPos + al * position.x + side * hw * position.y, 1.0);
  } else {
    vec3 B = vec3(-iA.z, 0.0, iA.x);
    mv = modelViewMatrix * vec4(iPos + iA.xyz * position.x + B * position.y, 1.0);
  }
  mv.z += iB.z;
  gl_Position = projectionMatrix * mv;
  vQ = position.xy;
  // near fade: the impact sprites are sized for the wide view; a close follow cam (PiP) must not be flooded
  float dz = -c0.z;
  vC = vec4(iC.rgb * smoothstep(0.08, 0.3, dz / max(hw, max(length(iA.xyz), 1e-3))) * smoothstep(10.0, 40.0, dz), iC.w);
  vShape = int(iB.w + 0.5);
}`;

const FRAG = /* glsl */ `
in vec2 vQ;
in vec4 vC;
flat in int vShape;
void main() {
  vec2 q = vQ;
  float r2 = dot(q, q), r = sqrt(r2), a = 0.0;
  if (vShape == 0) {                       // soft glow with a hot core
    a = (exp(-r2 * 18.0) + 0.28 * exp(-r2 * 5.0)) * (1.0 - smoothstep(0.75, 1.0, r));
  } else if (vShape == 1) {                // 4-point star flare
    float sx = exp(-abs(q.y) * 55.0) * pow(max(0.0, 1.0 - abs(q.x)), 2.5);
    float sy = exp(-abs(q.x) * 55.0) * pow(max(0.0, 1.0 - abs(q.y)), 2.5);
    vec2 d = vec2(q.x + q.y, q.x - q.y) * 0.7071;
    float sd = 0.35 * (exp(-abs(d.y) * 70.0) * pow(max(0.0, 1.0 - abs(d.x) * 1.4), 3.0)
                    + exp(-abs(d.x) * 70.0) * pow(max(0.0, 1.0 - abs(d.y) * 1.4), 3.0));
    a = sx + sy + sd + exp(-r2 * 40.0);
  } else if (vShape == 2) {                // ring: bright rim + faint fill
    float w = 0.11;
    float d = (r - vC.w) / w;
    a = (exp(-d * d) + 0.12 * smoothstep(vC.w, 0.0, r) * step(r, vC.w)) * (1.0 - smoothstep(0.92, 1.0, r));
  } else {                                 // streak: hot core line + soft sheath, tapered ends
    float along = max(0.0, 1.0 - q.x * q.x);
    a = (exp(-q.y * q.y * 40.0) * 1.6 + 0.4 * exp(-q.y * q.y * 5.0)) * along * along * (1.0 - smoothstep(0.8, 1.0, abs(q.y)));
  }
  // premultiplied 'over': rgb adds light, alpha (coverage) replaces what is underneath, so stacked hits converge to
  // their colour (≈ rgb / cover) instead of summing to white, and stay readable on the sun glitter
  float cover = vShape == 0 ? 0.6 : vShape == 1 ? 0.0 : vShape == 2 ? 0.6 : 0.55;
  float lum = max(vC.r, max(vC.g, vC.b));
  gl_FragColor = vec4(vC.rgb * a, clamp(a * cover * min(1.0, lum * 0.5), 0.0, 0.85));
}`;

export class Sprites {
  constructor() {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const mk = (n) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SPRITES * n), n); a.setUsage(THREE.DynamicDrawUsage); return a; };
    this.aPos = mk(3); this.aA = mk(4); this.aB = mk(4); this.aC = mk(4);
    g.setAttribute('iPos', this.aPos); g.setAttribute('iA', this.aA); g.setAttribute('iB', this.aB); g.setAttribute('iC', this.aC);
    g.instanceCount = 0;
    this.geometry = g;
    this.uniforms = { uPxM: { value: 0.001 } };
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, uniforms: this.uniforms,
      transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide, ...PREMULT,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 21;
    this.n = 0;
  }
  begin() { this.n = 0; }
  /** p: [x,y,z]; A: [ax,ay,az]; mode; hw (m); minPx; bias (m); shape; rgb (HDR, already × intensity); param. */
  add(px, py, pz, ax, ay, az, mode, hw, minPx, bias, shape, r, g, b, param = 0) {
    if (this.n >= MAX_SPRITES || !(r + g + b > 1e-4)) return;
    const i = this.n++;
    this.aPos.array.set([px, py, pz], i * 3);
    this.aA.array.set([ax, ay, az, mode], i * 4);
    this.aB.array.set([hw, minPx, bias, shape], i * 4);
    this.aC.array.set([r, g, b, param], i * 4);
  }
  end(pxm) {
    this.uniforms.uPxM.value = pxm;
    for (const a of [this.aPos, this.aA, this.aB, this.aC]) {
      a.clearUpdateRanges();
      if (this.n) { a.addUpdateRange(0, this.n * a.itemSize); a.needsUpdate = true; }
    }
    this.geometry.instanceCount = this.n;
  }
  dispose() { this.geometry.dispose(); this.material.dispose(); }
}
