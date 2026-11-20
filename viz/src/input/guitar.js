// BlueCurl Swell — guitar input (WP10): Tuninator Notes → GuitarMapper lanes → app.input impulses.
// Contract: src/contracts.js "guitar input".
//
// Lanes are resolved here, before the input log, so a recorded log replays without Tuninator.
//
// Per Tuninator Note (id):
//   - its pitch is first known (noteStarted, or a later noteChanged that brings pitch.current) → mapper.note(midi)
//     → one impulse (lowest latency). Later pitch refinements/corrections never fire again.
//   - harmony blooms (noteChanged harmonyEnrichment | harmonyCorrection | pitchAdded with ≥ 2 detected pitches)
//     → mapper.chord(detectedPitches, { root, quality }) (may change the key) → one impulse per lane this Note
//     has not fired yet.
//   - noteEnded / noteResolved → release every impulse of the Note.
// velocity = dB(amplitude.rms) mapped linearly from VEL_DB_LO..VEL_DB_HI to VEL_MIN..1 (clamped); see velocityFor.
//
// Sources: real mic (key G toggles; ?guitar=1 starts on load, or on the first click/key if the autoplay policy
// refuses), a scripted mock (?guitar=mock, or G while in mock mode), and window.bluecurl.guitarNote(...) (harness).
import { GuitarMapper, midiName, inferTriad, PC_NAMES } from './guitarMap.js';

/** dBFS of a Note's rms at first pitch, calibrated on Tuninator's fixtures (offline engine, see test/guitar-fixtures):
 *  quietest picked notes ≈ −42 dB, median single notes ≈ −37, strummed chords ≈ −26 … −20, loudest ≈ −20.5. */
export const VEL_DB_LO = -45, VEL_DB_HI = -20, VEL_MIN = 0.3;
export function velocityFor(rms) {
  if (!(rms > 0)) return VEL_MIN;
  const db = 20 * Math.log10(rms);
  const k = Math.min(1, Math.max(0, (db - VEL_DB_LO) / (VEL_DB_HI - VEL_DB_LO)));
  return +(VEL_MIN + (1 - VEL_MIN) * k).toFixed(3);
}

const HARMONY_CHANGES = new Set(['harmonyEnrichment', 'harmonyCorrection', 'pitchAdded']);
const LANES = 8;

/** Scripted phrase for ?guitar=mock: [delay s, midi | midis[], dur s, rms]. Plays C major run, C, Cm (→ C minor),
 *  C minor run, C (→ C major), then loops. */
const MOCK_PHRASE = [
  ...[48, 50, 52, 53, 55, 57, 59, 60].map((m, i) => [0.3, m, 0.25, 0.03 + 0.006 * i]),
  [0.5, [48, 52, 55, 60], 0.9, 0.09],
  [1.1, [48, 51, 55, 60], 0.9, 0.09],
  ...[48, 50, 51, 53, 55, 56, 58, 60].map((m, i) => [i ? 0.3 : 1.1, m, 0.25, 0.03 + 0.006 * i]),
  [0.5, [48, 52, 55, 60], 0.9, 0.09],
];
const MOCK_LOOP_GAP = 2.5;

/** Minimal Note snapshot in Tuninator's shape (only what GuitarInput reads). */
function mkNote(id, midi, rms, harmony) {
  return {
    id, pitch: { current: { midi, name: midiName(midi) } }, harmony,
    amplitude: { rms }, lifecycle: 'started',
  };
}
function mkHarmony(midis, root, quality) {
  const ms = [...midis].sort((a, b) => a - b);
  const tri = root == null ? inferTriad(ms) : { root, quality };
  const rootName = typeof tri.root === 'number' ? PC_NAMES[tri.root] : tri.root;
  return {
    root: rootName, quality: tri.quality,
    chordName: rootName ? rootName + (tri.quality === 'min' ? 'm' : tri.quality && tri.quality !== 'maj' ? tri.quality : '') : undefined,
    detectedPitches: ms.map((m) => ({ midi: m, name: midiName(m) })),
  };
}

/** A recognizer-shaped mock: plays MOCK_PHRASE in a loop (wall clock). */
class MockRecognizer {
  constructor() { this.handlers = {}; this.timers = []; this.state = 'idle'; this.n = 0; }
  on(ev, fn) { (this.handlers[ev] ||= []).push(fn); return () => {}; }
  emit(ev, ...a) { for (const fn of this.handlers[ev] || []) fn(...a); }
  getState() { return this.state; }
  _at(sec, fn) { this.timers.push(setTimeout(fn, Math.round(sec * 1000))); }
  _loop() {
    let t = 0;
    for (const [delay, m, dur, rms] of MOCK_PHRASE) {
      t += delay;
      const id = `mock${++this.n}`;
      const midis = Array.isArray(m) ? m : [m];
      const note = mkNote(id, midis[0], rms);
      this._at(t, () => this.emit('noteStarted', note));
      if (midis.length > 1) {
        const bloom = { ...note, harmony: mkHarmony(midis), lifecycle: 'enriching' };
        this._at(t + 0.06, () => this.emit('noteChanged', bloom, { type: 'harmonyEnrichment' }));
      }
      this._at(t + dur, () => this.emit('noteEnded', { ...note, lifecycle: 'ended' }));
    }
    this._at(t + MOCK_LOOP_GAP, () => { this.timers = []; if (this.state === 'listening') this._loop(); });
  }
  async start() { this.state = 'listening'; this.emit('stateChange', 'listening'); this._loop(); }
  async stop() { this.state = 'idle'; for (const h of this.timers) clearTimeout(h); this.timers = []; this.emit('stateChange', 'idle'); }
  async dispose() { await this.stop(); }
}

function errorMessage(e) {
  const name = e?.cause?.name || e?.name;
  const code = e?.code;
  if (code === 'mic-permission-denied' || name === 'NotAllowedError' || name === 'SecurityError') return 'microphone permission denied';
  if (code === 'mic-unavailable' || name === 'NotFoundError' || name === 'OverconstrainedError') return 'no microphone found';
  return (code ? code + ': ' : '') + (e?.message || String(e));
}

export class GuitarInput {
  /**
   * @param app  { input: InputBus, simTime, cfg, capture? }
   * @param opts { recognizer?: Recognizer-like (on/start/stop/dispose) — used instead of tuninator's, mapper? }
   */
  constructor(app, opts = {}) {
    this.app = app;
    app.guitar = this;
    this.opts = opts;
    this.mapper = opts.mapper || new GuitarMapper(GuitarInput.keyFromName(app.cfg?.guitar?.key));
    this.status = { state: 'off', message: '', key: this.mapper.name, lowRoot: this.mapper.lowRoot, last: null };
    this.source = null;        // 'mic' | 'mock' | 'custom'
    this.recognizer = null;
    this.audioContext = null;
    this.notes = new Map();    // Tuninator note id → { fired:Set<lane>, ids:number[], pitched, harmonySig }
    this._unsub = [];
    this._harnessN = 0;
    this._busy = false;

    if (typeof window === 'undefined') return;
    const qs = new URLSearchParams(window.location?.search || '');
    const want = qs.get('guitar');
    this.mode = want === 'mock' ? 'mock' : 'mic';
    this._onKey = (e) => {
      if (e.code !== 'KeyG' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      this.toggle();
    };
    window.addEventListener('keydown', this._onKey);
    // harness hook; main.js (re)creates window.bluecurl right after the App is constructed, so attach afterwards
    const attach = () => { window.bluecurl = Object.assign(window.bluecurl || {}, { guitarNote: (o) => this.guitarNote(o) }); };
    attach();
    queueMicrotask(attach);
    setTimeout(attach, 0);
    // Guitar input is asked for by default (?guitar=0 turns that off, ?guitar=mock plays the scripted phrase): start
    // once the app has booted (window.__ready is set right after the App is constructed; starting earlier would bunch
    // the mock's wall-clock notes up behind shader compilation). Without a user gesture yet, a prompt asks for a click.
    if (want !== '0' && want !== 'false' && !app.capture) {
      setTimeout(() => Promise.resolve(window.__ready).catch(() => {}).then(() => this.start({ deferToGesture: true })), 0);
    }
  }

  /** 'C minor' → { tonicPc, mode } (defaults C major). */
  static keyFromName(name) {
    const m = /^\s*([A-Ga-g][#b]?)\s*(major|minor)?/.exec(String(name || ''));
    const map = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
    if (!m) return { tonicPc: 0, mode: 'major' };
    const n = m[1][0].toUpperCase() + m[1].slice(1);
    return { tonicPc: map[n] ?? 0, mode: m[2] || 'major' };
  }

  _set(state, message = '') { this.status.state = state; this.status.message = message; }
  _syncKey() { this.status.key = this.mapper.name; this.status.lowRoot = this.mapper.lowRoot; }

  // ------------------------------------------------------------ note handling (shared by mic, mock, harness, tests)
  /** Feed one recognizer event. type: 'noteStarted' | 'noteChanged' | 'noteEnded' | 'noteResolved'. Returns lanes fired. */
  onNoteEvent(type, note, change) {
    if (!note || note.id == null) return [];
    if (type === 'noteEnded' || type === 'noteResolved') { this._end(note.id); return []; }
    let rec = this.notes.get(note.id);
    if (!rec) {
      if (type === 'noteChanged' && this._ended?.has(note.id)) return [];   // late revision of an ended note
      rec = { fired: new Set(), ids: [], pitched: false, harmonySig: '' };
      this.notes.set(note.id, rec);
    }
    const fired = [];
    const vel = velocityFor(note.amplitude?.rms);
    // 1) first known pitch → one impulse
    const midi = note.pitch?.current?.midi;
    if (!rec.pitched && Number.isFinite(midi)) {
      rec.pitched = true;
      if (this._isEcho(midi)) { rec.echo = true; return fired; }    // the mic heard our own pluck
      const lane = this.mapper.note(midi);
      if (lane != null) this._fire(rec, lane, vel, note.pitch.current.name || midiName(midi), fired);
      else this._syncKey();
    }
    // 2) harmony bloom → chord lanes (+ maybe a key change)
    if (rec.echo) return fired;
    const h = note.harmony;
    const pitches = h?.detectedPitches;
    if (pitches && pitches.length >= 2 && (type === 'noteStarted' || HARMONY_CHANGES.has(change?.type))) {
      const midis = pitches.map((p) => p.midi).filter(Number.isFinite);
      const sig = `${h.root}|${h.quality}|${midis.join(',')}`;
      if (sig !== rec.harmonySig) {
        rec.harmonySig = sig;
        const { keyChanged, lanes } = this.mapper.chord(midis, { root: h.root, quality: h.quality });
        if (keyChanged) this.app.input?.setConfig?.('guitar.key', this.mapper.name);
        const name = h.chordName || (h.root ? h.root + (h.quality === 'min' ? 'm' : '') : midis.map(midiName).join(' '));
        for (const lane of lanes) if (!rec.fired.has(lane)) this._fire(rec, lane, vel, name, fired);
        this._syncKey();
        if (keyChanged) this.status.message = `key → ${this.mapper.name}`;
      }
    }
    return fired;
  }

  _fire(rec, lane, velocity, name, fired) {
    rec.fired.add(lane);
    const id = this.app.input?.impulse?.({ lane: lane - 1, lanes: LANES, scale: 1, velocity });
    if (id != null) rec.ids.push(id);
    fired.push(lane);
    this._syncKey();
    this.status.last = { name, lane, t: this.app.simTime ?? 0, velocity };
  }

  _end(noteId) {
    const rec = this.notes.get(noteId);
    if (!rec) return;
    for (const id of rec.ids) this.app.input?.release?.(id);
    this.notes.delete(noteId);
    (this._ended ||= new Set()).add(noteId);
    if (this._ended.size > 256) this._ended.delete(this._ended.values().next().value);
  }

  _releaseAll() { for (const id of [...this.notes.keys()]) this._end(id); }

  /**
   * Harness: play a note or chord through the same path. { midi } | { midis, root?, quality? }, rms = 0.05,
   * duration (s, wall clock; null = hold until window.bluecurl.guitarNote({ release: id })). Returns
   * { id, lanes, key }.
   */
  guitarNote(o = {}) {
    if (o.release != null) { this.onNoteEvent('noteEnded', { id: o.release }); return { id: o.release, lanes: [], key: this.mapper.name }; }
    const midis = Array.isArray(o.midis) ? o.midis : (Number.isFinite(o.midi) ? [o.midi] : []);
    if (!midis.length) return { id: null, lanes: [], key: this.mapper.name };
    const id = `h${++this._harnessN}`;
    const rms = Number.isFinite(o.rms) ? o.rms : 0.05;
    const sorted = [...midis].sort((a, b) => a - b);
    const note = mkNote(id, sorted[0], rms);
    const lanes = this.onNoteEvent('noteStarted', note);
    if (sorted.length > 1) {
      const harmony = mkHarmony(sorted, o.root, o.quality);     // root: pc number or name; omitted → inferred triad
      lanes.push(...this.onNoteEvent('noteChanged', { ...note, harmony }, { type: 'harmonyEnrichment' }));
    }
    const dur = o.duration === undefined ? 0.4 : o.duration;
    if (dur != null && typeof setTimeout !== 'undefined') setTimeout(() => this.onNoteEvent('noteEnded', note), dur * 1000);
    return { id, lanes, key: this.mapper.name };
  }

  // ------------------------------------------------------------ sources
  _wire(rec) {
    this._unsub = [
      rec.on('noteStarted', (n) => this.onNoteEvent('noteStarted', n)),
      rec.on('noteChanged', (n, c) => this.onNoteEvent('noteChanged', n, c)),
      rec.on('noteEnded', (n) => this.onNoteEvent('noteEnded', n)),
      rec.on('noteResolved', (n) => this.onNoteEvent('noteResolved', n)),
      rec.on('error', (e) => this._set('error', errorMessage(e))),
      rec.on('stateChange', (s) => {
        if (s === 'listening') this._set('listening', this.source === 'mock' ? 'mock phrase' : 'mic on');
        else if (s === 'error' && this.status.state !== 'error') this._set('error', 'recognizer error');
      }),
    ];
  }

  get active() { return this.status.state === 'listening' || this.status.state === 'starting'; }

  toggle() { return this.active ? this.stop() : this.start(); }

  /** Start listening (mic needs a user gesture). Never throws: failures land in status ('error', message). */
  async start({ deferToGesture = false } = {}) {
    if (this._busy || this.active) return;
    this._busy = true;
    this._clearGesture();
    try {
      if (this.opts.recognizer) { this.source = 'custom'; this.recognizer = this.opts.recognizer; }
      else if (this.mode === 'mock') { this.source = 'mock'; this.recognizer = new MockRecognizer(); }
      else {
        this.source = 'mic';
        const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
        if (!AC || !navigator.mediaDevices?.getUserMedia) throw new Error('no Web Audio / microphone API in this browser');
        // created synchronously inside the gesture, then resumed: a context still suspended = autoplay policy
        this.audioContext = new AC();
        // without a gesture Chrome leaves resume() pending (it neither resolves nor rejects): race a short timeout
        try { await Promise.race([this.audioContext.resume(), new Promise((r) => setTimeout(r, 400))]); } catch { /* checked below */ }
        if (this.audioContext.state !== 'running') {
          await this._closeContext();
          if (deferToGesture) { this._armGesture(); return; }
          throw new Error('audio blocked by the browser — press G again');
        }
        this._set('starting', 'opening microphone…');
        const { createRecognizer } = await import('tuninator');
        const base = (import.meta.env && import.meta.env.BASE_URL) || '/';
        this.recognizer = createRecognizer({
          audioContext: this.audioContext,
          workletUrl: new URL(`${base}tuninator/tuninator-worklet.js`, window.location.href).href,
          input: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
      }
      this._set('starting', this.source === 'mic' ? 'opening microphone…' : 'starting');
      this._wire(this.recognizer);
      await this.recognizer.start();
      this._set('listening', this.source === 'mock' ? 'mock phrase' : this.source === 'mic' ? 'mic on' : 'listening');
    } catch (e) {
      console.warn('[guitar] start failed:', e);
      await this._teardown();
      this._set('error', errorMessage(e));
    } finally {
      this._busy = false;
    }
  }

  async stop() {
    if (this._busy) return;
    this._busy = true;
    this._clearGesture();
    try { await this._teardown(); } finally { this._busy = false; }
    this._set('off', '');
  }

  async _teardown() {
    const rec = this.recognizer;
    this.recognizer = null;
    if (rec && rec !== this.opts.recognizer) {
      try { await (rec.dispose ? rec.dispose() : rec.stop()); } catch (e) { console.warn('[guitar] stop:', e); }
    } else if (rec) { try { await rec.stop(); } catch { /* ignore */ } }
    for (const u of this._unsub) { try { typeof u === 'function' && u(); } catch { /* ignore */ } }
    this._unsub = [];
    this._releaseAll();
    await this._closeContext();
  }

  async _closeContext() {
    const ctx = this.audioContext;
    this.audioContext = null;
    if (ctx && ctx.state !== 'closed') { try { await ctx.close(); } catch { /* ignore */ } }
  }

  /** Autoplay policy refused: start on the first click or key (any key; G itself toggles as usual). */
  _armGesture() {
    if (this._gesture || typeof document === 'undefined') return;
    this._set('off', 'click or press a key to start the guitar mic');
    this._showPrompt();
    const fire = (e) => {
      this._clearGesture();
      if (e?.type === 'keydown' && e.code === 'KeyG') return;   // the G handler starts it
      this.start();
    };
    const o = { capture: true };
    document.addEventListener('pointerdown', fire, o);
    document.addEventListener('keydown', fire, o);
    this._gesture = () => { document.removeEventListener('pointerdown', fire, o); document.removeEventListener('keydown', fire, o); };
  }
  _clearGesture() { if (this._gesture) { this._gesture(); this._gesture = null; } this._hidePrompt(); }

  /** On-screen ask while waiting for the gesture the browser needs before it opens the mic. */
  _showPrompt() {
    if (this._prompt || typeof document === 'undefined' || !document.body) return;
    const el = document.createElement('div');
    el.className = 'bc-guitar-prompt';
    el.textContent = '🎸 Click or press any key to turn on guitar input (G toggles · ?guitar=0 to skip)';
    Object.assign(el.style, {
      position: 'fixed', left: '50%', bottom: '24px', transform: 'translateX(-50%)', zIndex: 20,
      padding: '10px 18px', borderRadius: '999px', font: '600 15px system-ui, sans-serif', color: '#fff7e8',
      background: 'rgba(20, 30, 40, 0.72)', boxShadow: '0 2px 12px rgba(0,0,0,0.35)', pointerEvents: 'none',
    });
    document.body.appendChild(el);
    this._prompt = el;
  }
  _hidePrompt() { if (this._prompt) { this._prompt.remove(); this._prompt = null; } }

  /** A pluck (number key) the speakers just played: ignore the mic hearing it as a guitar note (same pitch class). */
  suppressEcho(midi, sec = 0.7) {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    (this._echo ||= []).push({ pc: ((midi % 12) + 12) % 12, until: now + sec * 1000 });
    if (this._echo.length > 32) this._echo.shift();
  }
  _isEcho(midi) {
    if (this.source !== 'mic' || !this._echo?.length) return false;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now(), pc = ((midi % 12) + 12) % 12;
    this._echo = this._echo.filter((e) => e.until > now);
    return this._echo.some((e) => e.pc === pc);
  }

  dispose() {
    if (typeof window !== 'undefined' && this._onKey) window.removeEventListener('keydown', this._onKey);
    this._clearGesture();
    this._teardown();
  }
}
