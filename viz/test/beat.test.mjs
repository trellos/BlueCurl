import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DT, DEFAULT_CFG } from '../src/contracts.js';
import { InputBus, applyCfgEvent } from '../src/input/input.js';
import { Beat } from '../src/beat/beat.js';
import { patternHits, INSTRUMENTS } from '../src/beat/patterns.js';
import { BeatScheduler } from '../src/beat/scheduler.js';

/** Minimal App-like harness: input → cfg → beat, fixed steps. */
function rig(cfgOver = {}) {
  const cfg = structuredClone(DEFAULT_CFG);
  Object.assign(cfg, cfgOver);
  let k = 0;
  const bus = new InputBus(() => k * DT);
  const beat = new Beat(cfg);
  const levels = [];   // level per measure index
  const run = (sec, onStep) => {
    const n = Math.round(sec / DT);
    for (let i = 0; i < n; i++) {
      k++;
      const t = k * DT;
      const evs = bus.drainUntil(t);
      for (const e of evs) applyCfgEvent(cfg, e);
      beat.step(t, DT, evs);
      levels[beat.measure] = beat.level;
      onStep?.(t);
    }
  };
  return { cfg, bus, beat, run, levels, now: () => k * DT };
}
/** Schedule `perMeasure` evenly spaced notes in each of measures [m0, m1) at 120 bpm (2 s measures). */
function notes(bus, m0, m1, perMeasure, len = 2) {
  for (let m = m0; m < m1; m++) for (let i = 0; i < perMeasure; i++) bus.impulse({ lane: i % 8, time: m * len + (i + 0.25) * len / perMeasure, duration: 0.05 });
}

test('level starts at 1; silence keeps it at 1', () => {
  const r = rig();
  assert.equal(r.beat.level, 1);
  assert.equal(r.beat.target, 1);
  r.run(10);
  assert.equal(r.beat.measure, 5);
  assert.equal(r.beat.level, 1);
  assert.equal(r.beat.measureLen, 2);
  assert.equal(r.beat.beatLen, 0.5);
});

test('target = clamp(notes, 1, 8) and the level moves one step per measure', () => {
  const r = rig();
  notes(r.bus, 0, 1, 0); notes(r.bus, 1, 2, 1); notes(r.bus, 2, 3, 3); notes(r.bus, 3, 4, 12);
  r.run(2 + 1e-9 + DT);
  assert.equal(r.beat.target, 1); assert.equal(r.beat.level, 1);       // 0 notes
  r.run(2);
  assert.equal(r.beat.target, 1); assert.equal(r.beat.level, 1);       // 1 note
  r.run(2);
  assert.equal(r.beat.target, 3); assert.equal(r.beat.level, 2);       // 3 notes → +1 only
  r.run(2);
  assert.equal(r.beat.target, 8); assert.equal(r.beat.level, 3);       // 12 notes → clamp 8, +1
  const ms = r.beat.measures;
  assert.deepEqual(ms.map((m) => m.notes), [0, 1, 3, 12]);
  assert.deepEqual(ms.map((m) => m.target), [1, 1, 3, 8]);
});

test('eighth notes for many measures reach level 8 after 7 measures; silence steps back down', () => {
  const r = rig();
  notes(r.bus, 0, 12, 8);
  r.run(24 + DT);
  // level of measure m: 1 + min(m, 7)
  for (let m = 0; m <= 12; m++) assert.equal(r.levels[m], Math.min(8, 1 + m), `measure ${m}`);
  assert.equal(r.levels[7], 8); assert.equal(r.levels[6], 7);
  r.run(2 * 9);
  for (let m = 13; m <= 21; m++) assert.equal(r.levels[m], Math.max(1, 8 - (m - 12)), `measure ${m}`);
  const ev = r.beat.events.filter((e) => e.type === 'downbeat');
  for (const e of ev) { assert.ok(Math.abs(e.change) <= 1); assert.equal(e.change, e.level - e.prevLevel); }
});

test('a note-heavy measure followed by silence moves 1 up then 1 down', () => {
  const r = rig();
  notes(r.bus, 0, 1, 8);
  r.run(6 + DT);
  assert.deepEqual(r.levels.slice(0, 4), [1, 2, 1, 1]);
});

test('bpm change applies at the next downbeat (the bar in progress keeps its length)', () => {
  const r = rig();
  r.run(0.5);
  r.bus.setConfig('bpm', 60);                       // mid measure 0
  r.run(1.0);
  assert.equal(r.cfg.bpm, 60);
  assert.equal(r.beat.measureLen, 2);               // measure 0 still 2 s
  r.run(0.5 + DT);                                  // t ≈ 2 + DT → measure 1 at 60 bpm
  assert.equal(r.beat.measure, 1);
  assert.ok(Math.abs(r.beat.measureT0 - 2) < 1e-9);
  assert.equal(r.beat.measureLen, 4);
  assert.equal(r.beat.beatLen, 1);
  r.run(4);
  assert.equal(r.beat.measure, 2);
  assert.ok(Math.abs(r.beat.measureT0 - 6) < 1e-9);
  // barPhase within the measure
  const p = r.beat.barPhase(r.beat.measureT0 + 2.5);
  assert.equal(p.measure, 2); assert.equal(p.beat, 2); assert.ok(Math.abs(p.frac - 0.5) < 1e-9);
});

test('notes landing on the downbeat step count for the new measure', () => {
  const r = rig();
  r.bus.impulse({ lane: 0, time: 2, duration: 0.05 });       // exactly on the downbeat of measure 1
  r.bus.impulse({ lane: 1, time: 2 - DT, duration: 0.05 });  // last step of measure 0
  r.run(4 + DT);
  assert.equal(r.beat.measures[0].notes, 1);
  assert.equal(r.beat.measures[1].notes, 1);
});

test('chords count every note; invalid bpm falls back to 120', () => {
  const r = rig();
  for (let i = 0; i < 3; i++) r.bus.impulse({ lane: i, time: 0.5, duration: 0.1 });
  r.run(2 + DT);
  assert.equal(r.beat.target, 3);
  const b = new Beat({ ...structuredClone(DEFAULT_CFG), bpm: 0 });
  assert.equal(b.measureLen, 2);
});

test('determinism: same log → identical beat state and history', () => {
  const mk = () => {
    const r = rig();
    notes(r.bus, 0, 3, 5); notes(r.bus, 3, 6, 8); notes(r.bus, 8, 9, 2);
    r.bus.setConfig('bpm', 97, 7.3);
    r.run(30);
    return r;
  };
  const a = mk(), b = mk();
  assert.deepEqual(a.beat.events, b.beat.events);
  assert.deepEqual(a.beat.measures, b.beat.measures);
  // replay after reset gives the same result too
  const log = a.bus.log;
  const c = rig();
  c.bus.load(log);
  c.run(30);
  assert.deepEqual(c.beat.events, a.beat.events);
});

// ---------------------------------------------------------------- patterns

test('patterns: 8 distinct levels, accented 1 at level 1, every step valid', () => {
  const sig = new Set();
  for (let L = 1; L <= 8; L++) {
    for (let m = 0; m < 4; m++) {
      const h = patternHits(L, m);
      for (const x of h) {
        assert.ok(Number.isInteger(x.step) && x.step >= 0 && x.step < 16);
        assert.ok(INSTRUMENTS.includes(x.inst), x.inst);
        assert.ok(x.vel > 0 && x.vel <= 1);
      }
      assert.ok(h.some((x) => x.step === 0), `level ${L} has a hit on the 1`);
      assert.deepEqual(patternHits(L, m), h);
      assert.deepEqual(patternHits(L, m + 4), h);
    }
    sig.add(JSON.stringify(patternHits(L, 0)));
  }
  assert.equal(sig.size, 8);
  const l1 = patternHits(1, 0);
  assert.deepEqual(l1.map((x) => x.step), [0, 4, 8, 12]);
  assert.equal(l1[0].inst, 'clickHi');
  assert.ok(l1.slice(1).every((x) => x.inst === 'click' && x.vel < l1[0].vel));
  // each level adds instruments (roughly monotone density)
  const n = (L) => patternHits(L, 0).length;
  for (let L = 2; L <= 8; L++) assert.ok(n(L) >= n(L - 1), `level ${L} density`);
});

// ---------------------------------------------------------------- scheduler

/** Drive the scheduler with irregular frames over the beat sim; returns emitted hits. */
function schedRun(r, sec, { pauseAt = null, pauseFor = 0, rewindAt = null } = {}) {
  const s = new BeatScheduler({ lookahead: 0.12 });
  const out = [];
  let frame = 0, acc = 0;
  const frames = [0.016, 0.017, 0.033, 0.008, 0.016, 0.05, 0.016];
  let paused = false, pausedLeft = 0;
  while (r.now() < sec) {
    const dt = frames[frame++ % frames.length];
    if (pauseAt != null && !paused && r.now() >= pauseAt && pausedLeft === 0 && pauseFor > 0) { paused = true; pausedLeft = pauseFor; }
    if (paused) {
      pausedLeft -= dt;
      // what BeatAudio does while paused: cut the voices scheduled ahead (bus swap) and restart from now
      for (let i = out.length - 1; i >= 0 && out[i].t >= r.now(); i--) out.pop();
      s.seek(r.now());
      if (pausedLeft <= 0) { paused = false; pauseFor = 0; }
      continue;
    }
    acc += dt;
    const n = Math.floor(acc / DT); acc -= n * DT;
    r.run(n * DT);
    s.frame(r.now(), r.beat, out);
  }
  return out;
}

test('scheduler: each measure gets exactly its pattern, no double hits, in time order', () => {
  const r = rig();
  notes(r.bus, 0, 10, 8); notes(r.bus, 10, 14, 0);
  const out = schedRun(r, 28);
  const byM = new Map();
  for (const h of out) { if (!byM.has(h.measure)) byM.set(h.measure, []); byM.get(h.measure).push(h); }
  for (let m = 0; m < 13; m++) {
    const hs = byM.get(m);
    const L = r.levels[m];
    assert.equal(hs[0].level, L);
    const exp = patternHits(L, m);
    assert.equal(hs.length, exp.length, `measure ${m} level ${L}`);
    assert.deepEqual(hs.map((h) => h.step + h.inst), exp.map((h) => h.step + h.inst));
    for (const h of hs) assert.ok(Math.abs(h.t - (m * 2 + h.step * 0.125)) < 1e-9);
  }
  for (let i = 1; i < out.length; i++) assert.ok(out[i].t >= out[i - 1].t);
  const keys = out.map((h) => h.t.toFixed(9) + h.inst);
  assert.equal(new Set(keys).size, keys.length);
});

test('scheduler: next measure only after the sim passes its downbeat; window ≤ lookahead', () => {
  const r = rig();
  const s = new BeatScheduler({ lookahead: 0.12 });
  const out = [];
  r.run(1.95);
  s.frame(r.now(), r.beat, out);
  assert.ok(out.every((h) => h.measure === 0 && h.t < 2));
  out.length = 0;
  r.run(0.04);                        // t = 1.99: still measure 0, nothing of measure 1 yet
  s.frame(r.now(), r.beat, out);
  assert.equal(out.filter((h) => h.t >= 2).length, 0);
  r.run(0.02);                        // t = 2.01: downbeat passed
  s.frame(r.now(), r.beat, out);
  assert.ok(out.some((h) => h.measure === 1 && h.step === 0));
  assert.ok(out.every((h) => h.t <= r.now() + 0.12));
});

test('scheduler: pause emits nothing and resumes without a burst; rewind re-seeds', () => {
  const r = rig();
  const out = schedRun(r, 8, { pauseAt: 3.1, pauseFor: 2 });
  // all level-1 clicks, 4 per measure, none missing or doubled (pause does not move the sim)
  const done = out.filter((h) => h.measure < 4);
  assert.equal(done.length, 16);
  assert.equal(new Set(done.map((h) => h.t)).size, 16);
  const s = new BeatScheduler();
  const r2 = rig();
  r2.run(3);
  const a = s.frame(r2.now(), r2.beat, []);
  assert.equal(a.jumped, true);
  const r3 = rig();                   // rewind: new sim at t ≈ 0.016 < lastT
  r3.run(0.016);
  const b = s.frame(r3.now(), r3.beat, []);
  assert.equal(b.jumped, true);
  assert.deepEqual(b.hits.map((h) => h.step), [0]);  // a re-seed backfills 50 ms: the 1 at t = 0 still plays (latency 70 ms)
});
