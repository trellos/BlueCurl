// Fixed-step clock: stepsFor tolerance and chunking-independent determinism.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DT, stepsFor } from '../src/contracts.js';
import { FixedClock } from '../src/core/clock.js';

test('stepsFor rounds to the nearest step with a 1 %·DT tolerance', () => {
  assert.equal(stepsFor(0), 0);
  assert.equal(stepsFor(-1), 0);
  assert.equal(stepsFor(DT), 1);
  assert.equal(stepsFor(1), 120);
  assert.equal(stepsFor(3), 360);
  assert.equal(stepsFor(1 / 24), 5);
  assert.equal(stepsFor(0.041667), 5);          // 24 fps frame written with 6 digits
  assert.equal(stepsFor(0.0416), 5);
  assert.equal(stepsFor(1 / 60), 2);
  assert.equal(stepsFor(1 / 30), 4);
  assert.equal(stepsFor(DT * 0.49), 0);
  assert.equal(stepsFor(DT * 0.5), 1);          // the tolerance resolves the exact half upward
  assert.equal(stepsFor(DT * 1.48), 1);
  assert.equal(stepsFor(10 * DT - 1e-12), 10);  // float noise never loses a step
  assert.equal(stepsFor(10 * DT + 1e-12), 10);
});

// A dummy deterministic system: integrates a nonlinear state per step.
class Dummy {
  constructor() { this.n = 0; this.x = 0.123; this.lastT = 0; this.ts = []; }
  step(t, dt) {
    this.n++; this.lastT = t; this.ts.push(t);
    this.x = (this.x * 3.9 * (1 - this.x)) * 0.999 + Math.sin(t) * 1e-3 * dt;
  }
}

function drive(chunks) {
  const c = new FixedClock(), s = new Dummy();
  for (const sec of chunks) c.advance(sec, (t, dt) => s.step(t, dt));
  return { c, s };
}

test('different advance chunkings give identical steps, time and state', () => {
  const a = drive([3]);
  const b = drive(Array(72).fill(1 / 24));
  const c = drive(Array(72).fill(0.041667));
  const d = drive(Array(180).fill(1 / 60));
  const e = drive(Array(150).fill(1 / 50));      // 2.4 steps per chunk: the accumulator carries the rest
  const f = drive([0.5, 1.25, 0.004, 1.246]);
  for (const r of [a, b, c, d, e, f]) {
    assert.equal(r.s.n, 360);
    assert.equal(r.c.step, 360);
    assert.equal(r.c.t, 360 * DT);
    assert.equal(r.s.lastT, 3 * 1);
    assert.equal(r.s.x, a.s.x);                  // bit-identical state
    assert.deepEqual(r.s.ts, a.s.ts);
  }
});

test('each step is called with t = k·DT', () => {
  const { s } = drive([5 * DT]);
  assert.deepEqual(s.ts, [1, 2, 3, 4, 5].map((k) => k * DT));
});

test('reset and runSteps', () => {
  const c = new FixedClock();
  c.reset(2);
  assert.equal(c.step, 240);
  let n = 0;
  c.runSteps(12, () => n++);
  assert.equal(n, 12);
  assert.equal(c.t, 252 * DT);
  assert.equal(c.request(0), 0);                 // no pending steps after runSteps
  assert.equal(c.request(1 / 24), 5);
});
