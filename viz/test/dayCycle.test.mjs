// WP14 day cycle: pure maths (src/sky/dayCycle.js) + the env-map quantisation (src/sky/Sky.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DT, DEFAULT_CFG } from '../src/contracts.js';
import { Beat } from '../src/beat/beat.js';
import { dayPhase, sunAt, sunPath, DAY } from '../src/sky/dayCycle.js';
import { envStep, ENV_STEPS } from '../src/sky/Sky.js';
import { PRESETS } from '../src/camera/wide.js';

const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);
const flat = (s) => [...s.color.map((c) => c * s.intensity), ...s.glow, ...s.ambient, ...Object.values(s.sky).flat(),
  ...s.skyMisc, ...s.deep, s.exposure, s.saturation, s.rim, s.shadow];

test('wrap is invisible: every light / colour quantity at phase 1 equals phase 0', () => {
  const a = flat(sunAt(0)), b = flat(sunAt(1 - 1e-9)), c = flat(sunAt(1));
  a.forEach((v, i) => { close(v, b[i], 1e-6, `q${i} 0 vs 1-ε`); close(v, c[i], 0, `q${i} 0 vs 1`); });
  // and near the wrap the sky carries no sun-side asymmetry (only the hidden sun's direction differs)
  const s = sunAt(0);
  assert.equal(s.intensity, 0);
  assert.deepEqual(s.glow, [0, 0, 0]);
  assert.deepEqual(s.sky.hzSun, s.sky.hzAnti);
  assert.deepEqual(s.sky.hzSun, s.sky.hzMid);
  assert.deepEqual(s.sky.midSun, s.sky.midAnti);
  assert.deepEqual(s.sky.cloudSun, s.sky.cloudAnti);
  assert.deepEqual(s.sky.cloudSun, s.sky.cloudHi);
  assert.equal(s.skyMisc[0], 0);   // belt / pink band
  assert.equal(s.rim, 0);
  assert.equal(s.shadow, 0);
  close(s.elevationDeg, DAY.twilightEl, 1e-9, 'twilight elevation');
  assert.ok(s.elevationDeg < -4 && s.elevationDeg > -6);
});

test('lighting is continuous along the cycle (no jumps between keys)', () => {
  let prev = flat(sunAt(0));
  const N = 20000;
  for (let i = 1; i <= N; i++) {
    const cur = flat(sunAt(i / N));
    cur.forEach((v, k) => assert.ok(Math.abs(v - prev[k]) < 0.05 * Math.max(1, Math.abs(v)), `jump in q${k} at ${i / N}`));
    prev = cur;
  }
});

test('sun rises monotonically to noon then sets monotonically; dir is unit', () => {
  let prev = -Infinity;
  for (let i = 0; i <= 500; i++) {
    const p = sunPath(i / 1000);
    assert.ok(p.elevationDeg > prev, `rise at ${i / 1000}`);
    prev = p.elevationDeg;
    close(Math.hypot(...p.dir), 1, 1e-12, 'unit dir');
  }
  close(prev, DAY.peakEl, 1e-9, 'noon elevation');
  for (let i = 501; i <= 1000; i++) {
    const p = sunPath(i / 1000);
    assert.ok(p.elevationDeg < prev, `set at ${i / 1000}`);
    prev = p.elevationDeg;
  }
  // rises from below the horizon
  assert.ok(sunPath(0).elevationDeg < -4 && sunPath(0.04).elevationDeg > 0);
});

test('startPhase 0.06 keeps the dawn look (sun 6° up, just right of the old 108° dawn sun)', () => {
  const s = sunAt(DEFAULT_CFG.day.startPhase);
  close(s.elevationDeg, 6.0, 0.05, 'elevation');
  // azimuth decreases toward screen right in the lineup view
  assert.ok(s.azimuthDeg < 108 && s.azimuthDeg > 98, `az ${s.azimuthDeg}`);
  assert.deepEqual(s.color.map((c) => +(c * s.intensity).toFixed(2)), [3.6, 1.75, 0.62]);
});

test('sunrise in front of the lineup camera, sunset behind it', () => {
  const L = PRESETS.lineup;
  const fx = L.target[0] - L.position[0], fz = L.target[2] - L.position[2], fl = Math.hypot(fx, fz);
  const horiz = (d) => { const l = Math.hypot(d[0], d[2]); return (d[0] * fx + d[2] * fz) / (l * fl); };
  // horizon crossings
  let rise = null, set = null;
  for (let i = 0; i < 100000; i++) {
    const a = sunPath(i / 100000), b = sunPath((i + 1) / 100000);
    if (a.elevationDeg < 0 && b.elevationDeg >= 0) rise = b;
    if (a.elevationDeg >= 0 && b.elevationDeg < 0) set = a;
  }
  assert.ok(rise && set);
  assert.ok(horiz(rise.dir) > 0.95, `rise in front (cos ${horiz(rise.dir)})`);
  assert.ok(horiz(set.dir) < -0.95, `set behind (cos ${horiz(set.dir)})`);
  assert.ok(horiz(sunPath(0.97).dir) < -0.95 && horiz(sunPath(1 - 1e-9).dir) < -0.95);   // (phase 1 ≡ 0)
});

/** Step a Beat with fixed DT, calling onStep(t) after each step; bpmAt(t) may change cfg.bpm. */
function runBeat(cfg, sec, onStep, bpmAt) {
  const beat = new Beat(cfg);
  const n = Math.round(sec / DT);
  for (let k = 1; k <= n; k++) {
    const t = k * DT;
    if (bpmAt) cfg.bpm = bpmAt(t);
    beat.step(t, DT, []);
    onStep(t, beat);
  }
  return beat;
}

test('64 measures at 120 bpm = 128 s per cycle', () => {
  const cfg = structuredClone(DEFAULT_CFG);
  assert.equal(cfg.day.measures, 64);
  close(dayPhase(new Beat(cfg), 0, cfg), cfg.day.startPhase, 1e-12, 't = 0');
  const at = {};
  runBeat(cfg, 128, (t, beat) => { for (const T of [32, 64, 96, 128]) if (Math.abs(t - T) < DT / 2) at[T] = dayPhase(beat, t, cfg); });
  close(at[32], cfg.day.startPhase + 0.25, 1e-9, '32 s');
  close(at[64], cfg.day.startPhase + 0.5, 1e-9, '64 s');
  close(at[96], cfg.day.startPhase + 0.75, 1e-9, '96 s');
  close(at[128], cfg.day.startPhase, 1e-9, '128 s = one cycle');
  // the no-beat fallback agrees
  close(dayPhase(null, 64, cfg), cfg.day.startPhase + 0.5, 1e-12, 'fallback');
});

test('bpm change speeds the cycle up / down without a jump', () => {
  const cfg = structuredClone(DEFAULT_CFG);
  let prev = dayPhase(new Beat(cfg), 0, cfg), maxStep = 0, total = 0;
  runBeat(cfg, 60, (t, beat) => {
    const p = dayPhase(beat, t, cfg);
    if (prev != null) {
      let d = p - prev; if (d < -0.5) d += 1;
      assert.ok(d > 0, `phase advances at t=${t}`);
      maxStep = Math.max(maxStep, d); total += d;
    }
    prev = p;
  }, (t) => (t < 9.3 ? 120 : t < 31.1 ? 180 : 75));   // changes mid-measure; apply at the next downbeat
  // per-step advance at the fastest tempo (180 bpm): DT / (64 · 240 / 180)
  assert.ok(maxStep < (DT / (64 * 240 / 180)) * 1.001, `max step ${maxStep}`);
  // total = measures elapsed / 64: 5 × 2 s at 120 bpm (to the downbeat at 10 s), 16 × 4/3 s at 180 (to the first
  // downbeat ≥ 31.1 s: 31.333 s), then 3.2 s measures at 75 bpm
  const m120 = 5, m180 = 16, m75 = (60 - (10 + 16 * 240 / 180)) / (240 / 75);
  close(total, (m120 + m180 + m75) / 64, 1e-6, 'phase advance = measures / 64');
});

test('env map is quantised by phase only, and the wrap reuses step 0', () => {
  assert.equal(envStep(0), 0);
  assert.equal(envStep(1), 0);
  assert.equal(envStep(1 - 1e-9), 0);
  assert.equal(envStep(0.5), ENV_STEPS / 2);
  for (let i = 0; i < 1000; i++) { const k = envStep(i / 1000); assert.ok(k >= 0 && k < ENV_STEPS && Number.isInteger(k)); }
});
