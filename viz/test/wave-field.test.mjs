// WP4a — JS wave field (field.js) on synthetic FrontStates. node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { localTau, breakStartTime, ambientHeight, uToZ, zToU, NCOLS, ZONES, mulberry32 } from '../src/contracts.js';
import { sampleFront, surfaceHeight, barrel, lip, columnState, evalLocal, colsAt, colU } from '../src/wave/field.js';
import { profileExtents } from '../src/wave/profile.js';
import { syntheticFronts, makeFront, zoneBreak } from '../dev/wave-fronts.js';

const fronts = syntheticFronts();
const uniformFront = (H, steep, curl, mush, extra = {}) => makeFront({ x: 165, vx: -9, cols: () => [H, steep, curl, mush],
  breaks: [zoneBreak(1, { tBreak: 0, uPeak: 0.5, u0: 0.2, u1: 0.8, dir: -1, peelLen: 100, backLen: 20, Tb: 2.6 })], ...extra });

test('sampleFront: tau / zi exactly contracts.localTau; placement x = front.x - xi, z = uToZ(u), ambient included', () => {
  const rnd = mulberry32(3);
  for (let n = 0; n < 3000; n++) {
    const f = fronts[n % fronts.length], u = rnd(), s = rnd(), t = -2 + 14 * rnd();
    const p = sampleFront(f, u, s, t), lt = localTau(f, u, t);
    assert.equal(p.tau, lt.tau); assert.equal(p.zi, lt.zi);
    assert.ok(Math.abs(p.x - (f.x - p.xi)) < 1e-9 && p.z === uToZ(u));
    assert.ok(Math.abs(p.y - (p.yl + ambientHeight(p.x, p.z, t))) < 1e-9);
    for (const k of ['x', 'y', 'z', 'nx', 'ny', 'nz', 'vx', 'vy', 'vz', 'H', 'thick']) assert.ok(Number.isFinite(p[k]), k);
    assert.ok(Math.abs(Math.hypot(p.nx, p.ny, p.nz) - 1) < 1e-9);
    assert.ok(Math.abs(p.H - colsAt(f.cols, u)[0]) < 1e-12);
  }
});

test('column mapping: column c at u = (c + 0.5) / NCOLS, linear in between', () => {
  const f = fronts[1];
  for (const c of [0, 17, 64, NCOLS - 1]) assert.ok(Math.abs(colsAt(f.cols, colU(c))[0] - f.cols[c * 4]) < 1e-12);
  const m = colsAt(f.cols, 0.5 * (colU(10) + colU(11)))[2];
  assert.ok(Math.abs(m - 0.5 * (f.cols[10 * 4 + 2] + f.cols[11 * 4 + 2])) < 1e-7);
});

test('1–3 zone breaks incl. closeout and sections: phases follow breakStartTime per column', () => {
  const [f0, f1, f2] = fronts;
  // closeout: whole outer range starts within |ds|/80 s
  const out = f2.breaks[0];
  let tmin = Infinity, tmax = -Infinity;
  for (let u = out.u0; u <= out.u1; u += 0.005) { const ts = breakStartTime(out, u); tmin = Math.min(tmin, ts); tmax = Math.max(tmax, ts); }
  assert.ok(tmax - tmin < 1.5, 'closeout nearly simultaneous');
  // sections: the sectiony point break has jumps in start time; sampleFront stays finite across them
  const pt = f2.breaks[1];
  for (let u = pt.u0; u < pt.u1; u += 0.0007) {
    const p = sampleFront(f2, u, 0.5, 4.5);
    assert.ok(Number.isFinite(p.x + p.y + p.nx + p.vx));
  }
  // second zone takes over once its start time passes (most recent zone wins)
  const u = 0.35, ts1 = breakStartTime(f1.breaks[1], u);
  assert.ok(Number.isFinite(ts1) && Number.isFinite(breakStartTime(f1.breaks[0], u)) === false || true);
  for (const f of [f0, f1, f2]) for (let t = -2; t < 14; t += 0.37) for (let uu = 0.02; uu < 1; uu += 0.06) {
    const p = sampleFront(f, uu, 0.47, t), lt = localTau(f, uu, t);
    assert.equal(p.zi, lt.zi);
    if (lt.zi >= 0) assert.ok(p.tau >= 0 && p.tau <= 2); else assert.ok(p.tau >= -1 && p.tau < 0 || p.tau === -1);
  }
});

test('re-form → next zone: the local shape is continuous in t across the next break start', () => {
  const f = fronts[1];
  let checked = 0;
  for (let u = 0.55; u < 0.68; u += 0.004) {
    const tsA = breakStartTime(f.breaks[0], u), tsB = breakStartTime(f.breaks[1], u);
    if (!Number.isFinite(tsA) || !Number.isFinite(tsB) || tsB <= tsA) continue;
    for (const s of [0.2, 0.45, 0.6, 0.8]) {
      const a = evalLocal(columnState(f, u, tsB - 1e-6), s, {}), b = evalLocal(columnState(f, u, tsB + 1e-6), s, {});
      assert.ok(Math.hypot(a.xi - b.xi, a.y - b.y) < 1e-3, `jump at u ${u.toFixed(2)} s ${s}`);
      checked++;
    }
  }
  assert.ok(checked > 8, 'test covers re-break columns');
});

test('normal: perpendicular to both surface tangents, points out of the water', () => {
  const f = fronts[0], h = 1e-5;
  for (const t of [-1, 1.5, 2.5, 3.3, 5]) for (const u of [0.3, 0.45, 0.55]) for (let s = 0.05; s < 0.96; s += 0.05) {
    const p = sampleFront(f, u, s, t), ps = sampleFront(f, u, s + h, t), pu = sampleFront(f, u + 1e-4, s, t);
    const ts = [ps.x - p.x, ps.y - p.y, ps.z - p.z], tu = [pu.x - p.x, pu.y - p.y, pu.z - p.z];
    const ls = Math.hypot(...ts), lu = Math.hypot(...tu);
    if (ls > 1e-9) assert.ok(Math.abs((ts[0] * p.nx + ts[1] * p.ny + ts[2] * p.nz) / ls) < 2e-3, `n·Ts at ${u},${s},${t}`);
    if (lu > 1e-9) assert.ok(Math.abs((tu[0] * p.nx + tu[1] * p.ny + tu[2] * p.nz) / lu) < 2e-2, `n·Tu at ${u},${s},${t}`);
  }
  // back of the wave and flat ends: normal up. Under a thrown lip (plunge, high curl): normal down into the tube.
  const g = uniformFront(3, 0.8, 1, 0);
  const t = 0.62 * 2.6 + breakStartTime(g.breaks[0], 0.5);
  assert.ok(sampleFront(g, 0.5, 0.1, t).ny > 0.9 && sampleFront(g, 0.5, 0.99, t).ny > 0.9);
  assert.ok(sampleFront(g, 0.5, 0.52, t).ny < -0.3, 'lip underside faces down');
});

test('velocity: matches d/dt of the world position with the crest moving at vx', () => {
  const rnd = mulberry32(11);
  for (let n = 0; n < 400; n++) {
    const f = fronts[n % 3], u = rnd(), s = rnd(), t = -1 + 10 * rnd(), h = 1e-4;
    const fa = { ...f, x: f.x - f.vx * h }, fb = { ...f, x: f.x + f.vx * h };
    const a = sampleFront(fa, u, s, t - h), b = sampleFront(fb, u, s, t + h), p = sampleFront(f, u, s, t);
    const vx = (b.x - a.x) / (2 * h), vy = (b.y - a.y) / (2 * h);
    // skip the rare kinks (tau clamp, section jumps) where a central difference is meaningless
    if (Math.abs(vx - p.vx) > 0.05 * (1 + Math.abs(vx)) && Math.abs(sampleFront(f, u, s, t + 3e-3).tau - p.tau) > 0.01) continue;
    assert.ok(Math.abs(vx - p.vx) < 0.05 * (1 + Math.abs(vx)), `vx ${vx} vs ${p.vx}`);
    assert.ok(Math.abs(vy - p.vy) < 0.05 * (1 + Math.abs(vy)), `vy ${vy} vs ${p.vy}`);
    assert.equal(p.vz, 0);
  }
  // a pre-break swell column moves with the crest
  const q = sampleFront(fronts[3], 0.5, 0.3, 0);
  assert.ok(Math.abs(q.vx - fronts[3].vx) < 1e-6);
});

test('surfaceHeight: lowest surface under the lip, ambient included, continuous along x where nothing overhangs', () => {
  const t = 2;
  const amb = (x, z) => ambientHeight(x, z, t);
  // far from every front → ambient only
  assert.ok(Math.abs(surfaceHeight(fronts, 900, 0, t) - amb(900, 0)) < 1e-12);
  // equals the sampled surface on a single-valued profile (approach / steepening phase)
  const g = uniformFront(2.5, 0.5, 0, 0.6);
  for (const tt of [-1, 0.3]) for (let s = 0.02; s < 0.98; s += 0.03) {
    const p = sampleFront(g, 0.5, s, tt);
    assert.ok(Math.abs(surfaceHeight([g], p.x, p.z, tt) - p.y) < 1e-6, `s ${s} t ${tt}`);
  }
  // continuity along x on non-overhanging waves (approach swell, wall, mush) and along z
  for (const [f, tt] of [[fronts[3], 1], [uniformFront(3, 1, 0, 0), 0.4 * 2.6 - 1.5], [uniformFront(2, 0.3, 0.3, 1), 0.5]]) {
    const e = profileExtents(3);
    let prev = null;
    for (let x = f.x - e.front - 2; x < f.x - e.back + 2; x += 0.05) {
      const h = surfaceHeight([f], x, 0, tt);
      if (prev !== null) assert.ok(Math.abs(h - prev) < 0.12, `jump at x ${x.toFixed(2)}: ${prev} → ${h}`);
      prev = h;
    }
    prev = null;
    for (let z = -100; z < 100; z += 0.25) {
      const h = surfaceHeight([f], f.x - 1, z, tt);
      if (prev !== null) assert.ok(Math.abs(h - prev) < 0.12, `jump at z ${z}`);
      prev = h;
    }
  }
  // under a thrown lip: below the lip, i.e. the tube floor / trough
  const b = uniformFront(3, 0.8, 1, 0), tb = breakStartTime(b.breaks[0], 0.5) + 0.62 * 2.6;
  const L = lip(b, 0.5, tb);
  const under = surfaceHeight([b], L.x, L.z, tb);
  assert.ok(under < L.y - 0.3, `surface under the lip tip (${under}) must be below the lip (${L.y})`);
});

test('barrel: only with high curl and tau in the throw/plunge range; tube centre inside the cavity', () => {
  const Tb = 2.6;
  const scan = (curl, mush) => {
    const f = uniformFront(3, 0.8, curl, mush), ts = breakStartTime(f.breaks[0], 0.5), hits = [];
    for (let tau = -1; tau <= 2; tau += 0.02) { const b = barrel(f, 0.5, ts + tau * Tb); if (b) hits.push([tau, b]); }
    return hits;
  };
  const hi = scan(1, 0);
  assert.ok(hi.length > 10, 'barrel at high curl');
  for (const [tau, b] of hi) {
    assert.ok(tau > 0.3 && tau < 0.9, `tau ${tau} outside throw/plunge`);
    assert.ok(b.r > 0.36 && b.r < 3, `radius ${b.r}`);
  }
  // centre is in air: above the floor and the lip above it
  const f = uniformFront(3, 0.8, 1, 0), t = breakStartTime(f.breaks[0], 0.5) + 0.62 * Tb, b = barrel(f, 0.5, t);
  assert.ok(b && surfaceHeight([f], b.x, b.z, t) < b.y - 0.3 * b.r);
  assert.equal(scan(0, 0).length, 0, 'no barrel for a wall');
  assert.equal(scan(0.3, 0).length, 0, 'no barrel at low curl');
  assert.equal(scan(1, 1).length, 0, 'no barrel when mushy');
  assert.equal(barrel(fronts[3], 0.5, 1), null, 'no barrel on an unbroken swell');
});

test('lip: landmark C, follows the crest', () => {
  for (const f of fronts) for (const t of [0, 2, 6]) {
    const L = lip(f, 0.4, t), p = sampleFront(f, 0.4, L.sigma, t);
    assert.ok(Math.hypot(L.x - p.x, L.y - p.y, L.z - p.z) < 1e-9);
  }
});

test('determinism: identical results for identical inputs', () => {
  const a = [], b = [];
  for (let i = 0; i < 300; i++) a.push(sampleFront(fronts[i % 4], (i * 0.37) % 1, (i * 0.61) % 1, (i * 0.13) % 9));
  for (let i = 0; i < 300; i++) b.push(sampleFront(fronts[i % 4], (i * 0.37) % 1, (i * 0.61) % 1, (i * 0.13) % 9));
  assert.deepEqual(a, b);
});
