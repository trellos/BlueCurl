// BlueCurl Swell — note birds + flocks (WP13). Stylised seabird (white tern/gull: long swept wings, black tips,
// forked tail), instanced. Pose per bird from birdMath.birdPose on the CPU (≤ cfg.birds.max, a few closed-form
// evaluations each); the wing flap (two-joint dihedral) is in the vertex shader. Backlit by the dawn sun: warm
// translucent wings and rims, cool sky fill from below. A minimum on-screen wingspan keeps them reading as birds
// in the wide view. Note birds trail a faint glow ribbon in their lane colour ("the note escaping").
import * as THREE from 'three';
import { PREMULT } from './Sprites.js';
import { birdPose, birdPos } from './birdMath.js';

const smoothstep01 = (x) => { const s = Math.min(1, Math.max(0, x)); return s * s * (3 - 2 * s); };
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
#ifdef CAM_SPACE
  // WP15 key flock: instance pose given in camera space (x right, y up, -z into the view)
  mat3 camToWorld = transpose(mat3(viewMatrix));
  vec3 iPos = cameraPosition + camToWorld * iP.xyz;
  vec3 f = normalize(camToWorld * iF.xyz);
#else
  vec3 iPos = iP.xyz;
  vec3 f = normalize(iF.xyz);
#endif
  vec3 r0 = cross(f, vec3(0.0, 1.0, 0.0));
  r0 = length(r0) < 1e-3 ? vec3(0.0, 0.0, 1.0) : normalize(r0);
  vec3 u0 = cross(r0, f);
  float cr = cos(iF.w), sr = sin(iF.w);
  vec3 rt = r0 * cr - u0 * sr, up = u0 * cr + r0 * sr;
  vec4 c0 = viewMatrix * vec4(iPos, 1.0);
  float span = max(iP.w, uMinPx * uPxM * max(1.0, -c0.z));
  vec3 wp = iPos + span * (f * lp.x + up * lp.y + rt * lp.z);
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
uniform vec3 uSunC;      // sun colour (dawn: 1.0, 0.68, 0.4; follows app.sun when the day cycle runs)
uniform vec3 uSkyUp;
uniform vec3 uSkyDn;
uniform vec3 uHazeC;
uniform float uShade;   // 0..1: darken toward a backlit silhouette (WP15 key flock)
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
  vec3 sunC = uSunC;
  vec3 skyUp = uSkyUp, skyDn = uSkyDn;
  vec3 amb = mix(skyDn, skyUp, 0.5 + 0.5 * n.y);
  float dif = max(0.0, dot(n, L));
  float rim = pow(1.0 - abs(dot(n, -V)), 3.0);
  float trans = pow(mu, 5.0) * (0.35 + 0.65 * vWing);
  vec3 col = vAlb * (amb * 0.75 + sunC * dif * 1.6) + sunC * (trans * 1.5 + rim * (0.35 + 1.4 * mu)) * (0.4 + 0.6 * vAlb.r);
  // backlit silhouette (a little lighter where the sea is behind the bird)
  col = mix(col, uSkyDn * 0.12 + sunC * (0.03 + 0.25 * trans + 0.1 * rim), uShade * mix(0.75, 1.0, smoothstep(-0.015, 0.02, V.y)));
  col += vGlow;
  float dist = length(vW - cameraPosition);
  col = mix(col, uHazeC, 0.35 * (1.0 - exp(-dist / 1400.0)));   // haze (dawn: 1.1, 0.79, 0.55)
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

/** Dawn look of the bird shader (the day cycle scales / tints these, see Birds.setLight). */
export const BIRD_LIGHT = { sun: [1.0, 0.68, 0.4], skyUp: [0.95, 0.62, 0.5], skyDn: [0.16, 0.34, 0.33], haze: [1.1, 0.792, 0.55] };

export class Birds {
  /** opts: { max (instances), minPx (minimum on-screen wingspan), camSpace (poses in camera space, WP15 key flock) } */
  constructor(opts = {}) {
    const MAXB = opts.max ?? MAX_BIRDS;
    this.max = MAXB;
    // birds
    const g = makeBirdGeometry();
    const mk = (geo, n, k) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(n * k), k); a.setUsage(THREE.DynamicDrawUsage); return a; };
    this.aP = mk(g, MAXB, 4); this.aF = mk(g, MAXB, 4); this.aW = mk(g, MAXB, 4); this.aC = mk(g, MAXB, 3);
    g.setAttribute('iP', this.aP); g.setAttribute('iF', this.aF); g.setAttribute('iW', this.aW); g.setAttribute('iC', this.aC);
    g.instanceCount = 0;
    this.geometry = g;
    const L = BIRD_LIGHT, v3 = (a) => new THREE.Vector3(...a);
    this.uniforms = { uPxM: { value: 0.001 }, uMinPx: { value: opts.minPx ?? 30 }, uSunDir: { value: new THREE.Vector3(0.99, 0.1, -0.06) },
      uSunC: { value: v3(L.sun) }, uSkyUp: { value: v3(L.skyUp) }, uSkyDn: { value: v3(L.skyDn) }, uHazeC: { value: v3(L.haze) }, uShade: { value: opts.shade ?? 0 } };
    this.material = new THREE.ShaderMaterial({ vertexShader: BIRD_VERT, fragmentShader: BIRD_FRAG, uniforms: this.uniforms, side: THREE.DoubleSide,
      defines: opts.camSpace ? { CAM_SPACE: 1 } : {} });
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
    if (this.n >= this.max) return;
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

  /** Add a bird from an explicit pose { x,y,z, fx,fy,fz, roll, flap, amp, alpha, span } (world, or camera space). */
  addPose(p, col = null, glow = 0) {
    if (this.n >= this.max || !(p.alpha > 0.003) || !Number.isFinite(p.x + p.y + p.z)) return;
    const i = this.n++;
    this.aP.array.set([p.x, p.y, p.z, p.span], i * 4);
    this.aF.array.set([p.fx, p.fy, p.fz, p.roll], i * 4);
    this.aW.array.set([p.flap, p.amp, p.alpha, glow], i * 4);
    if (col) this.aC.array.set(col, i * 3); else this.aC.array.fill(0, i * 3, i * 3 + 3);
  }

  /**
   * Day-cycle light: sunScale/sunTint scale the dawn sun colour, skyScale the sky fill + haze (1, 1 = the dawn look).
   * tint = [r,g,b] multiplier normalised to the dawn hue (1,1,1 = dawn).
   */
  setLight(sunScale = 1, skyScale = 1, tint = null) {
    const L = BIRD_LIGHT, u = this.uniforms, t = tint || [1, 1, 1];
    u.uSunC.value.set(L.sun[0] * sunScale * t[0], L.sun[1] * sunScale * t[1], L.sun[2] * sunScale * t[2]);
    u.uSkyUp.value.set(L.skyUp[0] * skyScale, L.skyUp[1] * skyScale, L.skyUp[2] * skyScale);
    u.uSkyDn.value.set(L.skyDn[0] * skyScale, L.skyDn[1] * skyScale, L.skyDn[2] * skyScale);
    u.uHazeC.value.set(L.haze[0] * skyScale, L.haze[1] * skyScale, L.haze[2] * skyScale);
  }

  _trail(bp, a, p) {
    const pts = this._pts, col = bp.col;
    for (let k = 0; k < TRAIL_PTS; k++) birdPos(bp, Math.max(bp.t0, a - k * TRAIL_DT), pts[k]);
    const A = p.alpha;
    // no trail on the vertical climb out of the splash (it read as a cross): fades in once the bird levels off
    const T = A * smoothstep01((a - bp.t0 - 1.2) / 1.4);
    // halo at the bird (the note's light)
    this._seg(pts[0], pts[0], 1, bp.span * 0.35, 6, col, 1.2 * A, 1.2 * A);
    for (let k = 0; k < TRAIL_PTS - 1; k++) {
      const a0 = T * Math.pow(1 - k / (TRAIL_PTS - 1), 1.6), a1 = T * Math.pow(1 - (k + 1) / (TRAIL_PTS - 1), 1.6);
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
