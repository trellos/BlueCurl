// BlueCurl Swell — GPU parity page for the swept-profile wave (WP4a). Loaded by dev/wave-parity.html.
// Evaluates PROFILE_GLSL's bcSampleFront in a VERTEX shader (one GL point per sample, written to a float render
// target) and compares with field.sampleFront. window.__runParity(opts) → stats. Readback only here.
import * as THREE from 'three';
import { AMBIENT_GLSL, DEFAULT_CFG } from '../src/contracts.js';
import { PROFILE_GLSL, packFront, makeKeyTextureSpec } from '../src/wave/profile.glsl.js';
import { sampleFront } from '../src/wave/field.js';
import { NCOLS } from '../src/contracts.js';
import { parityCases } from './wave-fronts.js';

const VERT = /* glsl */ `
precision highp float; precision highp int; precision highp sampler2D;
in vec3 position;     // (u, sigma, local time)
in float aIdx;
uniform vec2 uRes;
uniform int uMode;
${AMBIENT_GLSL}
${PROFILE_GLSL}
flat out vec4 vOut;
void main() {
  BCSample s = bcSampleFront(position.x, position.y, position.z);
  vOut = uMode == 0 ? vec4(s.pos, s.tau) : uMode == 1 ? vec4(s.nrm, s.thick) : vec4(s.xi, s.yl, s.H, s.zi);
  float px = mod(aIdx, uRes.x), py = floor(aIdx / uRes.x);
  gl_Position = vec4((px + 0.5) / uRes.x * 2.0 - 1.0, (py + 0.5) / uRes.y * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}`;
const FRAG = /* glsl */ `
precision highp float;
flat in vec4 vOut;
out vec4 oColor;
void main() { oColor = vOut; }`;

function shifted(front, T0) {
  return { ...front, breaks: front.breaks.map((b) => ({ ...b, tBreak: b.tBreak + T0 })) };
}

export async function runParity({ n = 2400, offsets = [0, 3600] } = {}) {
  const canvas = document.createElement('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  const gl = renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const rendererString = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);

  const ks = makeKeyTextureSpec();
  const keyTex = new THREE.DataTexture(ks.data, ks.width, ks.height, THREE.RGBAFormat, THREE.FloatType);
  keyTex.minFilter = keyTex.magFilter = THREE.NearestFilter; keyTex.generateMipmaps = false; keyTex.needsUpdate = true;
  const a = DEFAULT_CFG.ambient;
  const { fronts, cases } = parityCases(n);
  const W = 64;
  const stats = { renderer: rendererString, samples: 0, maxPos: 0, maxNrm: 0, maxTau: 0, maxThick: 0, worstPos: null, worstNrm: null,
    p99Pos: 0, p99Nrm: 0, over: 0 };
  const errsP = [], errsN = [];

  for (const T0 of offsets) {
    const total = cases.length, Hrt = Math.ceil(total / W);
    const rt = new THREE.WebGLRenderTarget(W, Hrt, { type: THREE.FloatType, format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false });
    const scene = new THREE.Scene(), cam = new THREE.Camera(), mats = [];
    const sf = fronts.map((f) => shifted(f, T0));
    sf.forEach((f, fi) => {
      const idx = cases.map((c, i) => [c, i]).filter(([c]) => c.fi === fi);
      if (!idx.length) return;
      const pos = new Float32Array(idx.length * 3), aIdx = new Float32Array(idx.length);
      idx.forEach(([c, i], j) => { pos[j * 3] = c.u; pos[j * 3 + 1] = c.sigma; pos[j * 3 + 2] = c.t; aIdx[j] = i; });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('aIdx', new THREE.BufferAttribute(aIdx, 1));
      const pk = packFront(f, T0);
      const colsTex = new THREE.DataTexture(new Float32Array(pk.cols), NCOLS, 1, THREE.RGBAFormat, THREE.FloatType);
      colsTex.minFilter = colsTex.magFilter = THREE.NearestFilter; colsTex.generateMipmaps = false; colsTex.needsUpdate = true;
      const m = new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: FRAG,
        uniforms: {
          uKeyTex: { value: keyTex }, uFrontCols: { value: colsTex }, uFrontZB: { value: pk.zb }, uFrontNZB: { value: pk.nzb },
          uFrontX: { value: pk.frontX }, uFrontTRef: { value: pk.tRef }, uAmbient: { value: new THREE.Vector4(a.amp, a.period, a.amp2, a.period2) },
          uRes: { value: new THREE.Vector2(W, Hrt) }, uMode: { value: 0 },
        } });
      mats.push(m);
      const pts = new THREE.Points(g, m); pts.frustumCulled = false; scene.add(pts);
    });
    const read = (mode) => {
      for (const m of mats) m.uniforms.uMode.value = mode;
      renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 0); renderer.clear(); renderer.render(scene, cam);
      const buf = new Float32Array(W * Hrt * 4); renderer.readRenderTargetPixels(rt, 0, 0, W, Hrt, buf);
      renderer.setRenderTarget(null);
      return buf;
    };
    const P = read(0), N = read(1);
    const glErr = gl.getError();
    if (glErr) throw new Error('GL error ' + glErr);
    cases.forEach((c, i) => {
      const js = sampleFront(sf[c.fi], c.u, c.sigma, c.t + T0);
      const o = i * 4;
      const ep = Math.hypot(P[o] - js.x, P[o + 1] - js.y, P[o + 2] - js.z);
      const en = Math.hypot(N[o] - js.nx, N[o + 1] - js.ny, N[o + 2] - js.nz);
      const et = Math.abs(P[o + 3] - js.tau), eth = Math.abs(N[o + 3] - js.thick);
      errsP.push(ep); errsN.push(en);
      if (!(ep <= stats.maxPos)) { stats.maxPos = ep; stats.worstPos = { ...c, T0, gpu: [P[o], P[o + 1], P[o + 2]], js: [js.x, js.y, js.z], tau: js.tau }; }
      if (!(en <= stats.maxNrm)) { stats.maxNrm = en; stats.worstNrm = { ...c, T0, gpu: [N[o], N[o + 1], N[o + 2]], js: [js.nx, js.ny, js.nz], tau: js.tau }; }
      stats.maxTau = Math.max(stats.maxTau, et); stats.maxThick = Math.max(stats.maxThick, eth);
      if (ep >= 1e-3 || en >= 1e-3) stats.over++;
      stats.samples++;
    });
    rt.dispose(); mats.forEach((m) => m.dispose());
  }
  const p99 = (arr) => arr.slice().sort((x, y) => x - y)[Math.floor(arr.length * 0.99)];
  stats.p99Pos = p99(errsP); stats.p99Nrm = p99(errsN);
  renderer.dispose();
  return stats;
}

window.__runParity = runParity;
window.__ready = true;
