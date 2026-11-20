// Pure fixed-step simulation clock (no DOM, no wall time). The sim advances only in whole steps of DT.
//
// Requested time is accumulated and converted to a step count with contracts.stepsFor (round to nearest,
// tolerance 0.01·DT), so the number of steps after any sequence of advance() calls depends only on the
// total requested time, not on how it was chunked: 1 × 3 s and 72 × (1/24) s both give 360 steps.
// Step k (1-based) advances the state from (k−1)·DT to k·DT and is called with t = k·DT.
import { DT, stepsFor } from '../contracts.js';

export class FixedClock {
  constructor(dt = DT) {
    this.dt = dt;
    this.reset();
  }

  reset(t = 0) {
    this.step = stepsFor(t);
    this.requested = this.step * this.dt;
  }

  /** Sim time of the current state (s). */
  get t() { return this.step * this.dt; }

  /** Add `sec` of requested time; returns how many steps are now due (does not run them). */
  request(sec) {
    if (sec > 0) this.requested += sec;
    return Math.max(0, stepsFor(this.requested) - this.step);
  }

  /**
   * Advance by `sec`, calling stepFn(t, dt) once per due step with t = time after the step.
   * Returns the number of steps run.
   */
  advance(sec, stepFn) {
    const n = this.request(sec);
    for (let i = 0; i < n; i++) {
      this.step++;
      stepFn(this.t, this.dt);
    }
    return n;
  }

  /** Run exactly n steps (ignores the requested-time accumulator, then re-syncs it). */
  runSteps(n, stepFn) {
    for (let i = 0; i < n; i++) {
      this.step++;
      stepFn(this.t, this.dt);
    }
    this.requested = Math.max(this.requested, this.t);
    return n;
  }
}
