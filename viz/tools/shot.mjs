#!/usr/bin/env node
// Deterministic integration stills on the real GPU.
//
//   node tools/shot.mjs --name NAME [--demo demo/x.json] [--times 2,10,20] [--w 1280 --h 720] [--t0 0]
//                       [--port 5181] [--url http://host:port] [--query extra=1&more=2] [--bench 120]
//                       [--headed] [--angle d3d11|d3d11on12|gl|vulkan|default] [--keep-hud]
//
// Starts the Vite dev server (CAPTURE=1: no HMR / watching) on --port unless --url is given, launches
// Chrome (headless, ANGLE D3D11, high-performance GPU), prints the WebGL renderer string, opens
// ?capture=1&nohud&w=&h=..., awaits __ready, advances to each time in order and writes
// viz/captures/NAME/t<time>.png via __grab(). --bench N also prints GPU ms per frame (timer query).
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const flag = (k) => argv.includes('--' + k);

const NAME = opt('name');
if (!NAME) { console.error('usage: node tools/shot.mjs --name NAME [--demo demo/x.json] [--times 2,10] [--w 1280 --h 720] [--t0 0] [--port 5181] [--url ...] [--query a=1]'); process.exit(2); }
const W = +opt('w', 1280), H = +opt('h', 720);
const T0 = +opt('t0', 0);
const TIMES = String(opt('times', '2')).split(',').map(Number).filter(Number.isFinite).sort((a, b) => a - b);
const PORT = +opt('port', 5181);
const DEMO = opt('demo');
const EXTRA = opt('query', '');
const BENCH = opt('bench') ? +opt('bench') : 0;
const ANGLE = opt('angle', 'd3d11');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const out = path.join(root, 'captures', NAME);
fs.mkdirSync(out, { recursive: true });

let server = null, base = opt('url');
if (!base) {
  process.env.CAPTURE = '1';
  const { createServer } = await import('vite');
  server = await createServer({ root, configFile: path.join(root, 'vite.config.js'), logLevel: 'error', server: { port: PORT, strictPort: true, hmr: false } });
  await server.listen();
  base = `http://localhost:${server.config.server.port}`;
}
base = base.replace(/\/$/, '');

const args = ['--headless=new', `--use-angle=${ANGLE}`, '--enable-gpu', '--ignore-gpu-blocklist', '--force_high_performance_gpu',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding'];
let browser;
const cleanup = async () => { try { await browser?.close(); } catch {} try { await server?.close(); } catch {} };
process.on('SIGINT', async () => { await cleanup(); process.exit(130); });

try {
  browser = await chromium.launch({ executablePath: CHROME, headless: !flag('headed'), args: flag('headed') ? args.filter((a) => !a.startsWith('--headless')) : args });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text().slice(0, 2000)}`));
  page.on('pageerror', (e) => logs.push('[pageerror] ' + (e.stack || e.message)));

  const q = new URLSearchParams({ capture: '1', w: String(W), h: String(H) });
  if (!flag('keep-hud')) q.set('nohud', '1');
  if (DEMO) q.set('demo', DEMO.startsWith('/') || DEMO.startsWith('http') ? DEMO : '/' + DEMO.replace(/\\/g, '/'));
  if (T0 > 0) q.set('t0', String(T0));
  const url = `${base}/?${q}${EXTRA ? '&' + EXTRA.replace(/^[?&]/, '') : ''}`;
  console.log('url:', url);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });

  const gpu = await page.evaluate(() => {
    const c = document.createElement('canvas').getContext('webgl2');
    const e = c && c.getExtension('WEBGL_debug_renderer_info');
    return e ? c.getParameter(e.UNMASKED_RENDERER_WEBGL) : (c ? c.getParameter(c.RENDERER) : 'no webgl2');
  });
  console.log('renderer:', gpu);
  if (!/nvidia/i.test(gpu)) console.warn('WARNING: not running on the NVIDIA GPU');

  try {
    await page.waitForFunction(() => window.__ready instanceof Promise, null, { timeout: 60000 });
    await page.evaluate(() => window.__ready);
  } catch (e) {
    console.error(logs.join('\n'));
    throw e;
  }
  const errs = logs.filter((l) => /error|warning/i.test(l));
  if (errs.length) console.log(errs.slice(0, 20).join('\n'));

  const files = [];
  for (const t of TIMES) {
    const t0w = Date.now();
    const sim = await page.evaluate((target) => window.__advance(Math.max(0, target - window.__simTime())), t);
    const data = await page.evaluate(() => window.__grab());
    const file = path.join(out, `t${t}.png`);
    fs.writeFileSync(file, Buffer.from(data.split(',')[1], 'base64'));
    files.push(file);
    console.log(`t=${t} (sim ${sim.toFixed(4)} s, ${Date.now() - t0w} ms) -> ${file}`);
  }
  if (BENCH > 0) {
    await page.evaluate((n) => window.__bench(Math.min(n, 10)), BENCH);   // warm-up
    const b = await page.evaluate((n) => window.__bench(n), BENCH);
    console.log('bench:', JSON.stringify(b));
  }
  const late = logs.filter((l) => /pageerror|\[error\]/.test(l));
  if (late.length) console.log(late.join('\n'));
  console.log('files:\n' + files.join('\n'));
} finally {
  await cleanup();
}
