import test from 'node:test';
import assert from 'node:assert/strict';
import { laneMidi, midiHz } from '../src/audio/Pluck.js';
import { GuitarMapper } from '../src/input/guitarMap.js';
import { GuitarInput } from '../src/input/guitar.js';

test('number keys play the C major octave C3–C4 by default', () => {
  const m = new GuitarMapper();
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map((l) => laneMidi(l, m.state)), [48, 50, 52, 53, 55, 57, 59, 60]);
  assert.ok(Math.abs(midiHz(69) - 440) < 1e-9);
});

test('number keys follow the guitar key and octave', () => {
  const m = new GuitarMapper();
  m.note(62 + 12);                                      // D5 → octave C5..C6
  assert.equal(laneMidi(1, m.state), 72);
  assert.equal(laneMidi(8, m.state), 84);
  m.chord([48, 51, 55], { root: 'C', quality: 'min' });   // → C minor, octave C3
  assert.deepEqual([3, 6, 7].map((l) => laneMidi(l, m.state)), [51, 56, 58]);
});

test('the mic ignores a note matching a pluck just played (echo), not other notes', () => {
  const fired = [];
  const app = { cfg: {}, simTime: 0, input: { impulse: (o) => { fired.push(o.lane); return fired.length; }, release() {}, setConfig() {} } };
  const g = new GuitarInput(app);
  g.source = 'mic';
  g.suppressEcho(52);                                   // plucked E3
  g.onNoteEvent('noteStarted', { id: 'a', pitch: { current: { midi: 64, name: 'E4' } }, amplitude: { rms: 0.05 } });
  assert.deepEqual(fired, []);                          // E heard (any octave) → ignored
  g.onNoteEvent('noteStarted', { id: 'b', pitch: { current: { midi: 55, name: 'G3' } }, amplitude: { rms: 0.05 } });
  assert.deepEqual(fired, [4]);                         // G → lane 5 (0-based 4)
  g.source = 'mock';
  g.onNoteEvent('noteStarted', { id: 'c', pitch: { current: { midi: 52, name: 'E3' } }, amplitude: { rms: 0.05 } });
  assert.equal(fired.length, 2);                        // only the mic is echo-filtered
});

test('a guitar chord tags its later tones with the first impulse id (the beat counts it once)', async () => {
  const { InputBus } = await import('../src/input/input.js');
  const { Beat } = await import('../src/beat/beat.js');
  const { DEFAULT_CFG, DT } = await import('../src/contracts.js');
  const bus = new InputBus(() => 0);
  const g = new GuitarInput({ cfg: {}, simTime: 0, input: bus });
  const r = g.guitarNote({ midis: [48, 52, 55, 60], duration: null });
  assert.equal(r.lanes.length, 4);
  const ons = bus.log.filter((e) => e.type === 'on');
  assert.equal(ons[0].chord, undefined);
  assert.ok(ons.slice(1).every((e) => e.chord === ons[0].id));
  const beat = new Beat(structuredClone(DEFAULT_CFG));
  for (let i = 1; i * DT <= 2 + DT; i++) beat.step(i * DT, DT, bus.drainUntil(i * DT));
  assert.equal(beat.measures.at(-1).notes, 1);
});
