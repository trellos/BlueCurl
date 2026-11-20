// WP15: key-letter flock + beat fish — pure helpers (no GPU).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DT, DEFAULT_CFG } from '../src/contracts.js';
import { GLYPHS, keyLabel, layoutLabel, labelSlots } from '../src/fx/keyGlyphs.js';
import { KeyFlockLog, keyBirdPose, crossWarp, KEY_FLOCK } from '../src/fx/keyFlockMath.js';
import { FishLog, makeFish, fishPose, fishXZ, fishAlpha, SCREEN_RIGHT, FISH } from '../src/fx/fishMath.js';
import { depthAt } from '../src/spot/bathymetry.js';
import { Beat } from '../src/beat/beat.js';
import { InputBus } from '../src/input/input.js';

const KEYS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];   // GuitarMapper key names
const cfg = (o = {}) => ({ ...structuredClone(DEFAULT_CFG), ...o });

test('keyLabel: mapper key names → letters (+ m for minor)', () => {
  assert.equal(keyLabel('E major'), 'E');
  assert.equal(keyLabel('C minor'), 'Cm');
  assert.equal(keyLabel('F# minor'), 'F#m');
  assert.equal(keyLabel('Bb major'), 'Bb');
  assert.equal(keyLabel('C♯ minor'), 'C#m');
  assert.equal(keyLabel('Am'), 'Am');
  assert.equal(keyLabel('g'), 'G');
  assert.equal(keyLabel(''), '');
  assert.equal(keyLabel(null), '');
});

test('glyphs: every key name has strokes; slots cover every stroke, inside the label box', () => {
  for (const k of KEYS) for (const mode of ['major', 'minor']) {
    const label = keyLabel(`${k} ${mode}`);
    assert.equal(label, k + (mode === 'minor' ? 'm' : ''));
    for (const ch of label) assert.ok(GLYPHS[ch], `glyph for ${ch}`);
    const L = layoutLabel(label);
    assert.ok(L.strokes.length >= 1 && L.length > 0.9 && L.width > 0.4);
    for (const n of [DEFAULT_CFG.keyFlock.birds, 24, 110]) {
      const s = labelSlots(label, n);
      assert.equal(s.n, n, `${label}: all ${n} birds placed`);
      for (let i = 0; i < n; i++) {
        const x = s.pts[2 * i], y = s.pts[2 * i + 1];
        assert.ok(Number.isFinite(x) && Number.isFinite(y));
        assert.ok(Math.abs(x) <= L.width / 2 + 1e-6 && y >= -0.5 - 1e-6 && y <= 0.5 + 1e-6, `${label} slot ${i} in the box`);
      }
      // every stroke gets birds at both ends (n ≥ 2 × strokes)
      for (const st of L.strokes) for (const end of [st[0], st[st.length - 1]]) {
        let best = Infinity;
        for (let i = 0; i < n; i++) best = Math.min(best, Math.hypot(s.pts[2 * i] - end[0], s.pts[2 * i + 1] - end[1]));
        assert.ok(best < 1e-6, `${label}: a bird on every stroke end`);
      }
    }
  }
});

test('key flock: detects cfg guitar.key changes (not the initial key, not repeats), reset rewinds', () => {
  const c = cfg();
  const log = new KeyFlockLog(c.guitar.key);
  const run = (t0, t1, at = {}) => { for (let i = Math.round(t0 / DT) + 1; i <= Math.round(t1 / DT); i++) { const t = i * DT; if (at[i]) c.guitar.key = at[i]; log.step(t, c); } };
  run(0, 1);
  assert.equal(log.list.length, 0, 'initial key: no flock');
  run(1, 4, { [Math.round(1.5 / DT)]: 'C minor', [Math.round(2.0 / DT)]: 'C minor', [Math.round(3.0 / DT)]: 'E major' });
  assert.deepEqual(log.list.map((r) => [r.label, Math.round(r.t0 / DT)]), [['Cm', Math.round(1.5 / DT)], ['E', Math.round(3.0 / DT)]]);
  assert.equal(log.list[0].n, DEFAULT_CFG.keyFlock.birds);
  assert.equal(log.list[0].T, DEFAULT_CFG.keyFlock.seconds);
  // a newer change breaks the older formation up early
  assert.ok(Math.abs(log.scatterAt(0) - 1.5 / log.list[0].T) < 1e-9);
  assert.equal(log.scatterAt(1), KEY_FLOCK.scatter);
  // rewind: restored t = 0 key, no records
  c.guitar.key = 'C major';
  log.reset(c.guitar.key);
  assert.equal(log.list.length, 0);
  run(0, 1);
  assert.equal(log.list.length, 0);
});

test('key flock: formation holds the letters mid-crossing, crosses left → right, deterministic', () => {
  const c = cfg();
  const log = new KeyFlockLog('C major');
  c.guitar.key = 'F# minor';
  log.step(1, c);
  const rec = log.list[0], slots = log.slots(rec), view = { tanY: Math.tan((72 * Math.PI) / 360), aspect: 16 / 9 };
  const D = KEY_FLOCK.depth, mY = D * view.tanY, Hm = KEY_FLOCK.height * mY;
  const at = (a) => Array.from({ length: slots.n }, (_, i) => ({ ...keyBirdPose(rec, slots, i, a, log.scatterAt(0), view, 1) }));
  // mid crossing: every bird within a small wobble of its slot (relative to the formation centre)
  const mid = at(0.5 * rec.T);
  const cx = mid.reduce((s, p) => s + p.x, 0) / mid.length;
  let maxErr = 0;
  mid.forEach((p, i) => { maxErr = Math.max(maxErr, Math.hypot(p.x - cx - slots.pts[2 * i] * Hm - (mid[0].x - cx - slots.pts[0] * Hm), 0)); });
  assert.ok(maxErr < 0.12 * Hm, `letters hold (max slot error ${maxErr.toFixed(2)} m)`);
  mid.forEach((p) => { assert.ok(p.alpha > 0.99); assert.ok(Math.abs(p.z + D) < 4); });
  // crossing: off-screen left at the start, centre of the screen mid-way, off right / faded at the end
  const ndcX = (ps) => ps.reduce((s, p) => s + p.x, 0) / ps.length / (mY * view.aspect);
  assert.ok(ndcX(at(0.01)) < -1, 'starts off-screen left');
  assert.ok(Math.abs(ndcX(mid)) < 0.25, 'legible in the middle');
  const end = at((KEY_FLOCK.scatter + KEY_FLOCK.fade) * rec.T);
  assert.ok(end.every((p) => p.alpha < 0.01), 'gone after the break-up');
  assert.ok(crossWarp(0) === 0 && Math.abs(crossWarp(1) - 1) < 1e-12);
  for (let s = 0; s < 1; s += 0.01) assert.ok(crossWarp(s + 0.01) > crossWarp(s), 'monotone crossing');
  // determinism: same inputs → identical poses
  assert.deepEqual(at(2.345), at(2.345));
});

/** Run a real Beat over an input log; fish log stepped after the beat (App step order). */
function runBeat(log, tEnd, c = cfg()) {
  const bus = new InputBus(); bus.load(log);
  const beat = new Beat(c), fish = new FishLog(), seen = [];
  for (let i = 1; i * DT <= tEnd + 1e-9; i++) {
    const t = i * DT, ev = bus.drainUntil(t);
    beat.step(t, DT, ev);
    const n = fish.list.length;
    fish.step(t, beat, c);
    for (const f of fish.list.slice(n)) seen.push(f);
  }
  return { beat, fish, seen };
}

test('fish: one per beat level change, +1 → swims right, −1 → left (demo-beat)', () => {
  const demo = JSON.parse(readFileSync(new URL('../demo/demo-beat.json', import.meta.url), 'utf8'));
  const { seen } = runBeat(demo.log, demo.duration);
  const up = seen.filter((f) => f.dir > 0), dn = seen.filter((f) => f.dir < 0);
  assert.equal(up.length, 7, 'level 1 → 8: seven fish swimming right');
  assert.equal(dn.length, 7, 'level 8 → 1: seven fish swimming left');
  assert.deepEqual(up.map((f) => f.t0), [2, 4, 6, 8, 10, 12, 14]);
  assert.ok(dn.every((f) => f.t0 >= 26 && f.t0 <= 42));
  for (const f of seen) {
    assert.equal(f.Ts, DEFAULT_CFG.fish.beats * 0.5, 'swims cfg.fish.beats beats (120 bpm)');
    // during the swim it moves along screen-right (dir +1) / screen-left (dir −1)
    const p0 = fishXZ(f, 0.2), p1 = fishXZ(f, f.Ts - 0.2);
    const along = (p1[0] - p0[0]) * SCREEN_RIGHT[0] + (p1[1] - p0[1]) * SCREEN_RIGHT[1];
    assert.ok(along * f.dir > 0.6 * f.v * (f.Ts - 0.4), `fish ${f.id} swims ${f.dir > 0 ? 'right' : 'left'}`);
    const pose = fishPose(f, 1.0);
    assert.ok((pose.hx * SCREEN_RIGHT[0] + pose.hz * SCREEN_RIGHT[1]) * f.dir > 0.9, 'heading matches');
    // stays in the shallows (water, not land, not deep) while visible; then turns seaward (+x) and fades
    for (let a = 0; a <= f.life; a += 0.1) {
      const q = fishXZ(f, a), d = depthAt(q[0], q[1]);
      assert.ok(d > 1.2 && d < 7, `fish ${f.id} over water ${d.toFixed(2)} m deep at age ${a.toFixed(1)}`);
    }
    const e0 = fishXZ(f, f.Ts), e1 = fishXZ(f, f.life);
    assert.ok(e1[0] > e0[0] + 3, 'exits seaward');
    assert.ok(fishPose(f, f.life - 0.05).depth > FISH.depth + 1.5, 'dives deeper');
    assert.equal(fishAlpha(f, f.life + 0.01), 0);
    assert.ok(fishAlpha(f, 1.0) > 0.99);
  }
  // consecutive fish use different swim rows (no overlap)
  for (let i = 1; i < seen.length; i++) {
    const a = fishXZ(seen[i - 1], 2.0 + seen[i].t0 - seen[i - 1].t0), b = fishXZ(seen[i], 2.0);
    assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) > FISH.len, 'simultaneous fish apart');
  }
});

test('fish: no fish on unchanged downbeats; deduplicated; deterministic; pruned; reset', () => {
  const c = cfg();
  const fl = new FishLog();
  const beat = { beatLen: 0.5, events: [] };
  const push = (t, index, change) => beat.events.push({ t, type: 'downbeat', index, level: 1, prevLevel: 1, change });
  push(2, 1, 0); fl.step(2, beat, c);
  assert.equal(fl.list.length, 0);
  push(4, 2, 1); fl.step(4, beat, c); fl.step(4 + DT, beat, c);
  push(6, 3, -1); fl.step(6, beat, c);
  assert.deepEqual(fl.list.map((f) => [f.id, f.dir]), [[2, 1], [3, -1]]);
  assert.deepEqual(JSON.parse(JSON.stringify(makeFish(2, 4, 1, 0.5, 4, 1))), JSON.parse(JSON.stringify(fl.list[0])));
  assert.deepEqual(fishPose(fl.list[0], 1.234), fishPose(makeFish(2, 4, 1, 0.5, 4, 1), 1.234));
  fl.step(20, beat, c);
  assert.equal(fl.list.length, 0, 'finished fish pruned');
  fl.reset();
  assert.equal(fl.list.length, 0); assert.equal(fl.lastIndex, -1);
  // beats scale with the tempo at the spawn
  const slow = makeFish(5, 0, 1, 1.0, DEFAULT_CFG.fish.beats, 1);
  assert.equal(slow.Ts, DEFAULT_CFG.fish.beats);
});
