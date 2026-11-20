import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bayBendJS } from './terrain.js';
import { coastMaterial } from './CoastMaterial.js';

// A low-rise surf town behind the beach (replaces the Nice seafront): a boardwalk and a coast road on
// the promenade level, then one or two rows of 1-2 storey beach houses (clapboard or render, gable or
// hip roofs in tin / shingle / tile, front decks with railings, some porch roofs), the odd surf shack
// or cafe with an awning and boards on a rack, and a sparser second row behind. Deterministic (hashed
// per lot), world-anchored over +-HALF m along the (bent) shore, batched per 84 m district like the
// original Seafront so whole streets are culled behind the camera.
//
// Material kinds (CoastMaterial.js): 0 render, 1 glass, 2 metal, 3 roofing, 4 paving, 5 clapboard,
// 6 deck boards.

const STREET = 5.56;                 // promenade / street level (Promenade.js Y_CAP)
const HALF = 3000;                   // along-shore extent either side of x = 0 (m)
const hash = (n) => { const v = Math.sin(n * 127.1 + 311.7) * 43758.5453; return v - Math.floor(v); };
const pick = (a, r) => a[Math.min(Math.floor(r * a.length), a.length - 1)];

const WALLS = ['#f2efe6', '#e9f0ee', '#bcd9e2', '#cfe3d2', '#f0dfc0', '#e8c9b5', '#a9c8d6', '#d9d3c8', '#b9c3c2', '#f3e6d0', '#8fb4c4', '#e4b8a6'];
const WOOD = ['#9c8a74', '#b39f86', '#8a7a68', '#c2b39c'];
const ROOFS = ['#5d6a70', '#6f7a7e', '#8b4b3e', '#a35a43', '#3f4a52', '#7d8b8f', '#4e5b4f'];
const TRIM = '#f4f2ec';
const AWNINGS = [['#e9e6dc', '#3d8fb0'], ['#f1ece0', '#d0604f'], ['#ece6d6', '#e3a33c'], ['#efeadf', '#3c9c86']];
const BOARDS = ['#f4f1ea', '#f2c94c', '#56b6d9', '#e76f51', '#f4f1ea', '#9bd37c'];

export class SurfTown {
  constructor(shared) {
    this.group = new THREE.Group(); this.group.name = 'Surf town';
    const material = coastMaterial(shared), districts = new Map();
    const district = (x) => { const id = Math.floor(x / 84); if (!districts.has(id)) districts.set(id, { boxes: [], parts: [] }); return districts.get(id); };
    // an axis-aligned box in the local frame of a lot (centre x0, front z0), rotated by rot about y
    const box = (x, y, z, w, h, d, c, kind = 0, rot = 0) => district(x).boxes.push({ x, y, z, w, h, d, c, kind, rot });
    const part = (x, g, c, kind) => {
      g.translate(0, 0, -bayBendJS(x));
      const n = g.attributes.position.count, cs = new Float32Array(n * 3), cc = new THREE.Color(c).toArray();
      for (let i = 0; i < n; i++) cs.set(cc, i * 3);
      g.setAttribute('color', new THREE.Float32BufferAttribute(cs, 3));
      g.setAttribute('aKind', new THREE.Float32BufferAttribute(new Float32Array(n).fill(kind), 1));
      if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
      district(x).parts.push(g.index ? g.toNonIndexed() : g);
    };
    // gable roof: a triangular prism with eaves; ridge along x (along = true) or along z
    const gable = (cx, y, cz, w, d, rise, c, along) => {
      const ow = w + 0.7, od = d + 0.7;
      const L = along ? ow : od, S = along ? od : ow;
      const sh = new THREE.Shape([new THREE.Vector2(-S / 2, 0), new THREE.Vector2(S / 2, 0), new THREE.Vector2(0, rise)]);
      const g = new THREE.ExtrudeGeometry(sh, { depth: L, bevelEnabled: false });
      g.translate(0, 0, -L / 2);
      if (along) g.rotateY(Math.PI / 2);
      g.translate(cx, y, cz);
      // slope uv.x across the roof courses (CoastMaterial kind 3 draws seams / tile courses)
      const p = g.attributes.position, uv = g.attributes.uv;
      for (let i = 0; i < p.count; i++) uv.setX(i, (along ? p.getZ(i) - cz : p.getX(i) - cx) * 2.2 + p.getY(i) * 2.2);
      part(cx, g, c, 3);
    };
    // hip roof: a 4-sided pyramid frustum
    const hip = (cx, y, cz, w, d, rise, c) => {
      const g = new THREE.CylinderGeometry(0.18, 1, rise, 4, 1);
      g.rotateY(Math.PI / 4); g.scale((w + 0.7) / Math.SQRT2, 1, (d + 0.7) / Math.SQRT2);
      g.translate(cx, y + rise / 2, cz);
      part(cx, g, c, 3);
    };

    // ---------------------------------------------------------------- boardwalk and coast road
    for (let x = -HALF - 21; x < HALF + 21; x += 21) {
      box(x, STREET - 0.15, 49.1, 21, 0.3, 18.2, '#a99a83', 6);          // timber boardwalk
      box(x, STREET - 0.16, 60.5, 21, 0.3, 4.6, '#cdbf9f');               // sandy verge
      box(x, STREET - 0.18, 70.5, 21, 0.3, 15.1, '#5f6466');              // road
      box(x, STREET - 0.017, 70.5, 9, 0.012, 0.14, '#d9d4bc');            // dashed centre line
      // boardwalk rail and posts on the beach side, a bench now and then
      box(x, STREET + 0.95, 40.25, 21, 0.09, 0.09, '#8d7c66', 6);
      for (let k = 0; k < 7; k++) box(x - 9 + k * 3, STREET + 0.5, 40.25, 0.12, 1.0, 0.12, '#7f705d', 6);
      if (hash(x * 0.37) > 0.6) {
        box(x + 4, STREET + 0.45, 45.0, 1.8, 0.08, 0.45, '#8d7c66', 6);
        box(x + 4, STREET + 0.7, 45.25, 1.8, 0.4, 0.06, '#8d7c66', 6);
        for (const s of [-0.8, 0.8]) box(x + 4 + s, STREET + 0.22, 45.0, 0.08, 0.44, 0.4, '#3d4448', 2);
      }
      // street lamps
      if (Math.round(x / 21) % 2 === 0) {
        box(x, STREET + 2.4, 62.6, 0.11, 4.8, 0.11, '#3a4245', 2);
        box(x, STREET + 4.8, 62.1, 0.12, 0.08, 1.0, '#3a4245', 2);
        box(x, STREET + 4.72, 61.65, 0.34, 0.1, 0.22, '#e8e4d8', 1);
      }
    }

    // ---------------------------------------------------------------- houses
    // row: front line z, lot width range, gap range, second-row flag
    const row = (z0, wMin, wMax, gMin, gMax, back) => {
      let x = -HALF;
      let lot = back ? 5000 : 0;
      while (x < HALF) {
        const r = (k) => hash(lot * 13.17 + k * 7.31 + (back ? 91.3 : 0));
        const gap = gMin + (gMax - gMin) * r(1);
        const w = wMin + (wMax - wMin) * r(2);
        const cx = x + gap + w / 2;
        x += gap + w; lot++;
        if (r(3) < (back ? 0.18 : 0.06)) continue;                       // empty lot / dune scrub
        house(cx, z0 + (back ? 6 : 2.5) * (r(4) - 0.5), w, r, back);
      }
    };
    const house = (cx, zf, w, r, back) => {
      const shack = !back && r(5) < 0.12;
      const storeys = shack ? 1 : (r(6) < (back ? 0.45 : 0.35) ? 2 : 1);
      const fh = 3.0, wallH = storeys * fh, base = 0.45;               // raised floor on a low plinth
      const d = shack ? 7 + 2 * r(7) : 8 + 5 * r(7);
      const clap = r(8) < 0.55;
      const wall = shack ? pick(WOOD, r(9)) : pick(WALLS, r(9));
      const kind = clap || shack ? 5 : 0;
      const zc = zf + d / 2, y0 = STREET + base;
      box(cx, STREET + base / 2, zc, w + 0.2, base, d + 0.2, '#b8b2a5');   // plinth
      // second storey set back on some houses (a smaller upper volume and a roof deck in front)
      let topW = w, topD = d, topZ = zc, topY = y0 + wallH;
      if (storeys === 2 && r(10) < 0.35) {
        box(cx, y0 + fh / 2, zc, w, fh, d, wall, kind);
        topD = d * 0.65; topZ = zf + d - topD / 2;
        box(cx, y0 + fh * 1.5, topZ, w, fh, topD, wall, kind);
        box(cx, y0 + fh + 0.55, zf + 0.06, w, 1.0, 0.08, TRIM, 2);      // roof-deck parapet rail
      } else box(cx, y0 + wallH / 2, zc, w, wallH, d, wall, kind);
      // windows and doors on the sea face, trim boards at the corners
      const bays = Math.max(2, Math.round(w / 2.6));
      for (let f = 0; f < storeys; f++) {
        const front = f > 0 && topD < d ? topZ - topD / 2 : zf;
        for (let j = 0; j < bays; j++) {
          const bx = cx - w / 2 + (j + 0.5) * (w / bays);
          const door = f === 0 && j === Math.floor(bays / 2);
          const big = r(11 + j) < 0.3 && !door;
          const ww = door ? 1.0 : big ? Math.min(2.2, w / bays - 0.5) : 1.15, wh = door ? 2.15 : big ? 1.8 : 1.3;
          const wy = y0 + f * fh + (door ? 1.08 : 1.55);
          box(bx, wy, front - 0.04, ww, wh, 0.1, door ? '#5b6b70' : '#7c8e92', door ? 2 : 1);
          box(bx, wy, front - 0.06, ww + 0.22, wh + 0.22, 0.06, TRIM, 0);  // frame
          if (!door && !big && r(20 + j + f) < 0.4) for (const s of [-1, 1]) box(bx + s * (ww / 2 + 0.3), wy, front - 0.08, 0.5, wh + 0.1, 0.05, pick(['#3f7d8c', '#6b9a7a', '#f2efe6', '#c56b4f'], r(30)), 0);
        }
      }
      for (const s of [-1, 1]) box(cx + s * (w / 2 - 0.06), y0 + wallH / 2, zf - 0.02, 0.16, wallH, 0.08, TRIM, 0);
      // roof
      const rc = pick(ROOFS, r(12)), rise = (r(13) < 0.5 ? 0.32 : 0.5) * Math.min(w, d) / 2;
      if (shack || r(14) < 0.18) {
        box(cx, topY + 0.12, topZ, topW + 0.6, 0.24, topD + 0.6, rc, 3);    // flat roof with a fascia
      } else if (r(14) < 0.6) gable(cx, topY, topZ, topW, topD, rise, rc, r(15) < 0.6);
      else hip(cx, topY, topZ, topW, topD, rise * 0.9, rc);
      if (back) return;
      // front deck: boards, posts, rails; a porch roof on some
      const dd = shack ? 3.2 : 2.0 + 1.2 * r(16), dz = zf - dd / 2;
      box(cx, y0 - 0.05, dz, w, 0.12, dd, pick(WOOD, r(17)), 6);
      for (let k = 0; k <= Math.round(w / 2.2); k++) box(cx - w / 2 + k * (w / Math.round(w / 2.2)), y0 + 0.5, zf - dd + 0.06, 0.1, 1.0, 0.1, TRIM, 6);
      box(cx, y0 + 0.95, zf - dd + 0.06, w, 0.07, 0.07, TRIM, 6);
      for (const s of [-1, 1]) box(cx + s * (w / 2 - 0.05), y0 + 0.95, dz, 0.07, 0.07, dd, TRIM, 6);
      if (shack) {
        // surf shack / cafe: striped awning, a board rack with boards, a sign board
        const [a, b] = pick(AWNINGS, r(18)), n = Math.max(4, Math.round(w / 0.8));
        for (let k = 0; k < n; k++) box(cx - w / 2 + (k + 0.5) * (w / n), y0 + 2.75, zf - 1.1, w / n, 0.05, 2.3, k % 2 ? b : a, 0, 0);
        box(cx, y0 + wallH + 0.55, zf - 0.08, Math.min(w - 1, 4.5), 0.75, 0.08, pick(['#2f5f73', '#c4553f', '#2f6d5d'], r(19)), 0);
        const rx = cx + w / 2 + 0.9;
        box(rx, y0 + 0.9, zf + 1.2, 0.08, 1.8, 2.6, '#7f705d', 6);
        for (let k = 0; k < 5; k++) box(rx + 0.12, y0 + 1.05, zf + 0.15 + k * 0.5, 0.07, 1.95, 0.48, pick(BOARDS, r(40 + k)), 2);
      } else if (r(21) < 0.5) {
        for (const s of [-1, 1]) box(cx + s * (w / 2 - 0.15), y0 + 1.3, zf - dd + 0.15, 0.14, 2.6, 0.14, TRIM, 6);
        box(cx, y0 + 2.62, dz, w + 0.3, 0.1, dd + 0.2, rc, 3);
      }
      // a garden palm stub / shrub block now and then, and a car on the road side
      if (r(22) < 0.3) box(cx + w / 2 + 1.2, STREET + 0.6, zf - 1.5, 1.6, 1.2, 1.6, '#6d8358', 0);
      if (r(23) < 0.2) {
        const carX = cx + (r(24) - 0.5) * w, carC = pick(['#d8d6cf', '#3d4a57', '#a63c32', '#2c6e8f', '#e2c044'], r(25));
        box(carX, STREET + 0.55, 75.0, 4.2, 0.75, 1.8, carC, 2);
        box(carX - 0.2, STREET + 1.15, 75.0, 2.3, 0.55, 1.65, '#425157', 1);
      }
    };
    row(80.0, 7.5, 13.5, 2.5, 6.5, false);
    row(97.0, 8.0, 15.0, 3.0, 9.0, true);
    row(118.0, 8.0, 14.0, 6.0, 22.0, true);

    // ---------------------------------------------------------------- land behind: scrub ground, trees
    for (let x = -HALF - 42; x < HALF + 42; x += 42) {
      box(x, STREET - 0.05, 103.5, 42.2, 0.1, 31, '#a6a07c');           // yards / dry grass
      box(x, STREET - 0.06, 840, 42.2, 0.1, 1440, '#8f9466');            // scrubland toward the hills
    }
    const tree = (x, z, h, r, c) => {
      const crown = new THREE.IcosahedronGeometry(r, 0);
      crown.scale(1, 0.8 + 0.3 * hash(x * 3.1 + z), 1); crown.translate(x, STREET + h, z);
      part(x, crown, c, 0);
      box(x, STREET + h / 2 - 0.2, z, 0.25, h, 0.25, '#5d4c3c', 0);
    };
    const GREENS = ['#5f7a45', '#6d8650', '#4f6b3e', '#7b8a55', '#58704a'];
    for (let i = 0; i < 2 * HALF / 4.5; i++) {
      const x = -HALF + i * 4.5 + 3 * (hash(i * 1.7) - 0.5), r1 = hash(i * 9.13), r2 = hash(i * 4.71);
      if (r1 < 0.55) tree(x, 92 + 6 * r2, 3 + 2.5 * r1, 1.4 + 1.2 * r2, pick(GREENS, hash(i * 2.3)));   // between the rows
      if (r2 < 0.7) tree(x + 2, 128 + 40 * hash(i * 6.1), 4 + 4 * r2, 2 + 1.6 * r1, pick(GREENS, hash(i * 5.9)));
      if (hash(i * 8.8) < 0.5) tree(x - 1, 175 + 120 * hash(i * 3.3), 5 + 4 * r1, 2.5 + 2 * r2, pick(GREENS, hash(i * 7.7)));
    }

    // ---------------------------------------------------------------- batch per district
    const dummy = new THREE.Object3D();
    const tilt = (x) => Math.atan(Math.sign(x) * Math.max(0, Math.abs(x) - 150) / 10000);
    for (const [id, d] of districts) {
      const g = new THREE.BoxGeometry(1, 1, 1);
      g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 3).fill(1), 3));
      g.setAttribute('aKind', new THREE.InstancedBufferAttribute(Float32Array.from(d.boxes, (b) => b.kind), 1));
      const mesh = new THREE.InstancedMesh(g, material, d.boxes.length); mesh.name = `Surf town district ${id}`;
      d.boxes.forEach((b, i) => {
        dummy.position.set(b.x, b.y, b.z - bayBendJS(b.x));
        dummy.rotation.set(0, b.rot + tilt(b.x), 0);
        dummy.scale.set(b.w, b.h, b.d); dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix); mesh.setColorAt(i, new THREE.Color(b.c));
      });
      mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor.needsUpdate = true; mesh.computeBoundingSphere();
      this.group.add(mesh);
      if (d.parts.length) {
        const merged = mergeGeometries(d.parts.map((p) => { for (const k of Object.keys(p.attributes)) if (!['position', 'normal', 'uv', 'color', 'aKind'].includes(k)) p.deleteAttribute(k); return p; }));
        d.parts.forEach((p) => p.dispose());
        const roofs = new THREE.Mesh(merged, material); roofs.name = `Surf town roofs ${id}`;
        this.group.add(roofs);
      }
    }
    this.group.userData.instances = [...districts.values()].reduce((n, d) => n + d.boxes.length, 0);
  }
}
