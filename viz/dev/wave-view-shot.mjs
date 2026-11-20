// Stills of dev/wave.html on the real GPU (headless Chrome, ANGLE D3D11, high-performance GPU).
// usage: node dev/wave-view-shot.mjs [--port 5190] [--out captures/wp4b] [--size 1920x1080] [--bench 60]
//          name="case=barrel&tau=0.5&view=channel" [name2=query ...]
// Starts its own Vite server (CAPTURE=1) on --port. Writes <out>/<name>.png and prints __info (+ GPU ms with --bench).
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let port = 5190, out = 'captures/wp4b', w = 1920, h = 1080, bench = 0;
const shots = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') port = Number(args[++i]);
  else if (args[i] === '--out') out = args[++i];
  else if (args[i] === '--size') [w, h] = args[++i].split('x').map(Number);
  else if (args[i] === '--bench') bench = Number(args[++i]);
  else { const k = args[i].indexOf('='); shots.push([args[i].slice(0, k), args[i].slice(k + 1)]); }
}
const outDir = path.resolve(root, out);
fs.mkdirSync(outDir, { recursive: true });

process.env.CAPTURE = '1';
const { createServer } = await import('vite');
const server = await createServer({ root, configFile: path.join(root, 'vite.config.js'), logLevel: 'error', server: { port, strictPort: true, hmr: false } });
await server.listen();
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  args: ['--headless=new', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--force_high_performance_gpu',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
try {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const logs = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text().slice(0, 3000)}`); });
  page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message));
  for (const [name, query] of shots) {
    logs.length = 0;
    await page.goto(`http://localhost:${port}/dev/wave.html?w=${w}&h=${h}&info=0&${query}`, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction(() => window.__ready instanceof Promise, null, { timeout: 60000 });
    try { await page.evaluate(() => window.__ready); } catch (e) { console.log(logs.join('\n')); throw e; }
    const info = await page.evaluate(() => window.__info);
    const data = await page.evaluate(() => window.__grab());
    const file = path.join(outDir, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(data.split(',')[1], 'base64'));
    let b = null;
    if (bench > 0) b = await page.evaluate((n) => window.__bench(n), bench);
    console.log(name, file, JSON.stringify(info), b ? 'bench ' + JSON.stringify(b) : '');
    if (logs.length) console.log(logs.slice(0, 10).join('\n'));
  }
} finally {
  await browser.close();
  await server.close();
}
