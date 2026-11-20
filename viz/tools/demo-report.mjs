#!/usr/bin/env node
// Headless swell simulation of a demo/input log; prints one compact table per front.
//   node tools/demo-report.mjs demo/demo-basic.json [--until 90]
import { readFileSync } from 'node:fs';
import { DT, DEFAULT_CFG, ZONES } from '../src/contracts.js';
import { InputBus, applyCfgEvent } from '../src/input/input.js';
import { Swell } from '../src/sim/swell.js';

/** Run cfg + log headlessly; returns every front ever seen (by id) and the swell. */
export function simulate(demo, { until = null, onStep = null } = {}) {
  const cfg = structuredClone(DEFAULT_CFG);
  let simT = 0;
  const input = new InputBus(() => simT);
  input.load(demo);
  const swell = new Swell(cfg);
  const lastT = input.log.length ? input.log[input.log.length - 1].t : 0;
  const end = until ?? demo.duration ?? lastT + 40;
  const seen = new Map();
  const steps = Math.round(end / DT);
  for (let k = 1; k <= steps; k++) {
    const t = k * DT;
    const evs = input.drainUntil(t);
    for (const ev of evs) applyCfgEvent(cfg, ev);
    swell.step(t, DT, evs);
    simT = t;
    for (const f of swell.fronts) if (!seen.has(f.id)) seen.set(f.id, f);
    onStep?.(t, swell);
  }
  return { fronts: [...seen.values()], swell, cfg };
}

const f2 = (v, d = 2) => (v == null ? '-' : Number(v).toFixed(d));
const pad = (s, n) => String(s).padStart(n);

export function report(fronts) {
  const lines = [];
  lines.push(' id set.k  tPoint  energy | zone    tBreak     H steep  curl  mush dir vPeel peelLen  CO sec barrel');
  for (const f of fronts) {
    const head = `${pad(f.id, 3)} ${pad(`${f.set}.${f.k}`, 5)} ${pad(f2(f.tPoint), 7)} ${pad(f2(f.charge), 7)}`;
    if (!f.breaks.length) { lines.push(`${head} | (no break)`); continue; }
    f.breaks.forEach((b, i) => {
      lines.push(`${i ? ' '.repeat(head.length) : head} | ${b.zone.padEnd(6)} ${pad(f2(b.tBreak), 7)} ${pad(f2(b.H), 5)} ${pad(f2(b.steep), 5)} ${pad(f2(b.curl), 5)} ${pad(f2(b.mush), 5)} ${pad(b.dir, 3)} ${pad(f2(b.vPeel, 1), 5)} ${pad(f2(b.peelLen, 0), 7)} ${pad(b.closeout ? 'Y' : '-', 3)} ${pad(b.sections, 3)} ${pad(f2(b.quality.barrelTime), 6)}`);
    });
  }
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('demo-report.mjs')) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) { console.error('usage: node tools/demo-report.mjs <demo.json> [--until s]'); process.exit(1); }
  const ui = args.indexOf('--until');
  const demo = JSON.parse(readFileSync(file, 'utf8'));
  const { fronts } = simulate(demo, { until: ui >= 0 ? +args[ui + 1] : null });
  console.log(`${file}: ${fronts.length} fronts, zones ${ZONES.map((z) => z.key).join('/')}`);
  console.log(report(fronts));
}
