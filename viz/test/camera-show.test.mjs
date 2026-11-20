// M2 camera: enter / flock show tiles in the PiP policy, calm push-in while riders enter / leave.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DT } from '../src/contracts.js';
import { createPipState, pipStep, pipLayout, PIP_DEFAULTS, SHOW_RANK } from '../src/camera/pipPolicy.js';
import { PushIn, PUSH, calmFrom } from '../src/camera/push.js';
import { FollowCam, framing, FLOCK_LOOK_UP } from '../src/camera/followCam.js';

const cfg = (o = {}) => ({ ...PIP_DEFAULTS, ...o });
const pos = { x: 300, y: 0, z: 40 };
const ev = (t, type, riderId, extra = {}) => ({ t, type, riderId, frontId: type === 'enter' || type === 'flock' ? undefined : riderId * 10, zi: 1, pos, ...extra });

function run(events, tEnd, c = cfg(), { prio = () => 2, ongoing = () => [] } = {}) {
  let s = createPipState();
  const n = Math.round(tEnd / DT);
  for (let k = 1; k <= n; k++) {
    const t = k * DT;
    const due = events.filter((e) => e.t > t - DT + 1e-9 && e.t <= t + 1e-9);
    s = pipStep(s, due, t, c, () => null, ongoing(t), prio);
  }
  return s;
}

test('defaults: onEnter / onFlock on, enterHold 3.5 s, flockHold 3 s; flock outranks enter', () => {
  assert.equal(PIP_DEFAULTS.onEnter, true);
  assert.equal(PIP_DEFAULTS.onFlock, true);
  assert.equal(PIP_DEFAULTS.enterHold, 3.5);
  assert.equal(PIP_DEFAULTS.flockHold, 3);
  assert.ok(SHOW_RANK.flock > SHOW_RANK.enter);
});

test('enter opens a show tile for enterHold s, then it slides out', () => {
  let s = run([ev(1, 'enter', 6)], 2);
  assert.equal(s.tiles.length, 1);
  assert.equal(s.tiles[0].riderId, 6);
  assert.equal(s.tiles[0].show, 'enter');
  assert.ok(Math.abs(s.tiles[0].endAt - 4.5) < 1e-6);
  assert.equal(pipLayout(s, 2, cfg())[0].show, 'enter');
  s = run([ev(1, 'enter', 6)], 4.6);
  assert.equal(s.tiles.length, 0);
  assert.equal(s.leaving.length, 1);
  // switched off → nothing
  assert.equal(run([ev(1, 'enter', 6)], 2, cfg({ onEnter: false })).tiles.length, 0);
  assert.equal(run([ev(1, 'flock', 6)], 2, cfg({ onFlock: false })).tiles.length, 0);
  assert.equal(run([ev(1, 'flock', 6)], 2, cfg({ enabled: false })).tiles.length, 0);
});

test('an enter never interrupts a ride tile (riding or holding)', () => {
  let s = run([ev(1, 'takeoff', 0), ev(2, 'enter', 6)], 2.5);
  assert.deepEqual(s.tiles.map((x) => [x.riderId, x.show]), [[0, null]]);
  s = run([ev(1, 'takeoff', 0), ev(2, 'rideEnd', 0), ev(2.5, 'enter', 6), ev(2.6, 'flock', 4)], 3);
  assert.deepEqual(s.tiles.map((x) => [x.riderId, x.show]), [[0, null]]);
});

test('rides pre-empt show tiles: takeoff, barrel and a ride still going', () => {
  let s = run([ev(1, 'enter', 6), ev(2, 'takeoff', 0)], 2.2, cfg(), { prio: () => 1 });
  assert.deepEqual(s.tiles.map((x) => [x.riderId, x.show, x.cut]), [[0, null, true]]);
  s = run([ev(1, 'flock', 4), ev(2, 'barrel', 1)], 2.2);
  assert.deepEqual(s.tiles.map((x) => [x.riderId, x.show]), [[1, null]]);
  // a ride in progress that was not on screen takes the slot from a show tile the same step it opens
  s = run([ev(1, 'enter', 6)], 1.2, cfg(), { ongoing: (t) => [{ riderId: 2, frontId: 20, zi: 1, tube: false, since: 0.5 }] });
  assert.deepEqual(s.tiles.map((x) => [x.riderId, x.show]), [[2, null]]);
});

test('flock replaces an enter tile; an enter does not replace a flock; own enter → flock gets a new key', () => {
  let s = run([ev(1, 'enter', 6), ev(2, 'flock', 4)], 2.2);
  assert.deepEqual(s.tiles.map((x) => [x.riderId, x.show]), [[4, 'flock']]);
  assert.ok(Math.abs(s.tiles[0].endAt - 5) < 1e-6);
  s = run([ev(1, 'flock', 4), ev(2, 'enter', 6)], 2.2);
  assert.deepEqual(s.tiles.map((x) => [x.riderId, x.show]), [[4, 'flock']]);
  // same rank: a newer show replaces one that has been up ≥ SHOW_MIN, not a fresh one
  s = run([ev(1, 'enter', 6), ev(2, 'enter', 3)], 2.2);
  assert.deepEqual(s.tiles.map((x) => [x.riderId, x.show]), [[6, 'enter']]);
  s = run([ev(1, 'enter', 6), ev(3, 'enter', 3)], 3.2);
  assert.deepEqual(s.tiles.map((x) => [x.riderId, x.show]), [[3, 'enter']]);
  s = run([ev(1, 'flock', 4), ev(3, 'flock', 1), ev(3.5, 'enter', 6)], 3.6);
  assert.deepEqual(s.tiles.map((x) => [x.riderId, x.show]), [[1, 'flock']]);
  s = run([ev(1, 'flock', 4), ev(1.2, 'flock', 1)], 1.4);
  assert.deepEqual(s.tiles.map((x) => [x.riderId, x.show]), [[4, 'flock']]);
  const a = run([ev(1, 'enter', 6)], 1.5), b = run([ev(1, 'enter', 6), ev(2, 'flock', 6)], 2.2);
  assert.equal(b.tiles[0].show, 'flock');
  assert.notEqual(b.tiles[0].key, a.tiles[0].key);
  assert.equal(b.tiles[0].cut, true);
  // a takeoff by the rider on its own show tile turns it back into a ride tile (same key)
  const c = run([ev(1, 'enter', 6), ev(2, 'takeoff', 6)], 2.2);
  assert.deepEqual(c.tiles.map((x) => [x.key, x.show, x.endAt]), [[a.tiles[0].key, null, null]]);
});

test('show policy is a pure function of its inputs', () => {
  const evs = [ev(1, 'enter', 6), ev(2, 'flock', 4), ev(3, 'takeoff', 0), ev(5, 'rideEnd', 0), ev(5.2, 'enter', 3)];
  assert.deepEqual(run(evs, 7), run(evs, 7));
});

test('flock framing looks up at the birds from further out; works for a rider that is not riding', () => {
  const f = framing('seal', 'flock', 1.5);
  assert.ok(f.lookUp === FLOCK_LOOK_UP && f.fov > 55);
  const fc = new FollowCam();
  const out = fc.step(DT, { pos: { x: 300, y: 0, z: 40 }, kind: 'seal', style: 'flock', state: 'LINEUP', H: 1.5, dir: 0, surface: () => 0 });
  const d = Math.hypot(out.x - 300, out.z - 40);
  assert.ok(d > 30 && d < 70, `distance ${d}`);
  assert.ok(out.pitch > 0, 'looks up');
  // an enter tile (default framing, not riding) also gets a solved offset on its first step
  const fe = new FollowCam();
  const o2 = fe.step(DT, { pos: { x: 300, y: 0, z: 40 }, kind: 'surfer', style: 'cruise', state: 'ENTER', H: 1.5, dir: 0, surface: () => 0 });
  assert.ok(Math.hypot(o2.x - 300, o2.z - 40) > 3);
});

test('push-in calms to calmAmt while riders enter / leave or a flock is live', () => {
  const lists = (st) => [[{ id: 0, state: 'LINEUP' }, { id: 6, state: st }]];
  assert.equal(calmFrom(5, lists('LINEUP'), []), false);
  assert.equal(calmFrom(5, lists('ENTER'), []), true);
  assert.equal(calmFrom(5, lists('LEAVE'), []), true);
  assert.equal(calmFrom(5, lists('LINEUP'), [{ t: 3, pos }]), true);
  assert.equal(calmFrom(5, lists('LINEUP'), [{ t: 1, pos }]), false);
  const p = new PushIn();
  for (let k = 0; k < 600; k++) p.step(k * DT, DT, [], true);
  p.p = 1;                              // pretend fully pushed in
  assert.ok(Math.abs(p.weight() - PUSH.calmAmt) < 1e-9);
  for (let k = 0; k < 600; k++) { p.step(5 + k * DT, DT, [], false); p.p = 1; }
  assert.ok(Math.abs(p.weight() - 1) < 1e-9);
});
