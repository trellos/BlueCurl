// WP7 camera: PiP trigger policy (pure) and follow-cam smoothing determinism.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DT } from '../src/contracts.js';
import { FixedClock } from '../src/core/clock.js';
import { createPipState, pipStep, pipLayout, PIP_ANIM, PIP_DEFAULTS } from '../src/camera/pipPolicy.js';
import { FollowCam, framing } from '../src/camera/followCam.js';
import { widePose, WIDE } from '../src/camera/wide.js';

const cfg = (o = {}) => ({ ...PIP_DEFAULTS, ...o });
const ev = (t, type, riderId, extra = {}) => ({ t, type, riderId, frontId: riderId * 10, zi: 1, ...extra });
const H = (map) => (e) => (e.riderId in map ? map[e.riderId] : null);

/** Run the policy over a timeline of events at the sim DT; returns the state at tEnd. */
function run(events, tEnd, c = cfg(), heightOf = () => null, state = createPipState(), t0 = 0) {
  let s = state;
  const n = Math.round((tEnd - t0) / DT);
  for (let k = 1; k <= n; k++) {
    const t = t0 + k * DT;
    const due = events.filter((e) => e.t > t - DT + 1e-9 && e.t <= t + 1e-9);
    s = pipStep(s, due, t, c, heightOf);
  }
  return s;
}

test('takeoff opens a tile; layout is a third of the screen in the bottom-right corner', () => {
  const s = run([ev(1, 'takeoff', 2)], 1.5);
  assert.equal(s.tiles.length, 1);
  assert.equal(s.tiles[0].riderId, 2);
  const [L] = pipLayout(s, 1.5, cfg(), 16 / 9);
  assert.equal(L.alpha, 1);
  assert.ok(Math.abs(L.rect.w - 1 / 3) < 1e-9 && Math.abs(L.rect.h - 1 / 3) < 1e-9);
  assert.ok(L.rect.x > 0.6 && L.rect.x + L.rect.w < 1 && L.rect.y > 0.6 && L.rect.y + L.rect.h < 1);
  // sliding in: offset toward the right edge, eased
  const [Lin] = pipLayout(s, 1 + PIP_ANIM / 2, cfg(), 16 / 9);
  assert.equal(Lin.phase, 'in');
  assert.ok(Lin.rect.x > L.rect.x && Lin.alpha > 0 && Lin.alpha < 1);
});

test('disabled / onTakeoff off → no tile', () => {
  assert.equal(run([ev(1, 'takeoff', 2)], 1.5, cfg({ enabled: false })).tiles.length, 0);
  assert.equal(run([ev(1, 'takeoff', 2)], 1.5, cfg({ onTakeoff: false })).tiles.length, 0);
  // but a barrel still opens one when onTakeoff is off
  assert.equal(run([ev(1, 'takeoff', 2), ev(2, 'barrel', 2)], 2.5, cfg({ onTakeoff: false })).tiles.length, 1);
});

test('minHeight filters small rides (unknown height passes)', () => {
  assert.equal(run([ev(1, 'takeoff', 2)], 1.5, cfg({ minHeight: 0.8 }), H({ 2: 0.5 })).tiles.length, 0);
  assert.equal(run([ev(1, 'takeoff', 2)], 1.5, cfg({ minHeight: 0.8 }), H({ 2: 1.2 })).tiles.length, 1);
  assert.equal(run([ev(1, 'takeoff', 2)], 1.5, cfg({ minHeight: 0.8 }), H({})).tiles.length, 1);
  assert.equal(run([ev(1, 'barrel', 2)], 1.5, cfg({ minHeight: 2 }), H({ 2: 1.5 })).tiles.length, 0);
});

test('busy: another takeoff keeps the current ride; a barrel for another rider switches in place', () => {
  const evs = [ev(1, 'takeoff', 2), ev(2, 'takeoff', 3)];
  let s = run(evs, 2.5);
  assert.deepEqual(s.tiles.map((x) => x.riderId), [2]);
  s = run([...evs, ev(3, 'barrel', 3)], 3.5);
  assert.deepEqual(s.tiles.map((x) => x.riderId), [3]);
  assert.equal(s.tiles[0].slot, 0);
  assert.ok(s.tiles[0].cut && s.tiles[0].barrel);
  // the replaced tile is not drawn while it "leaves" (a cut, not a slide)
  const s2 = run([...evs, ev(3, 'barrel', 3)], 3 + DT * 2);
  assert.deepEqual(pipLayout(s2, 3 + DT * 2, cfg()).map((x) => x.riderId), [3]);
  // a barrelling tile is not switched away by another barrel
  const s3 = run([ev(1, 'takeoff', 2), ev(1.5, 'barrel', 2), ev(2, 'takeoff', 3), ev(2.5, 'barrel', 3)], 3);
  assert.deepEqual(s3.tiles.map((x) => x.riderId), [2]);
  // barrel for the rider already shown just marks it
  const s4 = run([ev(1, 'takeoff', 2), ev(2, 'barrel', 2)], 2.5);
  assert.equal(s4.tiles.length, 1);
  assert.equal(s4.tiles[0].barrel, true);
  assert.ok(!s4.tiles[0].cut);
});

test('rideEnd holds for holdAfterRide, then the tile slides out and is gone', () => {
  const c = cfg({ holdAfterRide: 1.5 });
  const evs = [ev(1, 'takeoff', 2), ev(4, 'rideEnd', 2, { outcome: 'kickout' })];
  let s = run(evs, 5.4, c);
  assert.equal(s.tiles.length, 1);
  assert.ok(Math.abs(s.tiles[0].endAt - 5.5) < 1e-9);
  assert.equal(pipLayout(s, 5.4, c)[0].phase, 'hold');
  s = run(evs, 5.6, c);
  assert.equal(s.tiles.length, 0);
  assert.equal(s.leaving.length, 1);
  const [Lout] = pipLayout(s, 5.6, c);
  assert.equal(Lout.phase, 'out');
  assert.ok(Lout.alpha < 1 && Lout.alpha > 0);
  s = run(evs, 5.5 + PIP_ANIM + 0.05, c);
  assert.equal(s.leaving.length, 0);
  assert.equal(pipLayout(s, 5.5 + PIP_ANIM + 0.05, c).length, 0);
  // a takeoff while the only tile is holding replaces it
  s = run([...evs, ev(4.5, 'takeoff', 3)], 4.7, c);
  assert.deepEqual(s.tiles.map((x) => x.riderId), [3]);
});

test('maxConcurrent N: tiles stack upward from the corner; extra rides wait; lowering N drops the newest', () => {
  const c = cfg({ maxConcurrent: 2 });
  const evs = [ev(1, 'takeoff', 1), ev(1.2, 'takeoff', 2), ev(1.4, 'takeoff', 3)];
  let s = run(evs, 2, c);
  assert.deepEqual(s.tiles.map((x) => [x.riderId, x.slot]), [[1, 0], [2, 1]]);
  const L = pipLayout(s, 2, c, 16 / 9);
  const r0 = L.find((x) => x.slot === 0).rect, r1 = L.find((x) => x.slot === 1).rect;
  assert.ok(r1.y + r1.h <= r0.y);                     // slot 1 sits above slot 0
  assert.equal(r1.x, r0.x);
  // top-left corner stacks downward
  const Ltl = pipLayout(s, 2, cfg({ maxConcurrent: 2, corner: 'top-left' }), 16 / 9);
  const a = Ltl.find((x) => x.slot === 0).rect, b = Ltl.find((x) => x.slot === 1).rect;
  assert.ok(a.x < 0.1 && a.y < 0.1 && b.y >= a.y + a.h);
  // a freed slot is reused
  s = run([...evs, ev(2, 'rideEnd', 1), ev(4, 'takeoff', 4)], 4.2, cfg({ maxConcurrent: 2, holdAfterRide: 0.5 }));
  assert.deepEqual(s.tiles.map((x) => [x.riderId, x.slot]).sort(), [[2, 1], [4, 0]]);
  // lowering maxConcurrent removes the newest tile
  s = run(evs, 2, c);
  s = pipStep(s, [], 2 + DT, cfg({ maxConcurrent: 1 }));
  assert.deepEqual(s.tiles.map((x) => x.riderId), [1]);
});

test('policy is a pure function (same inputs → same state; input state untouched)', () => {
  const evs = [ev(1, 'takeoff', 2), ev(2, 'barrel', 3), ev(3, 'rideEnd', 3)];
  const a = run(evs, 6), b = run(evs, 6);
  assert.deepEqual(a, b);
  const s0 = run(evs, 1.5), snap = JSON.stringify(s0);
  pipStep(s0, [ev(1.6, 'barrel', 9)], 1.6, cfg());
  assert.equal(JSON.stringify(s0), snap);
});

// ------------------------------------------------------------------ follow cam
const riderAt = (t) => ({
  pos: { x: 90 - 6 * t + 1.5 * Math.sin(2.2 * t), y: 0.8 + 0.6 * Math.sin(2.2 * t), z: -20 + 8 * t },
  fwd: { x: -0.3 * Math.cos(2.2 * t), y: 0, z: 1 },
  kind: 'surfer', style: t > 2 && t < 3.5 ? 'tube' : 'carve', H: 2.4, dir: 1,
});
const surface = (t) => (x, z) => 0.3 * Math.sin(0.05 * x + t) + 0.2 * Math.sin(0.07 * z - 0.5 * t);

function chased(chunks) {
  const clock = new FixedClock(DT), fc = new FollowCam();
  for (const c of chunks) clock.advance(c, (t, dt) => { const r = riderAt(t); fc.step(dt, { ...r, surface: surface(t) }); });
  return { steps: clock.step, snap: fc.snapshot() };
}

test('follow cam: identical state under different step chunking (resumable)', () => {
  const one = chased([5]);
  const many = chased(Array(120).fill(5 / 120));
  const odd = chased([0.013, 1.7, 0.0041, 0.9, 2.3829, 0.0001, 5 - (0.013 + 1.7 + 0.0041 + 0.9 + 2.3829 + 0.0001)]);
  assert.equal(one.steps, 600);
  assert.deepEqual(many, one);
  assert.deepEqual(odd, one);
});

test('follow cam: stays ≥ 0.8 m above the water, roll 0, frames the rider from ahead and shoreward', () => {
  const clock = new FixedClock(DT), fc = new FollowCam();
  let minClear = Infinity;
  clock.advance(5, (t, dt) => {
    const r = riderAt(t), surf = surface(t), o = fc.step(dt, { ...r, surface: surf });
    minClear = Math.min(minClear, o.y - surf(o.x, o.z));
    assert.equal(o.roll, 0);
    if (t > 1.5 && r.style === 'carve') {
      assert.ok(o.z > r.pos.z + 3, 'ahead along the ride direction');
      assert.ok(o.x < r.pos.x, 'shoreward of the rider');
      // camera looks roughly back at the rider (rider within ~35° of the view axis)
      const dx = r.pos.x - o.x, dz = r.pos.z - o.z;
      const vx = -Math.sin(o.yaw), vz = -Math.cos(o.yaw);
      assert.ok((dx * vx + dz * vz) / Math.hypot(dx, dz) > Math.cos((35 * Math.PI) / 180));
    }
  });
  assert.ok(minClear >= 0.8 - 1e-9, `clearance ${minClear}`);
  const s = framing('surfer', 'carve', 2), d = framing('dolphin', 'carve', 2);
  assert.ok(d.h < s.h && d.a < s.a && d.b < s.b, 'animals: lower and closer');
});

test('wide pose: drift is a small pure function of t', () => {
  const a = widePose(12.34), b = widePose(12.34);
  assert.deepEqual(a, b);
  for (let t = 0; t < 200; t += 0.7) {
    const p = widePose(t);
    assert.ok(Math.hypot(p.px - WIDE.position[0], p.py - WIDE.position[1], p.pz - WIDE.position[2]) < 2);
  }
  const s = widePose(5, WIDE, 0);
  assert.deepEqual([s.px, s.py, s.pz], WIDE.position);
});
