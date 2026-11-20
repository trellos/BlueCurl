// Regenerates the Tuninator event streams in this folder from real guitar recordings.
//
// Runs Tuninator's own offline engine (src/offline/analyzer.ts, the same engine the browser runs, fed in
// 128-sample blocks) over the decoded fixture WAVs in the Tuninator repo, and writes the Note events
// GuitarInput listens to as compact JSON. test/guitar-offline.test.mjs replays them through GuitarInput,
// so the test itself needs neither Tuninator's sources nor the audio.
//
//   cd C:/dev/Tuninator && npm run decode-fixtures        (once: fixtures/audio → .cache/fixtures/*.wav)
//   C:/dev/Tuninator/node_modules/.bin/tsx C:/dev/BlueCurl/viz/test/guitar-fixtures/gen.mjs [tuninatorRoot]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const TUN = process.argv[2] || 'C:/dev/Tuninator';
const FIXTURES = ['clean-lead-120bpm', 'cowboy-chords-c-d-em-g-c-d-em-am-120bpm', 'chords-a-bm-g-d-2x-120bpm'];

const { analyzeSamples } = await import(pathToFileURL(path.join(TUN, 'src/offline/analyzer.ts')).href);
const { readWav, downmixToMono } = await import(pathToFileURL(path.join(TUN, 'src/offline/wav.ts')).href);

const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : undefined);
/** The parts of a Note snapshot GuitarInput reads. */
function snap(n) {
  const h = n.harmony;
  return {
    id: n.id,
    midi: n.pitch?.current?.midi,
    name: n.pitch?.current?.name,
    rms: r4(n.amplitude?.rms), peak: r4(n.amplitude?.peak),
    harmony: h ? { root: h.root, quality: h.quality, chordName: h.chordName,
      midis: (h.detectedPitches || []).map((p) => p.midi) } : undefined,
  };
}

for (const stem of FIXTURES) {
  const wavPath = path.join(TUN, '.cache/fixtures', `${stem}.wav`);
  const wav = readWav(new Uint8Array(fs.readFileSync(wavPath)));
  const mono = wav.channels > 1 ? downmixToMono(wav.samples, wav.channels) : wav.samples;
  const res = analyzeSamples(mono, wav.sampleRate);
  const events = [];
  for (const e of res.emissions) {
    const at = Math.round(e.type === 'changed' ? e.change.at : (e.type === 'ended' ? (e.note.endTime ?? e.note.startTime) : e.note.startTime));
    const ev = { type: e.type, at, ...snap(e.note) };
    if (e.type === 'changed') {
      ev.change = e.change.type;
      if (e.change.relatedNoteIds) { ev.related = e.change.relatedNoteIds; ev.relation = e.change.relation ?? 'absorbed'; }
    }
    events.push(ev);
  }
  const out = path.join(here, `${stem}.json`);
  fs.writeFileSync(out, JSON.stringify({ source: `tuninator offline analyzer, ${stem}.wav`, sampleRate: wav.sampleRate, events }) + '\n');
  console.log(stem, 'notes', res.notes.length, 'events', events.length, '→', path.relative(process.cwd(), out));
}
