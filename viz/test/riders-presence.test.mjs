// WP12a — rider presence: the number of riders in the water follows the beat level (contracts "riders" / "beat").
// Swell + Beat + Riders run headlessly (tools/rides-report.mjs simulate) over demo/demo-beat.json and generated logs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DT, ENTRY_ORDER, RIDERS } from '../src/contracts.js';
import { InputBus } from '../src/input/input.js';
import { depthAt } from '../src/spot/bathymetry.js';
import { simulate } from '../tools/rides-report.mjs';
import { TRAVEL_V } from '../src/riders/Riders.js';

const demoBeat = JSON.parse(fs.readFileSync(new URL('../demo/demo-beat.json', import.meta.url), 'utf8'));
const NAME = Object.fromEntries(RIDERS.map((R) => [R.id, R.name]));
const RIDING = new Set(['TAKEOFF', 'RIDE', 'KICKOUT', 'CLOSEOUT']);
const NEXT = {
  ASHORE: ['ENTER'], ENTER: ['LINEUP', 'LEAVE'], LEAVE: ['ASHORE', 'ENTER'],
  LINEUP: ['POSITION', 'RETURN', 'LEAVE'], POSITION: ['TAKEOFF', 'RETURN', 'LEAVE'], TAKEOFF: ['RIDE', 'CLOSEOUT', 'KICKOUT'],
  RIDE: ['KICKOUT', 'CLOSEOUT'], KICKOUT: ['RETURN', 'LEAVE'], CLOSEOUT: ['RETURN', 'LEAVE'], RETURN: ['LINEUP', 'POSITION', 'LEAVE'],
};

/** Input log with `counts[m]` soft notes in measure m (measure starts given, default 2 s measures at 120 bpm). */
function noteLog(counts, starts = counts.map((_, m) => 2 * m), extra = (bus) => {}) {
  const bus = new InputBus();
  counts.forEach((n, m) => {
    for (let i = 0; i < n; i++) bus.impulse({ lane: 1 + ((m + i) % 8), velocity: 0.4, time: starts[m] + 0.1 + 0.2 * i, duration: 0.1 });
  });
  extra(bus);
  return { name: 'gen', log: bus.log };
}

/** Run with a real Beat; collect events, downbeats, per-step checks. */
function run(demo, until) {
  const out = { events: [], downs: [], bad: [], nan: 0, inWrong: [], trace: [], maxStep: 0, wantedAt: new Map(), legs: [], vmax: {}, open: new Map(),
    stateAt: [], takeoffBad: [], seen: new Set(), seenDown: new Set() };
  const prev = new Map(), prevPos = new Map();
  const res = simulate(demo, {
    until,
    onStep(t, swell, riders, beat) {
      for (const d of beat.events) if (!out.seenDown.has(d)) { out.seenDown.add(d); out.downs.push({ ...d, step: t }); }
      const want = new Set(ENTRY_ORDER.slice(0, beat.level));
      for (const e of riders.events) {
        if (out.seen.has(e)) continue;
        out.seen.add(e); out.events.push({ ...e, measure: beat.measure, level: beat.level });
        if (e.type === 'takeoff' && !want.has(e.riderId)) out.takeoffBad.push(`${t} ${NAME[e.riderId]}`);
      }
      const inWater = riders.riders.filter((r) => r.present && r.state !== 'LEAVE' && !riders._b[r.id].leaving).map((r) => r.id);
      if (inWater.length !== want.size || inWater.some((id) => !want.has(id))) out.inWrong.push(`${t.toFixed(3)} L${beat.level} ${inWater.map((i) => NAME[i])}`);
      for (const r of riders.riders) {
        const ps = prev.get(r.id);
        if (ps && ps !== r.state && !NEXT[ps].includes(r.state)) out.bad.push(`${t.toFixed(3)} ${r.name} ${ps}->${r.state}`);
        prev.set(r.id, r.state);
        if (r.present !== (r.state !== 'ASHORE')) out.bad.push(`${t.toFixed(3)} ${r.name} present=${r.present} in ${r.state}`);
        for (const v of [r.pos.x, r.pos.y, r.pos.z, r.fwd.x, r.up.y, r.speed]) if (!Number.isFinite(v)) out.nan++;
        const pp = prevPos.get(r.id);
        if (pp && (r.state === 'ENTER' || r.state === 'LEAVE') && pp.state === r.state) {
          const d = Math.hypot(r.pos.x - pp.x, r.pos.z - pp.z);
          out.maxStep = Math.max(out.maxStep, d);
          out.vmax[r.kind] = Math.max(out.vmax[r.kind] ?? 0, d / DT);
          out.open.get(r.id).len += d;
        }
        // ENTER / LEAVE legs: path length and duration
        if ((r.state === 'ENTER' || r.state === 'LEAVE') && (!pp || pp.state !== r.state)) out.open.set(r.id, { kind: r.kind, name: r.name, state: r.state, t0: t, len: 0 });
        else if (pp && (pp.state === 'ENTER' || pp.state === 'LEAVE') && pp.state !== r.state) {
          const L = out.open.get(r.id); out.legs.push({ ...L, dur: t - L.t0, to: r.state }); out.open.delete(r.id);
        }
        prevPos.set(r.id, { x: r.pos.x, z: r.pos.z, state: r.state });
      }
      if (Math.abs(t / 0.5 - Math.round(t / 0.5)) < 1e-6) {
        out.trace.push(riders.riders.map((r) => `${r.state}:${r.action}:${r.pos.x.toFixed(4)},${r.pos.y.toFixed(4)},${r.pos.z.toFixed(4)}`).join('|'));
      }
      out.stateAt.push([t, riders.riders.map((r) => r.state)]);
    },
  });
  return { ...res, ...out };
}
const of = (a, type, id = null) => a.events.filter((e) => e.type === type && (id == null || e.riderId === id));
const stateOf = (a, t, id) => a.stateAt.find(([tt]) => Math.abs(tt - t) < DT / 2)?.[1][id];

let B = null;
const beatRun = () => (B ??= run(demoBeat, demoBeat.duration + 8));

test('t = 0: Kai alone; the count in the water follows the beat level at every step (ENTRY_ORDER prefix)', () => {
  const a = beatRun();
  assert.equal(a.stateAt[0][1].filter((s) => s !== 'ASHORE').length, 1);
  assert.equal(a.stateAt[0][1][ENTRY_ORDER[0]], 'LINEUP');
  assert.deepEqual(a.inWrong, []);
  assert.deepEqual(a.bad, []);
  assert.equal(a.nan, 0);
  // demo-beat climbs to 8 and back to 1: everyone came and (except Kai) went
  assert.equal(of(a, 'enter').length, 7);
  assert.equal(of(a, 'gone').length, 7);
  for (const r of a.riders.riders) assert.equal(r.state === 'ASHORE', r.id !== ENTRY_ORDER[0], `${r.name} ${r.state}`);
});

test('joiners in ENTRY_ORDER, leavers last-in-first-out', () => {
  const a = beatRun();
  assert.deepEqual(of(a, 'enter').map((e) => e.riderId), ENTRY_ORDER.slice(1));
  // the order riders were asked to go = reverse entry order (the leave event itself may wait for a ride)
  const asked = [];
  for (let k = 1; k < a.downs.length; k++) {
    const d = a.downs[k];
    if (d.change < 0) asked.push(ENTRY_ORDER[d.level]);
  }
  assert.deepEqual(asked, ENTRY_ORDER.slice(1).reverse());
  assert.deepEqual(of(a, 'leave').map((e) => e.riderId).sort(), asked.slice().sort());
});

test('entry takes exactly entryMeasures (4) measures: arrival on the downbeat, at the lineup', () => {
  const a = beatRun();
  const arr = of(a, 'arrive');
  assert.equal(arr.length, 7);
  for (const e of arr) {
    const en = of(a, 'enter', e.riderId)[0];
    assert.equal(e.measure, en.measure + 4, `${NAME[e.riderId]} measures ${en.measure} → ${e.measure}`);
    assert.ok(Math.abs(e.t - en.t - 4 * 2) < DT / 2, `${NAME[e.riderId]} ${en.t} → ${e.t}`);
    assert.ok(a.downs.some((d) => d.index === e.measure && Math.abs(d.t - e.t) < DT / 2), 'arrival is on a downbeat');
  }
  // smooth swim: no jumps (≤ 0.25 m per step at these distances / 8 s)
  assert.ok(a.maxStep < 0.12, `max step ${a.maxStep}`);
});

test('plausible swim / paddle speeds: start / exit points sit TRAVEL_V × duration away (surfers: shore if near)', () => {
  const a = beatRun();
  assert.ok(a.legs.length >= 14, `legs ${a.legs.length}`);
  for (const L of a.legs) {
    const v = L.len / L.dur, V = TRAVEL_V[L.kind];
    // easing: the path is exactly V·T unless a surfer's nearby shore stretched it (≤ 1.35×)
    assert.ok(v <= 1.36 * V && v >= (L.kind === 'surfer' ? 0.9 : 0.97) * V, `${L.name} ${L.state} ${v.toFixed(2)} m/s (V ${V})`);
  }
  for (const [kind, vm] of Object.entries(a.vmax)) assert.ok(vm <= 1.36 * 1.3 * TRAVEL_V[kind] + 0.05, `${kind} peak ${vm.toFixed(2)} m/s`);
  for (const e of [...of(a, 'enter'), ...of(a, 'gone')]) {
    const R = RIDERS[e.riderId];
    assert.ok(depthAt(e.pos.x, e.pos.z) >= 0.29, `${R.name} ${e.type} on land`);
  }
  // animals come in from / leave toward the open sea (seaward of where they are going / were)
  for (const e of of(a, 'enter')) if (RIDERS[e.riderId].kind !== 'surfer') {
    const ar = of(a, 'arrive', e.riderId)[0];
    assert.ok(e.pos.x > ar.pos.x + 10, `${RIDERS[e.riderId].name} came from x ${e.pos.x.toFixed(1)}`);
  }
});

test('flocks exactly when the level changes on a rider\'s arrival downbeat (demo-beat: 10 / 12 / 14 s)', () => {
  const a = beatRun();
  const fl = of(a, 'flock');
  assert.deepEqual(fl.map((e) => Math.round(e.t * 1000) / 1000), [10, 12, 14]);
  for (const e of of(a, 'arrive')) {
    const d = a.downs.find((x) => x.index === e.measure);
    assert.equal(fl.some((f) => f.riderId === e.riderId), d.change !== 0, `${NAME[e.riderId]} arrival change ${d.change}`);
  }
  for (const f of fl) assert.ok(Number.isFinite(f.pos.x + f.pos.y + f.pos.z));
});

test('a rider asked to leave mid-ride finishes the ride first; riders not in the water never take waves', () => {
  const a = beatRun();
  assert.deepEqual(a.takeoffBad, []);
  let deferred = 0;
  for (let k = 1; k < a.downs.length; k++) {
    const d = a.downs[k];
    if (d.change >= 0) continue;
    const id = ENTRY_ORDER[d.level], st = stateOf(a, d.step, id);
    const lv = of(a, 'leave', id).find((e) => e.t >= d.step - 1e-9);
    if (RIDING.has(st)) {
      deferred++;
      const end = a.events.find((e) => e.type === 'rideEnd' && e.riderId === id && e.t >= d.step - 30);
      assert.ok(lv.t > d.step && end && lv.t >= end.t, `${NAME[id]} left at ${lv.t} (asked ${d.step}, ride end ${end?.t})`);
    } else assert.ok(Math.abs(lv.t - d.step) < DT / 2, `${NAME[id]} (${st}) should leave at once`);
  }
  assert.ok(deferred >= 1, 'demo-beat should contain a rider asked to leave while riding');
});

test('determinism: the same log gives identical rider states and events', () => {
  const a = beatRun(), b = run(demoBeat, demoBeat.duration + 8);
  assert.deepEqual(b.trace, a.trace);
  assert.deepEqual(b.events, a.events);
});

test('a rider still swimming out turns round when the level drops, and is gone after as long as it swam', () => {
  // m0: 2 notes → level 2 at 2 s (Flip enters); m1: silence → level 1 at 4 s (Flip turns round)
  const a = run(noteLog([2, 0, 0, 0, 0]), 10);
  const id = ENTRY_ORDER[1];
  const en = of(a, 'enter', id), lv = of(a, 'leave', id), gone = of(a, 'gone', id);
  assert.equal(en.length, 1); assert.equal(lv.length, 1); assert.equal(gone.length, 1);
  assert.equal(of(a, 'arrive', id).length, 0);
  assert.ok(Math.abs(en[0].t - 2) < DT && Math.abs(lv[0].t - 4) < DT, `${en[0].t} ${lv[0].t}`);
  assert.equal(stateOf(a, 4, id), 'LEAVE');
  assert.ok(Math.abs(gone[0].t - 6) < 2 * DT, `gone at ${gone[0].t}`);
  assert.ok(Math.hypot(gone[0].pos.x - en[0].pos.x, gone[0].pos.z - en[0].pos.z) < 1e-6, 'back where it came from');
  assert.equal(a.riders.riders[id].state, 'ASHORE');
  assert.equal(a.riders.riders[id].exitT, lv[0].t + (lv[0].t - en[0].t));
});

test('flock rule is exact: change on the arrival downbeat (up or down) → flock; one measure early / late → none', () => {
  const flip = ENTRY_ORDER[1], pudge = ENTRY_ORDER[2];
  // Flip enters at m1 (2 s) → arrives at m5 (10 s). Level stays 2 except where noted.
  const on = run(noteLog([2, 2, 2, 2, 3, 3]), 11);          // 3 notes in m4 → level 3 at m5 = arrival
  assert.deepEqual(of(on, 'flock').map((e) => [e.riderId, Math.round(e.t * 1e3) / 1e3]), [[flip, 10]]);
  const early = run(noteLog([2, 2, 2, 3, 3, 3]), 11);       // level 3 at m4 (8 s), unchanged at m5
  assert.equal(of(early, 'arrive', flip).length, 1);
  assert.equal(of(early, 'flock').length, 0);
  const late = run(noteLog([2, 2, 2, 2, 2, 3]), 13);        // level 3 at m6 (12 s), one measure after the arrival
  assert.equal(of(late, 'arrive', flip).length, 1);
  assert.equal(of(late, 'flock').length, 0);
  // down: level 3 by m2 (Pudge enters at 4 s), 1 note in m4 → level 2 at m5: Flip arrives with change −1 → flock,
  // and Pudge (still swimming out) turns round
  const down = run(noteLog([3, 3, 3, 3, 1, 2]), 11);
  assert.deepEqual(of(down, 'flock').map((e) => [e.riderId, Math.round(e.t * 1e3) / 1e3]), [[flip, 10]]);
  assert.equal(of(down, 'leave', pudge).length, 1);
  assert.ok(Math.abs(of(down, 'leave', pudge)[0].t - 10) < DT / 2);
});

test('a bpm change mid-entry: arrival still exactly on the downbeat of enter measure + 4', () => {
  // 120 bpm for m0, m1 (2 s each); bpm 60 logged at 3 s applies from the 4 s downbeat → m2.. are 4 s long.
  // Flip enters at m1 (2 s) → arrives at the m5 downbeat = 4 + 3 · 4 = 16 s (not 10 s).
  const starts = [0, 2, 4, 8, 12, 16];
  const a = run(noteLog([2, 2, 2, 2, 2, 2], starts, (bus) => bus.setConfig('bpm', 60, 3)), 17);
  const flip = ENTRY_ORDER[1];
  const en = of(a, 'enter', flip)[0], ar = of(a, 'arrive', flip)[0];
  assert.ok(Math.abs(en.t - 2) < DT / 2);
  assert.equal(ar.measure, en.measure + 4);
  assert.ok(Math.abs(ar.t - 16) < DT / 2, `arrived at ${ar.t}`);
  assert.ok(Math.abs(a.riders.riders[flip].arriveT - 16) < 1e-9, `arriveT ${a.riders.riders[flip].arriveT}`);
  assert.ok(a.maxStep < 0.12, `max step ${a.maxStep}`);
  assert.deepEqual(a.bad, []);
});

test('Honu (turtle, cruise) and Noa (surfer) take waves when everyone is in the water', () => {
  const bus = new InputBus();
  for (let s = 0; s < 8; s++) for (let i = 0; i < 4; i++) bus.impulse({ lane: 3 + ((i + s) % 3), velocity: 1, time: 2 + s * 16 + i * 0.5, duration: 0.3 });
  const { riders } = simulate({ log: bus.log }, { until: 150, beat: null });
  const honu = riders.rides.filter((r) => r.name === 'Honu'), noa = riders.rides.filter((r) => r.name === 'Noa');
  assert.ok(honu.length >= 1, 'Honu never rode');
  assert.ok(noa.length >= 1, 'Noa never rode');
  for (const r of honu) assert.equal(r.style, 'cruise');
  for (const r of [...honu, ...noa]) assert.ok(r.tEnd > r.tStand, `${r.name} ride ${r.tStand}–${r.tEnd}`);
});
