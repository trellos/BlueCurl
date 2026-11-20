import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DT, STEP_TOL, DEFAULT_CFG } from '../src/contracts.js';
import { InputBus, applyCfgEvent, boundaryAfter } from '../src/input/input.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

test('log stays sorted by (t, seq) with future events queued in time order', () => {
  const bus = new InputBus(() => 0);
  bus.impulse({ lane: 1, time: 3 });
  bus.impulse({ lane: 2, time: 1 });
  bus.setConfig('bars', 2, 2);
  bus.impulse({ lane: 3, time: 1 });
  const ts = bus.log.map((e) => e.t);
  assert.deepEqual(ts, [...ts].sort((a, b) => a - b));
  for (let i = 1; i < bus.log.length; i++) {
    const a = bus.log[i - 1], b = bus.log[i];
    assert.ok(a.t < b.t || (a.t === b.t && a.seq < b.seq));
  }
  assert.deepEqual(bus.log.map((e) => e.lane ?? e.key), [2, 3, 'bars', 1]);
  // times are quantised to step boundaries
  for (const e of bus.log) assert.ok(near(e.t / DT, Math.round(e.t / DT), 1e-6));
});

test('live events land on the next step boundary; past times are clamped', () => {
  let now = 120 * DT;
  const bus = new InputBus(() => now);
  // exactly on a boundary → the following one
  bus.impulse({ lane: 0 });
  assert.ok(near(bus.log[0].t, 121 * DT));
  now = 1.234;
  bus.impulse({ lane: 0 });
  const t = bus.log[1].t;
  assert.ok(t > now + STEP_TOL / 2 && t - DT <= now + STEP_TOL / 2, `t=${t}`);
  // past time → next boundary
  now = 5;
  bus.impulse({ lane: 0, time: 3 });
  assert.ok(near(bus.log[2].t, boundaryAfter(5)));
  // future time → quantised to the nearest step
  bus.impulse({ lane: 0, time: 7.0012 });
  assert.ok(near(bus.log[3].t, Math.round(7.0012 / DT) * DT));
  // u is filled in
  assert.ok(near(bus.log[0].u, 0.5 / 8));
});

test('drained time also clamps: nothing is inserted behind the drain cursor', () => {
  const bus = new InputBus(() => 0);
  bus.drainUntil(10);
  bus.impulse({ lane: 4, time: 2 });
  assert.ok(bus.log[0].t > 10);
  assert.equal(bus.drainUntil(10).length, 0);
  assert.equal(bus.drainUntil(10 + 2 * DT).length, 1);
});

test('duration schedules the off; release logs an off with duration', () => {
  const bus = new InputBus(() => 0);
  const id = bus.impulse({ lane: 5, time: 2, duration: 0.5 });
  const off = bus.log.find((e) => e.type === 'off' && e.id === id);
  assert.ok(off && near(off.t, 2.5, DT));
  assert.ok(near(off.duration, off.t - 2));
  bus.release(id, 4); // already has an off → ignored
  assert.equal(bus.log.filter((e) => e.type === 'off').length, 1);

  let now = 1;
  const live = new InputBus(() => now);
  const id2 = live.impulse({ lane: 0 });
  now = 1.75;
  live.release(id2);
  const off2 = live.log.find((e) => e.type === 'off');
  assert.equal(off2.id, id2);
  assert.ok(near(off2.duration, off2.t - live.log[0].t));
  assert.ok(off2.duration > 0.7 && off2.duration < 0.8);
  // release with a time before the note still lands at least one step after it
  const id3 = live.impulse({ lane: 1, time: 3 });
  live.release(id3, 2);
  const off3 = live.log.find((e) => e.type === 'off' && e.id === id3);
  assert.ok(off3.t >= 3 + DT - 1e-9);
});

test('drainUntil returns each event once in seq order; reset rewinds; load accepts demos', () => {
  const bus = new InputBus(() => 0);
  bus.impulse({ lane: 0, time: 1 });
  bus.impulse({ lane: 1, time: 1 });
  bus.impulse({ lane: 2, time: 2 });
  assert.equal(bus.drainUntil(0.5).length, 0);
  const a = bus.drainUntil(1);
  assert.deepEqual(a.map((e) => e.lane), [0, 1]);
  assert.equal(bus.drainUntil(1).length, 0);
  assert.equal(bus.drainUntil(5).length, 1);
  bus.reset();
  assert.equal(bus.drainUntil(5).length, 3);

  const demo = { version: 1, cfg: { bars: 2, pip: { enabled: false } }, log: [
    { t: 1, type: 'on', id: 7, lane: 3, lanes: 8, scale: 1, velocity: 1, duration: 0.25 },
    { t: 0.5, type: 'on', id: 3, lane: 1, scale: 1, velocity: 0.4 },
  ] };
  const b2 = new InputBus(() => 0);
  b2.load(demo);
  assert.deepEqual(b2.log.slice(0, 2).map((e) => [e.t, e.type, e.key, e.value]), [[0, 'cfg', 'bars', 2], [0, 'cfg', 'pip.enabled', false]]);
  assert.deepEqual(b2.log.slice(2).map((e) => [e.type, e.id]), [['on', 3], ['on', 7], ['off', 7]]);
  assert.ok(near(b2.log[2].u, 1.5 / 8));
  for (let i = 1; i < b2.log.length; i++) assert.ok(b2.log[i].seq > b2.log[i - 1].seq);
  // new ids continue after loaded ones
  assert.equal(b2.impulse({ lane: 0, time: 9 }), 8);
  // loading an array works too, and cfg events apply to a config object
  const b3 = new InputBus();
  b3.load(b2.log);
  assert.equal(b3.log.length, b2.log.length);
  const cfg = structuredClone(DEFAULT_CFG);
  for (const e of b3.drainUntil(0)) applyCfgEvent(cfg, e);
  assert.equal(cfg.bars, 2);
  assert.equal(cfg.pip.enabled, false);
});

test('same calls give the same log', () => {
  const run = () => {
    let now = 0;
    const bus = new InputBus(() => now);
    for (let i = 0; i < 20; i++) {
      now = i * 0.37;
      const id = bus.impulse({ lane: i % 8, velocity: i % 3 ? 1 : 0.4, duration: i % 4 ? null : 0.3 });
      if (i % 4 === 1) bus.release(id, now + 0.2);
      if (i % 7 === 0) bus.setConfig('bpm', 120 + i);
    }
    return JSON.stringify(bus.log);
  };
  assert.equal(run(), run());
});

function fakeTarget() {
  const h = {};
  return {
    addEventListener: (type, fn) => { (h[type] ||= []).push(fn); },
    removeEventListener: (type, fn) => { h[type] = (h[type] || []).filter((f) => f !== fn); },
    fire: (type, o) => { for (const fn of h[type] || []) fn({ preventDefault() {}, ...o }); },
    count: (type) => (h[type] || []).length,
  };
}

test('keyboard mapping', () => {
  let now = 0;
  const bus = new InputBus(() => now);
  const tgt = fakeTarget();
  const unbind = bus.bindKeyboard(tgt);
  tgt.fire('keydown', { code: 'Digit3', key: '3' });
  tgt.fire('keydown', { code: 'Digit3', key: '3', repeat: true });          // auto-repeat ignored
  tgt.fire('keydown', { code: 'Numpad8', key: '8' });
  tgt.fire('keydown', { code: 'Digit1', key: '!', shiftKey: true });        // soft
  tgt.fire('keydown', { code: 'Digit9', key: '9' });                        // not a lane
  tgt.fire('keydown', { code: 'Digit2', key: '2', ctrlKey: true });         // browser shortcut: ignored
  const ons = bus.log.filter((e) => e.type === 'on');
  assert.deepEqual(ons.map((e) => [e.lane, e.velocity]), [[2, 1], [7, 1], [0, 0.4]]);
  now = 0.5;
  tgt.fire('keyup', { code: 'Digit3', key: '3' });
  const off = bus.log.find((e) => e.type === 'off');
  assert.equal(off.id, ons[0].id);
  assert.ok(off.duration > 0.45 && off.duration < 0.55);

  const val = (k) => bus._cfgValue(k);
  tgt.fire('keydown', { code: 'KeyI' }); assert.equal(val('bars'), 16);
  tgt.fire('keydown', { code: 'KeyI' }); assert.equal(val('bars'), 2);
  tgt.fire('keydown', { code: 'KeyI' }); assert.equal(val('bars'), 8);
  tgt.fire('keydown', { code: 'BracketRight' }); assert.equal(val('bpm'), 125);
  tgt.fire('keydown', { code: 'BracketLeft' });
  tgt.fire('keydown', { code: 'BracketLeft' }); assert.equal(val('bpm'), 115);
  tgt.fire('keydown', { code: 'Comma' }); assert.equal(val('travel'), 13);
  tgt.fire('keydown', { code: 'Period' });
  tgt.fire('keydown', { code: 'Period' }); assert.equal(val('travel'), 15);
  for (let i = 0; i < 30; i++) tgt.fire('keydown', { code: 'Comma' });
  assert.equal(val('travel'), 6);
  for (let i = 0; i < 40; i++) tgt.fire('keydown', { code: 'Period' });
  assert.equal(val('travel'), 30);
  tgt.fire('keydown', { code: 'KeyS' }); assert.equal(val('setSize'), 4);
  tgt.fire('keydown', { code: 'KeyS' }); assert.equal(val('setSize'), 1);
  tgt.fire('keydown', { code: 'KeyP' }); assert.equal(val('pip.enabled'), false);
  tgt.fire('keydown', { code: 'KeyP' }); assert.equal(val('pip.enabled'), true);
  // all config changes are logged
  assert.ok(bus.log.filter((e) => e.type === 'cfg').length >= 10);
  unbind();
  assert.equal(tgt.count('keydown'), 0);
});

test('bindKeyboard is safe in node', () => {
  const bus = new InputBus();
  assert.doesNotThrow(() => bus.bindKeyboard());
  assert.doesNotThrow(() => bus.bindKeyboard(null));
});
