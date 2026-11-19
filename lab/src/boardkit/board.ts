// boardkit v0: analytic board model from a BoardSpec. Same code answers runtime queries
// (deck point + normal, anchors, stance) and builds the mesh (mesh.ts).
//
// Board frame: metres, +Z nose, +Y deck normal, +X left rail, origin on the stringer on the
// rocker-table plane at mid-length (docs/research/03-surfboards.md §4.1).

import * as THREE from 'three';
import { MonotoneCurve } from './curves.ts';
import type { BoardSpec } from './spec.ts';

export type Stance = 'regular' | 'goofy';

export interface Anchor {
  name: string;
  position: THREE.Vector3;
  /** +Y surface normal (outward), +Z the anchor's "forward" (feet: heel → toe). */
  quaternion: THREE.Quaternion;
  extras?: Record<string, unknown>;
}

export interface DeckFrame {
  p: THREE.Vector3;
  n: THREE.Vector3;
}

const DEG = Math.PI / 180;
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _m = new THREE.Matrix4();

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export class Board {
  readonly spec: BoardSpec;
  readonly L: number;
  private width: MonotoneCurve;
  private rockerC: MonotoneCurve;
  private foilC: MonotoneCurve;
  private apexC: MonotoneCurve;
  private fullC: MonotoneCurve;
  private edgeC: MonotoneCurve;
  readonly derived: { volumeL: number; cob: THREE.Vector3; massKg: number; lengthOverCurve: number };
  /** Rail-fullness scale solved so the model meets the spec's published volume (doc 03 §4.7). */
  fullnessScale = 1;

  constructor(spec: BoardSpec) {
    this.spec = spec;
    const L = (this.L = spec.dims.length);
    const o = spec.outline;
    const wk: Array<[number, number]> = [[0, o.tail.blockWidth / 2]];
    for (const [d, w] of o.widths) wk.push([d / L, w / 2]);
    wk.push([0.5 + o.widePointFromCentre / L, spec.dims.width / 2]);
    wk.push([1, o.noseTipRadius]);
    this.width = new MonotoneCurve(wk);
    this.rockerC = new MonotoneCurve(spec.rocker.map(([d, v]) => [d / L, v] as [number, number]));
    this.foilC = new MonotoneCurve(spec.foil.map(([d, v]) => [d / L, v] as [number, number]));
    this.apexC = new MonotoneCurve(spec.rails.apexRatio);
    this.fullC = new MonotoneCurve(spec.rails.fullness);
    this.edgeC = new MonotoneCurve(spec.rails.edgeRadius);
    this.derived = this.computeDerived();
    if (spec.dims.volumeL > 0) {
      // bisection on one scalar (rail/deck fullness) so the published litres are met
      let lo = 0.6;
      let hi = 2.2;
      for (let i = 0; i < 24; i++) {
        this.fullnessScale = 0.5 * (lo + hi);
        const v = this.computeDerived().volumeL;
        if (v < spec.dims.volumeL) lo = this.fullnessScale;
        else hi = this.fullnessScale;
      }
      this.derived = this.computeDerived();
    }
  }

  // ---------------------------------------------------------------- longitudinal curves (u: 0 tail .. 1 nose)
  uOf(z: number): number {
    return z / this.L + 0.5;
  }
  zOf(u: number): number {
    return (u - 0.5) * this.L;
  }
  halfWidth(u: number): number {
    const L = this.L;
    let w = Math.max(0, this.width.at(u));
    const t = this.spec.outline.tail;
    const zt = u * L;
    const rc = t.cornerRadius;
    if (zt < rc) w -= rc - Math.sqrt(Math.max(0, rc * rc - (rc - zt) * (rc - zt)));
    // pointed nose: round off the last tip radius
    const zn = (1 - u) * L;
    const rn = this.spec.outline.noseTipRadius;
    if (zn < rn) w = Math.min(w, Math.sqrt(Math.max(0, rn * rn - (rn - zn) * (rn - zn))));
    return Math.max(w, 1e-4);
  }
  rocker(u: number): number {
    return this.rockerC.at(u);
  }
  thickness(u: number): number {
    return Math.max(0.004, this.foilC.at(u));
  }
  apexRatio(u: number): number {
    return this.apexC.at(u);
  }
  /** Deck/rail superellipse exponent. */
  deckExp(u: number): number {
    return this.fullC.at(u) * this.fullnessScale;
  }
  /** Bottom-to-rail superellipse exponent from the bottom edge radius (hard edge = high). */
  bottomExp(u: number): number {
    const e = this.edgeC.at(u);
    return (2 + 0.0075 / (e + 0.0001)) * Math.sqrt(this.fullnessScale);
  }

  /** Bottom contour offset (+ = up) at station u and lateral fraction q = |x| / W. */
  contour(u: number, q: number): number {
    let y = 0;
    for (const c of this.spec.bottom.contours) {
      const f = smoothstep(c.u0 - 0.06, c.u0 + 0.06, u) * (1 - smoothstep(c.u1 - 0.08, c.u1 + 0.04, u));
      if (f <= 0) continue;
      if (c.type === 'single') {
        const wc = c.width ?? 0.75;
        if (q < wc) y += f * c.depth * (1 - (q / wc) ** 2);
      } else if (c.type === 'double') {
        const wc = c.width ?? 0.8;
        if (q < wc) y += f * c.depth * Math.sin((Math.PI * q) / wc) ** 2;
      } else {
        y -= f * c.depth * (1 - q);
      }
    }
    return y;
  }

  // ---------------------------------------------------------------- cross-section
  /**
   * Point on the +X half-section at station u, angle phi in [0, pi]:
   * 0 = bottom stringer, pi/2 = rail apex (max width), pi = deck stringer.
   * Writes [x, y] into out.
   */
  section(u: number, phi: number, out: Float64Array | number[]): void {
    const W = this.halfWidth(u);
    const T = this.thickness(u);
    const r = this.rocker(u);
    const a = this.apexRatio(u);
    const yA = r + a * T;
    const s = Math.max(0, Math.sin(phi));
    if (phi <= Math.PI / 2) {
      const p = this.bottomExp(u);
      const c = Math.max(0, Math.cos(phi));
      const x = W * Math.pow(s, 2 / p);
      out[0] = x;
      out[1] = yA - a * T * Math.pow(c, 2 / p) + this.contour(u, x / W);
    } else {
      const p = this.deckExp(u);
      const c = Math.max(0, -Math.cos(phi));
      out[0] = W * Math.pow(s, 2 / p);
      out[1] = yA + (1 - a) * T * Math.pow(c, 2 / p);
    }
  }

  // ---------------------------------------------------------------- runtime queries
  deckHeight(z: number, x: number): number {
    const u = Math.min(1, Math.max(0, this.uOf(z)));
    const W = this.halfWidth(u);
    const T = this.thickness(u);
    const a = this.apexRatio(u);
    const q = Math.min(1, Math.abs(x) / W);
    const p = this.deckExp(u);
    return this.rocker(u) + a * T + (1 - a) * T * Math.pow(Math.max(0, 1 - Math.pow(q, p)), 1 / p);
  }

  bottomHeight(z: number, x: number): number {
    const u = Math.min(1, Math.max(0, this.uOf(z)));
    const W = this.halfWidth(u);
    const T = this.thickness(u);
    const a = this.apexRatio(u);
    const q = Math.min(1, Math.abs(x) / W);
    const p = this.bottomExp(u);
    return this.rocker(u) + a * T - a * T * Math.pow(Math.max(0, 1 - Math.pow(q, p)), 1 / p) + this.contour(u, q);
  }

  /** Exact deck point and outward normal at board-frame (z, x). */
  deckFrame(z: number, x: number, out?: DeckFrame): DeckFrame {
    const o = out ?? { p: new THREE.Vector3(), n: new THREE.Vector3() };
    const e = 0.002;
    const y = this.deckHeight(z, x);
    const dydx = (this.deckHeight(z, x + e) - this.deckHeight(z, x - e)) / (2 * e);
    const dydz = (this.deckHeight(z + e, x) - this.deckHeight(z - e, x)) / (2 * e);
    o.p.set(x, y, z);
    o.n.set(-dydx, 1, -dydz).normalize();
    return o;
  }

  bottomFrame(z: number, x: number, out?: DeckFrame): DeckFrame {
    const o = out ?? { p: new THREE.Vector3(), n: new THREE.Vector3() };
    const e = 0.002;
    const y = this.bottomHeight(z, x);
    const dydx = (this.bottomHeight(z, x + e) - this.bottomHeight(z, x - e)) / (2 * e);
    const dydz = (this.bottomHeight(z + e, x) - this.bottomHeight(z - e, x)) / (2 * e);
    o.p.set(x, y, z);
    o.n.set(dydx, -1, dydz).normalize();
    return o;
  }

  /** Frame on the deck at (z, x) with +Y = deck normal and +Z = `dir` projected on the deck. */
  deckAnchor(name: string, z: number, x: number, dir: THREE.Vector3, extras?: Record<string, unknown>): Anchor {
    const f = this.deckFrame(z, x);
    return this.frameAnchor(name, f.p, f.n, dir, extras);
  }

  frameAnchor(name: string, p: THREE.Vector3, n: THREE.Vector3, dir: THREE.Vector3, extras?: Record<string, unknown>): Anchor {
    const zAx = _a.copy(dir).addScaledVector(n, -dir.dot(n)).normalize();
    const xAx = _b.crossVectors(n, zAx).normalize();
    _m.makeBasis(xAx, _c.copy(n), zAx);
    return { name, position: p.clone(), quaternion: new THREE.Quaternion().setFromRotationMatrix(_m), extras };
  }

  // ---------------------------------------------------------------- derived data
  private computeDerived() {
    const N = 240;
    const M = 64;
    const pt = [0, 0];
    let vol = 0;
    let mz = 0;
    let my = 0;
    let prevA = 0;
    let prevZ = 0;
    let prevCy = 0;
    let arc = 0;
    let prevR = 0;
    for (let i = 0; i <= N; i++) {
      const u = i / N;
      const z = this.zOf(u);
      // half-section area by the shoelace formula over the closed half profile (+ stringer line)
      let A = 0;
      let cy = 0;
      let px = 0;
      let py = 0;
      for (let j = 0; j <= M; j++) {
        this.section(u, (Math.PI * j) / M, pt);
        if (j > 0) {
          const cr = px * pt[1] - pt[0] * py;
          A += cr;
          cy += (py + pt[1]) * cr;
        }
        px = pt[0];
        py = pt[1];
      }
      // close along the stringer (x = 0) from deck back to bottom
      this.section(u, 0, pt);
      const cr = px * pt[1] - pt[0] * py;
      A += cr;
      cy += (py + pt[1]) * cr;
      A = Math.abs(A) / 2;
      const cyy = A > 1e-9 ? Math.abs(cy) / (6 * A) : this.rocker(u);
      const area = 2 * A;
      if (i > 0) {
        const dz = z - prevZ;
        vol += 0.5 * (area + prevA) * dz;
        mz += 0.5 * (area * z + prevA * prevZ) * dz;
        my += 0.5 * (area * cyy + prevA * prevCy) * dz;
        const r = this.rocker(u);
        arc += Math.hypot(dz, r - prevR);
      }
      prevA = area;
      prevZ = z;
      prevCy = cyy;
      prevR = this.rocker(u);
    }
    const cob = new THREE.Vector3(0, my / vol, mz / vol);
    return { volumeL: vol * 1000, cob, massKg: 2.7, lengthOverCurve: arc };
  }

  // ---------------------------------------------------------------- fins
  finPlacements(): Array<{ id: string; trail: THREE.Vector3; quaternion: THREE.Quaternion; template: string; depth: number; base: number }> {
    const out = [];
    const zt = -this.L / 2;
    for (const f of this.spec.fins.list) {
      const z = zt + f.fromTail;
      const u = this.uOf(z);
      let x = 0;
      let side = 0;
      if (f.id.startsWith('L')) side = 1;
      else if (f.id.startsWith('R')) side = -1;
      if (side !== 0) x = side * (this.halfWidth(u) - (f.fromRail ?? 0.029));
      const p = this.bottomFrame(z, x).p;
      p.y += 0.001; // root slightly embedded
      // fin local frame: +Y along the span (out of the bottom, i.e. board -Y), +Z toward the
      // nose (leading edge), toe-in rotates the leading edge toward the stringer, cant tilts
      // the tip away from the stringer.
      const q = new THREE.Quaternion().setFromAxisAngle(_a.set(0, 0, 1), Math.PI); // span down
      const toe = new THREE.Quaternion().setFromAxisAngle(_a.set(0, 1, 0), -side * f.toeDeg * DEG);
      const cant = new THREE.Quaternion().setFromAxisAngle(_a.set(0, 0, 1), side * f.cantDeg * DEG);
      q.premultiply(cant).premultiply(toe);
      const centre = f.template === 'M_centre';
      out.push({ id: f.id, trail: p, quaternion: q, template: f.template, depth: centre ? 0.112 : 0.114, base: centre ? 0.108 : 0.111 });
    }
    return out;
  }

  // ---------------------------------------------------------------- anchors (docs 03 §6)
  /** Stance anchors for a surfer of height H. */
  stance(H: number, stance: Stance): { back: Anchor; front: Anchor } {
    const zt = -this.L / 2;
    const fins = this.finPlacements().filter((f) => f.id !== 'C');
    const frontFinTrail = fins.length ? Math.max(...fins.map((f) => f.trail.z)) - zt : 0.28;
    const zBack = zt + Math.max(frontFinTrail + 0.01, this.spec.pad.fromTail + 0.12);
    const ws = 0.31 * H;
    const wideZ = this.spec.outline.widePointFromCentre;
    const zFront = Math.min(zBack + ws, wideZ + 0.1);
    const s = stance === 'regular' ? 1 : -1;
    // heel side is +X for regular (toes point to the right rail, -X)
    const xOff = s * 0.015;
    const dirBack = new THREE.Vector3(-s * Math.sin(80 * DEG), 0, Math.cos(80 * DEG));
    const dirFront = new THREE.Vector3(-s * Math.sin(40 * DEG), 0, Math.cos(40 * DEG));
    return {
      back: this.deckAnchor(`ANC_foot_back_${stance}`, zBack, xOff, dirBack, {
        role: 'foot', foot: 'back', stance, patch: { length: 0.27, width: 0.1 }, angleToStringerDeg: 80,
      }),
      front: this.deckAnchor(`ANC_foot_front_${stance}`, zFront, xOff, dirFront, {
        role: 'foot', foot: 'front', stance, patch: { length: 0.27, width: 0.1 }, angleToStringerDeg: 40,
      }),
    };
  }

  /** All static anchors for a reference surfer (1.78 m), as baked into the GLB. */
  anchors(H = 1.78): Anchor[] {
    const L = this.L;
    const zt = -L / 2;
    const fwd = new THREE.Vector3(0, 0, 1);
    const list: Anchor[] = [];
    const reg = this.stance(H, 'regular');
    const goof = this.stance(H, 'goofy');
    list.push(reg.back, reg.front, goof.back, goof.front);
    // tips
    const rn = this.rocker(1) + this.thickness(1) * 0.5;
    const rt = this.rocker(0) + this.thickness(0) * 0.5;
    list.push(this.frameAnchor('ANC_tip_nose', new THREE.Vector3(0, rn, L / 2), new THREE.Vector3(0, 1, 0), fwd));
    list.push(this.frameAnchor('ANC_tip_tail', new THREE.Vector3(0, rt, -L / 2), new THREE.Vector3(0, 1, 0), fwd));
    // prone paddling and pop-up (doc 03 §6.5)
    const zHips = this.derived.cob.z - 0.03;
    const zChest = zHips + 0.19 * H;
    list.push(this.deckAnchor('ANC_hips_paddle', zHips, 0, fwd));
    list.push(this.deckAnchor('ANC_chest_paddle', zChest, 0, fwd));
    const zHand = zChest - 0.06;
    const xHand = Math.max(0.1, this.halfWidth(this.uOf(zHand)) - 0.06);
    list.push(this.deckAnchor('ANC_hand_popup_L', zHand, xHand, fwd));
    list.push(this.deckAnchor('ANC_hand_popup_R', zHand, -xHand, fwd));
    // rail grabs at the rail apex, +Y = outward rail normal
    for (const side of [1, -1]) {
      const u = this.uOf(zHand);
      const pt = [0, 0];
      this.section(u, Math.PI / 2, pt);
      list.push(this.frameAnchor(side > 0 ? 'ANC_hand_rail_L' : 'ANC_hand_rail_R', new THREE.Vector3(side * pt[0], pt[1], zHand), new THREE.Vector3(side, 0, 0), fwd));
    }
    // leash
    const zPlug = zt + this.spec.plug.fromTail;
    const plug = this.deckAnchor('ANC_leash_plug', zPlug, 0, fwd);
    list.push(plug);
    const rs = this.deckAnchor('ANC_leash_railsaver', zPlug - 0.03, 0, fwd);
    rs.position.y += 0.015;
    list.push(rs);
    // fins
    let px = 0;
    let pz = 0;
    let pw = 0;
    for (const f of this.finPlacements()) {
      const tip = new THREE.Vector3(0, f.depth, -f.base * 0.35).applyQuaternion(f.quaternion).add(f.trail);
      list.push({ name: `ANC_fin_${f.id}_trail`, position: f.trail.clone(), quaternion: f.quaternion.clone() });
      list.push({ name: `ANC_fin_${f.id}_tip`, position: tip, quaternion: f.quaternion.clone() });
      const area = f.depth * f.base * 0.75;
      px += f.trail.x * area;
      pz += f.trail.z * area;
      pw += area;
    }
    const pivot = this.bottomFrame(pz / pw, px / pw);
    list.push(this.frameAnchor('ANC_pivot', pivot.p, pivot.n.clone().negate(), fwd));
    list.push(this.frameAnchor('ANC_cob', this.derived.cob.clone(), new THREE.Vector3(0, 1, 0), fwd));
    const com = this.derived.cob.clone();
    com.z -= 0.03;
    list.push(this.frameAnchor('ANC_com', com, new THREE.Vector3(0, 1, 0), fwd));
    // lowest bottom point (rocker apex)
    let bestU = 0.5;
    let best = Infinity;
    for (let i = 0; i <= 200; i++) {
      const u = i / 200;
      const r = this.rocker(u);
      if (r < best) {
        best = r;
        bestU = u;
      }
    }
    list.push(this.frameAnchor('ANC_contact_bottom_center', new THREE.Vector3(0, best, this.zOf(bestU)), new THREE.Vector3(0, -1, 0), fwd));
    return list;
  }
}
