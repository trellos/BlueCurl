// Headless screenshots of the lab (Playwright + pre-installed Chromium).
// Usage: node tools/shot.mjs <out.png> "<query string>" [width height] [--eval "js"]
// The dev server must be running (npm run dev). Query example: "preset=B&cam=chase&seek=6&paused&capture"
import { createRequire } from 'node:module';
// Playwright is pre-installed globally in the dev container (resolved through NODE_PATH).
const { chromium } = createRequire(import.meta.url)('playwright');

const argv = process.argv.slice(2);
const evalIdx = argv.indexOf('--eval');
const extra = evalIdx >= 0 ? argv.splice(evalIdx, 2)[1] : null;
const [out = 'out/shot.png', query = 'seek=4&paused&capture', w = '1280', h = '720'] = argv;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(`http://127.0.0.1:5199/?${query}`);
try {
  await page.waitForFunction(() => window.__lab?.ready === true, null, { timeout: 60000 });
} catch (e) {
  console.log(logs.join('\n'));
  throw e;
}
if (extra) console.log('eval:', JSON.stringify(await page.evaluate(extra)));
await page.waitForTimeout(300);
const url = await page.evaluate(() => window.__lab.screenshot(1));
const fs = await import('node:fs');
const path = await import('node:path');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.from(url.split(',')[1], 'base64'));
console.log('wrote', out);
for (const l of logs) if (!l.includes('[vite]')) console.log(l);
await browser.close();
