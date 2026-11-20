import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  strengthStyle, impactLook, particleLocal, emitterCount, KIND_BURST, KIND_SPLASH, PARTICLES_PER_EMITTER,
  jumpParams, dolphinPose, jumpSplashes, shimmerLevel, GOLD, CYAN,
} from '../src/fx/fxMath.js';

test('strength → size/warmth: soft notes smaller and cooler, monotone', () => {
  const soft = strengthStyle(0.4), hard = strengthStyle(1.0);
  assert.ok(Math.abs(soft.size - 0.45) < 1e-9 && Math.abs(hard.size - 1) < 1e-9);
  assert.ok(soft.warm < 0.15 && hard.warm > 0.95);
  assert.ok(soft.color[2] > soft.color[0], 'soft is cyan-ish');
  assert.ok(hard.color[0] > hard.color[2], 'hard is gold-ish');
  let prev = -1;
  for (let s = 0; s <= 2; s += 0.05) { const v = strengthStyle(s).size; assert.ok(v >= prev - 1e-12); prev = v; }
  assert.deepEqual(strengthStyle(NaN), strengthStyle(1));
  assert.ok(GOLD[0] > GOLD[2] && CYAN[2] > CYAN[0]);
});

test('impact look: peaks at age 0 (next-frame visible), strong > soft, decays', () => {
  const s0 = impactLook(0.4, 0), h0 = impactLook(1, 0), h1 = impactLook(1, 1.5);
  for (const k of ['coreR', 'coreI', 'glowR', 'flareL', 'flareI', 'streakL', 'streakI', 'geyserI']) assert.ok(h0[k] > s0[k], k);
  assert.ok(h0.coreI > 4 && s0.coreI > 4, 'core above the bloom threshold (4) for every note');
  assert.ok(h0.coreI === impactLook(1, -0.01).coreI || impactLook(1, -0.01).coreI >= h0.coreI);
  assert.ok(impactLook(1, 1 / 120).coreI > 0.9 * h0.coreI, 'still ≥ 90 % one sim step later');
  assert.ok(h1.coreI < 0.01 * h0.coreI && h1.flareI < 0.01 * h0.flareI);
  assert.ok(h1.ringR > h0.ringR, 'ring expands');
  assert.ok(impactLook(1, 0, 15).streakL < impactLook(1, 0, 8).streakL, 'streak spans ± a lane');
});

test('particle trajectory: deterministic, from the origin, ballistic, seeded per emitter', () => {
  const a = particleLocal(40, 7, KIND_BURST, 1, 0.8), b = particleLocal(40, 7, KIND_BURST, 1, 0.8);
  assert.deepEqual(a, b);
  const c = particleLocal(44, 7, KIND_BURST, 1, 0.8);
  assert.notEqual(a.x, c.x);
  // starts at the origin (before its tiny launch delay)
  const z0 = particleLocal(40, 7, KIND_BURST, 1, 0);
  assert.ok(Math.hypot(z0.x, z0.y, z0.z) < 1e-9);
  // evaluated at any age without integration: same value regardless of evaluation order
  const seq = [0.3, 1.2, 0.3].map((t) => particleLocal(9, 3, KIND_BURST, 0.7, t).y);
  assert.equal(seq[0], seq[2]);
  // every burst particle rises first and eventually falls (gravity) — check the apex exists
  let rises = 0, falls = 0;
  for (let k = 0; k < 64; k++) {
    const p1 = particleLocal(12, k, KIND_BURST, 1, 0.15), p2 = particleLocal(12, k, KIND_BURST, 1, 3.5);
    if (p1.y > 0) rises++;
    if (p2.y < particleLocal(12, k, KIND_BURST, 1, 1.0).y) falls++;
  }
  assert.equal(rises, 64); assert.equal(falls, 64);
  // finite life
  assert.equal(particleLocal(12, 1, KIND_BURST, 1, 5).alive, false);
  assert.equal(particleLocal(12, 1, KIND_SPLASH, 1, 3).alive, false);
});

test('particle budget: ≤ 320 per emitter, strong bursts bigger, ≤ 20k with 48 emitters', () => {
  assert.ok(emitterCount(KIND_BURST, 1) > emitterCount(KIND_BURST, 0.45));
  assert.ok(emitterCount(KIND_BURST, 1.3) <= PARTICLES_PER_EMITTER);
  assert.ok(emitterCount(KIND_SPLASH, 1) <= PARTICLES_PER_EMITTER);
  assert.ok(48 * PARTICLES_PER_EMITTER <= 20000);
  // strong particles fly farther on average
  const reach = (size) => { let s = 0; for (let k = 0; k < 200; k++) { const p = particleLocal(5, k, KIND_BURST, size, 0.6); s += Math.hypot(p.x, p.y, p.z); } return s / 200; };
  assert.ok(reach(1) > reach(0.45) * 1.2);
});

test('dolphin jump: deterministic from id, ~1.4 s arc, under water at the ends, splashes at y = 0', () => {
  const jp = jumpParams(17, 1);
  assert.deepEqual(jp, jumpParams(17, 1));
  assert.notDeepEqual(jp, jumpParams(18, 1));
  assert.ok(jp.D >= 1.3 && jp.D <= 1.5);
  const p0 = dolphinPose(jp, jp.delay), pm = dolphinPose(jp, jp.delay + jp.D / 2), p1 = dolphinPose(jp, jp.delay + jp.D);
  assert.ok(p0.y < 0 && p1.y < 0 && pm.y > 3, 'leaps out and back');
  assert.ok(p0.pitch > 0 && p1.pitch < 0 && Math.abs(pm.pitch) < 1e-9, 'nose follows the arc');
  assert.equal(dolphinPose(jp, 0).visible, false);
  assert.equal(dolphinPose(jp, jp.delay + jp.D * 1.5).visible, false);
  const [a, b] = jumpSplashes(jp);
  assert.ok(a.t > jp.delay && b.t < jp.delay + jp.D && b.t > a.t);
  assert.ok(Math.abs(dolphinPose(jp, a.t).y) < 1e-9 && Math.abs(dolphinPose(jp, b.t).y) < 1e-9);
});

test('shimmer grows with energy and pulses', () => {
  const l0 = shimmerLevel(0, 0, 1), l1 = shimmerLevel(4, 0, 1), l2 = shimmerLevel(4, 1, 1);
  assert.ok(l1.core > l0.core && l2.core > l1.core && l1.width > l0.width);
  assert.equal(shimmerLevel(4, 0, 0).core, 0);
});
