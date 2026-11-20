// The open sea: FFT wind chop (256² x 3 cascades) + the contracts' ambient swell on a camera-centred
// polar grid that reaches the horizon (~6 km of geometry, then a far skirt to 19 km), shaded with the
// shared water optics (waterShading.glsl.js) including the shallow tint from the bathymetry (bcDepth).
//
// Wave-renderer coupling (WP4b):
//   ocean.setWaveHook(glslChunk, uniforms)
//     glslChunk defines   float bcWaveHeight(vec2 xz)   extra height (m) on top of ambient + chop
//                         float bcWaveMask(vec2 xz)     0..1; 1 = the sea is pushed down uMaskDepth m
//                                                       (hidden under the wave mesh)
//     It is compiled into the ocean's VERTEX shader only (BC_VERTEX_ONLY is defined); available there:
//     uTime, uAmbient/bcAmbient(), bcDepth(), bcChopDisp(), the shared uniforms. `uniforms` (objects) are
//     merged into the material; pass the same uniform objects you update each frame. Recompiles.
//   ocean.fft = { disp, slope, uniforms: {uOceanD, uOceanS, uOceanL, uOceanAmp}, glsl: CHOP_GLSL, L, rot, N }
//     sample identical chop with bcChopDisp() / bcChopLEAN() after spreading fft.uniforms (or app.waterUniforms).
import * as THREE from 'three';
import { OceanFFT, OCEAN, OCEAN_CHOP } from './OceanFFT.js';
import { waterShadingChunk, CHOP_GLSL, AMBIENT_CHUNK, BATHY_CHUNK, WATER_COMMON_GLSL } from './waterShading.glsl.js';
import { SKY_GLSL } from '../sky/skyModel.js';

export const DEFAULT_WAVE_HOOK = /* glsl */ `
float bcWaveHeight(vec2 xz) { return 0.0; }
float bcWaveMask(vec2 xz) { return 0.0; }
`;

// Polar grid: dense uniform core, then geometric rings (square cells), then a far skirt.
function buildGeometry({ segs = 448, core = 20, dr0 = 0.35, grow = 0.014, rMax = 6000, skirt = [9000, 13500, 19000] } = {}) {
  const radii = [0];
  let r = 0;
  while (r < core) { r += dr0; radii.push(r); }
  while (r < rMax) { r += Math.max(dr0, r * grow); radii.push(r); }
  for (const s of skirt) radii.push(s);
  const nr = radii.length, nc = segs;
  const pos = new Float32Array(nr * nc * 3);
  const lod = new Float32Array(nr * nc);
  for (let j = 0; j < nr; j++) {
    const rr = radii[j];
    const dr = j + 1 < nr ? radii[j + 1] - rr : rr - radii[j - 1];
    const arc = (2 * Math.PI * rr) / nc;
    for (let i = 0; i < nc; i++) {
      const a = (i / nc) * 2 * Math.PI, k = j * nc + i;
      pos[k * 3] = rr * Math.cos(a);
      pos[k * 3 + 1] = 0;
      pos[k * 3 + 2] = rr * Math.sin(a);
      lod[k] = Math.max(dr, arc, 0.05);
    }
  }
  const idx = new Uint32Array((nr - 1) * nc * 6);
  let t = 0;
  for (let j = 0; j < nr - 1; j++) {
    for (let i = 0; i < nc; i++) {
      const i1 = (i + 1) % nc;
      const a = j * nc + i, b = j * nc + i1, c = (j + 1) * nc + i, d = (j + 1) * nc + i1;
      // counter-clockwise seen from above (+y)
      idx[t++] = a; idx[t++] = b; idx[t++] = c;
      idx[t++] = b; idx[t++] = d; idx[t++] = c;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aLod', new THREE.BufferAttribute(lod, 1));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return { geometry: g, rings: nr, segs: nc };
}

const VERT_HEAD = /* glsl */ `
#define BC_VERTEX_ONLY
uniform float uSnap;          // grid centre snap (m)
uniform vec2 uChopFade;       // distance range (m) over which the chop displacement fades out
uniform float uMaskDepth;     // m the sea is pushed down where bcWaveMask = 1
in float aLod;                // local vertex spacing (m)
out vec3 vP;
out vec2 vXZ;
out vec2 vGrad;
out float vMask;
`;
const VERT_MAIN = /* glsl */ `
void main() {
  vec2 c = floor(cameraPosition.xz / uSnap + 0.5) * uSnap;
  vec2 xz = position.xz + c;
  float dist = length(xz - cameraPosition.xz);
  vec2 sl;
  vec3 d = bcChopDisp(xz, aLod, sl);
  float cw = smoothstep(0.05, 1.2, bcDepth(xz));                 // chop calms in very shallow water
  d *= (1.0 - smoothstep(uChopFade.x, uChopFade.y, dist)) * cw;
  // horizontal (choppy) displacement shears the per-triangle xz mapping, which shows up as LOD steps
  // along triangle edges in the per-pixel slope lookups far out: keep it to the near field
  d.xz *= 1.0 - smoothstep(uChopFade.x * 0.25, uChopFade.x, dist);
  float e = max(aLod, 0.5);
  float a0 = bcAmbient(xz, uTime);
  float w0 = bcWaveHeight(xz);
  float gx = bcAmbient(xz + vec2(e, 0.0), uTime) + bcWaveHeight(xz + vec2(e, 0.0)) - a0 - w0;
  float gz = bcAmbient(xz + vec2(0.0, e), uTime) + bcWaveHeight(xz + vec2(0.0, e)) - a0 - w0;
  vGrad = vec2(gx, gz) / e;
  vMask = clamp(bcWaveMask(xz), 0.0, 1.0);
  vec3 P = vec3(xz.x + d.x, a0 + w0 + d.y - vMask * uMaskDepth, xz.y + d.z);
  vP = P;
  vXZ = xz;
  gl_Position = projectionMatrix * viewMatrix * vec4(P, 1.0);
}`;

const FRAG_MAIN = /* glsl */ `
uniform float uLeanBias;
in vec3 vP;
in vec2 vXZ;
in vec2 vGrad;
in float vMask;
void main() {
  vec3 V = normalize(cameraPosition - vP);
  // pixel footprint from the view ray hitting the mean sea plane: depends on the screen position only, so
  // it is smooth across triangle edges (dFdx of the displaced mesh's xz jumps per triangle)
  vec3 rd = -V;
  float tPl = (cameraPosition.y - 0.0) / max(-rd.y, 0.004);
  vec2 xzFlat = cameraPosition.xz + rd.xz * tPl;
  vec4 lean = bcChopLEANGrad(vXZ, dFdx(xzFlat), dFdy(xzFlat), uLeanBias);
  float cw = smoothstep(0.05, 1.2, bcDepth(vXZ) + vP.y);
  vec2 g = vGrad + lean.xy * cw;
  vec3 N = normalize(vec3(-g.x, 1.0, -g.y));
  BcWater w = bcWater(vP, N, V);
  w.sig2 = lean.zw * cw * cw;
  gl_FragColor = vec4(bcShadeWater(w), 1.0);
}`;

export class Ocean {
  /**
   * shared: app.waterUniforms (createWaterUniforms()); the FFT textures are written into it.
   * opts: { U10, fetch, windDeg, seed, segs, rMax }
   */
  constructor(shared, opts = {}) {
    this.shared = shared;
    this.fftSim = new OceanFFT({ seed: opts.seed ?? 1234, U10: opts.U10 ?? 4.0, fetch: opts.fetch ?? 10000, windDeg: opts.windDeg ?? 80 });
    shared.uOceanD.value = this.fftSim.cascades.textures[0];
    shared.uOceanS.value = this.fftSim.cascades.textures[1];
    shared.uOceanL.value.set(...OCEAN.L);
    const { geometry, rings, segs } = buildGeometry({ segs: opts.segs ?? 448, rMax: opts.rMax ?? 6000 });
    this.rings = rings; this.segs = segs;
    this.own = {
      uSnap: { value: 1.0 },
      uChopFade: { value: new THREE.Vector2(350, 1600) },
      uMaskDepth: { value: 2.5 },
      uLeanBias: { value: 0.0 },
    };
    this.hook = { glsl: DEFAULT_WAVE_HOOK, uniforms: {} };
    this.material = new THREE.ShaderMaterial({ uniforms: {}, vertexShader: '', fragmentShader: '' });
    this._compose();
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'ocean';
    this.fft = {
      sim: this.fftSim,
      disp: this.fftSim.cascades.textures[0],
      slope: this.fftSim.cascades.textures[1],
      uniforms: { uOceanD: shared.uOceanD, uOceanS: shared.uOceanS, uOceanL: shared.uOceanL, uOceanAmp: shared.uOceanAmp },
      glsl: CHOP_GLSL,
      L: OCEAN.L.slice(), rot: OCEAN.ROT.slice(), N: OCEAN.N, chop: OCEAN_CHOP.slice(),
    };
  }

  _compose() {
    const m = this.material;
    m.uniforms = { ...this.shared, ...this.own, ...this.hook.uniforms };
    m.vertexShader = VERT_HEAD + SKY_GLSL + WATER_COMMON_GLSL + BATHY_CHUNK + AMBIENT_CHUNK + CHOP_GLSL
      + '\n// ---- wave hook\n' + this.hook.glsl + '\n' + VERT_MAIN;
    m.fragmentShader = waterShadingChunk() + FRAG_MAIN;
    m.needsUpdate = true;
  }

  /** Replace bcWaveHeight / bcWaveMask (see header) and recompile. Pass null to restore the defaults. */
  setWaveHook(glslChunk, uniforms = {}) {
    this.hook = { glsl: glslChunk || DEFAULT_WAVE_HOOK, uniforms: uniforms || {} };
    this._compose();
  }

  /** Advance the FFT to sim time t (pure function of t). */
  update(renderer, t) {
    this.fftSim.update(renderer, t);
  }

  dispose() { this.mesh.geometry.dispose(); this.material.dispose(); }
}
