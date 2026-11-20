// STUB (owner WP6a). Rider state machine + planner. See contracts.js "riders".
import { RIDERS } from '../contracts.js';
export class Riders {
  constructor(cfg) { this.cfg = cfg; this.events = []; this.riders = []; this.reset(); }
  reset() { this.events = []; this.riders = RIDERS.map((r, i) => ({ ...r, state: 'LINEUP', style: null, action: 'idle', actionT: 0,
    pos: { x: 190, y: 0, z: -40 + i * 12 }, fwd: { x: -1, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 }, speed: 0, frontId: null, zi: -1, u: 0.5, sigma: 0.5 })); }
  step(t, dt, swell) {}
}
