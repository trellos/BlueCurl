// Capture stills of dev/spot.html with headless Chrome on the GPU.
// usage: node dev/spot-shot.mjs [--port 5182] [--out captures/wp2] name=query [name=query ...]
//   e.g. node dev/spot-shot.mjs default="view=default&pip=1" top="view=top"
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
let port = 5182, out = 'captures/wp2', w = 1600, h = 900;
const shots = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') port = Number(args[++i]);
  else if (args[i] === '--out') out = args[++i];
  else if (args[i] === '--size') [w, h] = args[++i].split('x').map(Number);
  else { const k = args[i].indexOf('='); shots.push([args[i].slice(0, k), args[i].slice(k + 1)]); }
}
if (!shots.length) shots.push(['default', 'view=default'], ['top', 'view=top']);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  args: ['--headless=new', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: w, height: h } });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[page]', m.type(), m.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
for (const [name, query] of shots) {
  await page.goto(`http://localhost:${port}/dev/spot.html?${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready, null, { timeout: 60000 });
  await page.evaluate(() => window.__ready);
  await page.waitForTimeout(300);
  const info = await page.evaluate(() => ({ info: window.__info, parity: window.__parity }));
  const file = resolve(out, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(name, file, JSON.stringify(info));
}
await browser.close();
