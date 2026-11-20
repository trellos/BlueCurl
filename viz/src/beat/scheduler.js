// BlueCurl Swell — beat hit scheduler (WP11). Pure (no Web Audio): decides WHICH hits to schedule each frame,
// in sim time. BeatAudio maps sim time → AudioContext time with a constant latency.
//
// Each frame: hits of the CURRENT measure (beat.level, beat.measure) whose sim time lies in [cursor, end) with
// end = min(t + lookahead, end of the current measure). Hits of the next measure are emitted only once the sim
// has passed its downbeat (its level is unknown before). The cursor only moves forward → no double hits.
// A rewind or a forward jump > maxJump re-seeds the cursor at t − backfill (older hits are dropped, never played late).
import { patternHits } from './patterns.js';

export class BeatScheduler {
  constructor({ lookahead = 0.12, maxJump = 0.3, backfill = 0.05 } = {}) {
    this.lookahead = lookahead;
    this.backfill = backfill;     // on start / jump also take hits up to this far in the past (< audio latency)
    this.maxJump = maxJump;
    this._cache = new Map();          // `${level}:${measure % 4}` → hits (patterns depend on measure % 4 only)
    this.reset();
  }

  reset() { this.cursor = null; this.lastT = null; }

  /** Restart scheduling at sim time t (hits at t or later are still to come). */
  seek(t) { this.cursor = t; this.lastT = t; }

  _hits(level, measure) {
    const k = level * 4 + (measure % 4);
    let h = this._cache.get(k);
    if (!h) { h = patternHits(level, measure % 4); this._cache.set(k, h); }
    return h;
  }

  /**
   * Hits to schedule this frame (sim time t, beat = Beat sim state at t). Returns { hits, jumped } where
   * hits = [{ t (sim s), step, inst, vel, measure, level }] in time order; jumped = the cursor was re-seeded.
   */
  frame(t, beat, out = []) {
    let jumped = false;
    if (this.cursor == null || t < this.lastT - 1e-9 || t - this.lastT > this.maxJump) { this.seek(t); this.cursor = t - this.backfill; jumped = true; }
    this.lastT = t;
    const t0 = beat.measureT0, len = beat.measureLen;
    const mEnd = t0 + len;                               // same expression as Beat._downbeat's t1
    const start = Math.max(this.cursor, t0);
    const end = Math.min(t + this.lookahead, mEnd);
    if (end > start) {
      const s16 = len / 16;
      for (const h of this._hits(beat.level, beat.measure)) {
        const ts = h.step === 0 ? t0 : t0 + h.step * s16;
        if (ts >= start && ts < end) out.push({ t: ts, step: h.step, inst: h.inst, vel: h.vel, measure: beat.measure, level: beat.level });
      }
      this.cursor = end;
    } else if (start > this.cursor) this.cursor = start;
    return { hits: out, jumped };
  }
}
