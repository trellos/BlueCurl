// Shared capture plumbing (WP8): app source (Vite dev server or a frozen production build served
// statically), GPU Chrome launch, app URL and page boot, renderer string, small fs / process helpers.
// Used by tools/capture.mjs, tools/clips.mjs and test/capture-resume.mjs. Launch flags match tools/shot.mjs.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const VIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
export const FFMPEG = process.env.FFMPEG_PATH || 'C:/dev/ffmpeg/bin/ffmpeg.exe';

// ---------------------------------------------------------------- argv
/** Minimal --key value / --flag parser. Repeated keys collect into arrays via all(). */
export function argParser(argv = process.argv.slice(2)) {
  const has = (k) => argv.includes('--' + k);
  const opt = (k, d) => {
    const i = argv.lastIndexOf('--' + k);
    return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
  };
  const all = (k) => argv.flatMap((a, i) => (a === '--' + k && i + 1 < argv.length ? [argv[i + 1]] : []));
  const positional = argv.filter((a, i) => !a.startsWith('--') && (i === 0 || !argv[i - 1].startsWith('--')));
  return { has, opt, all, positional };
}

// ---------------------------------------------------------------- hashing / fs
export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** sha256 over every file below dir (relative path + content), sorted. */
export function hashDir(dir) {
  const h = crypto.createHash('sha256');
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { h.update(path.relative(dir, p).replace(/\\/g, '/')); h.update(fs.readFileSync(p)); }
    }
  };
  walk(dir);
  return h.digest('hex');
}

/** Write via a temp file + rename so a kill mid-write never leaves a truncated file behind. */
export function writeAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/** git commit + number of dirty paths under viz/ (best effort). */
export function gitInfo() {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: VIZ, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--', '.'], { cwd: VIZ, encoding: 'utf8' })
      .split('\n').filter((l) => l.trim() && !/captures\//.test(l)).length;
    return { commit, dirtyPaths: dirty };
  } catch (e) { return { commit: null, error: String(e.message || e).slice(0, 200) }; }
}

/** Resolve a demo argument to { file (absolute), rel (path relative to viz/, '/'-separated) }. */
export function resolveDemo(demo) {
  if (!demo) return null;
  if (/^https?:/.test(demo)) return { url: demo };
  const file = path.isAbsolute(demo) ? demo : path.resolve(VIZ, demo.replace(/^[/\\]+/, ''));
  if (!fs.existsSync(file)) throw new Error(`demo not found: ${file}`);
  let rel = path.relative(VIZ, file).replace(/\\/g, '/');
  if (rel.startsWith('..')) rel = '_demo/' + path.basename(file);
  return { file, rel };
}

// ---------------------------------------------------------------- app source
/** Vite dev server with CAPTURE=1 (no HMR / watching), like tools/shot.mjs. */
export async function startDevServer({ port = 5188 } = {}) {
  process.env.CAPTURE = '1';
  const { createServer } = await import('vite');
  const server = await createServer({ root: VIZ, configFile: path.join(VIZ, 'vite.config.js'), logLevel: 'error',
    server: { port, strictPort: true, hmr: false, watch: null } });
  await server.listen();
  return { base: `http://localhost:${server.config.server.port}`, close: () => server.close() };
}

/**
 * Frozen production build of the app (vite build into outDir) plus copies of the given data files
 * (paths relative to viz/, e.g. demo logs) so a capture keeps rendering the same code and data while
 * the sources change. Returns { dir, hash }.
 */
export async function buildSnapshot(outDir, { files = [] } = {}) {
  const { build } = await import('vite');
  const t = Date.now();
  await build({ root: VIZ, configFile: path.join(VIZ, 'vite.config.js'), logLevel: 'error',
    build: { outDir, emptyOutDir: true, reportCompressedSize: false } });
  for (const f of files) copyIntoSnapshot(outDir, f.file, f.rel);
  fs.writeFileSync(path.join(outDir, 'SNAPSHOT.txt'), `vite build of ${VIZ} at ${new Date().toISOString()} (${Date.now() - t} ms)\n`);
  return { dir: outDir, hash: hashDir(outDir) };
}
export function copyIntoSnapshot(dir, file, rel) {
  const dst = path.join(dir, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(file, dst);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.wasm': 'application/wasm',
  '.bin': 'application/octet-stream', '.ktx2': 'application/octet-stream', '.glb': 'model/gltf-binary', '.txt': 'text/plain' };

/**
 * Static file server for a snapshot directory. onUpload(pathname, Buffer) handles POSTs below /__upload/
 * (frame upload from the page, see tools/lib/framesink.mjs); it may return a Promise.
 */
export function startStaticServer(dir, { port = 5188, onUpload = null } = {}) {
  const rootDir = path.resolve(dir);
  const server = http.createServer((req, res) => {
    let p;
    try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
    if (req.method === 'POST' && onUpload && p.startsWith('/__upload/')) {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        try { await onUpload(p.slice('/__upload/'.length), Buffer.concat(chunks)); res.writeHead(200).end('ok'); }
        catch (e) { res.writeHead(500).end(String(e.message || e)); }
      });
      req.on('error', () => {});
      return;
    }
    if (p.endsWith('/')) p += 'index.html';
    const f = path.resolve(rootDir, '.' + p);
    if (!f.startsWith(rootDir)) { res.writeHead(403).end(); return; }
    fs.readFile(f, (err, data) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(data);
    });
  });
  server.keepAliveTimeout = 120000;          // the default 5 s races with reuse of idle sockets (POST is not retried)
  server.headersTimeout = 125000;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({
      base: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
    }));
  });
}

// ---------------------------------------------------------------- browser
export function chromeArgs({ angle = 'd3d11', headed = false } = {}) {
  const a = [`--use-angle=${angle}`, '--enable-gpu', '--ignore-gpu-blocklist', '--force_high_performance_gpu',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];
  return headed ? a : ['--headless=new', ...a];
}

export async function launchBrowser({ angle = 'd3d11', headed = false } = {}) {
  return chromium.launch({ executablePath: CHROME, headless: !headed, args: chromeArgs({ angle, headed }), timeout: 60000 });
}

/** App URL: ?capture=1&w&h[&nohud][&demo][&t0][&extra]. */
export function appUrl(base, { w = 1280, h = 720, demo = null, t0 = 0, hud = false, query = '' } = {}) {
  const q = new URLSearchParams({ capture: '1', w: String(w), h: String(h) });
  if (!hud) q.set('nohud', '1');
  if (demo) q.set('demo', demo);
  if (t0 > 0) q.set('t0', String(t0));
  const extra = String(query || '').replace(/^[?&]+/, '');
  return `${base.replace(/\/$/, '')}/?${q}${extra ? '&' + extra : ''}`;
}

export async function rendererString(page) {
  return page.evaluate(() => {
    const c = document.createElement('canvas').getContext('webgl2');
    const e = c && c.getExtension('WEBGL_debug_renderer_info');
    return e ? c.getParameter(e.UNMASKED_RENDERER_WEBGL) : (c ? c.getParameter(c.RENDERER) : 'no webgl2');
  });
}

/** Reject after ms (keeps hung GPU / renderer calls from blocking forever). */
export function withTimeout(promise, ms, what) {
  let id;
  return Promise.race([promise, new Promise((_, rej) => { id = setTimeout(() => rej(new Error(`timeout after ${ms} ms: ${what}`)), ms); })])
    .finally(() => clearTimeout(id));
}

/**
 * New page at url (viewport w×h, DPR 1), awaits window.__ready. Returns { page, logs, bootMs }.
 * logs collects console / page errors; page.__crashed is set when the renderer dies.
 */
export async function openApp(browser, url, { w, h, timeout = 180000 } = {}) {
  const t = Date.now();
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text().slice(0, 2000)}`));
  page.on('pageerror', (e) => logs.push('[pageerror] ' + (e.stack || e.message)));
  page.on('crash', () => { page.__crashed = true; logs.push('[crash] renderer process crashed'); });
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForFunction(() => window.__ready instanceof Promise, null, { timeout });
    await withTimeout(page.evaluate(() => window.__ready), timeout, '__ready');
  } catch (e) {
    e.message += '\n' + logs.slice(-30).join('\n');
    throw e;
  }
  return { page, logs, bootMs: Date.now() - t };
}
