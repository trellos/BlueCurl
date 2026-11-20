// BlueCurl Swell — beat sim (contract: src/contracts.js "beat"). Pure and deterministic: f(cfg, input log).
// 4/4 bar clock at cfg.bpm; a bpm change applies from the next downbeat. Level 1..maxLevel moves at most one step
// per measure toward target = clamp(notes in the measure that just ended, 1, maxLevel). A chord counts as one note.
import { STEP_TOL } from '../contracts.js';

const RING = 64;
/** s: notes struck this close together (e.g. several number keys at once) count as one chord = one note. */
export const CHORD_WINDOW = 0.04;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
/** Measure length (s) for a bpm; a missing/invalid bpm falls back to 120 so the clock never stalls. */
export const measureLenFor = (bpm) => 240 / (Number.isFinite(+bpm) && +bpm > 0 ? clamp(+bpm, 1, 1000) : 120);

export class Beat {
  constructor(cfg) { this.cfg = cfg; this.reset(); }

  get maxLevel() { return this.cfg.beat?.maxLevel ?? 8; }

  reset() {
    this.t = 0;
    this.measure = 0;
    this.measureT0 = 0;
    this.measureLen = measureLenFor(this.cfg.bpm);
    this.beatLen = this.measureLen / 4;
    this.notes = 0;
    this._lastNoteT = -Infinity;
    this.level = 1;
    this.target = 1;
    this.measures = [];
    this.events = [];
  }

  /** One fixed sim step ending at t; events = the input events applied on this step (all have ev.t ≈ t). */
  step(t, dt, events = []) {
    this.t = t;
    const tol = STEP_TOL / 2;
    // downbeats first: notes applied on the step that reaches a downbeat belong to the new measure
    for (let guard = 0; guard < 16 && t >= this.measureT0 + this.measureLen - tol; guard++) this._downbeat();
    for (const ev of events) {
      if (!ev || ev.type !== 'on') continue;
      if (ev.chord != null && ev.chord !== ev.id) continue;          // a later tone of a tagged chord (guitar)
      if (t - this._lastNoteT < CHORD_WINDOW - STEP_TOL) continue;   // struck with the previous note: same chord
      this._lastNoteT = t;
      this.notes++;
    }
  }

  _downbeat() {
    const t1 = this.measureT0 + this.measureLen;
    const target = clamp(this.notes, 1, this.maxLevel);
    const prevLevel = this.level;
    const change = Math.sign(target - prevLevel);
    this._push(this.measures, { index: this.measure, t0: this.measureT0, t1, notes: this.notes, target, level: prevLevel });
    this.level = clamp(prevLevel + change, 1, this.maxLevel);
    this.target = target;
    this.measure++;
    this.measureT0 = t1;
    this.measureLen = measureLenFor(this.cfg.bpm);
    this.beatLen = this.measureLen / 4;
    this.notes = 0;
    this._lastNoteT = -Infinity;                  // a chord window never spans a bar line
    this._push(this.events, { t: t1, type: 'downbeat', index: this.measure, level: this.level, prevLevel, change: this.level - prevLevel });
  }

  _push(ring, v) { ring.push(v); if (ring.length > RING) ring.shift(); }

  /** Position of time t in the current measure (t may run past it: beats continue at the current length). */
  barPhase(t) {
    const x = (t - this.measureT0) / this.beatLen;
    const k = Math.floor(x);
    return { measure: this.measure + Math.floor(k / 4), beat: ((k % 4) + 4) % 4, frac: x - k };
  }
}
