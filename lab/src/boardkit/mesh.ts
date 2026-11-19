// boardkit mesh builder: hull (deck + bottom sheets, rounded tip caps), fins, traction pad,
// leash plug, procedural textures (stringer, wax, wax bumps, pad grooves). Board frame per board.ts.

import * as THREE from 'three';
import type { Board } from './board.ts';

export interface BoardMeshOptions {
  stations?: number;
  /** Section points per half-sheet (apex → stringer). */
  halfSection?: number;
  finish?: 'sanded' | 'gloss';
  /** Wax coverage 0..1 (0 = freshly glassed board). */
  wax?: number;
}

// UV atlas: U = (z + 1.1) / 2.2; deck V in [0.5, 1], bottom V in [0, 0.5]; x spans ±0.3 m.
const ATLAS_LEN = 2.2;
const ATLAS_HALF = 0.3;
const uvU = (z: number) => (z + ATLAS_LEN / 2) / ATLAS_LEN;
const uvDeck = (x: number) => 0.75 + (x / ATLAS_HALF) * 0.25;
const uvBottom = (x: number) => 0.25 - (x / ATLAS_HALF) * 0.25;

const pt = [0, 0];
const pa = [0, 0];
const pb = [0, 0];

function cosStations(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(0.5 - 0.5 * Math.cos((Math.PI * i) / (n - 1)));
  return out;
}

/** phi values for one ring: bottom sheet (right apex → bottom stringer → left apex) or deck sheet (left apex → deck → right apex). Returns [phi, sideSign]. */
function sheetAngles(half: number, deck: boolean): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const f = (t: number) => Math.pow(t, 1.35); // dense toward the rail apex
  for (let i = 0; i <= 2 * half; i++) {
    // i = 0 .. half: first side apex -> stringer; half .. 2 half: stringer -> other apex
    const t = i <= half ? 1 - i / half : (i - half) / half; // distance from stringer (1 at apex)
    const off = (Math.PI / 2) * (1 - f(1 - t)); // 0 at stringer .. pi/2 at apex? (see below)
    // off measures angle from the stringer: stringer = 0, apex = pi/2
    const phi = deck ? Math.PI - off : off;
    const side = deck ? (i <= half ? 1 : -1) : i <= half ? -1 : 1;
    out.push([phi, side]);
  }
  return out;
}

function hullPoint(b: Board, u: number, phi: number, side: number, out: THREE.Vector3): THREE.Vector3 {
  b.section(u, phi, pt);
  return out.set(side * pt[0], pt[1], b.zOf(u));
}

const _p = new THREE.Vector3();
const _du = new THREE.Vector3();
const _dp = new THREE.Vector3();
const _n = new THREE.Vector3();

function hullNormal(b: Board, u: number, phi: number, side: number, deck: boolean, out: THREE.Vector3): THREE.Vector3 {
  const eu = 1e-4;
  const ep = 2e-3;
  const u0 = Math.max(0, u - eu);
  const u1 = Math.min(1, u + eu);
  b.section(u1, phi, pa);
  b.section(u0, phi, pb);
  _du.set(side * (pa[0] - pb[0]), pa[1] - pb[1], b.zOf(u1) - b.zOf(u0));
  const p0 = Math.max(ep, Math.min(Math.PI - ep, phi - ep));
  const p1 = Math.max(ep, Math.min(Math.PI - ep, phi + ep));
  b.section(u, p1, pa);
  b.section(u, p0, pb);
  _dp.set(side * (pa[0] - pb[0]), pa[1] - pb[1], 0);
  out.crossVectors(_du, _dp);
  // orient outward: deck sheet up-ish/outward, bottom sheet down-ish/outward
  b.section(u, phi, pt);
  const mid = b.rocker(u) + b.apexRatio(u) * b.thickness(u);
  const ox = side * pt[0];
  const oy = pt[1] - mid;
  if (out.x * ox + out.y * oy * 8 < 0) out.negate();
  if (out.lengthSq() < 1e-20) out.set(0, deck ? 1 : -1, 0);
  return out.normalize();
}

export function buildHullGeometry(b: Board, opts: BoardMeshOptions = {}): THREE.BufferGeometry {
  const N = opts.stations ?? 128;
  const half = opts.halfSection ?? 20;
  const us = cosStations(N);
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];

  const sheet = (deck: boolean) => {
    const angles = sheetAngles(half, deck);
    const base = pos.length / 3;
    const R = angles.length;
    for (const u of us) {
      for (const [phi, side] of angles) {
        hullPoint(b, u, phi, side, _p);
        hullNormal(b, u, phi, side, deck, _n);
        pos.push(_p.x, _p.y, _p.z);
        nor.push(_n.x, _n.y, _n.z);
        uv.push(uvU(_p.z), deck ? uvDeck(_p.x) : uvBottom(_p.x));
      }
    }
    for (let i = 0; i < N - 1; i++) {
      for (let j = 0; j < R - 1; j++) {
        const a = base + i * R + j;
        const c = a + R;
        idx.push(a, a + 1, c, a + 1, c + 1, c);
      }
    }
  };
  sheet(true);
  sheet(false);

  // rounded end caps (tail at u = 0, nose at u = 1)
  const cap = (u: number, dirZ: number) => {
    const ring: Array<[number, number]> = [...sheetAngles(half, true), ...sheetAngles(half, false).slice(1, -1)];
    const T = b.thickness(u);
    const yc = b.rocker(u) + b.apexRatio(u) * T + 0.0 * T;
    const zc = b.zOf(u);
    const rEnd = Math.min(0.45 * T, 0.012);
    const K = 4;
    const ringPts: THREE.Vector3[] = ring.map(([phi, side]) => hullPoint(b, u, phi, side, new THREE.Vector3()));
    const base = pos.length / 3;
    const R = ringPts.length;
    for (let k = 0; k <= K; k++) {
      const beta = (Math.PI / 2) * (k / K);
      const sc = Math.cos(beta);
      for (let j = 0; j < R; j++) {
        const p = ringPts[j];
        const x = p.x * (0.15 + 0.85 * sc);
        const y = yc + (p.y - yc) * sc;
        const z = zc + dirZ * rEnd * Math.sin(beta);
        pos.push(x, y, z);
        // normal: blend from the ring's outward direction to the end direction
        _n.set(p.x, (p.y - yc) * 3, 0).normalize().multiplyScalar(sc).add(_du.set(0, 0, dirZ * Math.sin(beta))).normalize();
        nor.push(_n.x, _n.y, _n.z);
        const deckSide = p.y > yc;
        uv.push(uvU(z), deckSide ? uvDeck(x) : uvBottom(x));
      }
    }
    for (let k = 0; k < K; k++) {
      for (let j = 0; j < R; j++) {
        const a = base + k * R + j;
        const a1 = base + k * R + ((j + 1) % R);
        const c = a + R;
        const c1 = a1 + R;
        if (dirZ > 0) idx.push(a, a1, c, a1, c1, c);
        else idx.push(a, c, a1, a1, c, c1);
      }
    }
    // centre fan
    const centre = pos.length / 3;
    pos.push(0, yc, zc + dirZ * rEnd);
    nor.push(0, 0, dirZ);
    uv.push(uvU(zc), 0.5);
    const last = base + K * R;
    for (let j = 0; j < R; j++) {
      const a = last + j;
      const a1 = last + ((j + 1) % R);
      if (dirZ > 0) idx.push(a, a1, centre);
      else idx.push(a, centre, a1);
    }
  };
  cap(0, -1);
  cap(1, 1);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

// ---------------------------------------------------------------- fins
export function buildFinGeometry(depth: number, base: number, centre: boolean, inner: number): THREE.BufferGeometry {
  const NS = 14; // span stations
  const K = 16; // chord points per side
  const pos: number[] = [];
  const idx: number[] = [];
  const rake = 0.55 * base; // trailing-edge sweep at the tip
  const tRatio = centre ? 0.085 : 0.075;
  const ring = 2 * K;
  for (let s = 0; s <= NS; s++) {
    const eta = s / NS;
    const c = base * Math.max(0.06, 1 - 0.8 * Math.pow(eta, 1.25)) * Math.sqrt(Math.max(0.02, 1 - Math.pow(eta, 6)));
    const te = -rake * Math.pow(eta, 1.6);
    const y = depth * eta;
    for (let side = 0; side < 2; side++) {
      for (let k = 0; k < K; k++) {
        const kk = side === 0 ? k : K - k;
        const xc = 0.5 - 0.5 * Math.cos((Math.PI * kk) / K); // 0 leading .. 1 trailing
        const yt = 5 * tRatio * (0.2969 * Math.sqrt(xc) - 0.126 * xc - 0.3516 * xc * xc + 0.2843 * xc ** 3 - 0.1036 * xc ** 4);
        const sgn = side === 0 ? -inner : inner;
        const scale = centre ? 1 : sgn === inner ? 0.2 : 1.8;
        const thick = yt * c * scale * (1 - 0.5 * eta);
        pos.push(sgn * thick, y, te + c * (1 - xc));
      }
    }
  }
  for (let s = 0; s < NS; s++) {
    for (let k = 0; k < ring; k++) {
      const a = s * ring + k;
      const a1 = s * ring + ((k + 1) % ring);
      idx.push(a, a + ring, a1, a1, a + ring, a1 + ring);
    }
  }
  // tip fan
  const tip = pos.length / 3;
  const lastS = NS * ring;
  pos.push(pos[lastS * 3], depth * 1.003, pos[lastS * 3 + 2] - 0.002);
  for (let k = 0; k < ring; k++) idx.push(lastS + k, tip, lastS + ((k + 1) % ring));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------- traction pad
export function buildPadGeometry(b: Board): THREE.BufferGeometry {
  const P = b.spec.pad;
  const zt = -b.L / 2;
  const z0 = zt + P.fromTail;
  const z1 = z0 + P.length;
  const NZ = 40;
  const NX = 28;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= NZ; i++) {
    const z = z0 + ((z1 - z0) * i) / NZ;
    const W = b.halfWidth(b.uOf(z)) - 0.022;
    for (let j = 0; j <= NX; j++) {
      const q = (j / NX) * 2 - 1;
      const x = q * W;
      const edge = i === 0 || i === NZ || j === 0 || j === NX;
      const zr = (z - z0) / (z1 - z0);
      // kick: wedge at the tail end, ramps up over the last 9 cm; arch: centre ridge in the middle third
      const kick = P.kick * (1 - smooth01((z - z0) / 0.09)) * (1 - 0.3 * q * q);
      const arch = P.arch * Math.exp(-((x / 0.035) ** 2)) * smooth01(zr / 0.35) * smooth01((1 - zr) / 0.3);
      const y = b.deckHeight(z, x) + (edge ? 0.0005 : 0.005 + kick + arch);
      pos.push(x, y, z);
      uv.push(x / 0.012, z / 0.012);
    }
  }
  const R = NX + 1;
  for (let i = 0; i < NZ; i++)
    for (let j = 0; j < NX; j++) {
      const a = i * R + j;
      idx.push(a, a + R, a + 1, a + 1, a + R, a + R + 1);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function smooth01(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

// ---------------------------------------------------------------- textures
function rng(seed: number) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hull textures in the planform atlas: albedo, ORM-like (R clearcoat, G roughness), normal. */
export function buildHullTextures(b: Board, opts: BoardMeshOptions = {}) {
  const W = 2048;
  const H = 1024;
  const wax = opts.wax ?? 1;
  const sanded = (opts.finish ?? b.spec.finish.surface) === 'sanded';
  const albedo = new Uint8Array(W * H * 4);
  const orm = new Uint8Array(W * H * 4);
  const height = new Float32Array(W * H);
  const zt = -b.L / 2;
  const padEnd = zt + b.spec.pad.fromTail + b.spec.pad.length;
  const waxZ0 = padEnd + 0.01;
  const waxZ1 = 0.32;
  const r = rng(7);
  // wax bumps: random blobs (base coat + top-coat bumps)
  const bumps: Array<[number, number, number, number]> = [];
  for (let i = 0; i < 26000 * wax; i++) {
    const z = waxZ0 + r() * (waxZ1 - waxZ0);
    const x = (r() * 2 - 1) * 0.25;
    bumps.push([z, x, 0.002 + r() * 0.004, 0.25 + r() * 0.75]);
  }
  const zOfPx = (i: number) => ((i + 0.5) / W) * ATLAS_LEN - ATLAS_LEN / 2;
  const xOfDeckPx = (j: number) => (((j + 0.5) / H - 0.75) / 0.25) * ATLAS_HALF;
  const xOfBotPx = (j: number) => -(((j + 0.5) / H - 0.25) / 0.25) * ATLAS_HALF;
  const pxOf = (z: number) => uvU(z) * W;
  const pyDeck = (x: number) => uvDeck(x) * H;
  for (const [z, x, rad, amp] of bumps) {
    const halfW = b.halfWidth(b.uOf(z)) - 0.03;
    if (Math.abs(x) > halfW) continue;
    const cx = pxOf(z);
    const cy = pyDeck(x);
    const rp = (rad / ATLAS_LEN) * W;
    const x0 = Math.floor(cx - rp);
    const x1 = Math.ceil(cx + rp);
    const y0 = Math.floor(cy - rp);
    const y1 = Math.ceil(cy + rp);
    for (let py = y0; py <= y1; py++)
      for (let px = x0; px <= x1; px++) {
        const d = Math.hypot(px - cx, py - cy) / rp;
        if (d < 1 && px >= 0 && px < W && py >= 0 && py < H) height[py * W + px] += amp * (1 - d * d) ** 2;
      }
  }
  const foam = [237, 235, 226];
  const wood = [176, 138, 92];
  const stringerHalf = b.spec.stringer.width / 2;
  for (let j = 0; j < H; j++) {
    const deck = j >= H / 2;
    const x = deck ? xOfDeckPx(j) : xOfBotPx(j);
    for (let i = 0; i < W; i++) {
      const z = zOfPx(i);
      const o = (j * W + i) * 4;
      let c = foam;
      let clear = 255;
      let rough = sanded ? 115 : 100;
      if (Math.abs(x) < stringerHalf) c = wood;
      let cr = c[0];
      let cg = c[1];
      let cb = c[2];
      if (deck && wax > 0) {
        const halfW = b.halfWidth(b.uOf(Math.max(-b.L / 2, Math.min(b.L / 2, z)))) - 0.03;
        // soft-edged wax region with grime toward the feet
        const inZ = smooth01((z - waxZ0) / 0.04) * smooth01((waxZ1 - z) / 0.08);
        const inX = smooth01((halfW - Math.abs(x)) / 0.03);
        const w = inZ * inX * wax;
        if (w > 0) {
          const h = Math.min(1.5, height[j * W + i]);
          const grime = 0.9 - 0.06 * h;
          cr = cr * (1 - w) + 226 * grime * w;
          cg = cg * (1 - w) + 222 * grime * w;
          cb = cb * (1 - w) + 205 * grime * w;
          clear = Math.round(255 * (1 - w));
          rough = Math.round(rough * (1 - w) + 205 * w);
        }
      }
      albedo[o] = cr;
      albedo[o + 1] = cg;
      albedo[o + 2] = cb;
      albedo[o + 3] = 255;
      orm[o] = clear;
      orm[o + 1] = rough;
      orm[o + 2] = 0;
      orm[o + 3] = 255;
    }
  }
  // normal map from the wax height field
  const nrm = new Uint8Array(W * H * 4);
  const k = 0.9;
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      const o = j * W + i;
      const hx = (height[j * W + Math.min(W - 1, i + 1)] - height[j * W + Math.max(0, i - 1)]) * k;
      const hy = (height[Math.min(H - 1, j + 1) * W + i] - height[Math.max(0, j - 1) * W + i]) * k;
      const l = Math.hypot(hx, hy, 1);
      nrm[o * 4] = Math.round((-hx / l) * 127.5 + 127.5);
      nrm[o * 4 + 1] = Math.round((-hy / l) * 127.5 + 127.5);
      nrm[o * 4 + 2] = Math.round((1 / l) * 127.5 + 127.5);
      nrm[o * 4 + 3] = 255;
    }
  const mk = (data: Uint8Array, srgb: boolean) => {
    const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.anisotropy = 8;
    t.flipY = false;
    t.needsUpdate = true;
    return t;
  };
  return { albedo: mk(albedo, true), orm: mk(orm, false), normal: mk(nrm, false) };
}

function padGrooveNormal(): THREE.DataTexture {
  // diamond grooves: two diagonal sets of V grooves, tiling
  const S = 128;
  const h = new Float32Array(S * S);
  for (let j = 0; j < S; j++)
    for (let i = 0; i < S; i++) {
      const u = i / S;
      const v = j / S;
      const d1 = Math.abs(((u + v) * 2) % 1 - 0.5);
      const d2 = Math.abs(((u - v + 1) * 2) % 1 - 0.5);
      h[j * S + i] = Math.min(1, Math.min(d1, d2) * 6);
    }
  const data = new Uint8Array(S * S * 4);
  for (let j = 0; j < S; j++)
    for (let i = 0; i < S; i++) {
      const hx = (h[j * S + ((i + 1) % S)] - h[j * S + ((i - 1 + S) % S)]) * 1.2;
      const hy = (h[((j + 1) % S) * S + i] - h[((j - 1 + S) % S) * S + i]) * 1.2;
      const l = Math.hypot(hx, hy, 1);
      const o = (j * S + i) * 4;
      data[o] = Math.round((-hx / l) * 127.5 + 127.5);
      data[o + 1] = Math.round((-hy / l) * 127.5 + 127.5);
      data[o + 2] = Math.round((1 / l) * 127.5 + 127.5);
      data[o + 3] = 255;
    }
  const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

export interface BoardMaterials {
  hull: THREE.MeshPhysicalMaterial;
  fin: THREE.MeshPhysicalMaterial;
  pad: THREE.MeshPhysicalMaterial;
  plug: THREE.MeshStandardMaterial;
}

export function buildMaterials(b: Board, opts: BoardMeshOptions = {}): BoardMaterials {
  const tex = buildHullTextures(b, opts);
  const sanded = (opts.finish ?? b.spec.finish.surface) === 'sanded';
  const hull = new THREE.MeshPhysicalMaterial({
    name: 'hull',
    map: tex.albedo,
    roughnessMap: tex.orm,
    clearcoatMap: tex.orm,
    normalMap: tex.normal,
    normalScale: new THREE.Vector2(0.6, 0.6),
    roughness: 1,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: sanded ? 0.32 : 0.04,
    ior: 1.55,
    sheen: 0,
  });
  const fin = new THREE.MeshPhysicalMaterial({ name: 'fin', color: new THREE.Color(0.05, 0.055, 0.06), roughness: 0.45, clearcoat: 0.6, clearcoatRoughness: 0.15 });
  const groove = padGrooveNormal();
  const pad = new THREE.MeshPhysicalMaterial({
    name: 'pad',
    color: new THREE.Color(0.025, 0.025, 0.027),
    roughness: 0.88,
    sheen: 0.25,
    sheenRoughness: 0.8,
    sheenColor: new THREE.Color(0.3, 0.3, 0.3),
    normalMap: groove,
    normalScale: new THREE.Vector2(0.8, 0.8),
  });
  const plug = new THREE.MeshStandardMaterial({ name: 'plug', color: 0x111111, roughness: 0.6 });
  return { hull, fin, pad, plug };
}

/** Build the complete board object: meshes + ANC_* anchor nodes, in the board frame. */
export function buildBoardObject(b: Board, opts: BoardMeshOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = `BOARD_${b.spec.id}`;
  const mats = buildMaterials(b, opts);
  const hull = new THREE.Mesh(buildHullGeometry(b, opts), mats.hull);
  hull.name = 'MESH_hull_LOD0';
  hull.castShadow = true;
  hull.receiveShadow = true;
  root.add(hull);
  for (const f of b.finPlacements()) {
    const side = f.id.startsWith('L') ? 1 : f.id.startsWith('R') ? -1 : 0;
    const m = new THREE.Mesh(buildFinGeometry(f.depth, f.base, f.template === 'M_centre', side >= 0 ? 1 : -1), mats.fin);
    m.name = `MESH_fin_${f.id}`;
    m.position.copy(f.trail);
    m.quaternion.copy(f.quaternion);
    m.castShadow = true;
    root.add(m);
  }
  const pad = new THREE.Mesh(buildPadGeometry(b), mats.pad);
  pad.name = 'MESH_pad';
  pad.castShadow = true;
  pad.receiveShadow = true;
  root.add(pad);
  const plugA = b.anchors().find((a) => a.name === 'ANC_leash_plug')!;
  const plug = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, 0.003, 24), mats.plug);
  plug.name = 'MESH_plug';
  plug.position.copy(plugA.position);
  plug.quaternion.copy(plugA.quaternion);
  plug.receiveShadow = true;
  root.add(plug);
  for (const a of b.anchors()) {
    const o = new THREE.Object3D();
    o.name = a.name;
    o.position.copy(a.position);
    o.quaternion.copy(a.quaternion);
    if (a.extras) o.userData = { bluecurl: a.extras };
    root.add(o);
  }
  root.userData = {
    bluecurl: {
      schema: 'bluecurl.board/1',
      units: 'm',
      frame: { forward: '+Z', up: '+Y', left: '+X', origin: 'rocker-table plane, stringer, mid-length' },
      spec: b.spec,
      derived: { volumeL: b.derived.volumeL, massKg: b.derived.massKg, cob: b.derived.cob.toArray(), lengthOverCurve: b.derived.lengthOverCurve },
    },
  };
  return root;
}
