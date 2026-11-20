// WP6a — rider simulation: Swell + Riders run headlessly over demo/demo-basic.json (and silence).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DT, hash01 } from '../src/contracts.js';
import { surfaceHeight, sampleFront, columnState } from '../src/wave/field.js';
import { SIGMA_TROUGH } from '../src/wave/keyframes.js';
import { seaLevel } from '../src/riders/plan.js';
import { simulate } from '../tools/rides-report.mjs';

const demo = JSON.parse(fs.readFileSync(new URL('../demo/demo-basic.json', import.meta.url), 'utf8'));
const UNTIL = (demo.duration ?? 92) + 40;          // silence after the demo: everyone gets back to the lineup

const NEXT = {
  LINEUP: ['POSITION'], POSITION: ['TAKEOFF', 'RETURN'], TAKEOFF: ['RIDE', 'CLOSEOUT', 'KICKOUT'],
  RIDE: ['KICKOUT', 'CLOSEOUT'], KICKOUT: ['RETURN'], CLOSEOUT: ['RETURN'], RETURN: ['LINEUP', 'POSITION'],
};

/** One full run with per-step checks collected (the expensive part is shared by the tests). */
function run(d = demo, until = UNTIL) {
  const out = { nan: 0, badTransitions: [], surfDy: 0, surfAt: '', animalDy: 0, events: [], seenEv: new Set(),
    idsMissing: 0, trace: [], states: new Set(), frameDup: 0, hist: new Map(), trailErr: 0, trailN: 0, actBad: 0,
    face: new Map(), minUpY: 1, fwdSnap: 0, prevFwd: new Map() };
  const prevState = new Map();
  const res = simulate(d, {
    until,
    onStep(t, swell, riders) {
      for (const ev of riders.events) {                // new events (each a fresh object)
        if (out.seenEv.has(ev)) continue;
        out.seenEv.add(ev); out.events.push(ev);
      }
      for (const r of riders.riders) {
        // trail: riders.trail(id, age) is the position age seconds ago
        const H = out.hist.get(r.id) ?? []; H.push([t, r.pos.x, r.pos.y, r.pos.z]); if (H.length > 200) H.shift(); out.hist.set(r.id, H);
        if (H.length > 100 && Math.round(t / DT) % 7 === 0) {
          const old = H[H.length - 1 - 60], q = riders.trail(r.id, t - old[0]);
          out.trailErr = Math.max(out.trailErr, Math.hypot(q.x - old[1], q.y - old[2], q.z - old[3])); out.trailN++;
        }
        if (typeof r.prevAction !== 'string' || !Number.isFinite(r.prevActionT) || !(r.actionStart <= t)) out.actBad++;
        // on the face during RIDE: the face point is ≥ 25 % of the local column height above the local trough
        const pf = out.prevFwd.get(r.id);
        if (r.state === 'RIDE') {
          const R = riders._b[r.id].ride, P = R.plan;
          if (pf && pf.x * r.fwd.x + pf.y * r.fwd.y + pf.z * r.fwd.z < 0.9) out.fwdSnap++;
          if (r.kind === 'surfer') out.minUpY = Math.min(out.minUpY, r.up.y);
          const inTube = r.tube || (P.tube && t >= P.tube.t0 && t <= P.tube.t1);
          if (!inTube && !R.zb.closeout) {
            const H = columnState(R.front, r.u, t, {}).H;
            const yT = sampleFront(R.front, r.u, SIGMA_TROUGH, t).y, yF = sampleFront(R.front, r.u, r.sigma, t).y;
            const F = out.face.get(R.id) ?? { n: 0, ok: 0, name: r.name, front: R.frontId };
            F.n++; if (yF - yT >= 0.25 * H) F.ok++;
            out.face.set(R.id, F);
          }
        }
        out.prevFwd.set(r.id, { ...r.fwd });
        for (const v of [r.pos.x, r.pos.y, r.pos.z, r.fwd.x, r.fwd.y, r.fwd.z, r.up.x, r.up.y, r.up.z, r.speed, r.actionT, r.u])
          if (!Number.isFinite(v)) out.nan++;
        if (Math.abs(Math.hypot(r.fwd.x, r.fwd.y, r.fwd.z) - 1) > 1e-6 || Math.abs(Math.hypot(r.up.x, r.up.y, r.up.z) - 1) > 1e-6) out.nan++;
        out.states.add(r.state);
        const ps = prevState.get(r.id);
        if (ps && ps !== r.state && !NEXT[ps].includes(r.state)) out.badTransitions.push(`${t.toFixed(2)} ${r.name} ${ps}->${r.state}`);
        prevState.set(r.id, r.state);
        if (['POSITION', 'TAKEOFF', 'RIDE', 'KICKOUT', 'CLOSEOUT'].includes(r.state) && (r.frontId == null || !(r.zi >= 0))) out.idsMissing++;
        // on the surface while riding (surfers exactly; animals within their swimming depth unless leaping)
        if ((r.state === 'RIDE' || r.state === 'TAKEOFF') && r.action !== 'jump') {
          const f = swell.fronts.find((g) => g.id === r.frontId);
          if (f) {
            const dy = Math.abs(r.pos.y - surfaceHeight([f], r.pos.x, r.pos.z, t));
            if (r.kind === 'surfer') { if (dy > out.surfDy) { out.surfDy = dy; out.surfAt = `${r.name} ${r.action} t=${t.toFixed(2)}`; } }
            else if (dy > out.animalDy) out.animalDy = dy;
          }
        }
      }
      if (Math.abs(t / 0.5 - Math.round(t / 0.5)) < 1e-6) {
        out.trace.push(riders.riders.map((r) => `${r.state}:${r.action}:${r.pos.x.toFixed(4)},${r.pos.y.toFixed(4)},${r.pos.z.toFixed(4)}`).join('|'));
      }
    },
  });
  return { ...res, ...out };
}

let A = null;
const base = () => (A ??= run());

test('rides happen on demo-basic, no NaNs, valid states and transitions', () => {
  const a = base();
  assert.ok(a.riders.rides.length >= 8, `rides: ${a.riders.rides.length}`);
  assert.equal(a.nan, 0, 'non-finite / non-unit rider fields');
  assert.deepEqual(a.badTransitions, []);
  assert.equal(a.idsMissing, 0, 'frontId / zi must stay set from POSITION to the end of the ride');
  for (const s of ['LINEUP', 'POSITION', 'TAKEOFF', 'RIDE', 'KICKOUT', 'RETURN']) assert.ok(a.states.has(s), `state ${s} never seen`);
});

test('short take-offs, long standing rides, trail and action history for WP6b', () => {
  const a = base();
  for (const r of a.riders.rides) {
    assert.ok(r.tStand - r.tTakeoff <= 1.0 + 1e-9, `${r.name} front ${r.frontId}: ${(r.tStand - r.tTakeoff).toFixed(2)} s to stand`);
  }
  const pt = a.riders.rides.filter((r) => r.zone === 'point' && r.outcome === 'kickout').map((r) => r.tEnd - r.tStand);
  const mean = pt.reduce((x, y) => x + y, 0) / pt.length;
  assert.ok(mean >= 4, `mean standing point ride ${mean.toFixed(2)} s`);
  assert.ok(Math.max(...pt) >= 7, `longest point ride ${Math.max(...pt).toFixed(2)} s`);
  assert.ok(a.trailN > 100 && a.trailErr < 0.15, `trail error ${a.trailErr} over ${a.trailN} checks`);
  assert.equal(a.actBad, 0);
});

test('riders stay up on the face during RIDE (≥ 25 % of local H above the trough, tube / close-out excepted)', () => {
  const a = base();
  let n = 0, ok = 0;
  for (const F of a.face.values()) {
    n += F.n; ok += F.ok;
    assert.ok(F.ok / F.n >= 0.8, `${F.name} on front ${F.front}: ${(100 * F.ok / F.n).toFixed(0)} % on the face`);
  }
  assert.ok(n > 1000 && ok / n >= 0.9, `${(100 * ok / n).toFixed(1)} % of ride time on the face`);
});

test('ride pose stays sane: no heading snaps, surfers never tip over', () => {
  const a = base();
  assert.equal(a.fwdSnap, 0, 'fwd turned > 25° in one step');
  assert.ok(a.minUpY > 0.4, `surfer up.y down to ${a.minUpY.toFixed(2)}`);
});

test('every ride ends and every rider gets back to LINEUP', () => {
  const a = base();
  const takeoffs = a.events.filter((e) => e.type === 'takeoff');
  const ends = a.events.filter((e) => e.type === 'rideEnd');
  assert.equal(ends.length, takeoffs.length);
  for (const e of takeoffs) assert.ok(ends.some((x) => x.riderId === e.riderId && x.frontId === e.frontId && x.zi === e.zi && x.t > e.t));
  for (const e of ends) assert.ok(e.outcome === 'kickout' || e.outcome === 'closeout');
  assert.equal(a.riders.rides.length, ends.length);
  for (const r of a.riders.riders) assert.equal(r.state, 'LINEUP', `${r.name} is ${r.state} at the end`);
});

test('RideEvents are fresh objects with the contract fields', () => {
  const a = base();
  assert.equal(new Set(a.events).size, a.events.length);
  for (const e of a.events) {
    assert.ok(['takeoff', 'barrel', 'rideEnd'].includes(e.type));
    assert.ok(Number.isFinite(e.t) && Number.isInteger(e.riderId) && Number.isInteger(e.frontId) && e.zi >= 0);
  }
});

test('at least one takeoff per breaking point wave', () => {
  const a = base();
  const pts = a.breaks.filter((b) => b.zb.zone === 'point');
  assert.ok(pts.length >= 5, `point breaks: ${pts.length}`);
  for (const b of pts) {
    assert.ok(a.events.some((e) => e.type === 'takeoff' && e.frontId === b.frontId && e.zi === b.zi),
      `nobody took front ${b.frontId} (set ${b.set}) at the point`);
  }
});

test('styles follow the sets: cruise on the soft set, tube on the barrel set, carve on the wall set', () => {
  const a = base();
  const styles = (set) => a.riders.rides.filter((r) => r.set === set).map((r) => r.style);
  assert.ok(styles(0).includes('cruise'), `set 0: ${styles(0)}`);
  assert.ok(styles(1).includes('tube'), `set 1: ${styles(1)}`);
  assert.ok(styles(2).includes('carve'), `set 2: ${styles(2)}`);
  assert.ok(!styles(0).includes('tube') && !styles(0).includes('carve'), 'the soft set is not a carve / tube wave');
  // the tube ride actually sits in the barrel
  const tube = a.riders.rides.find((r) => r.set === 1 && r.style === 'tube');
  assert.ok(tube.barrelS > 0.3, `barrel time ${tube.barrelS}`);
  assert.ok(a.events.some((e) => e.type === 'barrel' && e.frontId === tube.frontId && e.riderId === tube.riderId));
  // the close-out set closes out on its riders
  const co = a.breaks.find((b) => b.zb.closeout);
  if (co) for (const r of a.riders.rides.filter((x) => x.frontId === co.frontId && x.zi === co.zi)) assert.equal(r.outcome, 'closeout');
});

test('riders stay on the wave surface while riding', () => {
  const a = base();
  assert.ok(a.surfDy < 0.3, `surfer |y − surface| up to ${a.surfDy.toFixed(3)} m (${a.surfAt})`);
  assert.ok(a.animalDy < 1.0, `animal |y − surface| up to ${a.animalDy.toFixed(3)} m`);
});

test('determinism: two runs are identical', () => {
  const a = base(), b = run();
  assert.deepEqual(b.riders.rides, a.riders.rides);
  assert.deepEqual(b.trace, a.trace);
  assert.deepEqual(b.events.map((e) => ({ ...e })), a.events.map((e) => ({ ...e })));
});

test('silence gives no rides', () => {
  const s = run({ name: 'silence', log: [], duration: 60 }, 60);
  assert.equal(s.riders.rides.length, 0);
  assert.equal(s.events.length, 0);
  assert.equal(s.nan, 0);
  for (const r of s.riders.riders) assert.equal(r.state, 'LINEUP');
  // idle behaviours run (each kind moves / animates)
  assert.ok(s.trace.length === Math.round(60 / 0.5) && new Set(s.trace).size > 10);
});

test('plan.seaLevel matches field.surfaceHeight (cheap scan used for bobbing)', () => {
  let worst = 0;
  simulate(demo, {
    until: 40,
    onStep(t, swell) {
      if (Math.abs(t - Math.round(t)) > 1e-6) return;
      for (let i = 0; i < 25; i++) {
        const x = 20 + 180 * hash01(i, Math.round(t), 1), z = -150 + 300 * hash01(i, Math.round(t), 2);
        worst = Math.max(worst, Math.abs(seaLevel(swell.fronts, x, z, t) - surfaceHeight(swell.fronts, x, z, t)));
      }
    },
  });
  assert.ok(worst < 1e-3, `max difference ${worst}`);
});

test('reset() rewinds to the initial lineup', () => {
  const a = base();
  const R = a.riders;
  R.reset();
  assert.equal(R.rides.length, 0);
  assert.equal(R.events.length, 0);
  for (const r of R.riders) assert.equal(r.state, 'LINEUP');
  assert.ok(DT > 0);
});
