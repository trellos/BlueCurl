#!/usr/bin/env node
// BlueCurl Swell — ride report (WP6a). Runs Swell + Riders headlessly over an input log and prints one row per ride.
//   node tools/rides-report.mjs demo/demo-basic.json [--until <s>] [--breaks]
// --breaks also lists every committed ZoneBreak and who took it.
import fs from 'node:fs';
import path from 'node:path';
import { DT, DEFAULT_CFG } from '../src/contracts.js';
import { InputBus, applyCfgEvent } from '../src/input/input.js';
import { Swell } from '../src/sim/swell.js';
import { Riders } from '../src/riders/Riders.js';

/** Simulate a demo ({cfg, log, duration}) headlessly; onStep(t, swell, riders) per fixed step. */
export function simulate(demo, { until = null, onStep = null } = {}) {
  const cfg = structuredClone(DEFAULT_CFG);
  let simT = 0;
  const input = new InputBus(() => simT);
  input.load(demo);
  const swell = new Swell(cfg), riders = new Riders(cfg);
  const breaks = [];
  const end = until ?? (demo.duration ?? 60);
  const steps = Math.round(end / DT);
  for (let k = 1; k <= steps; k++) {
    const t = k * DT, evs = input.drainUntil(t);
    for (const e of evs) applyCfgEvent(cfg, e);
    swell.step(t, DT, evs);
    for (const f of swell.fronts) for (const zb of f.breaks) {
      if (!breaks.some((b) => b.frontId === f.id && b.zi === zb.zi)) breaks.push({ frontId: f.id, set: f.set, k: f.k, zi: zb.zi, zb });
    }
    riders.step(t, DT, swell);
    simT = t;
    onStep?.(t, swell, riders);
  }
  return { cfg, swell, riders, breaks };
}

const pad = (v, n) => String(v).padEnd(n);
const num = (v, d = 1) => (v == null || !Number.isFinite(v) ? '-' : v.toFixed(d));

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'))) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--')) ?? 'demo/demo-basic.json';
  const ui = args.indexOf('--until');
  const demo = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { riders, breaks } = simulate(demo, { until: ui >= 0 ? Number(args[ui + 1]) : null });
  console.log(`${demo.name ?? file}: ${riders.rides.length} rides, ${breaks.length} zone breaks`);
  console.log([pad('rider', 7), pad('front', 6), pad('set', 4), pad('zone', 7), pad('style', 9), pad('takeoff', 8),
    pad('end', 7), pad('outcome', 9), pad('maxH', 5), 'barrel'].join(''));
  for (const r of riders.rides) {
    console.log([pad(r.name, 7), pad(r.frontId, 6), pad(r.set, 4), pad(r.zone, 7), pad(r.style, 9), pad(num(r.tTakeoff, 2), 8),
      pad(num(r.tEnd, 2), 7), pad(r.outcome, 9), pad(num(r.maxH), 5), num(r.barrelS, 2)].join(''));
  }
  const busy = riders.riders.filter((r) => r.state !== 'LINEUP' && r.state !== 'RETURN');
  if (busy.length) console.log(`still riding at the end: ${busy.map((r) => `${r.name}:${r.state}`).join(', ')}`);
  if (args.includes('--breaks')) {
    console.log('\nzone breaks:');
    for (const b of breaks) {
      const who = riders.rides.filter((r) => r.frontId === b.frontId && r.zi === b.zi).map((r) => r.name).join('+') || '—';
      const zb = b.zb;
      console.log(`  front ${b.frontId} set ${b.set} ${pad(zb.zone, 7)} tBreak ${num(zb.tBreak, 2)} H ${num(zb.H, 2)} steep ${num(zb.steep, 2)} ` +
        `curl ${num(zb.curl, 2)} dir ${zb.dir} peel ${num(zb.peelLen, 0)}${zb.closeout ? ' CLOSEOUT' : ''}  → ${who}`);
    }
  }
}
