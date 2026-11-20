// WP13: note splash + birds + flock — pure helpers (no GPU).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DT, DEFAULT_CFG } from '../src/contracts.js';
import { splashParams, splashBoost, splashX, SPLASH_X, jetTop, jetApexT, SPLASH } from '../src/fx/splashMath.js';
import { BirthLog, birdPos, birdPose, birdAlpha, flapAmp, BIRD } from '../src/fx/birdMath.js';

const cfg = (o = {}) => ({ ...structuredClone(DEFAULT_CFG), ...o });
const SUN = { x: 0.99, y: 0.105, z: -0.06 };
const imp = (id, t, o = {}) => ({ id, t, u: 0.4375, lane: 3, lanes: 8, strength: 1, frontId: 1, precharge: false, x: 300, z: -20, jump: false, ...o });

/** Run the birth log over [t0, t1] at the sim DT with a scripted swell/riders state. */
function run(log, t0, t1, src, c = cfg()) {
  const n = Math.round((t1 - t0) / DT);
  for (let i = 1; i <= n; i++) { const t = t0 + i * DT; const s = src(t); log.step(t, s.swell, s.riders, c, SUN); }
}

test('splash: bigger for stronger notes, far splashes boosted, jet rises to H and falls back', () => {
  const soft = splashParams(200, 0, 0, 0.4), hard = splashParams(200, 0, 0, 1);
  assert.ok(hard.H > soft.H && hard.S > soft.S);
  assert.ok(hard.H / hard.boost >= 14 && hard.H / hard.boost <= 20, "full note ≈ 18 m before the distance boost");
  assert.ok(splashBoost(500, 0) > splashBoost(150, 0) && splashBoost(30, 60) === 1);
  assert.ok(splashBoost(5000, 0) <= SPLASH.boostMax);
  const far = splashParams(5000, 0, 0, 1);
  assert.equal(far.x, SPLASH.maxX, 'pre-charge (spawn-line) hits pulled in to maxX');
  assert.equal(jetTop(hard, 0), 0);
  assert.ok(jetTop(hard, 1 / 60) > 0.3, 'already above the water on the next frame');
  assert.ok(Math.abs(jetTop(hard, jetApexT(hard)) - hard.H) < 1e-9);
  assert.equal(jetTop(hard, 2 * jetApexT(hard) + 0.1), 0);
  const s2 = splashParams(200, 0, 0, 1, 1, 0.5);
  assert.ok(Math.abs(s2.H - hard.H / 2) < 1e-9, 'density scale');
});

test('births: one splash + perNote birds per impulse, deduplicated, deterministic, pruned', () => {
  const imps = [];
  const src = (t) => {
    if (Math.abs(t - 1) < DT / 2) imps.push(imp(1, t));
    if (Math.abs(t - 1.5) < DT / 2) imps.push(imp(2, t, { strength: 0.4, u: 0.9 }));
    return { swell: { impulses: imps.filter((m) => m.t >= t - 10) }, riders: null };
  };
  const A = new BirthLog();
  run(A, 0, 3, src);
  assert.equal(A.list.length, 2);
  assert.deepEqual(A.list.map((b) => b.key), [1, 2]);
  assert.equal(A.list[0].birds.length, DEFAULT_CFG.birds.perNote);
  // same input → identical births (no hidden randomness)
  imps.length = 0;
  const B = new BirthLog();
  run(B, 0, 3, src);
  assert.deepEqual(JSON.parse(JSON.stringify(B.list)), JSON.parse(JSON.stringify(A.list)));
  // pruned once everything is over; impulses that left the ring are not re-added
  run(A, 3, 40, src);
  assert.equal(A.list.length, 0);
  // perNote from cfg
  imps.length = 0;
  const C = new BirthLog();
  run(C, 0, 2, src, cfg({ birds: { perNote: 3, flock: 16, max: 96 } }));
  assert.equal(C.list[0].birds.length, 3);
});

test('note bird: bursts out of the splash column, climbs, circles ~6–10 s, then leaves up toward the sun and fades', () => {
  const L = new BirthLog();
  const imps = [];
  run(L, 0, 1.2, (t) => { if (Math.abs(t - 1) < DT / 2) imps.push(imp(7, t, { x: 260, z: 30 })); return { swell: { impulses: imps } }; });
  const br = L.list[0], bp = br.birds[0], sp = br.sp;
  assert.equal(birdAlpha(bp, 0), 0, 'hidden inside the splash at first');
  const p0 = birdPos(bp, bp.t0 + 0.01);
  assert.ok(Math.hypot(p0[0] - sp.x, p0[2] - sp.z) < 3, 'starts at the column');
  assert.ok(p0[1] > 0 && p0[1] < jetTop(sp, bp.t0) + 2, 'inside the jet');
  assert.ok(birdPos(bp, 1.0)[1] > jetTop(sp, 1.0), 'outruns the jet top');
  // circling: stays within a bounded region above the water, turns through > 1 rad
  const TL = bp.t0 + bp.TL;
  let ang = 0, prev = null, ymin = Infinity;
  for (let a = bp.t0 + BIRD.burstT; a < TL; a += 0.05) {
    const p = birdPose(bp, a);
    ymin = Math.min(ymin, p.y);
    const h = Math.atan2(p.fz, p.fx);
    if (prev !== null) { let d = h - prev; d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI; ang += Math.abs(d); }
    prev = h;
    assert.ok(Math.abs(p.roll) <= 0.95 + 1e-9);
    assert.ok(p.speed > 3 && p.speed < 60, `speed ${p.speed}`);
  }
  assert.ok(TL - bp.t0 - BIRD.burstT >= 6 - 1e-9 && TL - bp.t0 - BIRD.burstT <= 10 + 1e-9);
  assert.ok(ang > 2.5, 'circles (heading turns)');
  assert.ok(ymin > 20, 'above the lineup');
  // leaving: rises and heads east (toward the dawn sun), fades out
  const a1 = TL + 1, a2 = TL + 5;
  const q1 = birdPos(bp, a1), q2 = birdPos(bp, a2);
  assert.ok(q2[1] - q1[1] > 20 && q2[0] - q1[0] > 30);
  assert.equal(birdAlpha(bp, bp.life + 0.01), 0);
  assert.ok(birdAlpha(bp, TL + 1) > 0.99);
  assert.ok(flapAmp(bp, 0.5) > 0.9 && flapAmp(bp, TL + 2) > 0.9);
  // analytic: evaluation order doesn't matter
  assert.deepEqual(birdPos(bp, 5.5), (birdPos(bp, 2), birdPos(bp, 9), birdPos(bp, 5.5)));
});

test('flock: a synthetic riders flock event → cfg.birds.flock birds bursting from the rider, swirling, then away', () => {
  const pos = { x: 150, y: 0.2, z: 10 };
  const events = [{ t: 0.5, type: 'takeoff', riderId: 1 }];
  const L = new BirthLog();
  run(L, 0, 4, (t) => {
    if (Math.abs(t - 2) < DT / 2) events.push({ t, type: 'flock', riderId: 3, pos });
    return { swell: { impulses: [] }, riders: { events } };
  });
  assert.equal(L.list.length, 1, 'one flock, deduplicated across steps');
  const fl = L.list[0];
  assert.equal(fl.kind, 'flock');
  assert.equal(fl.birds.length, DEFAULT_CFG.birds.flock);
  // burst outward from the rider: close at first, spread out after ~1 s
  const at = (a) => fl.birds.map((b) => birdPos(b, a));
  const d0 = Math.max(...at(0.06).map((p) => Math.hypot(p[0] - pos.x, p[2] - pos.z)));
  assert.ok(d0 < 3, 'starts at the rider');
  const c = at(2.5), cx = c.reduce((s, p) => s + p[0], 0) / c.length, cz = c.reduce((s, p) => s + p[2], 0) / c.length;
  const spread = Math.max(...c.map((p) => Math.hypot(p[0] - cx, p[2] - cz)));
  assert.ok(spread > 3 && spread < 25, `swirls together (spread ${spread.toFixed(1)} m)`);
  assert.ok(Math.min(...c.map((p) => p[1])) > 5);
  // away and gone
  const end = Math.max(...fl.birds.map((b) => b.life));
  assert.ok(end < 15);
  assert.ok(fl.birds.every((b) => birdAlpha(b, end + 0.01) === 0));
  // tolerates riders without events / with other shapes
  const M = new BirthLog();
  run(M, 0, 0.1, () => ({ swell: null, riders: {} }));
  run(M, 0.1, 0.2, () => ({ swell: { impulses: [] }, riders: { events: [{ t: 0.15, type: 'flock' }] } }));
  assert.equal(M.list.length, 0);
});

test('bird cap: ≤ cfg.birds.max live birds, oldest births culled first', () => {
  const L = new BirthLog();
  const imps = [];
  run(L, 0, 6, (t) => {
    const k = Math.round(t / DT);
    if (k % 12 === 0) imps.push(imp(k, t, { z: -100 + (k % 200) }));
    return { swell: { impulses: imps.filter((m) => m.t >= t - 10) } };
  });
  const seen = [];
  const n = L.forBirds(6, 20, (bp, age, br) => seen.push(br.key));
  assert.equal(n, 20);
  const newest = L.list.filter((b) => 6 - b.t0 >= b.birds[0].t0).slice(-20).map((b) => b.key).reverse();   // emerged ones
  assert.deepEqual(seen, newest);
});

test('splash placement: in the lineup band, deterministic per impulse, nearest the front side', () => {
  for (const fx of [600, 450, 200, 90, NaN]) for (let id = 1; id < 40; id++) {
    const x = splashX(fx, id, 1);
    assert.ok(x >= SPLASH_X[0] && x <= SPLASH_X[1]);
    assert.equal(x, splashX(fx, id, 1));
  }
  let far = 0, near = 0;
  for (let id = 1; id < 200; id++) { far += splashX(600, id); near += splashX(90, id); }
  assert.ok(far / 199 > 200 && near / 199 < 140);
});
