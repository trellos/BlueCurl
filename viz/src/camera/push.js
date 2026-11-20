// BlueCurl Swell — automatic push-in of the 'lineup' wide view (WP7). Pure JS, stepped at the sim DT (deterministic).
//
// While a committed ZoneBreak is active (from its commit, ~3 s before tBreak, until PUSH.after s after its peel ends)
// the view eases toward a 'point'-like framing centred on that break, then back out to the full lineup.
//   - progress p ∈ [0, 1] moves linearly at 1 / rampSec per second toward its goal; the blend is smoothstep(p),
//     i.e. a slow ~2.6 s S-curve in and out;
//   - the focus is the biggest active break (ZoneBreak H); it may only change ZONE when fully pushed out (p = 0),
//     so the camera never whips between zones; a later break in the same zone extends the focus (its centre is
//     eased over with τ PUSH.tauCentre);
//   - calm (M2): while any rider is ENTER-ing / LEAVE-ing or a bird flock is live (PUSH.flockSec after its event),
//     the push is limited to PUSH.calmAmt of itself (eased with the same linear ramp + S-curve), so the riders
//     joining / leaving at the inside and the point stay in the wide frame; the focus logic is unchanged;
//   - cfg.cameraPush (0..1) scales the blend at render time (0 = static); only the 'lineup' preset pushes.
import { ZONES, uToZ, FRONT_W } from '../contracts.js';
import { depthAt } from '../spot/bathymetry.js';

export const PUSH = {
  rampSec: 2.6,            // s, push in / out
  after: 3.0,              // s after the peel ends
  tauCentre: 1.5,          // s, focus centre easing within a zone
  dist: [150, 108, 88],    // m, camera → break centre per zone (outer, point, inside) at full push
  fov: 58,                 // deg at full push
  minY: 24,                // m, camera height floor at full push
  // direction break centre → camera of the full push (the 'point' preset's view of the point: from the bay side,
  // west-north-west and up, looking ESE with the sunrise behind the break), and the terrain clearance
  dir: [-94, 30, 39],
  clear: 14,
  shoreward: 6,            // m, the frame centre sits this far shoreward of the zone line (where the curl lands)
  calmAmt: 0.2,            // push kept while riders enter / leave or a flock is live (fraction)
  flockSec: 3.0,           // s a flock event keeps the push calm
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smoothstep = (p) => { p = clamp(p, 0, 1); return p * p * (3 - 2 * p); };

/** Time the break stops being interesting (peel end + PUSH.after). */
export function breakUntil(zb, after = PUSH.after) {
  const run = zb.closeout ? 1.5 : Math.max(0, zb.peelLen) / Math.max(1, zb.vPeel);
  return zb.tBreak + run + (zb.Tb || 2.5) + after;
}

/** World centre of a break: the middle of its peel run on the zone line (clamped to the zone). */
export function breakCentre(zb) {
  const zn = ZONES[zb.zi];
  const lo = Math.min(zn.u0, zn.u1), hi = Math.max(zn.u0, zn.u1);
  const half = zb.closeout || !zb.dir ? 0 : (zb.dir * Math.min(zb.peelLen, 0.6 * (hi - lo) * FRONT_W)) / 2;
  const u = clamp(zb.uPeak + half / FRONT_W, lo, hi);
  return { x: zn.lineX - PUSH.shoreward, y: 0, z: uToZ(u) };
}

/** True while any rider is ENTER-ing / LEAVE-ing or a flock event is younger than PUSH.flockSec (calm input). */
export function calmFrom(t, riderLists, flocks) {
  for (const l of riderLists || []) for (const r of l || []) if (r && (r.state === 'ENTER' || r.state === 'LEAVE')) return true;
  return (flocks || []).some((f) => f && f.t <= t + 1e-9 && t - f.t <= PUSH.flockSec);
}

export class PushIn {
  constructor() { this.reset(); }
  reset() { this.p = 0; this.goal = 0; this.focus = null; this.c = null; this.calm = 0; }

  /**
   * One fixed step: fronts = swell.fronts (committed breaks live in front.breaks); busy = some rider is ENTER-ing
   * or LEAVE-ing or a flock is live (see calmFrom) → the push eases down to PUSH.calmAmt.
   */
  step(t, dt, fronts, busy = false) {
    const cs = dt / PUSH.rampSec;
    this.calm = busy ? Math.min(1, this.calm + cs) : Math.max(0, this.calm - cs);
    const act = [];
    for (const f of fronts || []) for (const zb of f.breaks || []) {
      const until = breakUntil(zb);
      if (t <= until) act.push({ frontId: f.id, zi: zb.zi, H: zb.H, until, zb });
    }
    const best = (list) => list.slice().sort((a, b) => b.H - a.H || a.frontId - b.frontId || a.zi - b.zi)[0] || null;
    if (this.focus && t > this.focus.until) {
      const same = best(act.filter((a) => a.zi === this.focus.zi));
      if (same && this.goal > 0) this.focus = same;           // keep the zone, follow its next break
    }
    if (this.p <= 0 && this.goal <= 0) {                       // fully out: free to pick any zone
      const b = best(act);
      this.focus = b;
      if (b) this.c = breakCentre(b.zb);
    }
    this.goal = this.focus && t <= this.focus.until ? 1 : 0;
    const step = dt / PUSH.rampSec;
    this.p = this.goal > this.p ? Math.min(this.goal, this.p + step) : Math.max(this.goal, this.p - step);
    if (this.focus && this.c) {
      const tc = breakCentre(this.focus.zb), k = 1 - Math.exp(-dt / PUSH.tauCentre);
      this.c.x += (tc.x - this.c.x) * k; this.c.z += (tc.z - this.c.z) * k;
    }
    if (this.p <= 0 && this.goal <= 0) this.focus = null;
  }

  /** S-curve blend weight 0..1 (incl. the calm limit). */
  weight() { return smoothstep(this.p) * (1 - (1 - PUSH.calmAmt) * smoothstep(this.calm)); }

  /** Blend `base` ({position, target, fov}) toward the focus framing by amount · weight(); returns a new pose. */
  apply(base, amount = 1) {
    const a = clamp(amount, 0, 1) * this.weight();
    if (!(a > 0) || !this.c || !this.focus) return base;
    const C = this.c, [px, py, pz] = base.position;
    const [dx, dy, dz] = PUSH.dir, L = Math.hypot(dx, dy, dz), D = PUSH.dist[this.focus.zi] ?? 110;
    const fx = C.x + (dx * D) / L, fz = C.z + (dz * D) / L;
    const ground = Math.max(0, -depthAt(fx, fz));
    const fp = [fx, Math.max(PUSH.minY, C.y + (dy * D) / L, ground + PUSH.clear), fz], ft = [C.x, -6, C.z];
    const lerp = (u, v) => u + (v - u) * a;
    return {
      ...base,
      position: [lerp(px, fp[0]), lerp(py, fp[1]), lerp(pz, fp[2])],
      target: [lerp(base.target[0], ft[0]), lerp(base.target[1], ft[1]), lerp(base.target[2], ft[2])],
      fov: lerp(base.fov, PUSH.fov),
    };
  }

  snapshot() { return JSON.parse(JSON.stringify({ p: this.p, goal: this.goal, c: this.c, calm: this.calm, focus: this.focus && { frontId: this.focus.frontId, zi: this.focus.zi, until: this.focus.until } })); }
}
