// BlueCurl Swell — guitar note → lane mapping (WP10). Pure: no DOM, no clock, no randomness.
// Contract: src/contracts.js "guitar input". Lanes 1..8 = one octave of the current key's scale
// (1 = low tonic, 2..7 = scale degrees, 8 = high tonic).
import { GUITAR, SCALES } from '../contracts.js';

export const PC_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
/** Display spelling of key tonics (flats where a key signature would use them). */
const KEY_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const FLAT = { Db: 1, Eb: 3, Gb: 6, Ab: 8, Bb: 10, Cb: 11, Fb: 4, 'E#': 5, 'B#': 0 };

const mod12 = (n) => ((n % 12) + 12) % 12;

/** Pitch class (0..11) from a number or a name ('C#', 'Eb', 'c'); undefined if unknown. */
export function toPc(x) {
  if (Number.isFinite(x)) return mod12(Math.round(x));
  if (typeof x !== 'string' || !x) return undefined;
  const s = x.trim().replace(/♯/g, '#').replace(/♭/g, 'b');
  const name = s[0].toUpperCase() + s.slice(1);
  if (name in FLAT) return FLAT[name];
  const i = PC_NAMES.indexOf(name);
  return i >= 0 ? i : undefined;
}

/** MIDI number → 'C3' (C4 = 60). */
export const midiName = (m) => `${PC_NAMES[mod12(m)]}${Math.floor(m / 12) - 1}`;

/**
 * Tuninator chord quality ('maj', 'min', 'm7', 'maj7', '7', 'sus4', '5', ...) → 'major' | 'minor' | null.
 * major: maj, maj7, maj9, 6, add9, M, major · minor: min, m, m6, m7, m9, m11, minor · anything else (7, 9, sus2,
 * sus4, 5, dim, aug, unknown) → null = keep the current mode.
 */
export function qualityMode(q) {
  if (typeof q !== 'string') return null;
  const s = q.trim();
  if (/^(maj|major|M$|M7|M9|6$|6\/9|add)/.test(s)) return 'major';
  if (/^(min|minor|m(?!aj))/.test(s)) return /^m7b5|^min7b5/.test(s) ? null : 'minor';
  return null;
}

/**
 * Best-effort triad name for a set of pitches (harness/mock convenience only; live input uses Tuninator's
 * own harmony.root / quality). Returns { root: pc, quality: 'maj'|'min' } or {}.
 */
export function inferTriad(midis) {
  const pcs = new Set(midis.map(mod12));
  const bass = midis.length ? mod12(Math.min(...midis)) : 0;
  const order = [bass, ...[...pcs].filter((p) => p !== bass)];
  for (const r of order) {
    if (!pcs.has(mod12(r + 7))) continue;
    if (pcs.has(mod12(r + 4))) return { root: r, quality: 'maj' };
    if (pcs.has(mod12(r + 3))) return { root: r, quality: 'min' };
  }
  return {};
}

export class GuitarMapper {
  constructor({ tonicPc = 0, mode = 'major', lowRoot = GUITAR.initialLowRoot } = {}) {
    this.tonicPc = mod12(tonicPc);
    this.mode = SCALES[mode] ? mode : 'major';
    // lowRoot must carry the tonic's pitch class: snap to the tonic at or below the given value
    this.lowRoot = lowRoot - mod12(lowRoot - this.tonicPc);
  }

  get name() { return `${KEY_NAMES[this.tonicPc]} ${this.mode}`; }
  get state() { return { tonicPc: this.tonicPc, mode: this.mode, lowRoot: this.lowRoot, name: this.name }; }

  /** Scale degree index 0..6 of a MIDI note in the current key, or -1 when it is not diatonic. */
  degree(midi) { return SCALES[this.mode].indexOf(mod12(midi - this.tonicPc)); }
  /** True when every note is in the current key. */
  diatonic(midis) { return midis.every((m) => this.degree(m) >= 0); }
  /** The tonic at or below a MIDI note. */
  tonicAtOrBelow(midi) { return midi - mod12(midi - this.tonicPc); }

  /** One note → lane 1..8, or null when it is not in the key (does nothing). Moves the octave per the rules. */
  note(midi) {
    if (!Number.isFinite(midi)) return null;
    midi = Math.round(midi);
    const d = this.degree(midi);
    if (d < 0) return null;
    if (d > 0) { this.lowRoot = this.tonicAtOrBelow(midi); return d + 1; }
    // tonic: relative to the current octave
    if (midi === this.lowRoot) return 1;
    if (midi === this.lowRoot + 12) return 8;
    if (midi > this.lowRoot + 12) { this.lowRoot = midi - 12; return 8; }
    this.lowRoot = midi;                          // below the octave: it becomes the low root
    return 1;
  }

  /**
   * A chord (Tuninator harmony): key change test, then every tone mapped ascending, lanes deduplicated (first
   * appearance order). A key change needs ≥ 3 pitches (voices: duplicates in other octaves count), a pitch class
   * outside the current key, and a known root (no root → Tuninator is abstaining → no key change; tones are
   * still mapped in the current key). After mapping, the octave is left where the chord's lowest note (its bass)
   * alone would put it, so upper chord tones do not drag the octave up.
   * @returns {{ keyChanged: boolean, lanes: number[] }}
   */
  chord(midis, { root, quality } = {}) {
    const ms = (midis || []).filter(Number.isFinite).map(Math.round).sort((a, b) => a - b);
    if (!ms.length) return { keyChanged: false, lanes: [] };
    let keyChanged = false;
    const rootPc = toPc(root);
    if (ms.length >= 3 && rootPc !== undefined && !this.diatonic(ms)) {
      const mode = qualityMode(quality) ?? this.mode;
      keyChanged = rootPc !== this.tonicPc || mode !== this.mode;
      this.tonicPc = rootPc;
      this.mode = mode;
      this.lowRoot = this.tonicAtOrBelow(ms[0]);
    }
    const lanes = [];
    let bassRoot = this.lowRoot;
    ms.forEach((m, i) => {
      const lane = this.note(m);
      if (i === 0) bassRoot = this.lowRoot;          // the octave as the bass note alone would leave it
      if (lane != null && !lanes.includes(lane)) lanes.push(lane);
    });
    this.lowRoot = bassRoot;
    return { keyChanged, lanes };
  }
}
