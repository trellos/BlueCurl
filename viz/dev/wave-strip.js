// BlueCurl Swell — profile strip (WP4a visual check). node dev/wave-strip.js [out.png]
// Draws the swept-profile cross-section across tau for three shapes (wall, barrel, mush) plus extents rows,
// as SVG, rendered to PNG with headless Chrome. Also exported for test/wave-parity.mjs.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { profile, profileExtents } from '../src/wave/profile.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const STRIP_TAUS = [-1, -0.5, 0, 0.18, 0.33, 0.42, 0.48, 0.55, 0.62, 0.7, 0.78, 0.9, 1.0, 1.5];
export const STRIP_ROWS = [
  { name: 'wall  steep 1 · curl 0 · mush 0', H: 3, shape: { steep: 1, curl: 0, mush: 0 }, view: [-10, 10, -1.6, 4] },
  { name: 'barrel  steep 0.8 · curl 1 · mush 0', H: 3, shape: { steep: 0.8, curl: 1, mush: 0 }, view: [-10, 10, -1.6, 4] },
  { name: 'mid  steep 0.6 · curl 0.5 · mush 0.25', H: 3, shape: { steep: 0.6, curl: 0.5, mush: 0.25 }, view: [-10, 10, -1.6, 4] },
  { name: 'mush  steep 0.3 · curl 0.3 · mush 1', H: 3, shape: { steep: 0.3, curl: 0.3, mush: 1 }, view: [-10, 10, -1.6, 4] },
  { name: 'barrel H 1, full extent, vertical ×4', H: 1, shape: { steep: 0.8, curl: 1, mush: 0 }, view: [-24, 17, -1, 2.2], full: true, vex: 4 },
  { name: 'barrel H 6, full extent, vertical ×2', H: 6, shape: { steep: 0.8, curl: 1, mush: 0 }, view: [-46, 36, -3, 8], full: true, vex: 2 },
];

export function stripSVG({ taus = STRIP_TAUS, rows = STRIP_ROWS, PW = 150 } = {}) {
  const LAB = 18, cols = taus.length;
  const rowH = (row) => (row.view[3] - row.view[2]) * (row.vex || 1) * ((PW - 8) / (row.view[1] - row.view[0])) + 8;
  const W = PW * cols, Hh = Math.ceil(rows.reduce((a, r) => a + rowH(r) + LAB, 20));
  let oy = 20;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${Hh}" viewBox="0 0 ${W} ${Hh}" font-family="Consolas,monospace" font-size="11">`;
  s += `<rect width="${W}" height="${Hh}" fill="#0f1720"/>`;
  taus.forEach((tau, c) => { s += `<text x="${c * PW + 6}" y="13" fill="#9fb4c8">τ ${tau}</text>`; });
  rows.forEach((row, r) => {
    if (r > 0) oy += rowH(rows[r - 1]) + LAB;
    s += `<text x="6" y="${oy + 12}" fill="#e8d28a">${row.name}</text>`;
    const [x0, x1, y0, y1] = row.view;
    const sc = (PW - 8) / (x1 - x0), vs = sc * (row.vex || 1);
    taus.forEach((tau, c) => {
      const ox = c * PW + 4, base = oy + LAB;
      // xi > 0 shoreward drawn to the RIGHT (wave travels right in the strip)
      const X = (xi) => (ox + (xi - x0) * sc).toFixed(2), Y = (y) => (base + (y1 - y) * vs).toFixed(2);
      const cid = `c${r}_${c}`;
      s += `<clipPath id="${cid}"><rect x="${ox}" y="${base}" width="${(x1 - x0) * sc}" height="${(y1 - y0) * vs}"/></clipPath>`;
      s += `<rect x="${ox}" y="${base}" width="${(x1 - x0) * sc}" height="${(y1 - y0) * vs}" fill="#132433" stroke="#203546"/><g clip-path="url(#${cid})">`;
      s += `<line x1="${X(x0)}" y1="${Y(0)}" x2="${X(x1)}" y2="${Y(0)}" stroke="#2c4a60" stroke-dasharray="2,2"/>`;
      const n = 400, pts = [];
      for (let i = 0; i <= n; i++) { const p = profile(tau, i / n, row.H, row.shape); pts.push([p.xi, p.y]); }
      const poly = pts.map((p) => `${X(p[0])},${Y(p[1])}`).join(' ');
      const e = profileExtents(row.H);
      s += `<polygon points="${poly} ${X(e.front)},${Y(y0)} ${X(e.back)},${Y(y0)}" fill="#1f8c8a" fill-opacity="0.85" fill-rule="nonzero"/>`;
      s += `<polyline points="${poly}" fill="none" stroke="#bff3ea" stroke-width="1"/>`;
      // 64 uniform-sigma mesh rows as dots (shows the lip refinement)
      for (let j = 0; j < 64; j++) {
        const p = profile(tau, j / 63, row.H, row.shape);
        s += `<circle cx="${X(p.xi)}" cy="${Y(p.y)}" r="0.9" fill="#ffcf5a"/>`;
      }
      s += '</g>';
    });
  });
  return s + '</svg>';
}

export async function renderStrip(outPng, chromium, opts) {
  mkdirSync(dirname(outPng), { recursive: true });
  const svg = stripSVG(opts);
  writeFileSync(outPng.replace(/\.png$/, '.svg'), svg);
  const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', args: ['--headless=new'] });
  const page = await browser.newPage();
  const m = svg.match(/width="(\d+)" height="(\d+)"/);
  await page.setViewportSize({ width: +m[1], height: +m[2] });
  await page.setContent(`<html><body style="margin:0">${svg}</body></html>`);
  await page.screenshot({ path: outPng });
  await browser.close();
  return outPng;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { chromium } = await import('playwright-core');
  const out = resolve(process.argv[2] || resolve(HERE, '../test/out/profile-strip.png'));
  const opt = {}; for (const a of process.argv.slice(3)) { const [k, v] = a.replace(/^--/, '').split('=');
    if (k === 'rows') opt.rows = v.split(',').map((i) => STRIP_ROWS[+i]);
    if (k === 'taus') opt.taus = v.split(',').map(Number);
    if (k === 'pw') opt.PW = +v; }
  console.log(await renderStrip(out, chromium, opt));
}
