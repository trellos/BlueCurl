// Surfboard for the rider models (WP6b).
// Adapted from the spike's src/surf/Board.js (repo root, same project): the lofted 6'0" thruster outline
// (halfWidth / rocker / thickness foil, soft-railed section) and the three raked fins are copied as they were;
// the custom gloss ShaderMaterial is replaced by a vertex-coloured MeshPhysicalMaterial (clearcoat) so it shares
// the app's sun light, IBL and the riders' warm rim. Deck white with a stringer-ish centre line, black tail pad,
// a rider-colour nose band and a rider-colour sprayed bottom (reads when the board is on rail or upside down).
// Board space: +x nose, +y deck normal, +z right rail; origin on the bottom at the widest point (stance centre).
import * as THREE from 'three';

export const BOARD = {
  length: 1.83,
  width: 0.483,       // 19"
  thick: 0.062,       // 2 7/16"
  noseRocker: 0.125,  // bottom lift at the nose (m)
  tailRocker: 0.045,
  wideAt: 0.47,       // widest point, fraction of the length from the tail
};

const smooth = (a, b, v) => { const t = Math.min(Math.max((v - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };
function halfWidth(u) {
  const W = BOARD.width / 2;
  if (u >= BOARD.wideAt) {
    const v = (u - BOARD.wideAt) / (1 - BOARD.wideAt);
    return W * Math.pow(Math.max(1 - v * v, 0), 0.62) * (1 - 0.06 * v);
  }
  const v = (BOARD.wideAt - u) / BOARD.wideAt;
  return W * (1 - 0.42 * Math.pow(v, 1.9)) * (u < 0.015 ? 0.6 + 0.4 * u / 0.015 : 1);
}
function rocker(u) {
  const c = BOARD.wideAt;
  if (u >= c) { const v = (u - c) / (1 - c); return BOARD.noseRocker * Math.pow(v, 2.3); }
  const v = (c - u) / c; return BOARD.tailRocker * Math.pow(v, 2.0);
}
function thickness(u) {
  const v = (u - 0.45) / 0.55;
  const t = u >= 0.45 ? 1 - 0.78 * Math.pow(Math.max(v, 0), 1.6) : 1 - 0.55 * Math.pow((0.45 - u) / 0.45, 1.8);
  return BOARD.thick * Math.max(t, 0.12);
}
/** Deck height (top surface, centre line) at board-space x. */
export function deckAt(x) {
  const u = Math.min(Math.max((x + BOARD.wideAt * BOARD.length) / BOARD.length, 0), 1);
  return rocker(u) + thickness(u);
}

function buildHull(rider, NU = 56, NV = 22) {
  const pos = [], col = [], idx = [];
  const L = BOARD.length, x0 = -BOARD.wideAt * L;
  const white = new THREE.Color(0.86, 0.87, 0.86), pad = new THREE.Color(0.06, 0.065, 0.07);
  const rc = new THREE.Color(rider), bottom = rc.clone().lerp(white, 0.15), band = rc.clone();
  const strC = new THREE.Color(0.62, 0.50, 0.36);
  const c = new THREE.Color();
  for (let i = 0; i <= NU; i++) {
    const s = i / NU, u = 0.5 - 0.5 * Math.cos(Math.PI * s);
    const w = halfWidth(u), th = thickness(u), r = rocker(u);
    for (let j = 0; j <= NV; j++) {
      const a = (j / NV) * 2 * Math.PI - Math.PI / 2;
      const cs = Math.cos(a), sn = Math.sin(a);
      const lat = Math.sign(cs) * Math.pow(Math.abs(cs), 0.42);
      const y = sn >= 0 ? th * (0.32 + 0.68 * Math.pow(sn, 0.55)) : th * 0.32 * (1 - Math.pow(-sn, 0.30));
      const vee = (1 - Math.abs(lat)) * 0.004 * (1 - smooth(0.0, 0.5, u));
      pos.push(x0 + u * L, r + y - vee, w * lat);
      // colour
      if (sn < -0.05) c.copy(bottom);
      else {
        c.copy(white);
        if (sn > 0.3 && u < 0.17 && Math.abs(w * lat) < 0.17) c.copy(pad);
        else if (u > 0.70 && u < 0.80) c.copy(band);
        else if (sn > 0.97) c.lerp(strC, 0.5);
      }
      col.push(c.r, c.g, c.b);
    }
  }
  const row = NV + 1;
  for (let i = 0; i < NU; i++) for (let j = 0; j < NV; j++) {
    const a = i * row + j, b = a + 1, cc = a + row, d = cc + 1;
    idx.push(a, cc, b, b, cc, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function buildFins() {
  const L = BOARD.length, x0 = -BOARD.wideAt * L;
  const fin = (xBase, zBase, toe, cant, depth, base) => {
    const pts = [];
    const N = 8;
    for (let k = 0; k <= N; k++) {
      const v = k / N;
      const lead = -base * 0.5 + base * 0.62 * Math.pow(v, 1.4);
      const trail = base * 0.5 - base * 0.25 * Math.pow(v, 0.8) + base * 0.15 * v;
      pts.push([lead, -depth * v], [Math.max(trail, lead + 0.004), -depth * v]);
    }
    const pos = [], idx = [];
    const thick = 0.005;
    for (const side of [-1, 1]) for (const [px, py] of pts) {
      const tz = side * thick * (1 - Math.min(Math.abs(py) / depth, 1) * 0.6);
      const xx = px * Math.cos(toe) - tz * Math.sin(toe), zz = px * Math.sin(toe) + tz * Math.cos(toe);
      const yy = py * Math.cos(cant), zc = zz + py * Math.sin(cant);
      pos.push(xBase + xx, yy + 0.002, zBase + zc);
    }
    const n = pts.length;
    for (let k = 0; k < N; k++) {
      const a = 2 * k, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, c, b, b, c, d);
      idx.push(n + a, n + b, n + c, n + b, n + d, n + c);
      idx.push(a, n + a, c, c, n + a, n + c);
      idx.push(b, d, n + b, d, n + d, n + b);
    }
    return { pos, idx };
  };
  const parts = [
    fin(x0 + 0.115, 0, 0, 0, 0.112, 0.105),
    fin(x0 + 0.29, 0.195, -0.06, 0.12, 0.115, 0.11),
    fin(x0 + 0.29, -0.195, 0.06, -0.12, 0.115, 0.11),
  ];
  const pos = [], idx = [];
  for (const p of parts) { const o = pos.length / 3; pos.push(...p.pos); idx.push(...p.idx.map((i) => i + o)); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(new Array(pos.length).fill(0.12), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Merged hull + fins geometry (one draw), vertex-coloured for rider colour `rider` (hex). */
export function boardGeometry(rider) {
  const h = buildHull(rider), f = buildFins();
  const merge = (a, b) => {
    const g = new THREE.BufferGeometry();
    for (const k of ['position', 'normal', 'color']) {
      const A = a.attributes[k].array, B = b.attributes[k].array;
      const arr = new Float32Array(A.length + B.length); arr.set(A); arr.set(B, A.length);
      g.setAttribute(k, new THREE.BufferAttribute(arr, 3));
    }
    const n = a.attributes.position.count;
    g.setIndex([...a.index.array, ...Array.from(b.index.array, (i) => i + n)]);
    return g;
  };
  const g = merge(h, f);
  h.dispose(); f.dispose();
  return g;
}

export function boardMaterial(sunDir, riderMat) {
  const mat = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.35, metalness: 0, clearcoat: 1.0,
    clearcoatRoughness: 0.08, side: THREE.DoubleSide });
  // share the riders' warm rim (same onBeforeCompile body; separate cache key for the physical variant)
  if (riderMat) {
    mat.userData.rim = riderMat.userData.rim;
    mat.onBeforeCompile = riderMat.onBeforeCompile;
    mat.customProgramCacheKey = () => 'bcRiderBoard';
  }
  return mat;
}
