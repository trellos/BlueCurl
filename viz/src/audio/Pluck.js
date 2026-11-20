// BlueCurl Swell — plucky synth for the number keys. Output only: never feeds the sim.
//
// Keys 1–8 (Shift = soft) sound the note that lane stands for in the guitar's current key and octave
// (GuitarMapper: lane 1 = lowRoot, 2..7 = scale degrees, 8 = lowRoot + 12), so the keyboard plays the same
// scale the guitar is mapped to. It shares BeatAudio's AudioContext and compressor but not its volume/mute.
// The note plays immediately on keydown (no sim latency) and rings out on its own; keyup only damps it a little.
// With the guitar mic on, GuitarInput.suppressEcho() keeps the mic from re-triggering the plucked note.
import { SCALES, GUITAR } from '../contracts.js';

const GAIN = 0.32;            // per note at velocity 1 (before the shared compressor)
const DECAY = 1.1;            // s, amplitude tail
const DAMP = 0.18;            // s, extra release time constant after keyup

/** MIDI note for lane 1..8 in a key: { tonicPc, mode, lowRoot } (GuitarMapper.state). */
export function laneMidi(lane, key = { mode: 'major', lowRoot: GUITAR.initialLowRoot }) {
  const scale = SCALES[key.mode] || SCALES.major;
  const low = Number.isFinite(key.lowRoot) ? key.lowRoot : GUITAR.initialLowRoot;
  if (lane >= 8) return low + 12;
  return low + scale[Math.max(0, Math.min(6, lane - 1))];
}
export const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

export class Pluck {
  constructor(app) {
    this.app = app;
    this.voices = new Map();    // key code → { gain, stopAt }
    this.stats = { notes: 0 };
    if (typeof window === 'undefined' || app.capture) return;
    const laneOf = (e) => {
      const m = /^(?:Digit|Numpad)([1-8])$/.exec(e.code || '');
      if (m) return +m[1];
      if (!e.code && /^[1-8]$/.test(e.key || '')) return +e.key;
      return 0;
    };
    const typing = (e) => {
      const el = e.target;
      return !!(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || '')));
    };
    this._onDown = (e) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || typing(e)) return;
      const lane = laneOf(e);
      if (lane) this.play(lane, e.shiftKey ? 0.4 : 1, e.code || e.key);
    };
    this._onUp = (e) => { const v = this.voices.get(e.code || e.key); if (v) this._damp(v); };
    window.addEventListener('keydown', this._onDown);
    window.addEventListener('keyup', this._onUp);
  }

  /** The key the number keys play in: the guitar mapper's current state. */
  get key() { return this.app.guitar?.mapper?.state || { tonicPc: 0, mode: 'major', lowRoot: GUITAR.initialLowRoot }; }

  /** Pluck lane 1..8 now. Returns the MIDI note (or null when there is no audio yet). */
  play(lane, velocity = 1, voiceKey = null) {
    const ba = this.app.beatAudio;
    ba?.unlock?.();                                 // a keydown is a user gesture
    const ctx = ba?.ctx;
    if (!ctx || !ba.comp) return null;
    const midi = laneMidi(lane, this.key);
    this.app.guitar?.suppressEcho?.(midi);
    const f = midiHz(midi), now = ctx.currentTime, v = Math.max(0.05, Math.min(1, velocity));

    // two slightly detuned saws + a square an octave down through a low-pass whose cutoff snaps shut = pluck
    const out = ctx.createGain();
    out.gain.setValueAtTime(0, now);
    out.gain.linearRampToValueAtTime(GAIN * v, now + 0.003);
    out.gain.exponentialRampToValueAtTime(0.0001, now + DECAY);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 6;
    lp.frequency.setValueAtTime(Math.min(16000, f * (10 + 14 * v)), now);
    lp.frequency.exponentialRampToValueAtTime(Math.max(120, f * 1.5), now + 0.22);
    lp.connect(out);
    out.connect(ba.comp);
    const oscs = [];
    for (const [type, mul, det, g] of [['sawtooth', 1, -6, 0.5], ['sawtooth', 1, 6, 0.5], ['square', 0.5, 0, 0.35]]) {
      const o = ctx.createOscillator(), og = ctx.createGain();
      o.type = type; o.frequency.value = f * mul; o.detune.value = det; og.gain.value = g;
      o.connect(og).connect(lp);
      o.start(now); o.stop(now + DECAY + 0.05);
      oscs.push(o);
    }
    // a short noise-free "tick" at the attack: a high sine blip
    const tick = ctx.createOscillator(), tg = ctx.createGain();
    tick.frequency.value = Math.min(8000, f * 6);
    tg.gain.setValueAtTime(0.12 * v, now); tg.gain.exponentialRampToValueAtTime(0.0001, now + 0.03);
    tick.connect(tg).connect(out); tick.start(now); tick.stop(now + 0.05);

    const voice = { out, oscs, ctx };
    if (voiceKey != null) { const old = this.voices.get(voiceKey); if (old) this._damp(old); this.voices.set(voiceKey, voice); }
    oscs[0].onended = () => { try { out.disconnect(); } catch { /* ignore */ } if (voiceKey != null && this.voices.get(voiceKey) === voice) this.voices.delete(voiceKey); };
    this.stats.notes++;
    this.last = { lane, midi, velocity: v };
    return midi;
  }

  _damp(voice) {
    const now = voice.ctx.currentTime;
    voice.out.gain.cancelScheduledValues(now);
    voice.out.gain.setTargetAtTime(0, now, DAMP);
  }

  dispose() {
    if (typeof window === 'undefined') return;
    if (this._onDown) window.removeEventListener('keydown', this._onDown);
    if (this._onUp) window.removeEventListener('keyup', this._onUp);
  }
}
