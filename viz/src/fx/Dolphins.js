// Decorative dolphin jumps (WP5): a stylised low-poly dolphin (~2.6 m, grey-blue back, light belly), a small pool
// of meshes posed from fxMath.dolphinPose each frame (pure function of impulse + age).
import * as THREE from 'three';
import { DOLPHIN_LEN } from './fxMath.js';

const BACK = new THREE.Color(0x5f7f9a), BELLY = new THREE.Color(0xdfe8ee), FIN = new THREE.Color(0x4b6780);

/** Non-indexed, flat-shaded dolphin facing +X, length DOLPHIN_LEN, belly toward −Y. */
export function makeDolphinGeometry() {
  const L = DOLPHIN_LEN, pos = [], col = [];
  const tri = (a, b, c, ca, cb = ca, cc = ca) => { pos.push(...a, ...b, ...c); col.push(ca.r, ca.g, ca.b, cb.r, cb.g, cb.b, cc.r, cc.g, cc.b); };
  // body: rings along x (tail → nose); radius profile r(s), s ∈ [0,1]
  const NR = 13, NA = 8;
  const prof = (s) => {
    if (s > 0.93) return 0.045 + (1 - s) * 0.6;                       // beak
    const b = Math.sin(Math.PI * Math.pow(s, 0.75));
    return 0.035 + 0.27 * Math.pow(b, 1.1) * (s < 0.25 ? 0.55 + 1.8 * s : 1);
  };
  const ring = [];
  for (let i = 0; i <= NR; i++) {
    const s = i / NR, x = (s - 0.5) * L, r = prof(s), yo = 0.04 * Math.sin(Math.PI * s);
    const pts = [];
    for (let j = 0; j < NA; j++) {
      const a = (j / NA) * Math.PI * 2;
      pts.push([x, yo + Math.cos(a) * r, Math.sin(a) * r * 0.85]);
    }
    ring.push(pts);
  }
  const colorOf = (p) => (p[1] < -0.02 ? BELLY : BACK);
  for (let i = 0; i < NR; i++) {
    for (let j = 0; j < NA; j++) {
      const a = ring[i][j], b = ring[i][(j + 1) % NA], c = ring[i + 1][(j + 1) % NA], d = ring[i + 1][j];
      tri(a, c, b, colorOf(a), colorOf(c), colorOf(b));
      tri(a, d, c, colorOf(a), colorOf(d), colorOf(c));
    }
  }
  // nose cap + tail cap
  const nose = [L / 2 + 0.06, 0.0, 0], tailP = [-L / 2, 0.0, 0];
  for (let j = 0; j < NA; j++) {
    const a = ring[NR][j], b = ring[NR][(j + 1) % NA];
    tri(a, b, nose, colorOf(a), colorOf(b), BACK);
    const c = ring[0][j], d = ring[0][(j + 1) % NA];
    tri(c, tailP, d, BACK);
  }
  // dorsal fin (two-sided), pectoral fins, flukes
  const dx = 0.05 * L, top = 0.3;
  const dorsal = [[dx + 0.28, top - 0.02, 0], [dx - 0.25, top - 0.02, 0], [dx - 0.32, top + 0.36, 0]];
  tri(dorsal[0], dorsal[1], dorsal[2], FIN); tri(dorsal[0], dorsal[2], dorsal[1], FIN);
  for (const sz of [-1, 1]) {
    const p = [[0.42, -0.12, 0.17 * sz], [0.18, -0.14, 0.17 * sz], [0.08, -0.28, 0.5 * sz]];
    tri(p[0], p[1], p[2], FIN); tri(p[0], p[2], p[1], FIN);
    const f = [[-L / 2 + 0.05, 0, 0], [-L / 2 - 0.42, 0.02, 0.48 * sz], [-L / 2 - 0.22, 0.0, 0.05 * sz]];
    tri(f[0], f[1], f[2], FIN); tri(f[0], f[2], f[1], FIN);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

export class Dolphins {
  constructor(n = 6) {
    this.geometry = makeDolphinGeometry();
    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.38, metalness: 0.0, flatShading: true,
      emissive: new THREE.Color(0x0d1a24), envMapIntensity: 1.2,
    });
    this.group = new THREE.Group();
    this.meshes = [];
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(this.geometry, this.material);
      m.rotation.order = 'YZX';
      m.visible = false;
      m.frustumCulled = false;
      this.group.add(m);
      this.meshes.push(m);
    }
    this.n = 0;
  }
  begin() { this.n = 0; }
  /** Place the next dolphin: world position, yaw (about +Y), pitch (nose up, about local Z), roll. */
  add(x, y, z, yaw, pitch, roll = 0) {
    if (this.n >= this.meshes.length) return;
    const m = this.meshes[this.n++];
    m.position.set(x, y, z);
    m.rotation.set(roll, yaw, pitch);
    m.visible = true;
  }
  end() { for (let i = this.n; i < this.meshes.length; i++) this.meshes[i].visible = false; }
  dispose() { this.geometry.dispose(); this.material.dispose(); }
}
