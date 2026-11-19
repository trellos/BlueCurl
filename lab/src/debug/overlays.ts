// Debug overlays (doc 10 §3.8): board frame axes, specific force f_B (actual and planned-ahead),
// centre of mass over the support polygon, foot contact error in mm, planned path, and a
// signal scope (last 10 s). Also computes the lean metrics (body lean vs atan(v²/rg)).

import * as THREE from 'three';
import type GUI from 'lil-gui';
import type { Lab, LabSystem } from '../app.ts';
import type { RiderSystem } from '../riderSystem.ts';
import type { StreamSystem } from '../streamSystem.ts';

const G = 9.81;

interface Channel {
  name: string;
  color: string;
  min: number;
  max: number;
  get: () => number;
  buf: Float32Array;
}

export class OverlaySystem implements LabSystem {
  enabled = false;
  scopeOn = true;
  private group = new THREE.Group();
  private boardGroup = new THREE.Group();
  private fArrow = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 1, 0xff4040, 0.08, 0.05);
  private fPlanArrow = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 1, 0x40c0ff, 0.08, 0.05);
  private bodyArrow = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 1.3, 0xffe040, 0.08, 0.05);
  private com = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffff00, depthTest: false }));
  private comProj = new THREE.Mesh(new THREE.SphereGeometry(0.02, 10, 6), new THREE.MeshBasicMaterial({ color: 0x00ff00, depthTest: false }));
  private support: THREE.LineLoop;
  private path: THREE.Line;
  private pathPts = Array.from({ length: 64 }, () => new THREE.Vector3());
  private riderSys: RiderSystem;
  private streamSys: StreamSystem;
  private canvas: HTMLCanvasElement | null = null;
  private channels: Channel[] = [];
  private head = 0;
  private N = 600;
  // metrics
  leanDeg = 0;
  leanTheoryDeg = 0;
  comInside = true;

  constructor(riderSys: RiderSystem, streamSys: StreamSystem) {
    this.riderSys = riderSys;
    this.streamSys = streamSys;
    const sg = new THREE.BufferGeometry().setFromPoints(Array.from({ length: 8 }, () => new THREE.Vector3()));
    this.support = new THREE.LineLoop(sg, new THREE.LineBasicMaterial({ color: 0x00ff80, depthTest: false }));
    this.path = new THREE.Line(new THREE.BufferGeometry().setFromPoints(this.pathPts), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 }));
    for (const o of [this.fArrow, this.fPlanArrow, this.bodyArrow])
      o.traverse((c) => {
        const m = (c as THREE.Mesh).material as THREE.Material | undefined;
        if (m) m.depthTest = false;
      });
    this.boardGroup.add(new THREE.AxesHelper(0.6), this.fArrow, this.fPlanArrow, this.bodyArrow, this.com, this.comProj, this.support);
    this.boardGroup.traverse((o) => (o.renderOrder = 20));
  }

  init(lab: Lab): void {
    lab.boardRoot.add(this.boardGroup);
    lab.scene.add(this.group);
    this.group.add(this.path);
    const q = new URLSearchParams(location.search);
    this.enabled = q.has('debug');
    this.canvas = document.getElementById('scope') as HTMLCanvasElement | null;
    const r = () => this.riderSys.rider;
    const ch = (name: string, color: string, min: number, max: number, get: () => number) =>
      this.channels.push({ name, color, min, max, get, buf: new Float32Array(this.N) });
    ch('stream stability', '#5cf', 0, 1, () => this.streamSys.last?.stability ?? 0);
    ch('stability (damped)', '#18a', 0, 1, () => r().stability);
    ch('crouch', '#fc4', 0, 1.2, () => r().crouch.x);
    ch('balance err', '#f55', 0, 1.2, () => r().balanceError);
    ch('lean (°)', '#9f6', -60, 60, () => this.leanDeg);
    ch('atan(v²/rg) (°)', '#4a2', -60, 60, () => this.leanTheoryDeg);
    ch('|f|/g', '#ccc', 0, 2.5, () => r().fB.length() / G);
    this.setVisible(this.enabled);
  }

  setVisible(v: boolean): void {
    this.enabled = v;
    this.boardGroup.visible = v;
    this.group.visible = v;
    if (this.canvas) this.canvas.style.display = v && this.scopeOn ? 'block' : 'none';
  }

  frame(lab: Lab): void {
    const rs = this.riderSys;
    const rider = rs.rider;
    const S = lab.motion.state;
    // lean metrics (world): body axis vs vertical across the heading, and the coordinated-turn theory
    const h = new THREE.Vector3().copy(S.velocity).setY(0);
    if (h.lengthSq() < 0.25) h.set(0, 0, 1).applyQuaternion(S.quaternion).setY(0);
    h.normalize();
    const right = new THREE.Vector3(-h.z, 0, h.x);
    const uW = rider.bodyUp.clone().applyQuaternion(S.quaternion);
    this.leanDeg = (Math.atan2(uW.dot(right), uW.y) * 180) / Math.PI;
    this.leanTheoryDeg = (Math.atan2(S.accelPlan.dot(right), G) * 180) / Math.PI;

    // scope sampling
    this.head = (this.head + 1) % this.N;
    for (const c of this.channels) c.buf[this.head] = c.get();

    if (!this.enabled) return;
    const mid = new THREE.Vector3();
    const anchors = rider['anchors'] as { back: { p: THREE.Vector3; q: THREE.Quaternion }; front: { p: THREE.Vector3; q: THREE.Quaternion } };
    mid.addVectors(anchors.back.p, anchors.front.p).multiplyScalar(0.5);
    mid.y += 0.02;
    const f = rider.fB;
    this.fArrow.position.copy(mid);
    this.fArrow.setDirection(f.clone().normalize());
    this.fArrow.setLength(Math.max(0.1, (f.length() / G) * 0.9), 0.08, 0.05);
    this.fPlanArrow.position.copy(mid).add(new THREE.Vector3(0.0, 0, 0.05));
    this.fPlanArrow.setDirection(rider.fPlanLeadB.clone().normalize());
    this.fPlanArrow.setLength(Math.max(0.1, (rider.fPlanLeadB.length() / G) * 0.9), 0.08, 0.05);
    this.bodyArrow.position.copy(mid);
    this.bodyArrow.setDirection(rider.bodyUp);
    // COM (approx: pelvis + 8 cm up the body axis) and its projection along f onto the deck
    const com = rider.comB.clone().addScaledVector(rider.bodyUp, 0.08);
    this.com.position.copy(com);
    const fd = f.clone().normalize();
    const t = fd.y > 0.2 ? (com.y - mid.y) / fd.y : 0;
    const proj = com.clone().addScaledVector(fd, -t);
    this.comProj.position.copy(proj);
    // support polygon: outer corners of the two foot patches
    const pts: THREE.Vector3[] = [];
    for (const a of [anchors.back, anchors.front]) {
      for (const [dz, dx] of [[0.135, 0.05], [-0.135, 0.05], [-0.135, -0.05], [0.135, -0.05]]) {
        pts.push(new THREE.Vector3(dx, 0.01, dz).applyQuaternion(a.q).add(a.p));
      }
    }
    const hull = convexHullXZ(pts);
    const geo = this.support.geometry as THREE.BufferGeometry;
    const padded = hull.slice(0, 8);
    while (padded.length < 8) padded.push(hull[0]);
    geo.setFromPoints(padded);
    this.comInside = pointInPolyXZ(proj, hull);
    (this.comProj.material as THREE.MeshBasicMaterial).color.set(this.comInside ? 0x00ff00 : 0xff2020);
    // planned path (world)
    const n = lab.motion.plannedPath(this.pathPts, 2);
    for (let i = n; i < this.pathPts.length; i++) this.pathPts[i].copy(this.pathPts[Math.max(0, n - 1)]);
    for (const p of this.pathPts) p.y += 0.05;
    (this.path.geometry as THREE.BufferGeometry).setFromPoints(this.pathPts);
    this.drawScope();
  }

  hudLine(): string {
    const r = this.riderSys.rider;
    const e = r.footErrorMm.map((x) => (Number.isNaN(x) ? 'step' : x.toFixed(2)));
    const bad = r.footErrorMm.some((x) => x > 2);
    return `foot contact error back ${e[0]} mm  front ${e[1]} mm${bad ? '  (> 2 mm!)' : ''}\n` +
      `lean ${this.leanDeg.toFixed(1)}°  atan(v²/rg) ${this.leanTheoryDeg.toFixed(1)}°  |f|/g ${(r.fB.length() / G).toFixed(2)}\n` +
      `stability ${r.stability.toFixed(2)}  perf ${r.performance.toFixed(2)}  balance err ${r.balanceError.toFixed(2)}${r.fallen > 0 ? '  FALL' : ''}`;
  }

  private drawScope(): void {
    const cv = this.canvas;
    if (!cv || !this.scopeOn) return;
    const g = cv.getContext('2d')!;
    const W = cv.width;
    const H = cv.height;
    g.fillStyle = 'rgba(0,0,0,0.55)';
    g.fillRect(0, 0, W, H);
    g.font = '10px monospace';
    this.channels.forEach((c, k) => {
      g.strokeStyle = c.color;
      g.beginPath();
      for (let i = 0; i < this.N; i++) {
        const v = c.buf[(this.head + 1 + i) % this.N];
        const x = (i / (this.N - 1)) * W;
        const y = H - 4 - ((v - c.min) / (c.max - c.min)) * (H - 8);
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
      g.fillStyle = c.color;
      g.fillText(c.name, 4, 11 + k * 11);
    });
  }

  gui(lab: Lab, gui: GUI): void {
    const f = gui.addFolder('Debug overlays');
    f.add(this, 'enabled').name('overlays + scope').onChange((v: boolean) => this.setVisible(v));
    f.add(this, 'scopeOn').name('signal scope').onChange(() => this.setVisible(this.enabled));
    lab.hud.extra = () => this.hudLine();
  }
}

function convexHullXZ(pts: THREE.Vector3[]): THREE.Vector3[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.z - b.z);
  const cross = (o: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const lower: THREE.Vector3[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: THREE.Vector3[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function pointInPolyXZ(pt: THREE.Vector3, poly: THREE.Vector3[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.z > pt.z !== b.z > pt.z && pt.x < ((b.x - a.x) * (pt.z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}
