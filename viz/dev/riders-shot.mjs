// Stills of dev/riders.html with headless Chrome on the GPU (WP6b).
// usage: node dev/riders-shot.mjs [--port 5192] [--out captures/wp6b] [--size 1280x720] [--bench 120] name="query" ...
//   e.g. node dev/riders-shot.mjs lineup="scene=lineup" surfers="scene=grid&kind=surfer"
// Starts its own Vite server (CAPTURE=1) on --port unless --url is given.
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let port = 5192, out = 'captures/wp6b', w = 1280, h = 720, url = null, bench = 0;
const shots = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') port = Number(args[++i]);
  else if (args[i] === '--out') out = args[++i];
  else if (args[i] === '--size') [w, h] = args[++i].split('x').map(Number);
  else if (args[i] === '--url') url = args[++i];
  else if (args[i] === '--bench') bench = Number(args[++i]);
  else { const k = args[i].indexOf('='); shots.push([args[i].slice(0, k), args[i].slice(k + 1)]); }
}
if (!shots.length) shots.push(['lineup', 'scene=lineup']);
const outDir = path.resolve(root, out);
mkdirSync(outDir, { recursive: true });

let server = null;
if (!url) {
  process.env.CAPTURE = '1';
  const { createServer } = await import('vite');
  server = await createServer({ root, configFile: path.join(root, 'vite.config.js'), logLevel: 'error', server: { port, strictPort: true, hmr: false } });
  await server.listen();
  url = `http://localhost:${port}`;
}
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  args: ['--headless=new', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--force_high_performance_gpu'],
});
try {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[page]', m.type(), m.text().slice(0, 400)); });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  for (const [name, query] of shots) {
    await page.goto(`${url}/dev/riders.html?w=${w}&h=${h}&${query}`, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction(() => window.__ready instanceof Promise, null, { timeout: 60000 });
    await page.evaluate(() => window.__ready);
    await page.waitForTimeout(150);
    const file = path.join(outDir, `${name}.png`);
    await page.screenshot({ path: file });
    const info = await page.evaluate(() => window.__info);
    console.log(name, file, JSON.stringify(info));
    if (bench > 0) console.log('bench', name, JSON.stringify(await page.evaluate((n) => window.__bench(n), bench)));
  }
} finally {
  await browser.close();
  await server?.close();
}
