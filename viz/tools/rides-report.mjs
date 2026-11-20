#!/usr/bin/env node
// BlueCurl Swell — ride report (WP6a). Runs Swell + Riders headlessly over an input log and prints one row per ride.
//   node tools/rides-report.mjs demo/demo-basic.json [--until <s>] [--breaks] [--all]
// --breaks also lists every committed ZoneBreak and who took it. A Beat is stepped too (the rider count follows its
// level, as in the app); --all runs without a beat (every rider in the water). Presence / flock events are printed.
import fs from 'node:fs';
import path from 'node:path';
import { DT, DEFAULT_CFG } from '../src/contracts.js';
import { InputBus, applyCfgEvent } from '../src/input/input.js';
import { Swell } from '../src/sim/swell.js';
import { Riders } from '../src/riders/Riders.js';
import { Beat } from '../src/beat/beat.js';

/**
 * Simulate a demo ({cfg, log, duration}) headlessly; onStep(t, swell, riders, beat) per fixed step.
 * beat: true (default) = a real Beat stepped like the app (rider presence follows its level); null/false = no beat
 * (every rider in the water, the milestone-1 behaviour); (cfg) => object = a custom/fake beat with step(t, dt, evs).
 */
export function simulate(demo, { until = null, onStep = null, beat = true } = {}) {
  const cfg = structuredClone(DEFAULT_CFG);
  let simT = 0;
  const input = new InputBus(() => simT);
  input.load(demo);
  const swell = new Swell(cfg), riders = new Riders(cfg);
  const bt = beat === true ? new Beat(cfg) : typeof beat === 'function' ? beat(cfg) : null;
  const breaks = [];
  const end = until ?? (demo.duration ?? 60);
  const steps = Math.round(end / DT);
  for (let k = 1; k <= steps; k++) {
    const t = k * DT, evs = input.drainUntil(t);
    for (const e of evs) applyCfgEvent(cfg, e);
    swell.step(t, DT, evs);
    bt?.step?.(t, DT, evs);
    for (const f of swell.fronts) for (const zb of f.breaks) {
      if (!breaks.some((b) => b.frontId === f.id && b.zi === zb.zi)) breaks.push({ frontId: f.id, set: f.set, k: f.k, zi: zb.zi, zb });
    }
    riders.step(t, DT, swell, bt);
    simT = t;
    onStep?.(t, swell, riders, bt);
  }
  return { cfg, swell, riders, breaks, beat: bt };
}

const pad = (v, n) => String(v).padEnd(n);
const PRESENCE = new Set(['enter', 'arrive', 'leave', 'gone', 'flock']);
const num = (v, d = 1) => (v == null || !Number.isFinite(v) ? '-' : v.toFixed(d));

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'))) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--')) ?? 'demo/demo-basic.json';
  const ui = args.indexOf('--until');
  const demo = JSON.parse(fs.readFileSync(file, 'utf8'));
  const presence = [];
  const seen = new Set();
  const { riders, breaks } = simulate(demo, {
    until: ui >= 0 ? Number(args[ui + 1]) : null, beat: !args.includes('--all'),
    onStep(t, swell, rs, beat) {                     // the event ring is trimmed: collect presence events as they come
      for (const e of rs.events) {
        if (seen.has(e)) continue;
        seen.add(e);
        if (PRESENCE.has(e.type)) presence.push({ ...e, level: beat?.level, measure: beat?.measure });
      }
    },
  });
  console.log(`${demo.name ?? file}: ${riders.rides.length} rides, ${breaks.length} zone breaks`);
  console.log([pad('rider', 7), pad('front', 6), pad('set', 4), pad('zone', 7), pad('style', 9), pad('takeoff', 8),
    pad('stand', 7), pad('end', 7), pad('outcome', 9), pad('maxH', 5), pad('barrel', 7), 'why'].join(''));
  for (const r of riders.rides) {
    console.log([pad(r.name, 7), pad(r.frontId, 6), pad(r.set, 4), pad(r.zone, 7), pad(r.style, 9), pad(num(r.tTakeoff, 2), 8),
      pad(num(r.tStand, 2), 7), pad(num(r.tEnd, 2), 7), pad(r.outcome, 9), pad(num(r.maxH), 5), pad(num(r.barrelS, 2), 7), r.why ?? ''].join(''));
  }
  if (presence.length) {
    console.log('\npresence (t, measure, level, event, rider, pos):');
    for (const e of presence) {
      console.log(`  ${pad(num(e.t, 3), 8)} m${pad(e.measure ?? '-', 4)} L${pad(e.level ?? '-', 3)} ${pad(e.type, 7)} ${pad(riders.riders[e.riderId].name, 7)}` +
        ` (${num(e.pos?.x)}, ${num(e.pos?.z)})${e.type === 'flock' ? '  <-- birds' : ''}`);
    }
  }
  console.log(`in the water at the end: ${riders.riders.filter((r) => r.present).map((r) => r.name).join(', ')}`);
  const busy = riders.riders.filter((r) => !['LINEUP', 'RETURN', 'ASHORE'].includes(r.state));
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
