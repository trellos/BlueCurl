// Spike capture driver: like tools/capture.mjs but tolerant of slow (software / SwiftShader)
// WebGL, and records load phases, per-frame wall-clock timing and optional surf telemetry.
//
//   node tools/spike-capture.mjs --out captures/x [--w 960 --h 540] [--params 'surf'] \
//        [--times 3,8] [--seq start:end:step] [--fps 30] [--video name.mp4] [--timeout 1800]
//
// --seq renders a deterministic frame sequence through window.__advance (fixed sim steps), so
// the result is a real-time-equivalent recording regardless of how slowly the machine renders.
import { createServer, build, preview } from 'vite';
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const W = parseInt(opt('w', '960'), 10), H = parseInt(opt('h', '540'), 10);
const out = path.resolve(opt('out', 'captures/spike'));
const extra = opt('params', '');
const TIMEOUT = parseFloat(opt('timeout', '3600')) * 1000;
fs.mkdirSync(out, { recursive: true });
const chromePath = process.env.CHROME_PATH
  || ['/opt/pw-browsers/chromium-1243/chrome-linux64/chrome', '/usr/bin/chromium', '/usr/bin/google-chrome']
    .find((p) => fs.existsSync(p));

// --root DIR: capture another checkout (e.g. a worktree of the original branch);
// --dist: build it and serve the static build (no dev-server hot reload while sources are edited)
const root = path.resolve(opt('root', path.join(path.dirname(fileURLToPath(import.meta.url)), '..')));
let server, port;
if (args.includes('--dist')) {
  await build({ root, logLevel: 'error', build: { outDir: path.join(root, 'dist'), emptyOutDir: true } });
  server = await preview({ root, logLevel: 'error', preview: { port: 0, strictPort: false } });
  port = server.httpServer.address().port;
} else {
  // (own dependency cache per checkout: worktrees may share one node_modules)
  server = await createServer({ root, logLevel: 'error', cacheDir: path.join(root, '.vite-spike-cache'), server: { port: 0, strictPort: false, hmr: false, watch: null } });
  await server.listen();
  port = server.httpServer.address().port;
}
const browser = await chromium.launch({ executablePath: chromePath, headless: true,
  args: ['--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text().slice(0, 600)}`));
page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message));
const url = `http://localhost:${port}/?capture&nohud&w=${W}&h=${H}${extra ? '&' + extra : ''}`;
console.log('URL', url);
const tLoad = Date.now();
await page.goto(url, { waitUntil: 'commit', timeout: TIMEOUT });
// report the loader's stage while waiting (software rendering takes many minutes)
let lastStatus = '';
const poll = setInterval(async () => {
  try {
    const s = await page.evaluate(() => `${document.getElementById('load-status')?.textContent} ${document.getElementById('load-percent')?.textContent} marks=${JSON.stringify(window.__marks || [])}`);
    if (s !== lastStatus) { lastStatus = s; console.log(`[load ${((Date.now() - tLoad) / 1000).toFixed(0)}s] ${s}`); }
  } catch {}
}, 15000);
try {
  await page.waitForFunction(() => window.__ready === true || window.__failed, null, { timeout: TIMEOUT, polling: 2000 });
} catch (e) {
  console.error(logs.slice(-40).join('\n'));
  throw e;
}
clearInterval(poll);
const loadS = (Date.now() - tLoad) / 1000;
const info = await page.evaluate(() => {
  const c = document.createElement('canvas').getContext('webgl2');
  const e = c && c.getExtension('WEBGL_debug_renderer_info');
  return { gpu: e ? c.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown', marks: window.__marks, graphics: window.__graphicsInfo };
});
console.log('GPU:', info.gpu, ' load', loadS.toFixed(1), 's');
const report = { url, W, H, gpu: info.gpu, loadSeconds: loadS, marks: info.marks, frames: [] };

async function save(file) {
  const data = await page.evaluate(() => window.__grab());
  fs.writeFileSync(file, Buffer.from(data.split(',')[1], 'base64'));
}
async function telemetry() { return page.evaluate(() => (window.__surf ? window.__surf.telemetry() : null)); }

let lastStill = null;
for (const t of (opt('times') ? opt('times').split(',').map(Number) : [])) {
  const t0 = Date.now();
  // later stills advance the running simulation (a seek re-runs the whole warm-up)
  if (lastStill !== null && t > lastStill) await page.evaluate((dt) => window.__advance(dt), t - lastStill);
  else await page.evaluate((tt) => window.__seek(tt), t);
  lastStill = t;
  const f = path.join(out, `t${t.toFixed(2)}.png`);
  await save(f);
  const tel = await telemetry();
  // extra camera views of the same instant (surf mode: --views side,aerial)
  for (const v of (opt('views') ? opt('views').split(',') : [])) {
    const prev = await page.evaluate((vv) => { const d = window.__surf.demo, k = d.viewKey; d.setView(vv); window.__scene.renderOnce(); window.__scene.renderer.getContext().finish(); return k; }, v);
    await save(path.join(out, `t${t.toFixed(2)}-${v}.png`));
    await page.evaluate((k) => { window.__surf.demo.setView(k); window.__scene.renderOnce(); }, prev);
  }
  report.frames.push({ t, seekMs: Date.now() - t0, file: path.basename(f), tel });
  console.log('still', t, (Date.now() - t0) + 'ms', tel ? JSON.stringify(tel) : '');
}

if (opt('seq')) {
  const [a, b, s] = opt('seq').split(':').map(Number);
  const seqDir = path.join(out, 'seq');
  fs.mkdirSync(seqDir, { recursive: true });
  await page.evaluate((t) => window.__seek(t), a);
  let i = 0;
  const frameMs = [];
  for (let t = a; t <= b + 1e-6; t += s, i++) {
    const t0 = Date.now();
    if (i > 0) await page.evaluate((dt) => window.__advance(dt), s);
    const dtMs = Date.now() - t0;
    frameMs.push(dtMs);
    await save(path.join(seqDir, String(i).padStart(5, '0') + '.png'));
    const tel = await telemetry();
    report.frames.push({ t: +t.toFixed(3), advanceMs: dtMs, tel });
    if (i % 10 === 0) console.log('frame', i, 't', t.toFixed(2), dtMs + 'ms', tel ? JSON.stringify(tel) : '');
  }
  frameMs.shift();
  frameMs.sort((x, y) => x - y);
  report.seqWallMsPerFrame = { median: frameMs[frameMs.length >> 1], p95: frameMs[Math.floor(frameMs.length * 0.95)] };
  const fps = parseFloat(opt('fps', String(Math.round(1 / s))));
  const video = path.join(out, opt('video', 'seq.mp4'));
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-framerate', String(fps), '-i', path.join(seqDir, '%05d.png'),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', video]);
    console.log('video', video);
  } catch (e) { console.log('ffmpeg failed', e.message); }
}

if (args.includes('--split')) {
  // wall-clock split of one frame's work (finish()ed): render vs one sim step's subsystems
  report.split = await page.evaluate(() => {
    const { renderer, swe, whitewater } = window.__scene;
    const gl = renderer.getContext();
    const P = window.__params.shared;
    const time = (fn, n = 3) => { gl.finish(); const t0 = performance.now(); for (let i = 0; i < n; i++) fn(); gl.finish(); return +((performance.now() - t0) / n).toFixed(1); };
    const t = P.uTime.value, dt = 1 / 120;
    return { msSweStep: time(() => swe.step(t, dt)), msWhitewaterStep: time(() => whitewater.step(t, dt)),
      msRender: time(() => window.__draw && window.__seek ? window.__scene.renderOnce() : 0, 1) };
  }).catch((e) => ({ error: e.message }));
  console.log('split', JSON.stringify(report.split));
}
if (args.includes('--profile')) {
  // wall-clock cost per video frame, forced to completion with a 1-pixel readback (gl.finish alone
  // does not wait on SwiftShader): render only, 5 sim steps (1/24 s), and the subsystems
  report.profile = await page.evaluate(() => {
    const { renderer, whitewater } = window.__scene;
    const gl = renderer.getContext(), px = new Uint8Array(4);
    const sync = () => { renderer.setRenderTarget(null); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); };
    const time = (fn, n = 2) => { sync(); const t0 = performance.now(); for (let i = 0; i < n; i++) { fn(); sync(); } return +((performance.now() - t0) / n).toFixed(0); };
    const t = window.__params.shared.uTime.value;
    return {
      msRender: time(() => window.__scene.renderOnce()),
      msAdvanceFrame: time(() => window.__advance(5 / 120)),
      msWhitewaterStep: time(() => whitewater.step(t, 1 / 120), 3),
      msGrab: time(() => window.__grab(), 1),
    };
  }).catch((e) => ({ error: e.message }));
  console.log('profile', JSON.stringify(report.profile));
}
if (args.includes('--bench')) {
  report.bench = await page.evaluate(() => window.__bench(10));
  console.log('bench', JSON.stringify(report.bench));
}
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 1));
fs.writeFileSync(path.join(out, 'console.log'), logs.join('\n'));
await browser.close();
await (server.close ? server.close() : server.httpServer.close());
