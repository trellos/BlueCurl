import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GUITAR } from '../src/contracts.js';
import { GuitarMapper, qualityMode, inferTriad, toPc } from '../src/input/guitarMap.js';
import { GuitarInput, velocityFor } from '../src/input/guitar.js';
import { InputBus } from '../src/input/input.js';

const C3 = 48, C4 = 60;
const run = (m, notes) => notes.map((n) => m.note(n));

test('initial key C major, initial octave C3..C4 (low E fret 8 = C3)', () => {
  const m = new GuitarMapper();
  assert.equal(GUITAR.initialLowRoot, 48);
  assert.deepEqual(m.state, { tonicPc: 0, mode: 'major', lowRoot: 48, name: 'C major' });
  assert.deepEqual(run(m, [48, 50, 52, 53, 55, 57, 59, 60]), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(m.lowRoot, 48);
});

test('root inside the octave: low root → lane 1, high root → lane 8, octave unchanged', () => {
  const m = new GuitarMapper();
  assert.equal(m.note(C3), 1);
  assert.equal(m.note(C4), 8);   // B string fret 1 = C4 = the initial high root
  assert.equal(m.lowRoot, 48);
});

test('root above the high root switches the octave up so it becomes lane 8', () => {
  const m = new GuitarMapper();
  assert.equal(m.note(72), 8);        // C5
  assert.equal(m.lowRoot, 60);        // octave C4..C5
  assert.equal(m.note(60), 1);        // C4 is now the low root
  assert.equal(m.note(84), 8);        // C6
  assert.equal(m.lowRoot, 72);
});

test('root below the octave lowers it: the root becomes lane 1', () => {
  const m = new GuitarMapper({ lowRoot: 60 });
  assert.equal(m.note(48), 1);
  assert.equal(m.lowRoot, 48);
  assert.equal(m.note(36), 1);        // C2 (below the guitar's E2, still follows the rule)
  assert.equal(m.lowRoot, 36);
});

test('a non-root note sets the octave to the one it is in', () => {
  const m = new GuitarMapper();
  assert.equal(m.note(64), 3);        // E4 → octave C4..C5
  assert.equal(m.lowRoot, 60);
  assert.equal(m.note(60), 1);        // so C4 is now lane 1, not 8
  assert.equal(m.note(43), 5);        // G2 → octave C2..C3
  assert.equal(m.lowRoot, 36);
  assert.equal(m.note(48), 8);        // C3 = high root of C2..C3
  assert.equal(m.note(71), 7);        // B4 → C4..C5
  assert.equal(m.lowRoot, 60);
});

test('non-diatonic notes do nothing (no lane, octave unchanged)', () => {
  const m = new GuitarMapper();
  m.note(64);
  for (const n of [61, 63, 66, 68, 70, 49, 75]) assert.equal(m.note(n), null);
  assert.equal(m.lowRoot, 60);
  assert.equal(m.note(NaN), null);
});

test('chord: C → Cm switches the key to C minor; lanes in the new key', () => {
  const m = new GuitarMapper();
  const maj = m.chord([48, 52, 55], { root: 'C', quality: 'maj' });
  assert.deepEqual(maj, { keyChanged: false, lanes: [1, 3, 5] });
  const min = m.chord([48, 51, 55], { root: 'C', quality: 'min' });
  assert.equal(min.keyChanged, true);
  assert.deepEqual(min.lanes, [1, 3, 5]);
  assert.deepEqual(m.state, { tonicPc: 0, mode: 'minor', lowRoot: 48, name: 'C minor' });
});

test('chord: C major → Dm does not switch (diatonic); lanes map in C major', () => {
  const m = new GuitarMapper();
  const r = m.chord([50, 53, 57], { root: 'D', quality: 'min' });
  assert.deepEqual(r, { keyChanged: false, lanes: [2, 4, 6] });
  assert.equal(m.state.name, 'C major');
  // other diatonic triads of C major don't switch either
  for (const [ms, root, q] of [[[52, 55, 59], 'E', 'min'], [[53, 57, 60], 'F', 'maj'], [[55, 59, 62], 'G', 'maj'], [[57, 60, 64], 'A', 'min']]) {
    assert.equal(m.chord(ms, { root, quality: q }).keyChanged, false);
  }
  assert.equal(m.state.name, 'C major');
});

test('chord needs 3 detected pitches; the same pitch class in two octaves counts', () => {
  const m = new GuitarMapper();
  // two notes (C + Eb): not a chord for key purposes
  assert.equal(m.chord([48, 51], { root: 'C', quality: 'min' }).keyChanged, false);
  assert.equal(m.state.name, 'C major');
  // C3, Eb3, C4: three voices, two pitch classes → switches
  const r = m.chord([48, 51, 60], { root: 'C', quality: 'min' });
  assert.equal(r.keyChanged, true);
  assert.equal(m.state.name, 'C minor');
  assert.deepEqual(r.lanes, [1, 3, 8]);
});

test('key change: new lowRoot = new tonic at or below the chord lowest note; chord quality sets the mode', () => {
  const m = new GuitarMapper();
  const r = m.chord([45, 52, 57, 61, 64], { root: 'A', quality: 'maj' });   // open A: A2 E3 A3 C#4 E4
  assert.equal(r.keyChanged, true);
  assert.equal(m.state.name, 'A major');
  assert.equal(m.lowRoot, 45);
  assert.deepEqual(r.lanes, [1, 5, 8, 3]);
  // E7 (quality '7' = other) is diatonic to A major → no change; F#m is diatonic too
  assert.equal(m.chord([40, 47, 50, 56], { root: 'E', quality: '7' }).keyChanged, false);
  // G (G B D): G natural not in A major; major → G major; lowest note B2 (47) → lowRoot G2 (43)
  const g = m.chord([47, 50, 55, 59], { root: 'G', quality: 'maj' });
  assert.equal(g.keyChanged, true);
  assert.equal(m.state.name, 'G major');
  assert.equal(m.lowRoot, 43);
  // unknown quality keeps the mode: Bb-rooted chord with unknown quality in G major → Bb major
  const bb = m.chord([46, 50, 53], { root: 'A#' });
  assert.equal(bb.keyChanged, true);
  assert.equal(m.state.name, 'Bb major');
});

test('chord without a known root never changes the key (Tuninator abstaining) but still maps tones', () => {
  const m = new GuitarMapper();
  const r = m.chord([48, 51, 55]);
  assert.deepEqual(r, { keyChanged: false, lanes: [1, 5] });   // Eb ignored in C major
  assert.equal(m.state.name, 'C major');
});

test('chord leaves the octave where its bass puts it (upper voices do not drag it up)', () => {
  const m = new GuitarMapper();
  const r = m.chord([48, 52, 55, 60, 64], { root: 'C', quality: 'maj' });   // open C: C3 E3 G3 C4 E4
  assert.deepEqual(r.lanes, [1, 3, 5, 8]);
  assert.equal(m.lowRoot, 48);
  assert.equal(m.note(60), 8);
});

test('minor-key lanes: C natural minor scale run is lanes 1..8; E natural is ignored', () => {
  const m = new GuitarMapper({ tonicPc: 0, mode: 'minor' });
  assert.equal(m.state.name, 'C minor');
  assert.deepEqual(run(m, [48, 50, 51, 53, 55, 56, 58, 60]), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(m.note(52), null);
  assert.equal(m.note(57), null);
  const a = new GuitarMapper({ tonicPc: 9, mode: 'minor', lowRoot: 48 });
  assert.equal(a.lowRoot, 45);         // snapped to the tonic at or below
  assert.deepEqual(run(a, [45, 47, 48, 50, 52, 53, 55, 57]), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('Cm → C switches back to C major', () => {
  const m = new GuitarMapper({ mode: 'minor' });
  const r = m.chord([48, 52, 55], { root: 'C', quality: 'maj' });
  assert.equal(r.keyChanged, true);
  assert.equal(m.state.name, 'C major');
});

test('helpers: quality → mode, pitch-class names, triad inference', () => {
  for (const q of ['maj', 'maj7', 'maj9', '6', 'add9']) assert.equal(qualityMode(q), 'major', q);
  for (const q of ['min', 'm', 'm7', 'm6', 'm11']) assert.equal(qualityMode(q), 'minor', q);
  for (const q of ['7', '5', 'sus2', 'sus4', undefined, null, '']) assert.equal(qualityMode(q), null, String(q));
  assert.equal(toPc('Eb'), 3); assert.equal(toPc('A#'), 10); assert.equal(toPc(61), 1); assert.equal(toPc('X'), undefined);
  assert.deepEqual(inferTriad([48, 51, 55]), { root: 0, quality: 'min' });
  assert.deepEqual(inferTriad([52, 55, 60]), { root: 0, quality: 'maj' });   // first inversion C
  assert.deepEqual(inferTriad([48, 50]), {});
});

test('velocity: dB(rms) −45…−20 → 0.3…1, clamped', () => {
  assert.equal(velocityFor(0), 0.3);
  assert.equal(velocityFor(1e-4), 0.3);
  assert.equal(velocityFor(0.1), 1);
  assert.equal(velocityFor(10 ** (-32.5 / 20)), 0.65);
  assert.ok(velocityFor(0.02) < velocityFor(0.05));
});

// ------------------------------------------------------------ GuitarInput with a fake app
function fakeApp() {
  const app = { simTime: 0, cfg: { guitar: { key: 'C major' } } };
  app.input = new InputBus(() => app.simTime);
  return app;
}
const note = (id, midi, rms = 0.05, harmony) => ({ id, pitch: midi == null ? { confidence: 0 } : { current: { midi, name: 'x' } }, harmony, amplitude: { rms } });
const harm = (midis, root, quality) => ({ root, quality, detectedPitches: midis.map((m) => ({ midi: m })) });

test('GuitarInput: first pitch fires once (lane-1 index, lanes 8, scale 1, velocity), release on noteEnded', () => {
  const app = fakeApp();
  const g = new GuitarInput(app);
  assert.equal(app.guitar, g);
  assert.deepEqual(g.onNoteEvent('noteStarted', note('n1', undefined)), []);   // pitch not known yet
  assert.deepEqual(g.onNoteEvent('noteChanged', note('n1', 52), { type: 'pitchRefinement' }), [3]);
  assert.deepEqual(g.onNoteEvent('noteChanged', note('n1', 53), { type: 'pitchCorrection' }), []);   // no re-fire
  const ons = app.input.log.filter((e) => e.type === 'on');
  assert.equal(ons.length, 1);
  assert.equal(ons[0].lane, 2);
  assert.equal(ons[0].lanes, 8);
  assert.equal(ons[0].scale, 1);
  assert.equal(ons[0].velocity, velocityFor(0.05));
  g.onNoteEvent('noteEnded', note('n1', 53));
  assert.equal(app.input.log.filter((e) => e.type === 'off').length, 1);
  assert.equal(g.status.last.lane, 3);
});

test('GuitarInput: chord bloom fires each new lane once per Note; key change logged as cfg guitar.key', () => {
  const app = fakeApp();
  const g = new GuitarInput(app);
  assert.deepEqual(g.onNoteEvent('noteStarted', note('c', 48, 0.08)), [1]);
  // harmony without a root first (abstaining), then named Cm
  assert.deepEqual(g.onNoteEvent('noteChanged', note('c', 48, 0.08, harm([48, 51, 55, 60])), { type: 'harmonyEnrichment' }), [5, 8]);
  assert.deepEqual(g.onNoteEvent('noteChanged', note('c', 48, 0.08, harm([48, 51, 55, 60], 'C', 'min')), { type: 'harmonyEnrichment' }), [3]);
  // non-harmony change with the same harmony: nothing
  assert.deepEqual(g.onNoteEvent('noteChanged', note('c', 48, 0.08, harm([48, 51, 55, 60], 'C', 'min')), { type: 'bendUpdate' }), []);
  const cfg = app.input.log.filter((e) => e.type === 'cfg');
  assert.deepEqual(cfg.map((e) => [e.key, e.value]), [['guitar.key', 'C minor']]);
  assert.equal(g.status.key, 'C minor');
  assert.equal(g.status.lowRoot, 48);
  g.onNoteEvent('noteEnded', note('c', 48));
  assert.equal(app.input.log.filter((e) => e.type === 'off').length, 4);
  // late revisions of an ended note never fire
  assert.deepEqual(g.onNoteEvent('noteChanged', note('c', 50, 0.08), { type: 'pitchCorrection' }), []);
  // in C minor, Eb is lane 3
  assert.deepEqual(g.onNoteEvent('noteStarted', note('d', 63)), [3]);
});

test('GuitarInput: harness guitarNote and a custom recognizer (on/start/stop)', async () => {
  const app = fakeApp();
  const handlers = {};
  const rec = { on: (e, f) => { handlers[e] = f; return () => delete handlers[e]; }, start: async () => {}, stop: async () => {} };
  const g = new GuitarInput(app, { recognizer: rec });
  await g.start();
  assert.equal(g.status.state, 'listening');
  handlers.noteStarted(note('r1', 55));
  assert.equal(g.status.last.lane, 5);
  const r = g.guitarNote({ midis: [48, 51, 55], duration: null });
  assert.deepEqual(r.lanes, [1, 3, 5]);
  assert.equal(r.key, 'C minor');
  await g.stop();
  assert.equal(g.status.state, 'off');
  assert.equal(Object.keys(handlers).length, 0);
  // stop released everything still sounding
  const ons = app.input.log.filter((e) => e.type === 'on').map((e) => e.id);
  const offs = new Set(app.input.log.filter((e) => e.type === 'off').map((e) => e.id));
  assert.ok(ons.every((id) => offs.has(id)));
});

test('GuitarInput: a failing recognizer start lands in status error, never throws', async () => {
  const app = fakeApp();
  const err = Object.assign(new Error('Permission denied'), { code: 'mic-permission-denied' });
  const g = new GuitarInput(app, { recognizer: { on: () => () => {}, start: async () => { throw err; }, stop: async () => {} } });
  await g.start();
  assert.equal(g.status.state, 'error');
  assert.match(g.status.message, /permission denied/);
});
