// Real Tuninator output → GuitarInput → InputBus.
// The event streams in test/guitar-fixtures/*.json were produced by Tuninator's own offline engine over its
// recorded guitar fixtures (regenerate with test/guitar-fixtures/gen.mjs; needs the Tuninator repo + tsx).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { GuitarInput } from '../src/input/guitar.js';
import { InputBus } from '../src/input/input.js';

const TYPES = { started: 'noteStarted', changed: 'noteChanged', ended: 'noteEnded', resolved: 'noteResolved' };

function replay(stem) {
  const d = JSON.parse(fs.readFileSync(new URL(`./guitar-fixtures/${stem}.json`, import.meta.url)));
  const app = { simTime: 0, cfg: { guitar: { key: 'C major' } } };
  app.input = new InputBus(() => app.simTime);
  const g = new GuitarInput(app);
  for (const e of d.events) {
    app.simTime = Math.max(app.simTime, e.at / 1000);
    const note = {
      id: e.id, amplitude: { rms: e.rms },
      pitch: e.midi != null ? { current: { midi: e.midi, name: e.name } } : {},
      harmony: e.harmony ? { root: e.harmony.root, quality: e.harmony.quality, chordName: e.harmony.chordName,
        detectedPitches: e.harmony.midis.map((midi) => ({ midi })) } : undefined,
    };
    g.onNoteEvent(TYPES[e.type], note, e.change ? { type: e.change } : undefined);
  }
  const notes = new Set(d.events.map((e) => e.id)).size;
  return { log: app.input.log, g, notes };
}

function sane({ log }) {
  const ons = log.filter((e) => e.type === 'on');
  const offs = new Set(log.filter((e) => e.type === 'off').map((e) => e.id));
  assert.ok(ons.length > 0);
  for (const e of ons) {
    assert.ok(Number.isInteger(e.lane) && e.lane >= 0 && e.lane < 8, `lane ${e.lane}`);
    assert.equal(e.lanes, 8);
    assert.equal(e.scale, 1);
    assert.ok(e.velocity >= 0.3 && e.velocity <= 1, `velocity ${e.velocity}`);
    assert.ok(offs.has(e.id), `impulse ${e.id} released`);
  }
  return ons;
}
const keys = (log) => log.filter((e) => e.type === 'cfg' && e.key === 'guitar.key').map((e) => e.value);

test('clean lead line (B C# D E F# G A …): diatonic notes fire, C#/F# ignored, single notes never change the key', () => {
  const r = replay('clean-lead-120bpm');
  const ons = sane(r);
  assert.deepEqual(keys(r.log), []);
  assert.ok(ons.length >= 25 && ons.length <= r.notes, `${ons.length} impulses for ${r.notes} notes`);
  // velocity spread: picked lead notes are not all pinned to one end
  const v = ons.map((e) => e.velocity).sort((a, b) => a - b);
  assert.ok(v[0] < 0.5 && v.at(-1) > 0.85, `velocity range ${v[0]}..${v.at(-1)}`);
});

test('cowboy chords C D Em G C D Em Am: all diatonic to C major → no key change, several lanes per strum', () => {
  const r = replay('cowboy-chords-c-d-em-g-c-d-em-am-120bpm');
  const ons = sane(r);
  assert.deepEqual(keys(r.log), []);
  assert.ok(ons.length > r.notes, `${ons.length} impulses for ${r.notes} notes (chords fire several lanes)`);
});

test('chords A Bm G D ×2 from C major: A → A major, G → G major (Bm, D diatonic: no change), twice', () => {
  const r = replay('chords-a-bm-g-d-2x-120bpm');
  sane(r);
  assert.deepEqual(keys(r.log), ['A major', 'G major', 'A major', 'G major']);
  assert.equal(r.g.status.key, 'G major');
});

test('replay of the same stream is identical (no randomness, no wall clock in the mapping)', () => {
  const a = replay('chords-a-bm-g-d-2x-120bpm').log, b = replay('chords-a-bm-g-d-2x-120bpm').log;
  assert.deepEqual(a, b);
});
