// Standalone close-up viewer for the wave renderer (WP4b): real sky, FFT ocean, spot, post + WaveMesh on
// synthetic fronts with chosen ZoneBreaks. URL params:
//   case=barrel|wall|mush|closeout     tau=<peak column break phase> (t = tau·Tb; negative = approaching)
//   n=<fronts in the set, 1..4> gap=<m between fronts>   H=<peak height m>
//   view=wide|channel|behind|back|top|orbit   cam=x,y,z,tx,ty,tz[,fov]   spot=0 (hide terrain)
//   w=,h= (fixed canvas)  nofoam=1 nospray=1 info=0  play=1 (animate in real time)
// Hooks: __ready, __info, __setTau(tau), __bench(n) → {all, nowave, waves} GPU ms, __grab()
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ZONES, zToU, uToZ, FRONT_W } from '../src/contracts.js';
import { createWaterUniforms } from '../src/water/waterShading.glsl.js';
import { Sky } from '../src/sky/Sky.js';
import { SUN_COLOR } from '../src/sky/skyModel.js';
import { Ocean } from '../src/water/Ocean.js';
import { Post } from '../src/post/Post.js';
import { Spot } from '../src/spot/Spot.js';
import { GpuTimer } from '../src/core/gpuTimer.js';
import { WaveMesh } from '../src/wave/WaveMesh.js';
import { lip, barrel, sampleFront } from '../src/wave/field.js';
import { makeFront, zoneBreak } from './wave-fronts.js';

const q = new URLSearchParams(location.search);
const num = (k, d) => (q.has(k) && q.get(k) !== '' && Number.isFinite(+q.get(k)) ? +q.get(k) : d);
const CASE = q.get('case') || 'barrel';
const W = num('w', innerWidth), Hh = num('h', innerHeight);

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance', stencil: false });
renderer.setPixelRatio(1);
renderer.setSize(W, Hh, true);
renderer.toneMapping = THREE.NoToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
const gl = renderer.getContext();
const gpuTimer = new GpuTimer(gl);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, W / Hh, 0.3, 20000);
const waterUniforms = createWaterUniforms();
const sunDir = waterUniforms.uSunDir.value;
const sky = new Sky(waterUniforms);
scene.add(sky.mesh);
scene.environment = sky.buildEnvMap(renderer);
const sunLight = new THREE.DirectionalLight(new THREE.Color().setRGB(...SUN_COLOR, THREE.LinearSRGBColorSpace), 1.0);
sunLight.position.copy(sunDir).multiplyScalar(1000);
scene.add(sunLight, sunLight.target);
const ocean = new Ocean(waterUniforms);
scene.add(ocean.mesh);
const post = new Post(renderer, W, Hh);

// ------------------------------------------------------------------ synthetic fronts
const bump = (u, c, w) => Math.exp(-(((u - c) / w) ** 2));
const PRESETS = {
  barrel:   { zi: 1, H: 3.4, steep: 0.85, curl: 0.95, mush: 0.04, zPeak: 30, dir: -1, closeout: false },
  wall:     { zi: 1, H: 3.0, steep: 0.95, curl: 0.15, mush: 0.05, zPeak: 30, dir: -1, closeout: false },
  mush:     { zi: 1, H: 2.0, steep: 0.3, curl: 0.1, mush: 0.85, zPeak: 10, dir: 0, closeout: false },
  closeout: { zi: 1, H: 3.0, steep: 0.8, curl: 0.75, mush: 0.1, zPeak: -10, dir: 0, closeout: true },
  outer:    { zi: 0, H: 4.2, steep: 0.85, curl: 0.9, mush: 0.05, zPeak: 80, dir: -1, closeout: false },
};
const P = { ...(PRESETS[CASE] || PRESETS.barrel) };
P.H = num('H', P.H);
const Z = ZONES[P.zi];
const Tb = Z.Tb;
const VX = -9;
const NF = Math.max(1, Math.min(12, num('n', 1)));
const GAP = num('gap', 22);

function buildFront(k) {
  const tB = k * GAP / -VX;               // later fronts reach the line later
  const uPeak = zToU(P.zPeak);
  const zb = zoneBreak(P.zi, {
    tBreak: tB, uPeak, dir: P.dir, vPeel: Z.vPeel, Tb, peelLen: P.closeout ? 400 : 110, backLen: P.dir === 0 ? 0 : 15,
    closeout: P.closeout, sections: 1, H: P.H, steep: P.steep, curl: P.curl, mush: P.mush,
  });
  const width = P.closeout ? 0.5 : 0.3;
  const Hk = P.H * (1 - 0.12 * k);
  const f = makeFront({
    id: k + 1, x: Z.lineX, vx: VX, breaks: [zb], tPoint: tB,
    cols: (u) => {
      const inZone = u >= Z.u0 && u <= Z.u1 ? 1 : 0.35;
      const b = bump(u, uPeak, width);
      return [0.5 + (Hk - 0.5) * b * inZone, 0.15 + (P.steep - 0.15) * b, P.curl * b * inZone, P.mush * (0.4 + 0.6 * b)];
    },
  });
  f.lineX = Z.lineX; f.tB = tB;
  f.xAt = (tt) => Z.lineX + VX * (tt - tB);
  return f;
}
const fronts = Array.from({ length: NF }, (_, k) => buildFront(k));
const swell = { fronts };

const app = { renderer, scene, camera, sunDir, sunLight, waterUniforms, ocean, swell, cfg: {} };
let spot = null;
if (q.get('spot') !== '0') { spot = new Spot(app); app.spot = spot; }
const waves = new WaveMesh(app);
if (q.has('nofoam')) waves.look.uFoamTune.value.z = 0;
if (q.has('nospray')) for (const s of waves.slots) s.smat.visible = false;
if (q.has('dbg')) waves.look.uWvDebug.value = num('dbg', 0);
if (q.has('cheapfrag')) for (const s of waves.slots) { s.mat.fragmentShader = 'in vec4 vA; void main(){ gl_FragColor = vec4(0.0, 0.3 + 0.0 * vA.x, 0.25, 1.0); }'; s.mat.needsUpdate = true; }
if (q.has('nowave')) waves.group.visible = false;                         // debug: ocean (masked) only
if (q.has('nohook')) { waves.hook.uninstall(); waves.hook.set = () => {}; } // debug: mesh over the unmasked sea

let t = num('tau', 0.5) * Tb;
function setTime(tt) {
  t = tt;
  for (const f of fronts) { f.x = f.xAt(t); f.alpha = 1; }
  waterUniforms.uTime.value = t;
}
setTime(t);

// ------------------------------------------------------------------ cameras
function peelU(tt, tau) {          // column at break phase tau at time tt (front 0)
  const zb = fronts[0].breaks[0];
  const s = Math.max(0, zb.vPeel * (tt - tau * Tb - zb.tBreak));
  const sg = zb.dir === 0 ? 1 : zb.dir;
  return zb.uPeak + (sg * s) / FRONT_W;
}
function focus() {
  const f = fronts[0];
  const u = P.closeout ? zToU(P.zPeak) : peelU(t, Math.min(Math.max(t / Tb, 0.3), 0.55));
  const L = lip(f, u, t);
  const B = barrel(f, u, t);
  return { u, z: uToZ(u), lip: L, barrel: B, x: f.x };
}
let controls = null;
function placeCamera() {
  const view = q.get('view') || 'channel';
  const F = focus();
  const dir = P.dir === 0 ? -1 : P.dir;          // the tube opens toward the peel direction (−z for dir −1)
  const cy = F.barrel ? F.barrel.y : F.lip.y * 0.6;
  let pos, tgt, fov = 50;
  if (q.get('cam')) {
    const c = q.get('cam').split(',').map(Number);
    pos = c.slice(0, 3); tgt = c.slice(3, 6); fov = c[6] || 50;
  } else if (view === 'wide') {
    pos = [-30, 70, 105]; tgt = [160, 0, -25]; fov = 56;
  } else if (view === 'channel') {           // down the line, in the channel, looking back into the tube
    pos = [F.lip.x - 5, Math.max(1.4, cy * 0.9), F.z + dir * 13]; tgt = [F.lip.x + 0.5, cy, F.z - dir * 2]; fov = 60;
  } else if (view === 'behind') {            // shoreward of the face looking at the backlit lip (toward the sun)
    pos = [F.lip.x - 24, 2.2, F.z + dir * 10]; tgt = [F.lip.x, cy + 0.5, F.z - dir * 4]; fov = 50;
  } else if (view === 'back') {              // seaward, behind the wave (lip from the back)
    pos = [F.x + 30, 6, F.z + dir * 12]; tgt = [F.x, 2, F.z]; fov = 50;
  } else if (view === 'top') {
    pos = [F.x + 10, 120, F.z + 1]; tgt = [F.x, 0, F.z]; fov = 55;
  } else if (view === 'mid') {              // ~35 m off the shoulder, slightly raised
    pos = [F.lip.x - 22, 6.5, F.z + dir * 28]; tgt = [F.lip.x + 3, 1.2, F.z - dir * 6]; fov = 50;
  } else {
    pos = [F.lip.x - 30, 12, F.z + dir * 40]; tgt = [F.lip.x, 2, F.z]; fov = 50;
  }
  camera.position.set(...pos); camera.fov = fov; camera.aspect = W / Hh; camera.near = 0.3;
  camera.updateProjectionMatrix();
  camera.lookAt(...tgt);
  camera.updateMatrixWorld();
  if (view === 'orbit' && !controls) {
    controls = new OrbitControls(camera, canvas);
    controls.target.set(...tgt);
    controls.update();
  }
  return F;
}

function render() {
  ocean.update(renderer, t);
  spot?.update(t);
  waves.update(t);
  post.render(scene, camera);
}

let F = placeCamera();
function info() {
  const f = fronts[0];
  const i = {
    case: CASE, t: +t.toFixed(3), tauPeak: +(t / Tb).toFixed(3), fronts: NF, frontX: +f.x.toFixed(2),
    focusU: +F.u.toFixed(4), lip: F.lip && [F.lip.x, F.lip.y, F.lip.z].map((v) => +v.toFixed(2)),
    barrel: F.barrel && { y: +F.barrel.y.toFixed(2), r: +F.barrel.r.toFixed(2) }, stats: { ...waves.stats },
    clip: waves.slots.filter((s) => s.mesh.visible).map((s) => s.fu.uClip.value.toArray().map((v) => +v.toFixed(2))),
  };
  window.__info = i;
  if (q.get('info') !== '0') document.getElementById('info').textContent = JSON.stringify(i, null, 1);
  return i;
}

async function boot() {
  try { await renderer.compileAsync(scene, camera); } catch (e) { console.warn(e); }
  render(); info();
  if (q.has('play') || controls) {
    let last = performance.now();
    const loop = (now) => {
      requestAnimationFrame(loop);
      if (q.has('play')) { setTime(t + Math.min(0.1, (now - last) / 1000)); }
      last = now;
      controls?.update();
      render();
      if ((now | 0) % 10 === 0) info();
    };
    requestAnimationFrame(loop);
  }
  return true;
}

window.__setTau = (tau) => { setTime(tau * Tb); F = placeCamera(); render(); return info(); };
window.__grab = () => canvas.toDataURL('image/png');
window.__bench = async (n = 60) => {
  const m = async () => { const r = await gpuTimer.measure(() => render(), n); return r && +r.mean.toFixed(3); };
  await m();
  const all = await m();
  waves.group.visible = false;
  const nowave = await m();
  waves.group.visible = true;
  return { all, nowave, waves: all != null && nowave != null ? +(all - nowave).toFixed(3) : null, stats: { ...waves.stats }, w: W, h: Hh };
};
window.__app = app;
window.__ready = boot().catch((e) => { console.error(e); document.getElementById('info').textContent = String(e.stack || e); throw e; });
