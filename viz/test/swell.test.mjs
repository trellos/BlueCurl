import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DT, NCOLS, ZONES, PATH, FRONT_W, DEFAULT_CFG, intervalSec, localTau } from '../src/contracts.js';
import { InputBus, applyCfgEvent } from '../src/input/input.js';
import { Swell, TUNING } from '../src/sim/swell.js';

// ------------------------------------------------------------------ helpers
/** Simulate cfg overrides + notes [[t, lane, velocity, scale?]] (+ extra cfg events [[t, key, value]]). */
function run({ cfg: over = {}, notes = [], cfgEvents = [], until = 40, onStep = null } = {}) {
  const cfg = structuredClone(DEFAULT_CFG);
  const src = new InputBus();
  for (const [t, lane, velocity = 1, scale = 1] of notes) src.impulse({ lane, velocity, scale, time: t, duration: 0.2 });
  for (const [t, key, value] of cfgEvents) src.setConfig(key, value, t);
  let simT = 0;
  const input = new InputBus(() => simT);
  input.load({ cfg: over, log: src.log });
  const swell = new Swell(cfg);
  const seen = new Map();
  const steps = Math.round(until / DT);
  for (let k = 1; k <= steps; k++) {
    const t = k * DT, evs = input.drainUntil(t);
    for (const e of evs) applyCfgEvent(cfg, e);
    swell.step(t, DT, evs);
    simT = t;
    for (const f of swell.fronts) if (!seen.has(f.id)) seen.set(f.id, f);
    onStep?.(t, swell);
  }
  return { swell, cfg, fronts: [...seen.values()] };
}
const reg = (n, t0, dt, laneF, velF = () => 1) => Array.from({ length: n }, (_, i) => [t0 + i * dt, laneF(i), velF(i)]);
const R = (x) => { const s = Math.sin(x * 12.9898) * 43758.5453; return s - Math.floor(s); };
const firstFront = (fronts) => fronts.find((f) => f.tPoint === 16);
const zoneOf = (f, key) => f.breaks.find((b) => b.zone === key);

// the five input shapes, all aimed at the first front of set 1 (tPoint 16, input window 0 … 7.5 s)
const SHAPES = {
  hollow: reg(14, 1, 0.4, (i) => (i % 4 === 3 ? 4 : 3)),                     // (a) many, strong, concentrated
  wall: reg(14, 1, 0.4, (i) => 2 + (i % 4)),                                  // (b) strong, spread over the point
  mellow: reg(4, 2, 0.8, (i) => 3 + (i % 2), () => 0.4),                      // (c) few, soft
  south: reg(10, 1, 0.5, (i) => (i % 3 === 2 ? 1 : 2)),                       // (d) weighted to the south side
  north: reg(10, 1, 0.5, (i) => (i % 3 === 2 ? 5 : 4)),                       // (d) weighted to the north side
  centre: reg(10, 1, 0.5, (i) => (i % 3 === 2 ? 4 : 3)),                      // (d) centred on the point zone (u ≈ 0.47)
  weakErratic: (() => { let t = 1; return Array.from({ length: 12 }, (_, i) => { t += 0.12 + R(i) * 0.8; return [t, 3 + (i % 2), 0.2 + 0.5 * R(i + 50)]; }); })(),
  strongErratic: (() => { let t = 1; return Array.from({ length: 14 }, (_, i) => { t += 0.08 + R(i + 7) * 0.7; return [t, 2 + (i % 3), 0.3 + 0.7 * R(i + 90)]; }); })(),
};
const shapeCache = new Map();
const pointBreak = (name) => {
  if (!shapeCache.has(name)) shapeCache.set(name, zoneOf(firstFront(run({ notes: SHAPES[name], until: 20 }).fronts), 'point'));
  return shapeCache.get(name);
};

// ------------------------------------------------------------------ tests
test('TUNING is exported', () => { assert.equal(typeof TUNING, 'object'); assert.ok(TUNING.H.E0 > 0); });

test('determinism: two runs give identical fronts and cols at t = 90', () => {
  const opts = { notes: [...SHAPES.hollow, ...SHAPES.strongErratic.map(([t, l, v]) => [t + 30, l, v]), [55, 6, 1], [56.3, 7, 0.4]],
    cfgEvents: [[40, 'bars', 2], [60, 'travel', 12]], until: 90 };
  const a = run(opts), b = run(opts);
  assert.equal(a.swell.fronts.length, b.swell.fronts.length);
  assert.ok(a.swell.fronts.length > 0);
  a.swell.fronts.forEach((fa, i) => {
    const fb = b.swell.fronts[i];
    assert.equal(fa.id, fb.id); assert.equal(fa.x, fb.x); assert.equal(fa.alpha, fb.alpha);
    assert.deepEqual(Buffer.from(fa.cols.buffer), Buffer.from(fb.cols.buffer));
    assert.deepEqual(Buffer.from(fa.energy.buffer), Buffer.from(fb.energy.buffer));
    assert.deepEqual(JSON.stringify(fa.breaks), JSON.stringify(fb.breaks));
  });
  assert.equal(JSON.stringify(a.swell.impulses), JSON.stringify(b.swell.impulses));
  assert.equal(JSON.stringify(a.swell.events), JSON.stringify(b.swell.events));
});

for (const bars of [2, 8, 16]) {
  test(`point-break grid at bars ${bars}, 120 bpm`, () => {
    const I = bars * 2;
    const notes = reg(200, 0.25, 0.5, (i) => 3 + (i % 2));
    const { fronts } = run({ cfg: { bars }, notes, until: 100 });
    assert.equal(intervalSec({ bars, bpm: 120 }), I);
    const sets = new Map();
    for (const f of fronts) (sets.get(f.set) || sets.set(f.set, []).get(f.set)).push(f);
    let nPoint = 0;
    for (const fs of sets.values()) {
      const lead = fs.find((f) => f.k === 0);
      assert.ok(lead, 'set has a first front');
      const r = lead.tPoint / I;
      assert.ok(Math.abs(r - Math.round(r)) < 1e-9 && r >= 1, `tPoint ${lead.tPoint} on the ${I}s grid`);
      for (const f of fs) assert.ok(Math.abs(f.tPoint - lead.tPoint - f.k * 2.5) < 1e-9);
      for (const f of fs) {
        const pb = zoneOf(f, 'point');
        if (pb) { nPoint++; assert.ok(Math.abs(pb.tBreak - f.tPoint) <= DT); }
      }
    }
    assert.ok(nPoint >= 3, `point breaks: ${nPoint}`);
  });
}

test('set count and spacing (clamped to fit the interval)', () => {
  const sizes = (cfg) => {
    const { fronts } = run({ cfg, until: 100 });
    const by = new Map();
    for (const f of fronts) by.set(f.set, [...(by.get(f.set) || []), f]);
    const full = [...by.values()].filter((fs) => fs[0].tPoint + 10 < 100);
    return full.map((fs) => fs.length);
  };
  assert.ok(sizes({ bars: 8 }).every((n) => n === 3));
  assert.ok(sizes({ bars: 2 }).every((n) => n === 1));             // 4 s interval: one front
  assert.ok(sizes({ bars: 8, setSize: 4 }).every((n) => n === 4));
  assert.ok(sizes({ bars: 16, setSize: 4 }).every((n) => n === 4));
  assert.ok(sizes({ bars: 8, setSize: 4, setSpacing: 4 }).every((n) => n === 3)); // floor(9.6/4)+1 = 3
  const { fronts } = run({ until: 40 });
  const s0 = fronts.filter((f) => f.set === 0).map((f) => f.tPoint);
  assert.deepEqual(s0, [16, 18.5, 21]);
  for (const f of fronts) assert.ok(Math.abs(f.tSpawn - (f.tPoint - 14)) < 1e-9);
});

test('silence: 180 s without input never breaks', () => {
  let maxH = 0, maxInside = 0, maxPoint = 0;
  const iz = ZONES[2], pz = ZONES[1];
  const { swell, fronts } = run({
    until: 180,
    onStep: (t, sw) => {
      for (const f of sw.fronts) for (let c = 0; c < NCOLS; c++) {
        const H = f.cols[c * 4], u = (c + 0.5) / NCOLS;
        if (H > maxH) maxH = H;
        if (f.x < pz.lineX + 5 && f.x > iz.lineX - 5 && u >= iz.u0 && u <= iz.u1) maxInside = Math.max(maxInside, H);
        if (f.x < 305 && f.x > pz.lineX - 5 && u >= pz.u0 && u <= pz.u1) maxPoint = Math.max(maxPoint, H);
      }
    },
  });
  assert.ok(fronts.length >= 25, `fronts ${fronts.length}`);
  assert.ok(fronts.every((f) => f.breaks.length === 0));
  assert.ok(!swell.events.some((e) => e.type === 'commit' || e.type === 'break'));
  assert.ok(maxH < ZONES[1].Hbreak, `max H ${maxH}`);
  assert.ok(maxPoint < ZONES[1].Hbreak, `point ${maxPoint}`);
  assert.ok(maxInside < ZONES[2].Hbreak, `inside ${maxInside}`);
});

test('(a) many strong concentrated notes → big, hollow: highest curl and barrel time', () => {
  const a = pointBreak('hollow');
  for (const k of ['wall', 'mellow', 'weakErratic', 'strongErratic']) {
    const o = pointBreak(k);
    assert.ok(a.curl > o.curl, `curl vs ${k}`);
    assert.ok(a.quality.barrelTime > o.quality.barrelTime, `barrel vs ${k}`);
  }
  assert.ok(a.H > pointBreak('wall').H && a.H > pointBreak('mellow').H);
  assert.ok(a.curl > 0.5 && a.H > 2);
});

test('(b) strong but spread → steep wall: high steep, less curl than (a), long peel', () => {
  const a = pointBreak('hollow'), b = pointBreak('wall');
  assert.ok(b.steep > 0.8);
  assert.ok(b.curl < a.curl * 0.5);
  assert.ok(b.peelLen > a.peelLen);
  assert.ok(b.peelLen > 0.45 * (b.u1 - b.u0) * FRONT_W * 0.6);
  assert.ok(!b.closeout && b.sections === 1);
});

test('(c) few mellow notes → small, soft, slow', () => {
  const c = pointBreak('mellow');
  for (const k of ['hollow', 'wall', 'south']) {
    const o = pointBreak(k);
    assert.ok(c.H < o.H && c.steep < o.steep && c.curl < o.curl && c.vPeel < o.vPeel, `vs ${k}`);
  }
  assert.ok(c.H < 1.4 && c.vPeel < ZONES[1].vPeel * 0.8);
});

test('(d) weighted to one side → peak on that side, peels away from it; centred → A-frame', () => {
  const s = pointBreak('south'), n = pointBreak('north'), m = pointBreak('centre');
  const mid = (ZONES[1].u0 + ZONES[1].u1) / 2;
  assert.ok(s.uPeak < mid - 0.08 * (ZONES[1].u1 - ZONES[1].u0)); assert.equal(s.dir, 1);
  assert.ok(n.uPeak > mid + 0.08 * (ZONES[1].u1 - ZONES[1].u0)); assert.equal(n.dir, -1);
  assert.equal(m.dir, 0);
});

test('(e) weak or erratic → mush and sections; erratic and strong → close-out', () => {
  const w = pointBreak('weakErratic'), e = pointBreak('strongErratic');
  for (const k of ['hollow', 'wall']) {
    assert.ok(w.mush > pointBreak(k).mush + 0.3);
    assert.ok(e.mush > pointBreak(k).mush + 0.3);
  }
  assert.ok(w.sections >= 2 && w.sections <= 3);
  assert.ok(!w.closeout);
  assert.ok(e.closeout);
  assert.equal(e.quality.barrelTime, 0);
});

test('cfg change mid-run reschedules deterministically', () => {
  const opts = { cfgEvents: [[20, 'bars', 2]], until: 70 };
  const a = run(opts), b = run(opts);
  const tp = (r) => r.fronts.map((f) => [f.id, f.set, f.k, f.tPoint]);
  assert.deepEqual(tp(a), tp(b));
  const before = a.fronts.filter((f) => f.tSpawn <= 20 + 1e-9);
  const after = a.fronts.filter((f) => f.tSpawn > 20 + 1e-9);
  // spawned fronts keep their timing (set 0 complete, set 1 front 0 spawned at 18)
  assert.deepEqual(before.map((f) => f.tPoint), [16, 18.5, 21, 32]);
  const last = Math.max(...before.map((f) => f.tPoint));
  assert.ok(after.length >= 5);
  assert.equal(after[0].tPoint, 36);             // ≥ 20 + 14 + 0.5 and ≥ 32 + 2.5, on the 4 s grid
  for (const f of after) { assert.ok(Math.abs(f.tPoint / 4 - Math.round(f.tPoint / 4)) < 1e-9); assert.ok(f.tPoint >= last + 2.5); }
  for (let i = 1; i < after.length; i++) assert.ok(Math.abs(after[i].tPoint - after[i - 1].tPoint - 4) < 1e-9);
});

test('energy goes to the right target front, with pre-charge before spawn', () => {
  const seen = [];
  const { swell, fronts } = run({
    notes: [[1, 3], [8, 3], [11, 3], [13, 3], [14.5, 3]], until: 15,
    onStep: (t, sw) => {
      if (Math.abs(t - 1) < DT / 2) {
        const f = sw.fronts[0];
        seen.push({ n: sw.fronts.length, alpha: f.alpha, target: f.target, x: f.x, tPoint: f.tPoint, fx: { ...sw.impulses[0] } });
      }
    },
  });
  // t = 1: nothing on the water → the next scheduled front is created invisible at the horizon
  const s = seen[0];
  assert.equal(s.n, 1); assert.equal(s.alpha, 0); assert.equal(s.target, true); assert.equal(s.tPoint, 16); assert.equal(s.x, PATH[0].x);
  assert.equal(s.fx.frontId, fronts[0].id); assert.equal(s.fx.x, PATH[0].x); assert.equal(s.fx.precharge, true);
  const byT = (tp) => fronts.find((f) => f.tPoint === tp);
  const fxOf = (t) => swell.impulses.find((i) => Math.abs(i.t - t) < DT);
  assert.equal(fxOf(8).frontId, byT(18.5).id);   // front 1 committed at the outer reef at 7.5
  assert.equal(fxOf(11).frontId, byT(21).id);
  assert.equal(fxOf(13).frontId, byT(32).id);    // set 2 pre-charge (spawns at 18)
  assert.equal(fxOf(13).precharge, true);
  assert.equal(fxOf(14.5).frontId, byT(32).id);
  assert.ok(Math.abs(byT(16).charge - Math.pow(2, -6.5 / 20)) < 0.01);    // one note, decayed for 6.5 s
  assert.ok(swell.events.some((e) => e.type === 'spawn' && e.frontId === byT(16).id && Math.abs(e.t - 2) < DT));
  for (const fx of swell.impulses) assert.equal(typeof fx.jump, 'boolean');
  // energy is a normalised gaussian: one full note deposits ≈ 1 in total
  let E = 0; for (const v of byT(32).energy) E += v;
  assert.ok(E > 1.8 && E < 2.01);
});

test('cols are smooth in time and the break phase mirrors contracts.localTau', () => {
  let maxDH = 0, checked = 0;
  const prev = new Map(), prevRaw = new Map();
  run({
    notes: [...SHAPES.hollow, ...SHAPES.south.map(([t, l, v]) => [t + 16, l, v]), ...SHAPES.strongErratic.map(([t, l, v]) => [t + 32, l, v])],
    until: 75,
    onStep: (t, sw) => {
      for (const f of sw.fronts) {
        const p = prev.get(f.id);
        if (p) for (let c = 0; c < NCOLS; c++) maxDH = Math.max(maxDH, Math.abs(f.cols[c * 4] - p[c * 4]));
        // while contracts.localTau says a column is mid-break (0 < tau < 1) its (pre-taper) height is held exactly
        const raw = f._s.raw, pr = prevRaw.get(f.id);
        if (f.breaks.length && pr) {
          for (let c = 0; c < NCOLS; c += 3) {
            const u = (c + 0.5) / NCOLS, lt = localTau(f, u, t), lp = localTau(f, u, t - DT);
            if (lt.zi >= 0 && lt.zi === lp.zi && lp.tau > 0.01 && lt.tau < 0.99) {
              checked++;
              assert.equal(raw[c * 4], pr[c * 4], `front ${f.id} col ${c} t ${t}`);
            }
          }
        }
        prev.set(f.id, Float32Array.from(f.cols));
        prevRaw.set(f.id, Float32Array.from(raw));
      }
    },
  });
  assert.ok(maxDH < 0.05, `max |dH| per step ${maxDH}`);
  assert.ok(checked > 1000, `checked ${checked}`);
});

test('edge tapers hide breakStartTime jumps; headland columns fade and never break late; peel timing', async () => {
  const { breakStartTime, zToU } = await import('../src/contracts.js');
  const { pathSpline, pathEval } = await import('../src/sim/swell.js');
  const sp = pathSpline(14);
  const tAt = (x) => { let a = -14, b = 15; for (let i = 0; i < 60; i++) { const m = (a + b) / 2; if (pathEval(sp, m).x > x) a = m; else b = m; } return a; };
  let edgeChecks = 0, headChecks = 0, maxHeadH = 0;
  const uHead = zToU(TUNING.headland.z1);
  const notes = [...SHAPES.hollow, ...SHAPES.south.map(([t, l, v]) => [t + 16, l, v]), ...SHAPES.wall.map(([t, l, v]) => [t + 32, l, v])];
  const { fronts } = run({
    notes, until: 75,
    onStep: (t, sw) => {
      for (const f of sw.fronts) {
        const raw = f._s.raw;
        for (const zb of f.breaks) {
          if (t < zb.tBreak + 0.5 || t > zb.tBreak + 3) continue;
          const floor = TUNING.taper.floorFrac * ZONES[zb.zi].Hscale * TUNING.cols.ambient;
          for (let c = 0; c < NCOLS - 1; c++) {
            const a = breakStartTime(zb, (c + 0.5) / NCOLS), b = breakStartTime(zb, (c + 1.5) / NCOLS);
            if (Number.isFinite(a) === Number.isFinite(b)) continue;
            for (const cc of [c, c + 1]) {
              edgeChecks++;
              assert.ok(f.cols[cc * 4] <= floor + 0.06 * raw[cc * 4] + 1e-6, `edge col ${cc} H ${f.cols[cc * 4]} raw ${raw[cc * 4]}`);
              assert.ok(f.cols[cc * 4 + 2] <= 0.06 * raw[cc * 4 + 2] + 1e-6);
            }
          }
        }
        if (f.x < TUNING.headland.x1) for (let c = 0; c < NCOLS; c++) if ((c + 0.5) / NCOLS >= uHead) { headChecks++; maxHeadH = Math.max(maxHeadH, f.cols[c * 4]); }
      }
    },
  });
  assert.ok(edgeChecks > 100, `edge checks ${edgeChecks}`);
  assert.ok(headChecks > 100 && maxHeadH < 1e-6, `headland H ${maxHeadH}`);
  const tHead = tAt(TUNING.headland.breakX), tEnd = tAt(TUNING.peelEndX.point);
  let nPoint = 0;
  for (const f of fronts) for (const zb of f.breaks) {
    for (let c = 0; c < NCOLS; c++) {
      const u = (c + 0.5) / NCOLS, ts = breakStartTime(zb, u);
      if (!Number.isFinite(ts)) continue;
      if (u >= zToU(TUNING.headland.z0)) assert.ok(ts <= f.tPoint + tHead + 1e-6, `headland col ${c} breaks at ${ts - f.tPoint}`);
      if (zb.zone === 'point') assert.ok(ts <= f.tPoint + tEnd + 1e-6, `point peel late: ${ts - f.tPoint}`);
    }
    if (zb.zone === 'point') nPoint++;
  }
  assert.ok(nPoint >= 3);
  assert.ok(tAt(45) > tEnd);
});
