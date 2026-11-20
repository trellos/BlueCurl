// BlueCurl Swell — PiP follow cam (WP7). Pure JS (no three.js): stepped at the sim DT only, so its state is a
// function of the sim history and never of the frame rate (deterministic and resumable).
//
// Framing (world: waves travel toward -X, crests run along Z; T = along the crest in the ride direction,
// S = shoreward = -X (the face side), Y = up). The camera sits on a sphere around the rider at distance d:
//   ride   3/4 from the shoulder: azimuth az from T toward S, elevation el; looks back past the rider down the
//          line into the pocket so the curl and the lip are in shot.
//   tube   from the channel / shoulder, nearly in line with the tube axis and low, looking into the barrel.
//   animal (dolphin, seal, turtle) lower and closer.
// d comes from a minimum rider size: rider bounding height ≥ SIZE_MIN of the tile height at the tile's fov.
// Constraints (desired pose, re-solved every SOLVE_EVERY steps): ≥ minClear above the water surface, shoreward
// of the crest (never behind the wave relative to the rider), and an unobstructed camera → rider segment (no wave
// sheet / lip in between): if blocked, swing toward face-on (az ↑) and up (el ↑) until clear.
// Smoothing (spike chase cam): ride direction from the smoothed rider velocity (~1 s), anchor height τ 0.45 s,
// pitch τ 0.3 s, roll 0. The smoothed output is lifted (never lowered) if it ends up under the water / in a sheet.
// After the ride (kick-out, close-out, return) the framing offset freezes; the camera keeps trailing the rider.

export const FOLLOW = {
  tauHeading: 1.0,      // s, ride direction (smoothed rider velocity along the crest)
  tauAnchorXZ: 0.2,     // s, rider position (horizontal) the offsets hang from
  tauAnchorY: 0.45,     // s, rider height (spike: camera height τ 0.45)
  tauOffset: 0.6,       // s, camera offset (ride ↔ tube framing, occlusion swings, direction flips)
  tauLook: 0.15,        // s, look-at point
  tauPitch: 0.3,        // s, pitch (spike)
  tauFov: 0.5,          // s
  tauSub: 1.2,          // s, animal submerged ↔ surfaced (porpoising must not pump the camera)
  minClear: 1.5,        // m above the water surface under the camera
  sizeMin: 0.16,        // rider bounding height / tile height targeted (≥ 0.12 required)
  solveEvery: 6,        // steps between constraint solves (20 Hz at DT = 1/120)
  aspect: 16 / 9,       // tile aspect (the margin rule needs the horizontal fov)
  marginX: 0.6,         // the rider's centre stays within this fraction of the half-width …
  marginY: 0.55,        // … and of the half-height (output-only correction of yaw / pitch)
};

/** Bounding height (m) of a rider for the size rule. */
export const RIDER_HEIGHT = { surfer: 1.7, dolphin: 1.1, seal: 0.9, turtle: 0.7 };
/** Size-rule height of an animal swimming under the surface (the camera keeps a few metres and aims at the surface). */
export const SUBMERGED_HEIGHT = 0.75;
/** Extra elevation (deg) while an animal is under water: look down through the surface at where it swims. */
export const SUBMERGED_EL = 10;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const RAD = Math.PI / 180;

/** Base framing: { az, el (deg), fov (deg), back (× d, look-at behind the rider), lookUp (m), hR (m) }. */
export function framing(kind, style, H, sub = 0) {
  const g = clamp(Number.isFinite(H) ? H : 1.5, 0.6, 4);
  const animal = kind === 'dolphin' || kind === 'seal' || kind === 'turtle';
  let hR = (RIDER_HEIGHT[kind] || 1.5) * (style === 'tube' ? 0.85 : 1);
  if (animal) hR += (SUBMERGED_HEIGHT - hR) * clamp(sub, 0, 1);
  if (style === 'tube') return { az: 26, el: 5, fov: 46 + 2 * g, back: 0.12, lookUp: 0.3 * g, hR };
  if (animal) return { az: 50, el: 9, fov: 44 + 2 * g, back: 0.12, lookUp: 0.15 * g, hR };
  return { az: 48, el: 11, fov: 40 + 3 * g, back: 0.15, lookUp: 0.25 * g, hR };
}

/** Distance at which a rider of bounding height hR fills `size` of the frame height at vertical fov (deg). */
export const distanceFor = (hR, fovDeg, size) => hR / (size * 2 * Math.tan((fovDeg * RAD) / 2));

const RIDING = new Set(['POSITION', 'TAKEOFF', 'RIDE']);

export class FollowCam {
  constructor(opts = {}) { this.o = { ...FOLLOW, ...opts }; this.reset(); }

  reset() {
    this.init = false;
    this.n = 0;                       // steps taken
    this.vz = 0;                      // smoothed rider velocity along the crest (m/s)
    this.sigma = 1;                   // ride direction along +Z (1) or -Z (-1)
    this.anc = { x: 0, y: 0, z: 0 };  // smoothed rider position
    this.prev = null;                 // previous rider position (velocity)
    this.want = { x: 0, y: 0, z: 0 }; // desired offset (constraint-solved)
    this.off = { x: 0, y: 0, z: 0 };  // smoothed camera offset
    this.look = { x: 0, y: 0, z: 0 }; // smoothed look-at point
    this.pitch = 0;
    this.fov = 45;
    this.swing = 0;                   // extra azimuth/elevation from the last occlusion solve (0..N)
    this.sub = 0;                     // smoothed "animal is under water" (0..1, τ tauSub)
    this.out = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, fov: 45 };
  }

  /**
   * One fixed step. ctx = { pos, fwd, kind, style, state, H, dir (-1|0|1 peel direction along Z, 0 = unknown),
   *   surface(x, z) → water height, blocked(ax, ay, az, bx, by, bz) → bool (wave sheet between a and b),
   *   crestX (world x of the crest at the rider's column, or null) }. Animals under the surface get the smaller
   *   SUBMERGED_HEIGHT for the size rule (smoothed), so a porpoising dolphin is still readable.
   */
  step(dt, ctx) {
    const o = this.o, P = ctx.pos;
    const k = (tau) => (this.init ? 1 - Math.exp(-dt / tau) : 1);
    const riding = ctx.state == null || RIDING.has(ctx.state);

    // ride direction: smoothed velocity along the crest, else the peel direction, else the heading
    if (this.prev && dt > 0) this.vz += ((P.z - this.prev.z) / dt - this.vz) * k(o.tauHeading);
    this.prev = { x: P.x, y: P.y, z: P.z };
    if (riding) {
      if (Math.abs(this.vz) > 3) this.sigma = this.vz < 0 ? -1 : 1;     // hysteresis: a cutback doesn't flip it
      else if (!this.init) {
        const F = ctx.fwd;
        this.sigma = ctx.dir === 1 || ctx.dir === -1 ? ctx.dir : (F && F.z < 0 ? -1 : 1);
      }
    }

    // anchor (rider position, smoothed); after the ride the offset is frozen but the anchor keeps following, so
    // the rider (kicking out over the back, paddling away) never runs into or away from the camera
    {
      const kxz = k(o.tauAnchorXZ), ky = k(o.tauAnchorY);
      this.anc.x += (P.x - this.anc.x) * kxz; this.anc.z += (P.z - this.anc.z) * kxz; this.anc.y += (P.y - this.anc.y) * ky;
    }

    const wr = ctx.surface ? ctx.surface(P.x, P.z) : NaN;
    const under = Number.isFinite(wr) && P.y < wr - 0.15 ? 1 : 0;
    this.sub += (under - this.sub) * k(o.tauSub);
    const f = framing(ctx.kind, ctx.style, ctx.H, this.sub);
    this.fov += (f.fov - this.fov) * k(o.tauFov);
    const d = distanceFor(f.hR, f.fov, o.sizeMin);

    // constraint solve for the desired offset (every solveEvery steps, and on the first step)
    if (riding && (this.n % o.solveEvery === 0 || !this.init)) {
      let best = null;
      for (let i = 0; i <= 8; i++) {
        const az = Math.min(88, f.az + 8 * i) * RAD, el = Math.min(45, f.el + SUBMERGED_EL * this.sub + 4 * i) * RAD;
        const ox = -d * Math.cos(el) * Math.sin(az), oz = this.sigma * d * Math.cos(el) * Math.cos(az);
        const cx = P.x + ox, cz = P.z + oz;
        let oy = d * Math.sin(el);
        const w = ctx.surface ? ctx.surface(cx, cz) : 0;
        if (Number.isFinite(w)) oy = Math.max(oy, w + o.minClear - P.y);
        const cy = P.y + oy;
        const behind = ctx.crestX != null && Number.isFinite(ctx.crestX) && cx > Math.min(ctx.crestX - 1.5, P.x + 0.5);
        // aim the visibility test at the rider's upper body, kept just above the water (animals swim submerged)
        const ty = Math.max(P.y + 0.5 * f.hR, Number.isFinite(wr) ? wr + 0.4 : P.y);
        const blk = ctx.blocked ? ctx.blocked(cx, cy, cz, P.x, ty, P.z) : false;
        best = { x: ox, y: oy, z: oz, i };
        if (!behind && !blk) break;
      }
      this.want.x = best.x; this.want.y = best.y; this.want.z = best.z; this.swing = best.i;
    }
    this.n++;

    if (riding || !this.init) {
      const ko = k(o.tauOffset);
      this.off.x += (this.want.x - this.off.x) * ko;
      this.off.y += (this.want.y - this.off.y) * ko;
      this.off.z += (this.want.z - this.off.z) * ko;
    }

    // look-at: behind the rider (down the line toward the pocket), a little up the face
    const kl = k(o.tauLook);
    const back = riding ? f.back * d : 0;
    // (an animal under water: aim at the surface above it, not down into the water)
    const py = Number.isFinite(wr) ? Math.max(P.y, wr - 0.1) : P.y;
    const lx = P.x, ly = py + (riding ? f.lookUp : 0.3), lz = P.z - this.sigma * back;
    this.look.x += (lx - this.look.x) * kl; this.look.y += (ly - this.look.y) * kl; this.look.z += (lz - this.look.z) * kl;

    // camera position: lifted out of the water / sheet if the smoothed pose ended up there
    const cx = this.anc.x + this.off.x, cz = this.anc.z + this.off.z;
    let cy = this.anc.y + this.off.y;
    const w = ctx.surface ? ctx.surface(cx, cz) : 0;
    if (Number.isFinite(w)) cy = Math.max(cy, w + o.minClear);

    const dx = this.look.x - cx, dy = this.look.y - cy, dz = this.look.z - cz;
    let yaw = Math.atan2(-dx, -dz);
    const pitchT = Math.atan2(dy, Math.hypot(dx, dz));
    this.pitch += (pitchT - this.pitch) * k(o.tauPitch);
    // margin: keep the rider's centre inside the safe box (turn the view, not the state, when it would crop)
    let pitch = this.pitch;
    {
      const ry = (Number.isFinite(wr) ? Math.max(P.y, wr - 0.2) : P.y) + 0.45 * f.hR;
      const rx = P.x - cx, rz = P.z - cz, rh = Math.hypot(rx, rz);
      if (rh > 0.5) {
        const vf = (this.fov * RAD) / 2, hf = Math.atan(Math.tan(vf) * o.aspect);
        let dyaw = Math.atan2(-rx, -rz) - yaw;
        dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
        const limY = o.marginX * hf;
        if (Math.abs(dyaw) > limY) yaw += dyaw - Math.sign(dyaw) * limY;
        const dp = Math.atan2(ry - cy, rh) - pitch, limP = o.marginY * vf;
        if (Math.abs(dp) > limP) pitch += dp - Math.sign(dp) * limP;
      }
    }
    this.init = true;

    const out = this.out;
    out.x = cx; out.y = cy; out.z = cz; out.yaw = yaw; out.pitch = pitch; out.roll = 0; out.fov = this.fov;
    return out;
  }

  /** Plain snapshot of the full state (tests compare these). */
  snapshot() {
    return JSON.parse(JSON.stringify({ init: this.init, n: this.n, vz: this.vz, sigma: this.sigma, anc: this.anc,
      prev: this.prev, want: this.want, off: this.off, look: this.look, pitch: this.pitch, fov: this.fov, swing: this.swing, sub: this.sub,
      out: this.out }));
  }
}
