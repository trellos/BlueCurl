// Spot terrain: one heightfield mesh (land + sea floor) sampled from depthAt() on a warped grid that is
// dense around the headland, the bay and the lineup and coarse toward the far edges (±4 km).
// Colours are computed per fragment from world position, slope and per-vertex zone weights.
import * as THREE from 'three';
import { depthAt, bathyParts, headlandS } from './bathymetry.js';
import { patchRim } from './look.js';

/** Axis coordinates: fine core spans [a, b] at spacing h (list of [a, b, h]), geometric growth outside to ±lim. */
function warpedAxis(core, growLo, growHi, lim) {
  const out = [];
  for (const [a, b, h] of core) {
    const n = Math.max(1, Math.round((b - a) / h));
    for (let i = 0; i < n; i++) out.push(a + (b - a) * i / n);
  }
  const last = core[core.length - 1];
  out.push(last[1]);
  // grow high side
  let h = last[2], x = last[1];
  while (x < lim) { h *= growHi; x += h; out.push(Math.min(x, lim)); }
  // grow low side
  h = core[0][2]; x = core[0][0];
  const lo = [];
  while (x > -lim) { h *= growLo; x -= h; lo.push(Math.max(x, -lim)); }
  return lo.reverse().concat(out);
}

export function buildTerrainGeometry() {
  const xs = warpedAxis([[-110, -20, 4], [-20, 110, 2], [110, 260, 4], [260, 560, 10]], 1.14, 1.22, 4000);
  const zs = warpedAxis([[-200, 15, 3.5], [15, 85, 1.8], [85, 210, 2.6]], 1.18, 1.18, 4000);
  const nx = xs.length, nz = zs.length;
  const pos = new Float32Array(nx * nz * 3);
  const mat = new Float32Array(nx * nz * 4);
  const edge = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = xs[i], z = zs[j], k = j * nx + i;
      const p = bathyParts(x, z);
      pos[k * 3] = x; pos[k * 3 + 1] = p.y; pos[k * 3 + 2] = z;
      const others = Math.min(p.bay, p.bar);
      const reef = smooth(-0.3, 1.2, others - p.reef);
      const shelf = Math.max(smooth(-0.3, 1.2, Math.min(others, p.reef) - p.shelf), smooth(-0.3, 1.0, Math.min(others, p.shelf) - p.plat));
      const head = smooth(-2, 6, p.s);                       // 1 on the headland
      const jungle = smooth(-25, -75, p.xs) * (1 - head);   // hills behind the beach
      mat[k * 4] = reef; mat[k * 4 + 1] = shelf; mat[k * 4 + 2] = head; mat[k * 4 + 3] = jungle;
      edge[k] = smooth(-6, 0, p.s) * (1 - smooth(7, 10.5, p.s));   // rock band: cliff toe → lip
    }
  }
  const idx = [];
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      // skip cells that are deep and far out of view (keeps the budget for the near field)
      const deep = -pos[a * 3 + 1] > 26 && -pos[d * 3 + 1] > 26 && -pos[b * 3 + 1] > 26 && -pos[c * 3 + 1] > 26;
      if (deep) continue;
      // split along the diagonal that follows the surface better
      const ya = pos[a * 3 + 1], yb = pos[b * 3 + 1], yc = pos[c * 3 + 1], yd = pos[d * 3 + 1];
      if (Math.abs(ya - yd) < Math.abs(yb - yc)) idx.push(a, c, d, a, d, b);
      else idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aMat', new THREE.BufferAttribute(mat, 4));
  g.setAttribute('aEdge', new THREE.BufferAttribute(edge, 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}
function smooth(e0, e1, x) { const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1); return t * t * (3 - 2 * t); }

const C = (hex) => new THREE.Color(hex);
export function createTerrainMaterial(rimU) {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.93, metalness: 0 });
  const u = {
    cSandDry: { value: C(0xf0d6a2) }, cSandWet: { value: C(0xa88a5e) }, cSandSea: { value: C(0xe3cc95) },
    cReef: { value: C(0x6d6a45) }, cReef2: { value: C(0x9a7d55) }, cReefDark: { value: C(0x3d4a38) },
    cRock: { value: C(0x9a8470) }, cRock2: { value: C(0xc0a586) }, cRockDark: { value: C(0x5e5048) },
    cGrass: { value: C(0x7fa646) }, cGrass2: { value: C(0xb3ad5e) }, cScrub: { value: C(0x4d7a33) },
    cJungle: { value: C(0x2f6a2c) }, cJungle2: { value: C(0x4e8a34) },
  };
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 aMat; attribute float aEdge; varying vec4 vMat; varying float vEdge; varying vec3 vWPos; varying vec3 vWNrm;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vMat = aMat; vEdge = aEdge; vWPos = (modelMatrix * vec4(position, 1.0)).xyz; vWNrm = normalize(mat3(modelMatrix) * normal);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec4 vMat; varying float vEdge; varying vec3 vWPos; varying vec3 vWNrm;
uniform vec3 cSandDry, cSandWet, cSandSea, cReef, cReef2, cReefDark, cRock, cRock2, cRockDark, cGrass, cGrass2, cScrub, cJungle, cJungle2;
float tHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float tNoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(tHash(i), tHash(i + vec2(1, 0)), f.x), mix(tHash(i + vec2(0, 1)), tHash(i + vec2(1, 1)), f.x), f.y); }
float tFbm(vec2 p) { return 0.55 * tNoise(p) + 0.3 * tNoise(p * 2.13 + 7.1) + 0.15 * tNoise(p * 4.7 + 3.3); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  vec3 P = vWPos; vec3 N = normalize(vWNrm); float y = P.y;
  float steep = 1.0 - smoothstep(0.45, 0.75, N.y);            // 1 on cliff faces
  vec2 nP = mix(P.xz, vec2(P.x + P.z, P.y * 1.3), steep);     // vertical faces: noise in (horizontal, y)
  float n1 = tFbm(nP * 0.05), n2 = tFbm(nP * 0.21 + 3.0), n3 = tNoise(nP * 0.9);
  // --- sand: dry above the berm, wet band at the water line, pale under water
  vec3 sand = mix(cSandDry, cSandDry * (0.92 + 0.12 * n3), 0.6);
  sand = mix(cSandWet, sand, smoothstep(0.25, 1.1, y + 0.25 * n2));
  sand = mix(cSandSea * (0.9 + 0.15 * n2), sand, smoothstep(-0.45, -0.05, y));
  // ripples on the sea floor sand
  sand *= 1.0 - 0.06 * step(y, -0.3) * smoothstep(0.3, 0.9, sin(P.x * 0.9 + n2 * 6.0));
  vec3 col = sand;
  // --- reef: olive / ochre patches with dark holes
  vec3 reef = mix(cReef, cReef2, smoothstep(0.35, 0.7, n2));
  reef = mix(reef, cReefDark, smoothstep(0.62, 0.8, n1 + 0.25 * n3));
  col = mix(col, reef, clamp(vMat.x * smoothstep(0.25, 0.5, n1 + 0.35), 0.0, 1.0));
  // --- rock shelf / platform
  vec3 shelf = mix(cRockDark, cReef, smoothstep(0.3, 0.7, n2)) * (0.85 + 0.3 * n3);
  col = mix(col, shelf, clamp(vMat.y * smoothstep(0.2, 0.45, n1 + 0.3 * n3), 0.0, 1.0));
  // --- headland top: grass / dry grass / scrub
  vec3 grass = mix(cGrass, cGrass2, smoothstep(0.45, 0.75, n1));
  grass = mix(grass, cScrub, smoothstep(0.55, 0.8, n2));
  float land = smoothstep(1.2, 3.5, y);
  col = mix(col, grass, vMat.z * land);
  // --- jungle hills behind the bay
  vec3 jung = mix(cJungle, cJungle2, smoothstep(0.35, 0.7, n2)) * (0.8 + 0.35 * n3);
  col = mix(col, jung, vMat.w * smoothstep(2.6, 5.0, y + 2.0 * n1));
  // --- rock faces: horizontal strata, warm ochre bands
  float band = sin(y * 0.9 + n1 * 7.0 + 1.6 * sin(P.x * 0.05 + P.z * 0.04)) + 0.5 * sin(y * 2.7 + n2 * 4.0);
  vec3 rock = mix(cRock, cRock2, smoothstep(-0.4, 0.9, band));
  rock = mix(rock, cRockDark, smoothstep(0.8, 1.3, -band) * 0.45);
  rock *= 0.86 + 0.28 * n3;
  rock = mix(rock * vec3(0.55, 0.6, 0.5), rock, smoothstep(-0.3, 1.2, y));   // dark wet toe
  float rockW = max(steep * (0.55 + 0.45 * max(vMat.z, vMat.y)), vEdge * smoothstep(0.25, 0.55, n1 + 0.5 * vEdge));
  rockW = max(rockW, vMat.z * (1.0 - land) * step(-0.6, y) * 0.9);
  col = mix(col, rock, clamp(rockW, 0.0, 1.0));
  diffuseColor.rgb = col;
}`);
    patchRim(sh, rimU);
  };
  return m;
}

export function createTerrain(rimU) {
  const mesh = new THREE.Mesh(buildTerrainGeometry(), createTerrainMaterial(rimU));
  mesh.name = 'spot-terrain';
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  mesh.frustumCulled = false;
  return mesh;
}
export { depthAt, headlandS };
