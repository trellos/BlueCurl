#!/usr/bin/env node
// Regenerates demo/demo-basic.json and demo/demo-intervals.json (deterministic), then prints their demo reports.
//   node tools/gen-demos.mjs
// Note timing: at the default 16 s interval, set n's first front (tPoint 16n) takes input from 16n − 19.5 s
// (pre-charge at the horizon until it spawns at 16n − 14) to its outer-reef commit at 16n − 8.5 s; the second
// front takes 16n − 8.5 … 16n − 6, the third 16n − 6 … 16n − 3.5.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { InputBus } from '../src/input/input.js';
import { hash01 } from '../src/contracts.js';
import { simulate, report } from './demo-report.mjs';

const DEMO = (name) => fileURLToPath(new URL(`../demo/${name}.json`, import.meta.url));
const r2 = (v) => Math.round(v * 1000) / 1000;
const out = (bus, cfg, duration, notes) => ({ version: 1, name: '', notes, duration, cfg, log: bus.log.map(e => { const o = { ...e }; o.t = r2(o.t); delete o.u; if (o.duration != null) o.duration = r2(o.duration); return o; }) });
const pretty = (demo) => JSON.stringify(demo, null, 1).replace(/\n\s+(?=[^\s{\[])/g, ' ').replace(/\n\s+\}/g, ' }');
const note = (bus, t, lane, velocity = 1, dur = 0.2) => bus.impulse({ lane, velocity, time: t, duration: dur });

// ---------------- demo-basic
{
  const b = new InputBus();
  // set 1 (A tPoint 16, input 0–7.5 s): a few soft notes → small soft wave
  for (const [t, l] of [[2, 3], [3, 4], [4, 3], [5, 4], [6, 3]]) note(b, t, l, 0.4, 0.4);
  note(b, 8.5, 3, 0.4, 0.4); note(b, 9.5, 4, 0.4, 0.4);                         // set 1 B: soft echo
  // set 2 (A tPoint 32, input 12.5–23.5): many strong concentrated → hollow barrel
  for (const t of [14, 15, 16, 17]) note(b, t, 3);
  for (let i = 0; i < 22; i++) note(b, 18 + i * 0.25, i % 4 === 3 ? 4 : 3, 1, 0.12);
  for (let i = 0; i < 6; i++) note(b, 23.75 + i * 0.35, 3 + (i % 3 === 2 ? 1 : 0), 0.6); // B: smaller echo
  // set 3 (A tPoint 48, input 28.5–39.5): strong, spread → wall
  for (const [t, l] of [[30, 2], [31, 5], [32, 3], [33, 4]]) note(b, t, l);
  for (let i = 0; i < 20; i++) note(b, 34 + i * 0.27, [2, 4, 3, 5, 1, 6][i % 6], 1, 0.15);
  for (let i = 0; i < 6; i++) note(b, 39.75 + i * 0.35, [2, 5, 3, 4][i % 4]);  // B
  // set 4 (A tPoint 64, input 44.5–55.5): weighted to the south (left) → peak left, peels right
  for (const [t, l] of [[46, 2], [47, 1], [48, 2], [49, 3]]) note(b, t, l, 0.85);
  for (let i = 0; i < 16; i++) note(b, 50 + i * 0.33, [2, 1, 3, 2, 0, 2, 1, 3][i % 8], 0.85, 0.15);
  for (let i = 0; i < 5; i++) note(b, 55.75 + i * 0.4, [2, 1][i % 2], 0.6);    // B: softer echo
  // set 5 (A tPoint 80, input 60.5–71.5): erratic → mush / close-out
  let t = 64;
  for (let i = 0; i < 22; i++) {
    t += 0.08 + 0.75 * hash01(i, 5);
    if (t > 71.2) break;
    note(b, t, 2 + Math.floor(4 * hash01(i, 6)), r2(0.25 + 0.75 * hash01(i, 7)), 0.1 + 0.3 * hash01(i, 8));
  }
  const demo = out(b, {}, 92, 'Five sets at the default 16 s interval: soft → hollow barrel → wall → south peak peeling right → erratic close-out. Point breaks at 16/32/48/64/80 s.');
  demo.name = 'demo-basic';
  writeFileSync(DEMO('demo-basic'), pretty(demo));
}
// ---------------- demo-intervals
{
  const b = new InputBus();
  // bars 2 (4 s) to start; switch to 8 at 22.5 s, to 16 at 38 s; steady notes throughout
  b.setConfig('bars', 8, 22.5);
  b.setConfig('bars', 16, 38);
  for (let i = 0; i < 120; i++) { const t = 0.5 + i * 0.5; if (t > 56) break; note(b, t, [3, 4, 3, 2, 3, 5][i % 6], i % 4 === 0 ? 1 : 0.7, 0.2); }
  const demo = out(b, { bars: 2 }, 80, 'Interval switches while playing: bars 2 (4 s grid: points 16–36 s) → 8 at 22.5 s (16 s grid: 48 s) → 16 at 38 s (32 s grid: 64 s). Steady notes on the beat.');
  demo.name = 'demo-intervals';
  writeFileSync(DEMO('demo-intervals'), pretty(demo));
}

for (const name of ['demo-basic', 'demo-intervals']) {
  const demo = JSON.parse(readFileSync(DEMO(name), 'utf8'));
  console.log(`${name}:`);
  console.log(report(simulate(demo).fronts));
}
