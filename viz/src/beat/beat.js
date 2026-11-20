// BlueCurl Swell — beat sim (contract: src/contracts.js "beat"). Pure and deterministic: f(cfg, input log).
// 4/4 bar clock at cfg.bpm; a bpm change applies from the next downbeat. Level 1..maxLevel moves at most one step
// per measure toward target = clamp(notes in the measure that just ended, 1, maxLevel).
import { STEP_TOL } from '../contracts.js';

const RING = 64;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export class Beat {
  constructor(cfg) { this.cfg = cfg; this.reset(); }

  get maxLevel() { return this.cfg.beat?.maxLevel ?? 8; }

  reset() {
    this.t = 0;
    this.measure = 0;
    this.measureT0 = 0;
    this.measureLen = 240 / this.cfg.bpm;
    this.beatLen = this.measureLen / 4;
    this.notes = 0;
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
    for (const ev of events) if (ev && ev.type === 'on') this.notes++;
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
    this.measureLen = 240 / this.cfg.bpm;
    this.beatLen = this.measureLen / 4;
    this.notes = 0;
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
