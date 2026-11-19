// Deterministic offline video capture: steps the simulation at exactly 1/fps per frame (no real
// time), renders each frame and saves PNGs plus per-frame metadata. Encode with tools/encode_video.py.
// Usage: node tools/video.mjs <outDir> "<query>" <seconds> [fps=30] [w=1280] [h=720] [--events events.json]
// events.json: [[timeSeconds, "js expression run in the page"], ...]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const { chromium } = createRequire(import.meta.url)('playwright');
const argv = process.argv.slice(2);
const ei = argv.indexOf('--events');
const events = ei >= 0 ? JSON.parse(fs.readFileSync(argv.splice(ei, 2)[1], 'utf8')) : [];
const [outDir, query, seconds, fps = '30', w = '1280', h = '720'] = argv;
fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:5199/?${query}&paused&capture`);
await page.waitForFunction(() => window.__lab?.ready === true, null, { timeout: 60000 });
const N = Math.round(+seconds * +fps);
const sub = Math.round(60 / +fps); // lab frames (1/60 s) per video frame
const meta = [];
const pending = [...events].sort((a, b) => a[0] - b[0]);
const t0 = Date.now();
for (let f = 0; f < N; f++) {
  const t = await page.evaluate(() => window.__lab.clock.time);
  while (pending.length && pending[0][0] <= t + 1e-9) await page.evaluate(pending.shift()[1]);
  const r = await page.evaluate((sub) => {
    const L = window.__lab;
    L.advanceFrames(sub, false);
    const rd = L.rider.rider;
    return { url: L.screenshot(1), t: L.clock.time, phase: rd.fallen > 0 ? 'wipeout' : rd.phase, man: L.motion.state.maneuver, v: L.motion.state.speed, stab: rd.stability };
  }, sub);
  fs.writeFileSync(path.join(outDir, `f${String(f).padStart(5, '0')}.png`), Buffer.from(r.url.split(',')[1], 'base64'));
  delete r.url;
  meta.push(r);
  if (f % 30 === 0) console.log(`frame ${f}/${N} t=${r.t.toFixed(2)} ${r.phase} ${r.man} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}
fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta));
await browser.close();
console.log('done', N, 'frames');
