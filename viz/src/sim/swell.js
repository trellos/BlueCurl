// STUB (owner WP3). Contract: see src/contracts.js "swell state".
export class Swell {
  constructor(cfg) { this.cfg = cfg; this.fronts = []; this.impulses = []; this.events = []; this.schedule = { intervalSec: 16, nextPointT: 0 }; }
  reset() { this.fronts = []; this.impulses = []; this.events = []; }
  step(t, dt, events) {}
}
