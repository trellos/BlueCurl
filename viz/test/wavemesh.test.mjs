// WP4b: pure helpers of the wave renderer (clip windows, ocean-hook boxes, spray scheduling, crest history).
import test from 'node:test';
import assert from 'node:assert/strict';
import { NCOLS, ZONES } from '../src/contracts.js';
import { computeClips, frontHmax, MAX_FRONT_MESHES } from '../src/wave/WaveMesh.js';
import { OceanHook, CUT_OVERSHOOT, RAMP, MAX_HOOK_FRONTS } from '../src/wave/oceanHook.js';
import { activeSprayBreaks, fillCrestHistory, XHIST_N, XHIST_DT, SPRAY_PER_FRONT, SPRAY_MAX_FRONTS, SPRAY_LIFE_MAX } from '../src/wave/spray.js';
import { makeWaveGeometry, WAVE_COLS, WAVE_ROWS } from '../src/wave/waveMaterial.js';
import { extentBack, extentFront } from '../src/wave/profile.js';
import { makeFront, zoneBreak } from '../dev/wave-fronts.js';

const flat = (H) => () => [H, 0.5, 0.5, 0.1];

test('budgets: vertices and particles', () => {
  assert.ok(MAX_FRONT_MESHES * WAVE_COLS * WAVE_ROWS <= 200000);
  assert.ok(SPRAY_PER_FRONT * SPRAY_MAX_FRONTS <= 30000);
  const g = makeWaveGeometry();
  assert.equal(g.attributes.position.count, WAVE_COLS * WAVE_ROWS);
  assert.equal(g.index.count, (WAVE_COLS - 1) * (WAVE_ROWS - 1) * 6);
  const p = g.attributes.position.array;
  assert.equal(p[0], 0); assert.equal(p[1], 0);
  assert.equal(p[(WAVE_COLS * WAVE_ROWS - 1) * 3], 1); assert.equal(p[(WAVE_COLS * WAVE_ROWS - 1) * 3 + 1], 1);
});

test('frontHmax', () => {
  const f = makeFront({ cols: (u) => [u < 0.5 ? 1 : 3.2, 0, 0, 0] });
  assert.ok(Math.abs(frontHmax(f) - 3.2) < 1e-6);
  assert.equal(frontHmax(makeFront({ cols: flat(0) })), 0.3);
});

test('lone front: clip window = profile extent', () => {
  const f = makeFront({ x: 150, cols: flat(2) });
  const [c] = computeClips([f]);
  assert.ok(Math.abs(c.xiMax - extentFront(2)) < 1e-9);
  assert.ok(Math.abs(c.xiMin + extentBack(2)) < 1e-9);
  assert.equal(c.clipF, false); assert.equal(c.clipB, false);
});

test('close neighbours meet at the midpoint, in any input order', () => {
  const a = makeFront({ id: 1, x: 100, cols: flat(3) });
  const b = makeFront({ id: 2, x: 120, cols: flat(3) });
  const c = makeFront({ id: 3, x: 141, cols: flat(1) });
  const clips = computeClips([c, a, b]);          // shuffled
  const [cc, ca, cb] = clips;
  assert.equal(ca.clipB, true); assert.equal(cb.clipF, true);
  assert.ok(Math.abs(ca.xiMin + 10) < 1e-9);       // a's back edge at x 110
  assert.ok(Math.abs(cb.xiMax - 10) < 1e-9);       // b's front edge at x 110
  assert.ok(Math.abs((a.x - ca.xiMin) - (b.x - cb.xiMax)) < 1e-9);
  assert.ok(Math.abs((b.x - cb.xiMin) - (c.x - cc.xiMax)) < 1e-9);
  assert.equal(ca.clipF, false);                    // nothing shoreward of a
  for (const k of clips) { assert.ok(k.bandB > 0 && k.bandF > 0); assert.ok(k.xiMin < 0 && k.xiMax > 0); }
});

test('ocean hook boxes: ramps inside free edges, overshoot at cuts', () => {
  const h = new OceanHook();
  h.set([{ x0: 90, x1: 110, clip0: false, clip1: true, z0: -156, z1: 156, down: 1.2 }]);
  const A = h.uniforms.uWvBoxA.value, B = h.uniforms.uWvBoxB.value;
  assert.equal(h.uniforms.uWvN.value, 1);
  assert.equal(A[0], 90); assert.equal(A[2], RAMP);
  assert.equal(A[1], 110 + CUT_OVERSHOOT); assert.ok(A[3] < 1);
  assert.equal(B[0], -156); assert.equal(B[1], 156); assert.ok(Math.abs(B[3] - 1.2) < 1e-6);
  h.set(new Array(20).fill({ x0: 0, x1: 1, clip0: false, clip1: false, z0: 0, z1: 1, down: 0 }));
  assert.equal(h.uniforms.uWvN.value, MAX_HOOK_FRONTS);
});

test('spray: active breaks window', () => {
  const Z = ZONES[1];
  const zb = zoneBreak(1, { tBreak: 10, peelLen: 80, vPeel: 8, Tb: 2.6 });
  const f = makeFront({ breaks: [zb], cols: flat(2) });
  assert.deepEqual(activeSprayBreaks(f, 9), []);
  assert.deepEqual(activeSprayBreaks(f, 10.5), [0]);
  assert.deepEqual(activeSprayBreaks(f, 10 + 80 / 8 + 2.6 + SPRAY_LIFE_MAX - 0.1), [0]);
  assert.deepEqual(activeSprayBreaks(f, 10 + 80 / 8 + 2.6 + SPRAY_LIFE_MAX + 0.1), []);
  assert.ok(Z.Tb > 0);
});

test('crest history covers the particle lifetimes and is a pure function', () => {
  const hist = new Float32Array(XHIST_N), ht = { x: 0, y: 0, set(a, b) { this.x = a; this.y = b; } };
  fillCrestHistory((tl) => 100 - 9 * tl, 5, hist, ht);
  assert.ok(ht.x <= 5 - SPRAY_LIFE_MAX && ht.x + (XHIST_N - 1) * XHIST_DT >= 5 + 0.04);
  for (let i = 0; i < XHIST_N; i++) assert.ok(Math.abs(hist[i] - (100 - 9 * (ht.x + i * XHIST_DT))) < 1e-3);
  const h2 = new Float32Array(XHIST_N);
  fillCrestHistory((tl) => 100 - 9 * tl, 5, h2, ht);
  assert.deepEqual(Array.from(h2), Array.from(hist));
  assert.equal(NCOLS, 128);
});

test('asymmetric overlap: both meshes cut at one shared line (no uncovered strip)', () => {
  const a = makeFront({ id: 1, x: 27.6, cols: flat(0.3) });     // small: short back extent
  const b = makeFront({ id: 2, x: 76.3, cols: flat(4.7) });     // big: long front extent
  const [ca, cb] = computeClips([a, b]);
  const d = b.x - a.x;
  assert.ok(extentBack(0.3) + extentFront(4.7) > d);             // they overlap
  assert.equal(ca.clipB, true); assert.equal(cb.clipF, true);
  assert.ok(Math.abs((a.x - ca.xiMin) - (b.x - cb.xiMax)) < 1e-9);
  assert.ok(-ca.xiMin <= extentBack(0.3) + 1e-4 && cb.xiMax <= extentFront(4.7) + 1e-4);
});
