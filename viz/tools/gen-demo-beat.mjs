#!/usr/bin/env node
// Regenerates demo/demo-beat.json (deterministic): drives the beat through all 8 levels and back down.
//   node tools/gen-demo-beat.mjs
// 120 bpm → 2 s measures. Level moves one step per downbeat toward clamp(notes in the last measure, 1, 8).
//   measures 0–11  eighth notes (8 per measure, scale runs up and down) → level 1→8 by the downbeat at 14 s
//                  (riders entering at the 2/4/6 s downbeats arrive at 10/12/14 s while the level is still rising
//                   → bird flocks; later arrivals land on unchanged downbeats → no flock)
//   measures 12–17 quarter notes (4) → level 8→4
//   measures 18–25 silence → level 4→1 (riders leave last-in-first-out)
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { InputBus } from '../src/input/input.js';
import { Beat } from '../src/beat/beat.js';
import { DEFAULT_CFG, DT } from '../src/contracts.js';

const r3 = (v) => Math.round(v * 1000) / 1000;
const b = new InputBus();
const note = (t, lane, velocity = 0.9, dur = 0.18) => b.impulse({ lane, velocity, time: t, duration: dur });
const run = [1, 2, 3, 4, 5, 6, 7, 8, 7, 6, 5, 4, 3, 2];
let k = 0;
for (let m = 0; m < 12; m++) for (let i = 0; i < 8; i++) note(m * 2 + i * 0.25, run[k++ % run.length]);
for (let m = 12; m < 18; m++) for (let i = 0; i < 4; i++) note(m * 2 + i * 0.5, [3, 5, 4, 6][i], 0.8, 0.3);
const duration = 56;
const demo = {
  version: 1, name: 'demo-beat', duration, cfg: {},
  notes: 'Beat ramp: eighth notes for 12 measures (level 1→8, riders join, flocks on the 10/12/14 s arrivals), quarter notes for 6 (8→4), then silence (→1, riders leave).',
  log: b.log.map((e) => { const o = { ...e }; o.t = r3(o.t); delete o.u; if (o.duration != null) o.duration = r3(o.duration); return o; }),
};
const pretty = JSON.stringify(demo, null, 1).replace(/\n\s+(?=[^\s{\[])/g, ' ').replace(/\n\s+\}/g, ' }');
writeFileSync(fileURLToPath(new URL('../demo/demo-beat.json', import.meta.url)), pretty + '\n');

// report: level per measure
const cfg = structuredClone(DEFAULT_CFG), beat = new Beat(cfg), bus = new InputBus();
bus.load(demo.log);
const levels = [];
for (let i = 1; i * DT <= duration + 1e-9; i++) {
  const t = i * DT, ev = bus.drainUntil(t);
  const before = beat.measure;
  beat.step(t, DT, ev);
  if (beat.measure !== before) levels.push(`${beat.measure}:${beat.level}`);
}
console.log('demo-beat.json', demo.log.length, 'events; measure:level', levels.join(' '));
