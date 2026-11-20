// BlueCurl Swell — PiP follow cam (WP7). Pure JS (no three.js): stepped at the sim DT only, so its state is a
// function of the sim history and never of the frame rate (deterministic and resumable).
//
// Framing (world: waves travel toward -X, crests run along Z; T = along the crest in the ride direction,
// S = shoreward = -X, Y = up):
//   ride   a 3/4 view from the shoulder: ahead of the rider along the crest, out in front of the face and above
//          it, looking back past the rider into the pocket so the curl and the lip are in shot.
//   tube   low and nearly in line with the tube axis, from the open (shoulder / channel) end, looking into the barrel.
//   animal (dolphin, seal) slightly lower and closer.
// Smoothing (spike chase cam, src/surf/SurfDemo.js): ~1 s weighted heading, anchor height τ 0.45 s, pitch τ 0.3 s,
// ≥ 0.8 m above the water surface under the camera, roll 0.

export const FOLLOW = {
  tauHeading: 1.0,      // s, rider heading (decides the ride direction when the break is an A-frame)
  tauAnchorXZ: 0.2,     // s, rider position (horizontal) the offsets hang from
  tauAnchorY: 0.45,     // s, rider height (spike: camera height τ 0.45)
  tauOffset: 0.6,       // s, camera offset (blends ride ↔ tube framing and direction flips)
  tauLook: 0.15,        // s, look-at point
  tauPitch: 0.3,        // s, pitch (spike)
  minClear: 0.8,        // m above the water under the camera
  fov: 52,
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** Desired camera offset (T, S, Y components) and look-at offset for a rider. H = wave face height (m). */
export function framing(kind, style, H) {
  const g = clamp(Number.isFinite(H) ? H : 1.5, 0.6, 4);
  let f;
  if (style === 'tube') {
    f = { a: 5 + 2.8 * g, b: 0.9 + 0.55 * g, h: 0.3 + 0.55 * g, back: 2.5 + 1.2 * g, lookUp: 0.45 * g };
  } else {
    f = { a: 4 + 1.8 * g, b: 4.5 + 1.6 * g, h: 1.2 + 0.8 * g, back: 1.5 + 1.1 * g, lookUp: 0.3 * g };
  }
  if (kind === 'dolphin' || kind === 'seal') { f.a *= 0.72; f.b *= 0.7; f.h *= 0.6; f.back *= 0.8; f.lookUp *= 0.7; }
  return f;
}

export class FollowCam {
  constructor(opts = {}) { this.o = { ...FOLLOW, ...opts }; this.reset(); }

  reset() {
    this.init = false;
    this.hd = { x: -1, z: 0 };        // smoothed horizontal heading
    this.sigma = 1;                   // ride direction along +Z (1) or -Z (-1)
    this.anc = { x: 0, y: 0, z: 0 };  // smoothed rider position
    this.off = { x: 0, y: 0, z: 0 };  // smoothed camera offset
    this.look = { x: 0, y: 0, z: 0 }; // smoothed look-at point
    this.pitch = 0;
    this.out = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, fov: this.o.fov };
  }

  /**
   * One fixed step. ctx = { pos, fwd, kind, style, H, dir (-1|0|1 peel direction along Z, 0 = unknown),
   *   surface(x, z) → water height }.
   */
  step(dt, ctx) {
    const o = this.o, P = ctx.pos, F = ctx.fwd || { x: -1, y: 0, z: 0 };
    const k = (tau) => (this.init ? 1 - Math.exp(-dt / tau) : 1);

    // heading (1 s) and ride direction
    const fl = Math.hypot(F.x, F.z);
    if (fl > 1e-3) {
      const kh = k(o.tauHeading);
      this.hd.x += (F.x / fl - this.hd.x) * kh; this.hd.z += (F.z / fl - this.hd.z) * kh;
    }
    if (ctx.dir === 1 || ctx.dir === -1) this.sigma = ctx.dir;
    else if (!this.init) this.sigma = this.hd.z < 0 ? -1 : 1;
    else if (Math.abs(this.hd.z) > 0.3 * Math.hypot(this.hd.x, this.hd.z)) this.sigma = this.hd.z < 0 ? -1 : 1;

    // anchor (rider position, smoothed)
    const kxz = k(o.tauAnchorXZ), ky = k(o.tauAnchorY);
    this.anc.x += (P.x - this.anc.x) * kxz; this.anc.z += (P.z - this.anc.z) * kxz; this.anc.y += (P.y - this.anc.y) * ky;

    // offset: T = (0, 0, sigma), S = (-1, 0, 0)
    const f = framing(ctx.kind, ctx.style, ctx.H), s = this.sigma;
    const ko = k(o.tauOffset);
    this.off.x += (-f.b - this.off.x) * ko;
    this.off.y += (f.h - this.off.y) * ko;
    this.off.z += (s * f.a - this.off.z) * ko;

    // look-at: behind the rider (toward the pocket), a little up the face
    const kl = k(o.tauLook);
    const lx = P.x, ly = P.y + f.lookUp, lz = P.z - s * f.back;
    this.look.x += (lx - this.look.x) * kl; this.look.y += (ly - this.look.y) * kl; this.look.z += (lz - this.look.z) * kl;

    // camera position (clamped above the water, the state stays unclamped like the spike's camY)
    const cx = this.anc.x + this.off.x, cz = this.anc.z + this.off.z;
    let cy = this.anc.y + this.off.y;
    const w = ctx.surface ? ctx.surface(cx, cz) : 0;
    if (Number.isFinite(w)) cy = Math.max(cy, w + o.minClear);

    const dx = this.look.x - cx, dy = this.look.y - cy, dz = this.look.z - cz;
    const yaw = Math.atan2(-dx, -dz);
    const pitchT = Math.atan2(dy, Math.hypot(dx, dz));
    this.pitch += (pitchT - this.pitch) * k(o.tauPitch);
    this.init = true;

    const out = this.out;
    out.x = cx; out.y = cy; out.z = cz; out.yaw = yaw; out.pitch = this.pitch; out.roll = 0; out.fov = o.fov;
    return out;
  }

  /** Plain snapshot of the full state (tests compare these). */
  snapshot() {
    return JSON.parse(JSON.stringify({ init: this.init, hd: this.hd, sigma: this.sigma, anc: this.anc, off: this.off,
      look: this.look, pitch: this.pitch, out: this.out }));
  }
}
