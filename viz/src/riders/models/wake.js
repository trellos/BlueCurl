// Rider wake ribbon + spray (WP6b). Both are rebuilt every frame from the rider's recent path, so they are a pure
// function of (rider state, t): the path is sampled through a trail function (age → world position) that reads
// the sim's position history when the rider system exposes one, else integrates the current velocity backwards
// (pos − fwd·speed·age). Spray particles have closed-form ballistic trajectories from seeded emitter slots
// (slot j re-emits every LIFE seconds; its seed is hash01(rider, j, cycle)); no frame-dt accumulation.
import * as THREE from 'three';
import { hash01 } from '../../contracts.js';

export const WAKE_N = 22;           // ribbon stations
export const WAKE_T = 1.3;          // s of path shown
export const SPRAY_N = 96;          // particles per rider
export const SPRAY_LIFE = 0.75;     // s

const WAKE_VERT = /* glsl */ `
attribute vec4 aW;                 // x: across (-1..1), y: age01, z: dist along (m), w: alpha
varying vec4 vW;
varying vec3 vWorld;
void main() {
  vW = aW;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const WAKE_FRAG = /* glsl */ `
uniform vec3 uSunColor, uSkyAmb, uSunDir;
varying vec4 vW;
varying vec3 vWorld;
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
}
void main() {
  float a = abs(vW.x), age = clamp(vW.y, 0.0, 1.0);
  // two churned edges (the rails' wash) and a frothy centre right behind the rider
  float e1 = (a - 0.78) / 0.22;
  float edge = exp(-e1 * e1);
  float centre = (1.0 - smoothstep(0.0, 0.7, a)) * (1.0 - smoothstep(0.0, 0.45, age));
  float n = vnoise(vec2(vW.z * 2.2, vW.x * 3.0)) * 0.6 + vnoise(vec2(vW.z * 6.0, vW.x * 7.0 + 3.1)) * 0.4;
  float foam = clamp((edge * 0.9 + centre) * smoothstep(0.25, 0.75, n) * 1.6, 0.0, 1.0);
  foam *= 1.0 - smoothstep(0.85, 1.0, a);
  float alpha = foam * vW.w * pow(1.0 - age, 1.3);
  vec3 col = vec3(0.92, 0.9, 0.86) * (uSunColor * 0.32 + uSkyAmb * 1.25);
  gl_FragColor = vec4(col * alpha, alpha);   // premultiplied
}`;

const SPRAY_VERT = /* glsl */ `
attribute vec2 aS;                 // x: size (m), y: alpha
uniform float uProj;               // viewport height / (2 tan(fov/2))
varying float vA;
varying vec3 vDir;
void main() {
  vA = aS.y;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vDir = normalize(w.xyz - cameraPosition);
  vec4 mv = viewMatrix * w;
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(aS.x * uProj / max(-mv.z, 0.1), 1.5, 96.0);
}`;
const SPRAY_FRAG = /* glsl */ `
uniform vec3 uSunColor, uSkyAmb, uSunDir;
varying float vA;
varying vec3 vDir;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  float soft = (1.0 - r2) * (1.0 - r2);
  // backlit droplets: Henyey-Greenstein forward scatter toward the camera when it looks into the sun
  float g = 0.72, mu = dot(vDir, normalize(uSunDir));
  float hg = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * mu, 1.5) / 12.566;
  vec3 col = vec3(0.95, 0.94, 0.92) * (uSkyAmb * 3.2 + uSunColor * (0.5 + 5.0 * hg));
  float a = vA * soft * 0.75;
  gl_FragColor = vec4(col * a, a);
}`;

export const PREMULT = { blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor };

export function wakeUniforms(app) {
  const wu = app.waterUniforms || {};
  return {
    uSunColor: wu.uSunColor || { value: new THREE.Vector3(3.6, 1.75, 0.62) },
    uSkyAmb: wu.uSkyAmb || { value: new THREE.Vector3(0.3, 0.25, 0.33) },
    uSunDir: wu.uSunDir || { value: (app.sunDir || new THREE.Vector3(0.95, 0.1, -0.3)).clone().normalize() },
    uProj: { value: 600 },
  };
}

const _p = new THREE.Vector3(), _q = new THREE.Vector3(), _d = new THREE.Vector3(), _s = new THREE.Vector3();

export class Wake {
  constructor(uniforms, id) {
    this.id = id;
    const n = WAKE_N;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aW', new THREE.BufferAttribute(new Float32Array(n * 2 * 4), 4).setUsage(THREE.DynamicDrawUsage));
    const idx = [];
    for (let i = 0; i < n - 1; i++) { const a = 2 * i; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    g.setIndex(idx);
    this.ribbon = new THREE.Mesh(g, new THREE.ShaderMaterial({ uniforms, vertexShader: WAKE_VERT, fragmentShader: WAKE_FRAG,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, ...PREMULT,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }));
    this.ribbon.frustumCulled = false;
    this.ribbon.renderOrder = 18;
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SPRAY_N * 3), 3).setUsage(THREE.DynamicDrawUsage));
    sg.setAttribute('aS', new THREE.BufferAttribute(new Float32Array(SPRAY_N * 2), 2).setUsage(THREE.DynamicDrawUsage));
    this.spray = new THREE.Points(sg, new THREE.ShaderMaterial({ uniforms, vertexShader: SPRAY_VERT, fragmentShader: SPRAY_FRAG,
      transparent: true, depthWrite: false, ...PREMULT }));
    this.spray.frustumCulled = false;
    this.spray.renderOrder = 22;
  }

  /**
   * trail(age, outVec3) → world position of the contact point `age` s ago. up: world up of the rider (Vector3).
   * o = { wake (0..1 intensity), width (m), spray (0..1), side (-1|0|1 lateral spray direction in rider frame),
   *       lift (m/s extra upward), burst (0..1, wide splash), scale, fwd, right (Vector3, world unit), tailBack (m) }
   */
  update(t, trail, o) {
    const n = WAKE_N;
    const P = this.ribbon.geometry.attributes.position.array, W = this.ribbon.geometry.attributes.aW.array;
    let dist = 0;
    this.ribbon.visible = o.wake > 0.01;
    if (this.ribbon.visible) {
      let px = 0, py = 0, pz = 0;
      for (let i = 0; i < n; i++) {
        const age = (i / (n - 1)) * WAKE_T;
        trail(age, _p);
        trail(Math.max(0, age - 0.04), _q);
        _d.subVectors(_q, _p);                              // direction of travel at that point
        _d.y = 0;
        if (_d.lengthSq() < 1e-8) _d.copy(o.fwd).setY(0);
        _d.normalize();
        _s.set(-_d.z, 0, _d.x);                              // horizontal side vector
        if (i > 0) dist += Math.hypot(_p.x - px, _p.y - py, _p.z - pz);
        px = _p.x; py = _p.y; pz = _p.z;
        const a01 = age / WAKE_T;
        const w = o.width * (0.45 + 1.6 * Math.sqrt(a01));
        for (let k = 0; k < 2; k++) {
          const sd = k === 0 ? -1 : 1, j = 2 * i + k;
          P[3 * j] = _p.x + _s.x * w * sd; P[3 * j + 1] = _p.y + 0.04; P[3 * j + 2] = _p.z + _s.z * w * sd;
          W[4 * j] = sd; W[4 * j + 1] = a01; W[4 * j + 2] = dist; W[4 * j + 3] = o.wake * smooth01(i / 2);
        }
      }
      this.ribbon.geometry.attributes.position.needsUpdate = true;
      this.ribbon.geometry.attributes.aW.needsUpdate = true;
    }
    // spray
    const S = this.spray.geometry.attributes.position.array, A = this.spray.geometry.attributes.aS.array;
    const on = o.spray > 0.01 || o.burst > 0.01;
    this.spray.visible = on;
    if (!on) return;
    for (let j = 0; j < SPRAY_N; j++) {
      const off = (j / SPRAY_N) * SPRAY_LIFE;
      const cyc = Math.floor((t + off) / SPRAY_LIFE);
      const age = t + off - cyc * SPRAY_LIFE;
      const h1 = hash01(this.id + 17, j, cyc), h2 = hash01(this.id + 31, j, cyc), h3 = hash01(this.id + 53, j, cyc), h4 = hash01(this.id + 71, j, cyc);
      trail(age, _p);
      const sc = o.scale;
      const burst = h4 < o.burst ? 1 : 0;
      // emitter: off the tail (spray) or around the rider (burst)
      _p.addScaledVector(o.fwd, -o.tailBack * sc);
      let vx, vy, vz;
      const side = o.side !== 0 ? o.side : (h3 < 0.5 ? -1 : 1);
      if (burst) {
        const a = h1 * Math.PI * 2, sp = (1.5 + 3 * h2) * sc;
        vx = Math.cos(a) * sp; vz = Math.sin(a) * sp; vy = (3 + 4 * h3) * sc;
        _q.set(vx, 0, vz);
      } else {
        const lat = (2.0 + 4.0 * h1) * o.spray * sc, up = (1.8 + 3.2 * h2 + o.lift) * o.spray * sc, back = (-0.5 - 2.0 * h3) * sc;
        _q.copy(o.right).multiplyScalar(lat * side).addScaledVector(o.fwd, back);
        vy = up; vx = _q.x; vz = _q.z;
      }
      const g = 9.81 * 0.8;
      S[3 * j] = _p.x + vx * age; S[3 * j + 1] = _p.y + 0.1 + vy * age - 0.5 * g * age * age; S[3 * j + 2] = _p.z + vz * age;
      const a01 = age / SPRAY_LIFE;
      const k = burst ? o.burst : o.spray;
      A[2 * j] = (0.05 + 0.13 * h4) * sc * (1 + 1.6 * a01);
      A[2 * j + 1] = k * (1 - a01) * (1 - a01) * (S[3 * j + 1] < _p.y - 0.2 ? 0 : 0.9);
    }
    this.spray.geometry.attributes.position.needsUpdate = true;
    this.spray.geometry.attributes.aS.needsUpdate = true;
  }
}
const smooth01 = (x) => { const s = Math.min(Math.max(x, 0), 1); return s * s * (3 - 2 * s); };
