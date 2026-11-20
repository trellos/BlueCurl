// BlueCurl Swell entry: URL options, demo loading, App construction, test hooks.
//
// URL: ?capture=1 (no RAF, preserveDrawingBuffer, manual stepping) · ?demo=<path> (array log or {cfg, log})
//      ?t0=<s> (sim-only fast-forward at boot) · ?w=&h= (fixed canvas size, pixel ratio 1) · ?nohud
//      ?dpr=<n> (live pixel ratio, default 1)
//      read by the CameraRig itself (WP7, debug): ?fakeride=1|all (fake-ride fixture) · ?fakewave=1 (debug wave
//      patch around the fake ride) · ?zonelines=1 (zone break lines) · ?widecam=px,py,pz,tx,ty,tz,fov (wide pose)
//      any DEFAULT_CFG key, dotted allowed: ?bpm=100&bars=2&pip.enabled=0
// Hooks: __ready (Promise) · __advance(sec) → simTime · __simTime() · __loadInput(log | {cfg, log}, {reset, t0})
//        __setCfg(k, v) · __grab() → PNG data URL · __bench(n) → GPU ms · __app · window.bluecurl
import { DEFAULT_CFG } from './contracts.js';
import { App, setPath, getPath, mergeDeep } from './core/App.js';

const qs = new URLSearchParams(location.search);
const flag = (k) => qs.has(k) && qs.get(k) !== '0' && qs.get(k) !== 'false';
const num = (k, d) => (qs.has(k) && qs.get(k) !== '' && Number.isFinite(+qs.get(k)) ? +qs.get(k) : d);

function parseValue(raw, def) {
  if (typeof def === 'boolean') return !(raw === '0' || raw === 'false' || raw === 'off');
  if (typeof def === 'number') return Number(raw);
  try { return JSON.parse(raw); } catch { return raw; }
}

function showError(e) {
  console.error(e);
  const d = document.createElement('pre');
  d.style.cssText = 'position:fixed;inset:auto 10px 10px 10px;color:#ffb4a0;background:rgba(40,0,0,.8);padding:8px;font:12px monospace;white-space:pre-wrap;z-index:20';
  d.textContent = 'BlueCurl boot error: ' + (e && e.stack ? e.stack : e);
  document.body.appendChild(d);
}

async function boot() {
  const capture = flag('capture');
  const cfg = structuredClone(DEFAULT_CFG);
  let log = [];
  if (qs.get('demo')) {
    const res = await fetch(qs.get('demo'));
    if (!res.ok) throw new Error(`demo ${qs.get('demo')}: HTTP ${res.status}`);
    const demo = await res.json();
    if (Array.isArray(demo)) log = demo;
    else { if (demo.cfg) mergeDeep(cfg, demo.cfg); log = demo.log || []; }
  }
  for (const [k, raw] of qs) {
    const def = getPath(DEFAULT_CFG, k);
    if (def !== undefined && (typeof def !== 'object' || def === null)) setPath(cfg, k, parseValue(raw, def));
  }
  if (qs.has('nohud')) cfg.hud = false;

  const W = num('w', 0), H = num('h', 0);
  const canvas = document.getElementById('c');
  const app = new App({
    canvas, cfg, capture,
    width: W > 0 && H > 0 ? W : 0, height: W > 0 && H > 0 ? H : 0,
    pixelRatio: num('dpr', 1), hud: !qs.has('nohud'),
  });
  window.__app = app;
  window.bluecurl = {
    impulse: (o) => app.input.impulse(o),
    release: (id, time = null) => app.input.release(id, time),
    setConfig: (k, v, time = null) => app.input.setConfig(k, v, time),
  };

  app.loadInput(log, { reset: true, t0: num('t0', 0) });

  window.__simTime = () => app.simTime;
  window.__advance = (sec = 0) => { app.advanceSim(Number(sec) || 0); app.render(); return app.simTime; };
  window.__loadInput = (l, opts = {}) => app.loadInput(l, opts);
  window.__setCfg = (k, v) => app.input.setConfig(k, v);
  window.__grab = () => canvas.toDataURL('image/png');
  window.__bench = async (n = 60) => {
    const r = await app.gpuTimer.measure(() => app.render(), n);
    const b = app._bufferSize();
    return { gpuMs: r && +r.mean.toFixed(3), median: r && +r.median.toFixed(3), min: r && +r.min.toFixed(3), max: r && +r.max.toFixed(3), samples: r?.n ?? 0, timer: app.gpuTimer.available, w: b.x, h: b.y };
  };

  // compile every program before the first frame (parallel where KHR_parallel_shader_compile exists)
  try { await app.renderer.compileAsync(app.scene, app.camera); } catch (e) { console.warn('compileAsync', e); }
  app.render();
  if (!capture) app.start();
  return true;
}

window.__ready = boot().catch((e) => { showError(e); throw e; });
