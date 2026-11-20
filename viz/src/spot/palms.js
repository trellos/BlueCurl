// Procedural instanced palms: curved ringed trunk, alpha-tested fronds (canvas leaflet texture), coconuts.
// Sway is done in the vertex shader from a time uniform, so update(t) is a pure function of t.
import * as THREE from 'three';
import { mulberry32 } from '../contracts.js';
import { patchRim } from './look.js';

const VARIANTS = [
  { H: 14.0, lean: 3.6, fronds: 11, frondLen: 6.2 },   // tall, curvy
  { H: 10.5, lean: 2.0, fronds: 10, frondLen: 5.4 },    // shorter, stockier
];

/** Trunk centreline at height fraction f (0..1) for variant v and lean multiplier 1. */
function trunkPoint(v, f) { return [v.lean * f * f, v.H * f, 0]; }

function buildTrunk(v) {
  const rad = 7, seg = 12, pos = [], col = [], idx = [];
  for (let j = 0; j <= seg; j++) {
    const f = j / seg, [cx, cy] = trunkPoint(v, f);
    const ring = (j % 2) ? 1.0 : 1.08;                        // ring bulges read as palm trunk segments
    const r = (0.42 - 0.17 * f) * ring * (j === 0 ? 1.4 : 1);
    const shade = (j % 2) ? 0.82 : 1.0;
    for (let i = 0; i < rad; i++) {
      const a = i / rad * Math.PI * 2;
      pos.push(cx + Math.cos(a) * r, cy, Math.sin(a) * r);
      col.push(0.42 * shade, 0.35 * shade, 0.27 * shade);
    }
  }
  for (let j = 0; j < seg; j++) for (let i = 0; i < rad; i++) {
    const a = j * rad + i, b = j * rad + (i + 1) % rad, c = a + rad, d = b + rad;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aFlex', new THREE.Float32BufferAttribute(new Array(pos.length / 3).fill(0), 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function buildCrown(v, seed) {
  const rnd = mulberry32(seed);
  const [tx, ty] = trunkPoint(v, 1);
  const pos = [], uv = [], nrm = [], flex = [], col = [], idx = [];
  const seg = 9;
  for (let k = 0; k < v.fronds; k++) {
    const az = k / v.fronds * Math.PI * 2 + rnd() * 0.4;
    const pitch0 = 0.55 + rnd() * 0.5 - (k % 3 === 0 ? 0.5 : 0);   // some fronds start low (droopy)
    const len = v.frondLen * (0.8 + rnd() * 0.35);
    const ca = Math.cos(az), sa = Math.sin(az);
    const base = pos.length / 3;
    let px = tx, py = ty, pz = 0, pitch = pitch0;
    for (let j = 0; j <= seg; j++) {
      const f = j / seg;
      const w = len * 0.3 * Math.pow(Math.sin(Math.PI * Math.min(1, f * 0.95 + 0.05)), 0.75);
      const fold = w * 0.35;                                  // V cross-section
      // side vector (horizontal, perpendicular to frond direction)
      const sx = -sa, sz = ca;
      const dirx = Math.cos(pitch) * ca, diry = Math.sin(pitch), dirz = Math.cos(pitch) * sa;
      // up-ish normal for the leaf surface
      const nx = -Math.sin(pitch) * ca, ny = Math.cos(pitch), nz = -Math.sin(pitch) * sa;
      pos.push(px + sx * w, py + fold * 0.6, pz + sz * w); uv.push(0, f);
      pos.push(px, py - fold * 0.25, pz); uv.push(0.5, f);
      pos.push(px - sx * w, py + fold * 0.6, pz - sz * w); uv.push(1, f);
      for (let q = 0; q < 3; q++) { nrm.push(nx, ny, nz); flex.push(f); }
      const g = 0.85 + 0.15 * f;
      col.push(0.9 * g, 1.0 * g, 0.75 * g, 1 * g, 1 * g, 1 * g, 0.9 * g, 1.0 * g, 0.75 * g);
      const step = len / seg;
      px += dirx * step; py += diry * step; pz += dirz * step;
      pitch -= 0.17 + 0.05 * f;                               // gravity droop
    }
    for (let j = 0; j < seg; j++) {
      const a = base + j * 3;
      idx.push(a, a + 3, a + 1, a + 1, a + 3, a + 4, a + 1, a + 4, a + 2, a + 2, a + 4, a + 5);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aFlex', new THREE.Float32BufferAttribute(flex, 1));
  g.setIndex(idx);
  return g;
}

function buildNuts(v) {
  const [tx, ty] = trunkPoint(v, 1);
  const parts = [];
  for (let i = 0; i < 4; i++) {
    const g = new THREE.IcosahedronGeometry(0.22, 0);
    const a = i * 1.7;
    g.translate(tx + Math.cos(a) * 0.32, ty - 0.35 - (i % 2) * 0.15, Math.sin(a) * 0.32);
    parts.push(g);
  }
  const pos = [], nrm = [];
  for (const p of parts) { const q = p.index ? p.toNonIndexed() : p; pos.push(...q.attributes.position.array); nrm.push(...q.attributes.normal.array); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, i) => [0.42, 0.33, 0.12][i % 3]), 3));
  g.setAttribute('aFlex', new THREE.Float32BufferAttribute(new Array(pos.length / 3).fill(0), 1));
  return g;
}

let frondTex = null;
function frondTexture() {
  if (frondTex) return frondTex;
  const W = 128, H = 512, cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  c.clearRect(0, 0, W, H);
  // leaflets: tapered blades from the rib out to the edge, swept toward the tip (dense so crowns stay full far away)
  const N = 30;
  for (let side = -1; side <= 1; side += 2) {
    for (let i = 0; i < N; i++) {
      const v = (i + 0.5) / N, y = H * (1 - v) + 4;
      const reach = (W / 2 - 2) * Math.pow(Math.sin(Math.PI * Math.min(1, v * 0.95 + 0.05)), 0.5);
      const ex = W / 2 + side * reach, ey = y - 30 - 20 * v;
      const g = c.createLinearGradient(W / 2, y, ex, ey);
      g.addColorStop(0, '#4f8a26'); g.addColorStop(0.6, '#79b23a'); g.addColorStop(1, '#a6cf55');
      c.fillStyle = g;
      const th = (H / N) * 0.62;
      c.beginPath();
      c.moveTo(W / 2, y + th);
      c.quadraticCurveTo(W / 2 + side * reach * 0.5, y - 2 + th * 0.6, ex, ey);
      c.quadraticCurveTo(W / 2 + side * reach * 0.5, y - 10, W / 2, y - th);
      c.closePath(); c.fill();
    }
  }
  c.strokeStyle = '#b9a75c'; c.lineWidth = 5; c.beginPath(); c.moveTo(W / 2, H); c.lineTo(W / 2, 6); c.stroke();
  frondTex = new THREE.CanvasTexture(cv);
  frondTex.colorSpace = THREE.SRGBColorSpace;
  frondTex.anisotropy = 4;
  return frondTex;
}

/** Shared sway: bends the palm along local x/z with height², fronds flutter with aFlex. Pure in uTime. */
function patchSway(sh, swayU, H) {
  Object.assign(sh.uniforms, swayU);
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', `#include <common>
uniform float uTime; attribute float aFlex;`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>
{
  float ph = instanceMatrix[3].x * 0.071 + instanceMatrix[3].z * 0.043;
  float hf = clamp(transformed.y / ${H.toFixed(2)}, 0.0, 1.2);
  float sw = sin(uTime * 0.9 + ph) * 0.6 + sin(uTime * 1.7 + ph * 1.9) * 0.25;
  transformed.x += hf * hf * sw * 0.35;
  transformed.z += hf * hf * sin(uTime * 0.7 + ph * 2.3) * 0.22;
  float fl = aFlex * aFlex;
  transformed.y += fl * (sin(uTime * 2.3 + ph * 3.0 + aFlex * 2.5) * 0.28 + sw * 0.15);
  transformed.x += fl * sin(uTime * 1.9 + ph * 1.3 + transformed.z) * 0.12;
}`);
}

export class Palms {
  constructor(records, rimU) {
    this.group = new THREE.Group();
    this.group.name = 'spot-palms';
    this.swayU = { uTime: { value: 0 } };
    this.tris = 0;
    const trunkMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
    const frondMat = new THREE.MeshStandardMaterial({ vertexColors: true, map: frondTexture(), alphaTest: 0.4, alphaToCoverage: true,
      side: THREE.DoubleSide, roughness: 0.75, color: 0xe8ffd8 });
    const nutMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, flatShading: true });
    for (let vi = 0; vi < VARIANTS.length; vi++) {
      const v = VARIANTS[vi];
      const recs = records.filter((r) => r.variant === vi);
      if (!recs.length) continue;
      const parts = [
        [buildTrunk(v), trunkMat],
        [buildCrown(v, 101 + vi), frondMat],
        [buildNuts(v), nutMat],
      ];
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), p = new THREE.Vector3();
      for (const [geo, baseMat] of parts) {
        const mat = baseMat.clone();
        mat.onBeforeCompile = (sh) => { patchSway(sh, this.swayU, v.H); patchRim(sh, rimU); };
        mat.customProgramCacheKey = () => `palm-${vi}`;
        const im = new THREE.InstancedMesh(geo, mat, recs.length);
        recs.forEach((r, i) => {
          e.set(0, r.yaw, 0); q.setFromEuler(e);
          s.set(r.scale * r.lean, r.scale, r.scale * (0.92 + 0.16 * ((i * 37) % 7) / 7));
          p.set(r.x, r.y, r.z);
          m4.compose(p, q, s);
          im.setMatrixAt(i, m4);
        });
        im.castShadow = true;
        im.receiveShadow = baseMat !== frondMat;
        im.frustumCulled = false;
        this.group.add(im);
        const triPer = geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3;
        this.tris += triPer * recs.length;
      }
    }
  }
  update(t) { this.swayU.uTime.value = t; }
}
