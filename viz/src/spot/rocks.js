// Boulders (instanced, faceted) and sea stacks (strata-banded rock pillars) for the headland.
import * as THREE from 'three';
import { hash01, mulberry32 } from '../contracts.js';
import { patchRim } from './look.js';

function lumpy(geo, seed, amp) {
  const p = geo.attributes.position, v = new THREE.Vector3();
  // displace shared positions consistently (hash by quantised position so seams stay closed)
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const qx = Math.round(v.x * 1000), qy = Math.round(v.y * 1000), qz = Math.round(v.z * 1000);
    const k = 1 + amp * (hash01(qx + seed, qy, qz) - 0.5) * 2;
    p.setXYZ(i, v.x * k, v.y * k, v.z * k);
  }
  return geo;
}

function rockMaterial(rimU, strata) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: false, color: 0xffffff, roughness: 0.92, flatShading: true });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRW;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vec4 rw = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
rw = instanceMatrix * rw;
#endif
vRW = (modelMatrix * rw).xyz;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRW;')
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  float y = vRW.y;
  float band = sin(y * ${strata ? '1.6' : '0.7'} + sin(vRW.x * 0.3 + vRW.z * 0.21) * 1.2);
  vec3 a = vec3(0.46, 0.38, 0.30), b = vec3(0.66, 0.54, 0.41), dark = vec3(0.2, 0.18, 0.16);
  vec3 c = mix(a, b, smoothstep(-0.3, 0.7, band));
  c = mix(dark, c, smoothstep(-1.2, 0.4, y));                    // wet / weed-dark near the water line
  c = mix(c, vec3(0.20, 0.26, 0.16), smoothstep(0.2, -0.8, y) * 0.6);
  diffuseColor.rgb *= c;
}`);
    patchRim(sh, rimU);
  };
  return m;
}

export function createBoulders(records, rimU) {
  const base = lumpy(new THREE.IcosahedronGeometry(1, 1), 11, 0.22);
  const geo = base.index ? base.toNonIndexed() : base;
  geo.computeVertexNormals();
  const mat = rockMaterial(rimU, false);
  const im = new THREE.InstancedMesh(geo, mat, Math.max(1, records.length));
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const c = new THREE.Color();
  records.forEach((r, i) => {
    e.set(r.rx, r.ry, r.rz); q.setFromEuler(e); s.set(r.sx, r.sy, r.sz); p.set(r.x, r.y, r.z);
    m4.compose(p, q, s); im.setMatrixAt(i, m4);
    c.setRGB(r.shade, r.shade * 0.97, r.shade * 0.94); im.setColorAt(i, c);
  });
  im.count = records.length;
  im.castShadow = true; im.receiveShadow = true; im.frustumCulled = false;
  im.name = 'spot-boulders';
  return { mesh: im, tris: (geo.attributes.position.count / 3) * records.length };
}

/** A sea stack: tapered, faceted pillar with a ledge, lumpy, top tufted with green. */
function stackGeometry(seed) {
  const rnd = mulberry32(seed * 977);
  const rad = 9, seg = 7, pos = [];
  const rings = [];
  for (let j = 0; j <= seg; j++) {
    const f = j / seg;
    const r = (1.0 - 0.38 * f) * (j === seg ? 0.75 : 1) * (j === 3 ? 0.88 : 1);
    const ring = [];
    for (let i = 0; i < rad; i++) {
      const a = (i + rnd() * 0.4) / rad * Math.PI * 2;
      const rr = r * (0.82 + rnd() * 0.3);
      ring.push([Math.cos(a) * rr, f + (rnd() - 0.5) * 0.04 * (j > 0 && j < seg), Math.sin(a) * rr]);
    }
    rings.push(ring);
  }
  const tri = (a, b, c) => pos.push(...a, ...b, ...c);
  for (let j = 0; j < seg; j++) for (let i = 0; i < rad; i++) {
    const a = rings[j][i], b = rings[j][(i + 1) % rad], c = rings[j + 1][i], d = rings[j + 1][(i + 1) % rad];
    tri(a, c, b); tri(b, c, d);
  }
  const top = rings[seg], cy = 1.04;
  for (let i = 0; i < rad; i++) tri(top[i], [0, cy, 0], top[(i + 1) % rad]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

export function createStacks(records, rimU) {
  const group = new THREE.Group();
  group.name = 'spot-stacks';
  const mat = rockMaterial(rimU, true);
  let tris = 0;
  for (const r of records) {
    const g = stackGeometry(r.seed);
    g.scale(r.r, r.h, r.r);
    g.rotateY(r.yaw);
    g.translate(r.x, r.y, r.z);
    const m = new THREE.Mesh(g, mat);
    m.castShadow = true; m.receiveShadow = true;
    group.add(m);
    tris += g.attributes.position.count / 3;
  }
  return { group, tris };
}
