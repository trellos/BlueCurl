// BlueCurl Swell — note birds + flocks (WP13). Stylised seabird (white tern/gull: long swept wings, black tips,
// forked tail), instanced. Pose per bird from birdMath.birdPose on the CPU (≤ cfg.birds.max, a few closed-form
// evaluations each); the wing flap (two-joint dihedral) is in the vertex shader. Backlit by the dawn sun: warm
// translucent wings and rims, cool sky fill from below. A minimum on-screen wingspan keeps them reading as birds
// in the wide view. Note birds trail a faint glow ribbon in their lane colour ("the note escaping").
import * as THREE from 'three';
import { PREMULT } from './Sprites.js';
import { birdPose, birdPos } from './birdMath.js';

export const MAX_BIRDS = 128;
export const TRAIL_PTS = 9;          // samples per trail (8 segments)
export const TRAIL_DT = 0.075;       // s between trail samples
const MAX_SEG = 64 * TRAIL_PTS;      // segment + halo instances

/**
 * Bird geometry, wingspan 1 (tip to tip), +X forward, +Y up, +Z right wing. aS = signed span coordinate of wing
 * vertices (0 on the body) for the flap; colour: white body/wings, grey mantle, black tips.
 */
export function makeBirdGeometry() {
  const pos = [], col = [], span = [];
  const W = [0.98, 0.98, 0.97], M = [0.72, 0.74, 0.78], K = [0.08, 0.08, 0.09], B = [0.93, 0.92, 0.9];
  const tri = (a, b, c, ca, cb = ca, cc = ca) => {
    for (const [p, cl] of [[a, ca], [b, cb], [c, cc]]) { pos.push(p[0], p[1], p[2]); col.push(...cl); span.push(p[3] ?? 0); }
  };
  // body: spindle (nose → tail), diamond section
  const L = [[0.3, 0, 0], [0.2, 0.03, 0.035], [0.02, 0.04, 0.05], [-0.16, 0.025, 0.03], [-0.26, 0.01, 0.012]];
  const ring = L.map(([x, h, w]) => [[x, h, 0], [x, 0, w], [x, -h * 1.2, 0], [x, 0, -w]]);
  for (let i = 0; i < ring.length - 1; i++) for (let j = 0; j < 4; j++) {
    const a = ring[i][j], b = ring[i][(j + 1) % 4], c = ring[i + 1][(j + 1) % 4], d = ring[i + 1][j];
    const ca = j === 2 || j === 1 ? B : W;
    tri(a, b, c, ca); tri(a, c, d, ca);
  }
  for (let j = 0; j < 4; j++) { const a = ring[0][j], b = ring[0][(j + 1) % 4]; tri([0.36, 0.0, 0], b, a, [1.0, 0.72, 0.2]); } // beak
  // forked tail
  for (const sz of [-1, 1]) tri([-0.24, 0.01, 0], [-0.4, 0.012, 0.075 * sz], [-0.33, 0.012, 0.01 * sz], W);
  // wings: inner panel (root → elbow at s 0.2), outer panel (elbow → pointed tip at s 0.5) with black tips
  for (const sd of [-1, 1]) {
    const v = (x, s, y = 0) => [x, y, sd * s, sd * s];
    const r0 = v(0.11, 0.035), r1 = v(-0.09, 0.035), e0 = v(0.1, 0.2, 0.004), e1 = v(-0.1, 0.2, 0.004);
    const m0 = v(0.06, 0.38, 0.0), m1 = v(-0.11, 0.38, 0.0), tp = v(-0.06, 0.5, -0.004);
    const t0 = [r0, e0, e1], t1 = [r0, e1, r1];
    const fl = sd > 0 ? (q) => q : (q) => [q[0], q[2], q[1]];
    tri(...fl(t0), M); tri(...fl(t1), M);
    tri(...fl([e0, m0, m1]), W); tri(...fl([e0, m1, e1]), W);
    tri(...fl([m0, tp, m1]), K, K, K);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aS', new THREE.Float32BufferAttribute(span, 1));
  return g;
}

const BIRD_VERT = /* glsl */ `
in vec3 color;
in float aS;
in vec4 iP;    // xyz, wingspan (m)
in vec4 iF;    // heading xyz (unit), roll
in vec4 iW;    // flap phase, flap amplitude, alpha, glow
in vec3 iC;    // lane colour
uniform float uPxM;
uniform float uMinPx;
out vec3 vW;
out vec3 vAlb;
out vec3 vGlow;
out float vAlpha;
out float vWing;
void main() {
  vec3 lp = position;
  float s = abs(aS), sd = sign(aS);
  float ph = iW.x, amp = iW.y;
  // two-joint dihedral: glide = slight gull 'M', flap = big up/down stroke with the hand lagging
  float p1 = mix(0.16, 0.12 + 0.85 * sin(ph), amp);
  float p2 = mix(-0.32, -0.12 + 0.6 * sin(ph - 0.9), amp);
  if (s > 0.0) {
    const float s1 = 0.2;
    float y, z;
    if (s <= s1) { y = s * sin(p1); z = s * cos(p1); }
    else { y = s1 * sin(p1) + (s - s1) * sin(p1 + p2); z = s1 * cos(p1) + (s - s1) * cos(p1 + p2); }
    lp.y += y; lp.z = sd * z;
    lp.x += -0.05 * amp * (s / 0.5) * cos(ph);       // wings sweep a little through the stroke
  }
  lp.y -= 0.025 * amp * sin(ph);                      // body bobs against the stroke
  vec3 f = normalize(iF.xyz);
  vec3 r0 = cross(f, vec3(0.0, 1.0, 0.0));
  r0 = length(r0) < 1e-3 ? vec3(0.0, 0.0, 1.0) : normalize(r0);
  vec3 u0 = cross(r0, f);
  float cr = cos(iF.w), sr = sin(iF.w);
  vec3 rt = r0 * cr - u0 * sr, up = u0 * cr + r0 * sr;
  vec4 c0 = viewMatrix * vec4(iP.xyz, 1.0);
  float span = max(iP.w, uMinPx * uPxM * max(1.0, -c0.z));
  vec3 wp = iP.xyz + span * (f * lp.x + up * lp.y + rt * lp.z);
  vW = wp;
  vAlb = color;
  vGlow = iC * iW.w;
  vAlpha = iW.z;
  vWing = s > 0.0 ? 1.0 : 0.0;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

const BIRD_FRAG = /* glsl */ `
in vec3 vW;
in vec3 vAlb;
in vec3 vGlow;
in float vAlpha;
in float vWing;
uniform vec3 uSunDir;
float bayer4(vec2 p) {
  ivec2 i = ivec2(mod(p, 4.0));
  int b[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return (float(b[i.y * 4 + i.x]) + 0.5) / 16.0;
}
void main() {
  if (vAlpha < bayer4(gl_FragCoord.xy)) discard;     // deterministic screen-door fade
  vec3 n = normalize(cross(dFdx(vW), dFdy(vW)));
  vec3 V = normalize(vW - cameraPosition);
  if (dot(n, V) > 0.0) n = -n;                        // face the camera (two-sided)
  vec3 L = normalize(uSunDir);
  float mu = max(0.0, dot(V, L));
  vec3 sunC = vec3(1.0, 0.68, 0.4);
  vec3 skyUp = vec3(0.95, 0.62, 0.5), skyDn = vec3(0.16, 0.34, 0.33);
  vec3 amb = mix(skyDn, skyUp, 0.5 + 0.5 * n.y);
  float dif = max(0.0, dot(n, L));
  float rim = pow(1.0 - abs(dot(n, -V)), 3.0);
  float trans = pow(mu, 5.0) * (0.35 + 0.65 * vWing);
  vec3 col = vAlb * (amb * 0.75 + sunC * dif * 1.6) + sunC * (trans * 1.5 + rim * (0.35 + 1.4 * mu)) * (0.4 + 0.6 * vAlb.r);
  col += vGlow;
  float dist = length(vW - cameraPosition);
  col = mix(col, vec3(1.0, 0.72, 0.5) * 1.1, 0.35 * (1.0 - exp(-dist / 1400.0)));   // dawn haze
  gl_FragColor = vec4(col, 1.0);
}`;

const TRAIL_VERT = /* glsl */ `
in vec4 iA;    // p0 xyz, half-width (m)
in vec4 iB;    // p1 xyz, mode (0 segment, 1 halo)
in vec4 iC;    // rgb (HDR, premultiplied by alpha), a0
in vec2 iD;    // a1, min px
uniform float uPxM;
out vec2 vQ;
out vec3 vCol;
out float vA;
flat out int vMode;
void main() {
  vec4 a = modelViewMatrix * vec4(iA.xyz, 1.0), b = modelViewMatrix * vec4(iB.xyz, 1.0);
  float pxm = uPxM * max(1.0, -a.z);
  float hw = max(iA.w, iD.y * pxm);
  int mode = int(iB.w + 0.5);
  vec4 mv;
  if (mode == 1) { mv = a; mv.xy += position.xy * hw; vA = iC.a; }
  else {
    vec2 d = b.xy - a.xy;
    float len = length(d);
    vec2 ax = len > 1e-5 ? d / len : vec2(1.0, 0.0), sd = vec2(-ax.y, ax.x);
    float s = position.x * 0.5 + 0.5;
    mv = mix(a, b, s);
    mv.xy += sd * position.y * hw;
    vA = mix(iC.a, iD.x, s);
  }
  mv.z += min(2.0, 0.01 * -mv.z);
  gl_Position = projectionMatrix * mv;
  vQ = position.xy;
  vCol = iC.rgb * smoothstep(4.0, 14.0, -a.z);
  vMode = mode;
}`;

const TRAIL_FRAG = /* glsl */ `
in vec2 vQ;
in vec3 vCol;
in float vA;
flat in int vMode;
void main() {
  float a = vMode == 1 ? exp(-dot(vQ, vQ) * 4.5) * (1.0 - smoothstep(0.8, 1.0, length(vQ)))
                       : exp(-vQ.y * vQ.y * 3.0) * (1.0 - smoothstep(0.85, 1.0, abs(vQ.y)));
  a *= vA;
  gl_FragColor = vec4(vCol * a, clamp(0.25 * a, 0.0, 0.5));
}`;

export class Birds {
  constructor() {
    // birds
    const g = makeBirdGeometry();
    const mk = (geo, n, k) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(n * k), k); a.setUsage(THREE.DynamicDrawUsage); return a; };
    this.aP = mk(g, MAX_BIRDS, 4); this.aF = mk(g, MAX_BIRDS, 4); this.aW = mk(g, MAX_BIRDS, 4); this.aC = mk(g, MAX_BIRDS, 3);
    g.setAttribute('iP', this.aP); g.setAttribute('iF', this.aF); g.setAttribute('iW', this.aW); g.setAttribute('iC', this.aC);
    g.instanceCount = 0;
    this.geometry = g;
    this.uniforms = { uPxM: { value: 0.001 }, uMinPx: { value: 30 }, uSunDir: { value: new THREE.Vector3(0.99, 0.1, -0.06) } };
    this.material = new THREE.ShaderMaterial({ vertexShader: BIRD_VERT, fragmentShader: BIRD_FRAG, uniforms: this.uniforms, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    // trails + halos
    const tg = new THREE.InstancedBufferGeometry();
    tg.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    tg.setIndex([0, 1, 2, 0, 2, 3]);
    this.tA = mk(tg, MAX_SEG, 4); this.tB = mk(tg, MAX_SEG, 4); this.tC = mk(tg, MAX_SEG, 4); this.tD = mk(tg, MAX_SEG, 2);
    tg.setAttribute('iA', this.tA); tg.setAttribute('iB', this.tB); tg.setAttribute('iC', this.tC); tg.setAttribute('iD', this.tD);
    tg.instanceCount = 0;
    this.trailGeometry = tg;
    this.trailUniforms = { uPxM: this.uniforms.uPxM };
    this.trailMaterial = new THREE.ShaderMaterial({ vertexShader: TRAIL_VERT, fragmentShader: TRAIL_FRAG, uniforms: this.trailUniforms,
      transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide, ...PREMULT });
    this.trail = new THREE.Mesh(tg, this.trailMaterial);
    this.trail.frustumCulled = false;
    this.trail.renderOrder = 22;
    this.n = 0; this.ns = 0;
    this._pose = {}; this._pts = Array.from({ length: TRAIL_PTS }, () => [0, 0, 0]);
  }

  begin() { this.n = 0; this.ns = 0; }

  /** Add bird bp at age a (pose from birdMath). */
  add(bp, a) {
    if (this.n >= MAX_BIRDS) return;
    const p = birdPose(bp, a, this._pose);
    if (!(p.alpha > 0.003) || !Number.isFinite(p.x + p.y + p.z)) return;
    const i = this.n++;
    const glow = bp.trail ? 0.22 * p.alpha : 0.0;
    this.aP.array.set([p.x, p.y, p.z, bp.span], i * 4);
    this.aF.array.set([p.fx, p.fy, p.fz, p.roll], i * 4);
    this.aW.array.set([p.flap, p.amp, p.alpha, glow], i * 4);
    this.aC.array.set(bp.col, i * 3);
    if (bp.trail) this._trail(bp, a, p);
  }

  _trail(bp, a, p) {
    const pts = this._pts, col = bp.col;
    for (let k = 0; k < TRAIL_PTS; k++) birdPos(bp, Math.max(bp.t0, a - k * TRAIL_DT), pts[k]);
    const A = p.alpha;
    // halo at the bird (the note's light)
    this._seg(pts[0], pts[0], 1, bp.span * 0.35, 6, col, 1.2 * A, 1.2 * A);
    for (let k = 0; k < TRAIL_PTS - 1; k++) {
      const a0 = A * Math.pow(1 - k / (TRAIL_PTS - 1), 1.6), a1 = A * Math.pow(1 - (k + 1) / (TRAIL_PTS - 1), 1.6);
      this._seg(pts[k], pts[k + 1], 0, 0.22 * bp.span * (1 - 0.6 * k / TRAIL_PTS), 2.2, col, 2.6 * a0, 2.6 * a1);
    }
  }

  _seg(p0, p1, mode, hw, minPx, col, a0, a1) {
    if (this.ns >= MAX_SEG) return;
    const i = this.ns++;
    this.tA.array.set([p0[0], p0[1], p0[2], hw], i * 4);
    this.tB.array.set([p1[0], p1[1], p1[2], mode], i * 4);
    this.tC.array.set([col[0], col[1], col[2], a0], i * 4);
    this.tD.array.set([a1, minPx], i * 2);
  }

  end(pxm, sunDir) {
    this.uniforms.uPxM.value = pxm;
    if (sunDir) this.uniforms.uSunDir.value.copy(sunDir);
    const up = (attrs, n) => { for (const a of attrs) { a.clearUpdateRanges(); if (n) { a.addUpdateRange(0, n * a.itemSize); a.needsUpdate = true; } } };
    up([this.aP, this.aF, this.aW, this.aC], this.n);
    up([this.tA, this.tB, this.tC, this.tD], this.ns);
    this.geometry.instanceCount = this.n;
    this.trailGeometry.instanceCount = this.ns;
    this.mesh.visible = this.n > 0;
    this.trail.visible = this.ns > 0;
  }

  dispose() { this.geometry.dispose(); this.material.dispose(); this.trailGeometry.dispose(); this.trailMaterial.dispose(); }
}
