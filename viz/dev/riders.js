// Standalone rider viewer (WP6b). Boots the real App (sky, FFT ocean, spot, post) but swaps app.riders for a fake
// RiderState driver and renders with its own cameras (the CameraRig is bypassed).
//
// URL:  scene=single|grid|lineup|far|wave|cycle   (default cycle)
//   kind=surfer|dolphin|seal|all  action=<cue>  at=<actionT 0..1>  t=<s>  speed=<m/s>  state=<RiderStateName>
//   actions=a,b,c (grid: one rider per action)  az=<deg> dist=<m> ch=<camera height m> fov=<deg> (single/grid camera)
//   cam=x,y,z,tx,ty,tz,fov (override)  inset=1 (close 3/4 inset view)  scale=<riderScale>  labels=0  w=&h=
//   wave: demo=<path> (default /demo/demo-basic.json), t = sim time to advance to, u=<offset m from the peak>
// Hooks: __ready, __render(t), __info, __bench(n) → {all, noRiders, riders} GPU ms, __riders (fake list)
import * as THREE from 'three';
import { DEFAULT_CFG, RIDERS, uToZ, FRONT_W } from '../src/contracts.js';
import { App, CAMERA_DEFAULT, mergeDeep } from '../src/core/App.js';
import * as field from '../src/wave/field.js';
import * as KF from '../src/wave/keyframes.js';
import { SPOT_CAMERAS } from '../src/spot/layout.js';

const q = new URLSearchParams(location.search);
const num = (k, d) => (q.has(k) && q.get(k) !== '' && Number.isFinite(+q.get(k)) ? +q.get(k) : d);
const W = num('w', innerWidth), H = num('h', innerHeight);
const SCENE = q.get('scene') || 'cycle';
const cfg = structuredClone(DEFAULT_CFG);
cfg.hud = false;
cfg.pip.enabled = false;
if (q.has('scale')) cfg.riderScale = num('scale', 1.4);

const canvas = document.getElementById('c');
const app = new App({ canvas, cfg, capture: true, width: W, height: H, hud: false });
window.__app = app;
const fake = { riders: [], events: [], step() {}, reset() {} };
const realRiders = app.riders;
app.riders = fake;
window.__riders = fake.riders;

const cam = app.camera;
const inset = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 20000);
const SURF_ACTIONS = ['idle', 'paddle', 'pop', 'trim', 'bottomTurn', 'lipHit', 'cutback', 'crouch', 'kickout', 'wipe'];
const DOLPHIN_ACTIONS = ['idle', 'swim', 'jump', 'trim', 'bottomTurn', 'crouch', 'dive', 'wipe'];
const SEAL_ACTIONS = ['idle', 'swim', 'trim', 'cutback', 'jump', 'dive', 'wipe'];
const ACTIONS = { surfer: SURF_ACTIONS, dolphin: DOLPHIN_ACTIONS, seal: SEAL_ACTIONS };
const RIDE = new Set(['pop', 'trim', 'bottomTurn', 'lipHit', 'cutback', 'crouch']);
const defOf = (kind, i = 0) => RIDERS.filter((r) => r.kind === kind)[i % 2];

function waterY(x, z, t) { return field.surfaceHeight(app.swell.fronts || [], x, z, t); }

/** A RiderState-like record (contracts.js RiderState). */
function rider(def, id, x, z, { action = 'idle', at = 0.5, t = 0, heading = 0, speed = null, state = null, up = null, y = null } = {}) {
  const ride = RIDE.has(action) || action === 'kickout' || action === 'wipe';
  const sp = speed ?? (ride ? 7 : (action === 'paddle' || action === 'swim') ? 1.2 : action === 'jump' ? 6 : 0);
  let py = y ?? waterY(x, z, t);
  if (action === 'jump' && y == null) py += 2.2 * Math.sin(Math.PI * at);           // fake arc for the stills
  return {
    ...def, id, state: state || (ride || action === 'jump' && def.kind !== 'surfer' ? 'RIDE' : action === 'idle' ? 'LINEUP' : 'POSITION'),
    style: null, action, actionT: at,
    pos: { x, y: py, z }, fwd: { x: Math.cos(heading), y: 0, z: Math.sin(heading) }, up: up || { x: 0, y: 1, z: 0 },
    speed: sp, frontId: null, zi: -1, u: 0.5, sigma: 0.5,
  };
}

function setCam(c, pos, target, fov) {
  c.position.set(...pos); c.fov = fov; c.aspect = W / H; c.updateProjectionMatrix(); c.lookAt(new THREE.Vector3(...target)); c.updateMatrixWorld();
}
function orbit(c, target, az, dist, h, fov) {
  const a = THREE.MathUtils.degToRad(az);
  setCam(c, [target[0] + Math.cos(a) * dist, target[1] + h, target[2] + Math.sin(a) * dist], target, fov);
}

// ---------------------------------------------------------------- scenes
const t0 = num('t', 3);
const labels = [];
let target = [200, 0.8, -20];
let animate = null;     // (t) => void for cycle mode

function build(t) {
  fake.riders.length = 0;
  labels.length = 0;
  const kind = q.get('kind') || 'surfer';
  const action = q.get('action') || 'trim';
  const at = num('at', 0.5);
  const speed = q.has('speed') ? num('speed', 0) : null;
  const heading = THREE.MathUtils.degToRad(num('heading', 90));
  if (SCENE === 'single') {
    const def = defOf(kind, num('i', 0));
    fake.riders.push(rider(def, def.id, 200, -20, { action, at, t, heading, speed, state: q.get('state') }));
    target = [200, fake.riders[0].pos.y + (kind === 'surfer' ? 1.0 : 0.3), -20];
    if (!q.has('cam')) orbit(cam, target, num('az', 200), num('dist', 7), num('ch', 1.6), num('fov', 40));
  } else if (SCENE === 'grid') {
    const kinds = kind === 'all' ? ['surfer', 'dolphin', 'seal'] : [kind];
    let k = 0;
    const acts = q.get('actions') ? q.get('actions').split(',') : null;
    const sp = num('spacing', kind === 'surfer' ? 3.6 : 4.4);
    const rows = [];
    for (const kd of kinds) for (const a of (acts || ACTIONS[kd])) rows.push([kd, a]);
    rows.forEach(([kd, a], i) => {
      const def = defOf(kd, i);
      const z = -20 + (i - (rows.length - 1) / 2) * sp;
      const at2 = q.has('at') ? at : (a === 'pop' ? 0.62 : a === 'kickout' ? 0.45 : a === 'wipe' ? 0.3 : a === 'jump' ? 0.35 : 0.5);
      fake.riders.push(rider(def, 100 + k++, 200, z, { action: a, at: at2, t, heading, speed }));
      labels.push({ text: `${def.name} ${a}`, p: [200, 3.2, z] });
    });
    target = [200, 0.9, -20];
    if (!q.has('cam')) orbit(cam, target, num('az', 200), num('dist', rows.length * sp * 0.85 + 4), num('ch', 2.5), num('fov', 40));
  } else if (SCENE === 'lineup') {
    RIDERS.forEach((def, i) => {
      const z = -20 + (i - 2.5) * 4.5;
      fake.riders.push(rider(def, def.id, 200 + (i % 2) * 1.5, z, { action: def.kind === 'surfer' ? 'idle' : 'idle', at: 0.5, t, heading: Math.PI * 0 }));
      labels.push({ text: def.name, p: [200 + (i % 2) * 1.5, 2.8, z] });
    });
    target = [200, 0.6, -20];
    if (!q.has('cam')) orbit(cam, target, num('az', 195), num('dist', 26), num('ch', 3.5), num('fov', 40));
  } else if (SCENE === 'far') {
    // the wide camera's view: lineup ~200 m out, a mix of waiting and riding cues
    const mix = [['idle', 0.5], ['trim', 0.5], ['swim', 0.5], ['jump', 0.4], ['idle', 0.5], ['trim', 0.5]];
    RIDERS.forEach((def, i) => {
      const [a, at2] = mix[i];
      const x = 190 + (i % 3) * 6, z = -45 + i * 11;
      fake.riders.push(rider(def, def.id, x, z, { action: q.get('action') || a, at: at2, t, heading: THREE.MathUtils.degToRad(i % 2 ? 100 : -80) }));
    });
    const C = CAMERA_DEFAULT;
    if (q.get('wide') === '1') setCam(cam, SPOT_CAMERAS.default.pos, SPOT_CAMERAS.default.target, SPOT_CAMERAS.default.fov);
    else setCam(cam, C.position, [195, 0, -12], num('fov', 50));
  } else if (SCENE === 'wave') {
    placeOnWave(t);
  }
  if (q.has('cam')) { const v = q.get('cam').split(',').map(Number); setCam(cam, v.slice(0, 3), v.slice(3, 6), v[6] || 45); }
  window.__riders = fake.riders;
}

// riders on the face of a real breaking wave (demo replay)
function placeOnWave(t) {
  const fronts = app.swell.fronts || [];
  let best = null, bestH = 0;
  for (const f of fronts) for (const zb of f.breaks || []) {
    if (zb.zone !== 'point' && zb.zone !== 'outer' && zb.zone !== 'inside') continue;
    if (t >= zb.tBreak - 0.5 && t < zb.tBreak + 12 && zb.H > bestH) { best = { f, zb }; bestH = zb.H; }
  }
  if (!best) { console.warn('no breaking front at', t); return; }
  const { f, zb } = best;
  const dir = zb.dir || 1;
  const kinds = (q.get('kinds') || 'surfer,dolphin,seal').split(',');
  const acts = (q.get('actions') || 'trim,trim,trim').split(',');
  const sigma = num('sigma', 0.5 * ((KF.SIGMA_LIP ?? 0.46) + (KF.SIGMA_TROUGH ?? 0.8)));
  kinds.forEach((kd, i) => {
    // ahead of the breaking section along the peel
    const elapsed = Math.max(0, t - zb.tBreak);
    const s = elapsed * zb.vPeel + num('u', 10) + i * num('gap', 9);
    const u = zb.uPeak + (dir * s) / FRONT_W;
    const sm = field.sampleFront(f, u, sigma, t);
    const s2 = field.sampleFront(f, u + dir * 0.004, sigma + num('down', 0.0), t);
    const fwd = new THREE.Vector3(s2.x - sm.x, s2.y - sm.y, s2.z - sm.z).normalize();
    const def = defOf(kd, i);
    const r = rider(def, def.id, sm.x, sm.z, { action: acts[i] || 'trim', at: num('at', 0.5), t, speed: 8, y: sm.y, state: 'RIDE' });
    r.fwd = { x: fwd.x, y: fwd.y, z: fwd.z }; r.up = { x: sm.nx, y: sm.ny, z: sm.nz };
    r.frontId = f.id; r.u = u; r.sigma = sigma;
    fake.riders.push(r);
    labels.push({ text: `${def.name} ${r.action}`, p: [sm.x, sm.y + 3, sm.z] });
  });
  const r0 = fake.riders[Math.min(1, fake.riders.length - 1)];
  target = [r0.pos.x, r0.pos.y + 0.5, r0.pos.z];
  if (!q.has('cam')) {
    // in front of the face (shoreward = -x), looking back at it
    // on the shoulder, out in front of the face, looking back into the pocket
    setCam(cam, [r0.pos.x - num('dist', 14), r0.pos.y + num('ch', 2.5), r0.pos.z + (q.get('dir') === '-1' ? -dir : dir) * num('side', 22)], target, num('fov', 45));
  }
}

// ---------------------------------------------------------------- render
const vp = new THREE.Vector2();
function render(t) {
  app.waterUniforms.uTime.value = t;
  app.ocean.update(app.renderer, t);
  app.sky.update(t);
  for (const s of app.visuals) s.update?.(t);
  const hide = (q.get('hide') || '').split(',');
  for (const e of app.riderViews.models.values()) {
    if (hide.includes('wake')) e.wake.ribbon.visible = false;
    if (hide.includes('spray')) e.wake.spray.visible = false;
    if (hide.includes('body')) e.model.body.visible = false;
    if (hide.includes('board') && e.model.board) e.model.board.visible = false;
  }
  app.renderer.getDrawingBufferSize(vp);
  app.post.render(app.scene, cam);
  if (q.get('inset') === '1') {
    const r = fake.riders[0];
    if (r) {
      const tgt = [r.pos.x, r.pos.y + (r.kind === 'surfer' ? 1.0 : 0.3), r.pos.z];
      inset.aspect = 16 / 9;
      orbit(inset, tgt, num('iaz', 225), num('idist', 4.5), num('ich', 1.4), 40);
      if (!render.ipost) render.ipost = app.createPost(Math.round(vp.x / 3), Math.round(vp.y / 3));
      const iw = Math.round(vp.x / 3), ih = Math.round(vp.y / 3), m = 10;
      render.ipost.render(app.scene, inset, null, { x: vp.x - iw - m, y: m, w: iw, h: ih });
    }
  }
  drawLabels();
}
const lblEls = [];
function drawLabels() {
  const show = q.get('labels') !== '0';
  const v = new THREE.Vector3();
  labels.forEach((l, i) => {
    let el = lblEls[i];
    if (!el) { el = document.createElement('div'); el.className = 'lbl'; document.body.appendChild(el); lblEls[i] = el; }
    v.set(...l.p).project(cam);
    el.style.display = show && v.z < 1 ? 'block' : 'none';
    el.style.left = `${((v.x + 1) / 2) * W}px`; el.style.top = `${((1 - v.y) / 2) * H}px`;
    el.textContent = l.text;
  });
  for (let i = labels.length; i < lblEls.length; i++) lblEls[i].style.display = 'none';
}

// ---------------------------------------------------------------- cycle mode (interactive): every action per kind
function cycle(tw) {
  const kinds = ['surfer', 'dolphin', 'seal'];
  const per = 2.6;
  const all = kinds.flatMap((k) => ACTIONS[k].map((a) => [k, a]));
  const idx = Math.floor(tw / per) % all.length, at = (tw % per) / per;
  const [kd, a] = all[idx];
  const def = defOf(kd, Math.floor(tw / (per * all.length)));
  fake.riders.length = 0;
  fake.riders.push(rider(def, def.id, 200, -20, { action: a, at, t: tw, heading: Math.PI / 2 }));
  labels.length = 0;
  labels.push({ text: `${def.name} ${a} ${at.toFixed(2)}`, p: [200, 3, -20] });
  orbit(cam, [200, kd === 'surfer' ? 1 : 0.3, -20], 200 + tw * 12, 7, 1.8, 40);
}

async function main() {
  if (SCENE === 'wave') {
    const res = await fetch(q.get('demo') || '/demo/demo-basic.json');
    const demo = await res.json();
    if (!Array.isArray(demo) && demo.cfg) mergeDeep(app.baseCfg, demo.cfg);
    // only the swell is needed: keep the fake riders
    app.loadInput(Array.isArray(demo) ? demo : demo.log, { reset: true, t0: 0 });
    app.riders = fake;
    app.advanceSim(t0);
  }
  try { await app.renderer.compileAsync(app.scene, cam); } catch (e) { console.warn(e); }
  if (SCENE === 'cycle') {
    const start = performance.now();
    q.set('inset', q.get('inset') ?? '1');
    const loop = () => { const tw = (performance.now() - start) / 1000; cycle(tw); render(tw + t0); requestAnimationFrame(loop); };
    loop();
  } else {
    build(SCENE === 'wave' ? app.simTime : t0);
    render(SCENE === 'wave' ? app.simTime : t0);
  }
  const tris = app.riderViews.triangles;
  window.__info = { scene: SCENE, triangles: tris, riders: fake.riders.map((r) => `${r.name}:${r.action}`), calls: app.renderer.info.render.calls };
  document.getElementById('info').textContent = q.get('labels') === '0' ? '' :
    `scene ${SCENE}  tris/rider ${JSON.stringify(tris)}`;
}

window.__render = (t) => { build(t); render(t); return t; };
window.__bench = async (n = 60) => {
  const t = SCENE === 'wave' ? app.simTime : t0;
  const g = app.riderViews.group;
  const m = async () => { const r = await app.gpuTimer.measure(() => render(t), n); return r && +r.median.toFixed(3); };
  await m();
  const all = await m();
  g.visible = false;
  const none = await m();
  g.visible = true;
  return { all, noRiders: none, riders: all != null && none != null ? +(all - none).toFixed(3) : null, timer: app.gpuTimer.available };
};
void realRiders; void uToZ;
window.__ready = main().then(() => true);
