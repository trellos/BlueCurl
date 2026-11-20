#!/usr/bin/env node
// WP5 next-frame visibility check (real GPU, headless Chrome, like tools/shot.mjs).
//
//   node test/fx-nextframe.mjs [--port 5185] [--demo demo/demo-basic.json] [--t 6] [--lane 3] [--velocity 1]
//                              [--w 1280 --h 720] [--thresh 24] [--bench 120] [--name wp5-nextframe]
//
// ?capture=1 → advance to --t, grab A; advance 1/60 without input, grab C (control); rewind (deterministic replay
// to --t); window.bluecurl.impulse({lane}); __advance(1/60); grab B.
//   raw      = A → B  (what a viewer sees on the next frame: includes ordinary water motion)
//   isolated = C → B  (the same frame with vs without the impulse: the impulse's own footprint)
// Reports changed-pixel counts (max channel diff > --thresh), bboxes, the fraction within 250 px of the projected
// impact, and writes A/B/C/diff/crop PNGs to captures/<name>/. --bench N: GPU ms with 30 impulses in flight, FX
// on vs off. --velocity 0 = no impulse (measures replay noise). Exit code 1 if the isolated change is small (< 400 px) or not localised (< 60 % near the impact).
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const W = +opt('w', 1280), H = +opt('h', 720), PORT = +opt('port', 5185), T = +opt('t', 6), LANE = +opt('lane', 3);
const VEL = +opt('velocity', 1), THRESH = +opt('thresh', 24), BENCH = +opt('bench', 0);
const DEMO = opt('demo', 'demo/demo-basic.json'), NAME = opt('name', 'wp5-nextframe');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const out = path.join(root, 'captures', NAME);
fs.mkdirSync(out, { recursive: true });

process.env.CAPTURE = '1';
const { createServer } = await import('vite');
const server = await createServer({ root, configFile: path.join(root, 'vite.config.js'), logLevel: 'error', server: { port: PORT, strictPort: true, hmr: false } });
await server.listen();
const base = `http://localhost:${PORT}`;
const browser = await chromium.launch({ executablePath: CHROME, headless: true,
  args: ['--headless=new', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--force_high_performance_gpu'] });
let code = 0;
const save = (name, png) => fs.writeFileSync(path.join(out, name), Buffer.from(png.split(',')[1], 'base64'));
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const logs = [];
  page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
  page.on('pageerror', (e) => logs.push('[pageerror] ' + (e.stack || e.message)));
  const q = new URLSearchParams({ capture: '1', w: String(W), h: String(H), nohud: '1', demo: '/' + DEMO });
  await page.goto(`${base}/?${q}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => window.__ready instanceof Promise, null, { timeout: 60000 });
  await page.evaluate(() => window.__ready);

  // raw pixels of the WebGL canvas (preserveDrawingBuffer in capture mode) via a 2D canvas
  const grab = () => page.evaluate(() => {
    const c = document.getElementById('c'), cv = document.createElement('canvas');
    cv.width = c.width; cv.height = c.height;
    const g = cv.getContext('2d'); g.drawImage(c, 0, 0);
    return { data: Array.from(g.getImageData(0, 0, cv.width, cv.height).data), png: c.toDataURL('image/png') };
  });

  await page.evaluate((t) => window.__advance(Math.max(0, t - window.__simTime())), T);
  const A = await grab();
  await page.evaluate(() => window.__advance(1 / 60));
  const C = await grab();
  await page.evaluate(async ({ demo, t }) => {
    const d = await (await fetch(demo)).json();
    window.__loadInput(d, { reset: true, t0: t });
    window.__advance(0);
  }, { demo: '/' + DEMO, t: T });
  const info = await page.evaluate(({ lane, vel }) => {
    const app = window.__app;
    const id = vel > 0 ? window.bluecurl.impulse({ lane, velocity: vel }) : -1;
    const t = window.__advance(1 / 60);
    const imp = app.swell.impulses.find((i) => i.id === id) || { x: 0, z: 0, strength: 0, precharge: false, frontId: -1 };
    const f = app.swell.fronts.find((fr) => fr.id === imp.frontId);
    const x = f ? f.x : imp.x;
    const v = new app.camera.position.constructor(x, 1.5, imp.z).project(app.camera);
    return { id, t, imp, frontX: x, px: (v.x * 0.5 + 0.5) * app.renderer.domElement.width, py: (0.5 - v.y * 0.5) * app.renderer.domElement.height, fx: app.fx.stats };
  }, { lane: LANE, vel: VEL });
  const B = await grab();

  const cmp = (P, Q) => {
    let n = 0, x0 = W, y0 = H, x1 = -1, y1 = -1, sum = 0, near = 0;
    const diff = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const d = Math.max(Math.abs(P.data[i] - Q.data[i]), Math.abs(P.data[i + 1] - Q.data[i + 1]), Math.abs(P.data[i + 2] - Q.data[i + 2]));
      diff[y * W + x] = Math.min(255, d * 3);
      sum += d;
      if (d > THRESH) {
        n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (Math.hypot(x - info.px, y - info.py) < 250) near++;
      }
    }
    return { changedPx: n, bbox: n ? [x0, y0, x1, y1] : null, within250px: n ? +(near / n).toFixed(3) : 0, meanAbsDiff: +(sum / (W * H)).toFixed(3), diff };
  };
  const raw = cmp(A, B), iso = cmp(C, B);
  save('A.png', A.png); save('B.png', B.png); save('C-control.png', C.png);

  // isolated diff image + 2× crop of B around the impact, encoded in the page (no node image deps)
  const enc = await page.evaluate(({ diff, w, h, cx, cy, B }) => {
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const g = cv.getContext('2d'), im = g.createImageData(w, h);
    for (let i = 0; i < w * h; i++) { im.data[i * 4] = diff[i]; im.data[i * 4 + 1] = diff[i]; im.data[i * 4 + 2] = diff[i]; im.data[i * 4 + 3] = 255; }
    g.putImageData(im, 0, 0);
    const d = cv.toDataURL('image/png');
    return new Promise((res) => { const img = new Image(); img.onload = () => {
      const c2 = document.createElement('canvas'); c2.width = 640; c2.height = 360;
      const g2 = c2.getContext('2d');
      g2.drawImage(img, Math.max(0, Math.min(w - 320, cx - 160)), Math.max(0, Math.min(h - 180, cy - 90)), 320, 180, 0, 0, 640, 360);
      res({ d, crop: c2.toDataURL('image/png') });
    }; img.src = B; });
  }, { diff: Array.from(iso.diff), w: W, h: H, cx: Math.round(info.px), cy: Math.round(info.py), B: B.png });
  save('diff.png', enc.d); save('crop2x.png', enc.crop);

  const strip = ({ diff, ...r }) => r;
  console.log(JSON.stringify({
    t: info.t, impulse: { id: info.id, lane: LANE, strength: info.imp.strength, precharge: info.imp.precharge, x: +info.frontX.toFixed(1), z: info.imp.z },
    impactPx: [Math.round(info.px), Math.round(info.py)], thresh: THRESH, isolated: strip(iso), raw: strip(raw), fx: info.fx,
  }));
  if (iso.changedPx < 400 || iso.within250px < 0.6) { console.error('FAIL: change too small or not localised'); code = 1; }

  if (BENCH > 0) {
    const b = await page.evaluate(async (n) => {
      const t0 = window.__simTime();
      for (let i = 0; i < 30; i++) window.bluecurl.impulse({ lane: i % 8, velocity: i % 3 ? 1 : 0.4, time: t0 + 0.05 * (i + 1) });
      window.__advance(1.6);
      const app = window.__app;
      let live = 0;
      for (const imp of app.swell.impulses) if (window.__simTime() - imp.t < 3) live++;
      await window.__bench(10);
      const on = await window.__bench(n);
      const stats = { ...app.fx.stats, live };
      app.fx.group.visible = false;
      await window.__bench(10);
      const off = await window.__bench(n);
      app.fx.group.visible = true;
      // CPU cost of Fx.update
      const c0 = performance.now();
      for (let i = 0; i < 50; i++) app.fx.update(window.__simTime());
      const cpu = (performance.now() - c0) / 50;
      return { on, off, stats, cpu };
    }, BENCH);
    console.log('bench (30 impulses in flight):', JSON.stringify({ fxOnMedian: b.on.median, fxOffMedian: b.off.median, fxOnMean: b.on.gpuMs, fxOffMean: b.off.gpuMs,
      deltaMedianMs: +(b.on.median - b.off.median).toFixed(3), cpuUpdateMs: +b.cpu.toFixed(3), w: b.on.w, h: b.on.h, stats: b.stats }));
  }
  if (logs.length) console.log(logs.slice(0, 10).join('\n'));
  console.log('files:', ['A.png', 'B.png', 'C-control.png', 'diff.png', 'crop2x.png'].map((f) => path.join(out, f)).join(' '));
} finally {
  await browser.close();
  await server.close();
}
process.exit(code);
