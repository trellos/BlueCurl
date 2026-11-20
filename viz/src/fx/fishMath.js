// BlueCurl Swell — beat fish (WP15): pure helpers, no three.js.
//
// Fx.step() records every Beat 'downbeat' event whose level changed: change +1 → a fish swimming RIGHT on screen,
// change −1 → LEFT. Fish live in the bay shallows (the trough between the beach and the inside sandbar), in the
// lower middle of the default lineup view. "Right" is the lineup camera's screen-right projected on the water
// (≈ +z, a little seaward), so the fish crosses the screen horizontally. Each fish rises out of the green,
// swims cfg.fish.beats beats (beat length at the spawn), then banks seaward and dives into deeper water, fading.
// Every pose is a pure function of (record, seed, age): no dt integration, no Math.random.
//
// Scale: fantasy, like the 3–7 m birds — an 8 m reef fish (yellow tang / parrotfish / clownfish colours) is
// ~40 px long at 720p from the lineup camera ~130 m away; a real 0.3 m fish would be a single pixel.
import { hash01, DEFAULT_CFG } from '../contracts.js';
import { PRESETS } from '../camera/wide.js';
import { clamp01, lerp, smoothstep } from './fxMath.js';

const TAU = Math.PI * 2;

// lineup camera right vector on the water (unit, xz): screen-right in the default view
const LP = PRESETS.lineup, LF = [LP.target[0] - LP.position[0], LP.target[2] - LP.position[2]];
const RL = Math.hypot(LF[0], LF[1]);
export const SCREEN_RIGHT = [-LF[1] / RL, LF[0] / RL];              // (x, z): right = forward × up

export const FISH = {
  len: 8.0,            // m (fantasy scale, see above)
  speed: 6.5,          // m/s while swimming (≈ 1.2 body lengths / s)
  // (x, z) centres of the swim paths: the sheltered turquoise corner of the bay under the headland (2.5–4.5 m deep),
  // the one stretch of shallows that stays in frame while the lineup camera pushes in toward the point / outer reef
  rows: [[62, 0], [48, 8], [34, 8]],     // offshore → inshore: each new fish swims inshore of the one diving away
  rowJitter: 4,        // m
  depth: 1.4,          // m below the surface (body centre) while swimming
  deepDepth: 4.0,      // m when it has dived away
  rise: 0.45,          // s to rise into view at the spawn
  turnT: 1.7,          // s banking seaward + diving + fading
  tailHz: 2.4,         // tail beats / s while cruising (bursts faster in the turn)
  max: 12,
};

/** Palettes: [body, accent] linear albedo. Warm colours keep reading through the green water. */
export const FISH_PALETTES = [
  [[0.95, 0.72, 0.04], [0.98, 0.86, 0.3]],     // yellow tang
  [[0.98, 0.36, 0.06], [0.95, 0.92, 0.88], 1], // clownfish orange, white bands
  [[0.9, 0.22, 0.42], [0.12, 0.62, 0.95]],     // magenta parrotfish, blue fins
  [[1.0, 0.5, 0.02], [1.0, 0.7, 0.1]],         // garibaldi orange
];

/** Fish records from Beat downbeat events (sim-derived). */
export class FishLog {
  constructor() { this.reset(); }
  reset() { this.list = []; this.lastIndex = -1; }

  /** Per sim step: scan beat.events (append-only ring) for new downbeats with a level change. */
  step(t, beat, cfg) {
    const evs = beat?.events;
    if (!Array.isArray(evs)) return;
    const fc = cfg?.fish || DEFAULT_CFG.fish;
    for (let i = 0; i < evs.length; i++) {
      const ev = evs[i];
      if (!ev || ev.type !== 'downbeat' || !(ev.index > this.lastIndex)) continue;
      this.lastIndex = ev.index;
      if (!ev.change) continue;
      const beatLen = Number.isFinite(beat.beatLen) && beat.beatLen > 0 ? beat.beatLen : 0.5;
      this.list.push(makeFish(ev.index, ev.t, ev.change > 0 ? 1 : -1, beatLen, Math.max(0.5, +fc.beats || 4), cfg?.seed ?? DEFAULT_CFG.seed));
    }
    while (this.list.length && (t - this.list[0].t0 > this.list[0].life || this.list.length > FISH.max)) this.list.shift();
  }
}

/** Fish record: spawn on downbeat `index` at t0, dir +1 (right) / −1 (left). */
export function makeFish(index, t0, dir, beatLen, beats, seed = 1) {
  const h = (k) => hash01(index * 2654435 + 11, seed * 977 + 3, 1200 + k);
  const row = FISH.rows[((index % 3) + 3) % 3];
  const v = FISH.speed * (0.9 + 0.2 * h(0));
  const Ts = beats * beatLen;
  const dx = dir * SCREEN_RIGHT[0], dz = dir * SCREEN_RIGHT[1];
  const cx = row[0] + FISH.rowJitter * (h(1) - 0.5), cz = row[1] + FISH.rowJitter * 2 * (h(2) - 0.5);
  const half = 0.5 * v * Ts;
  // exit heading: banks seaward (+x, a little south: away from the headland)
  let ex = 0.4 * dx + 1, ez = 0.4 * dz - 0.3;
  const el = Math.hypot(ex, ez); ex /= el; ez /= el;
  const pal = FISH_PALETTES[Math.floor(h(3) * FISH_PALETTES.length) % FISH_PALETTES.length];
  return {
    id: index, t0, dir, beatLen, Ts, v, x0: cx - dx * half, z0: cz - dz * half, dx, dz, ex, ez,
    len: FISH.len * (0.9 + 0.2 * h(4)), ph: TAU * h(5), wig: TAU * h(6), body: pal[0], accent: pal[1], bands: !!pal[2],
    life: Ts + FISH.turnT,
  };
}

/** Horizontal position (x, z) at age a. */
export function fishXZ(f, a, out = [0, 0]) {
  const Tt = FISH.turnT;
  if (a <= f.Ts) {
    // straight run with a gentle meander across the path
    const w = 0.5 * Math.sin(1.7 * a + f.wig) * smoothstep(0, 0.6, a);
    out[0] = f.x0 + f.dx * f.v * a - f.dz * w;
    out[1] = f.z0 + f.dz * f.v * a + f.dx * w;
    return out;
  }
  // banking turn: quadratic Bézier, tangent-continuous with the run, exit faster along (ex, ez)
  const w = 0.5 * Math.sin(1.7 * f.Ts + f.wig);
  const p1x = f.x0 + f.dx * f.v * f.Ts - f.dz * w, p1z = f.z0 + f.dz * f.v * f.Ts + f.dx * w;
  const cx = p1x + f.dx * f.v * Tt / 2, cz = p1z + f.dz * f.v * Tt / 2;
  const v2 = 1.5 * f.v;
  const p2x = cx + f.ex * v2 * Tt / 2, p2z = cz + f.ez * v2 * Tt / 2;
  const u = Math.min(1, (a - f.Ts) / Tt), m = 1 - u;
  out[0] = m * m * p1x + 2 * u * m * cx + u * u * p2x;
  out[1] = m * m * p1z + 2 * u * m * cz + u * u * p2z;
  return out;
}

/** Depth of the body centre below the surface at age a (rises into view, dives away at the end). */
export function fishDepth(f, a) {
  const rise = smoothstep(0, FISH.rise, a);
  const dive = smoothstep(f.Ts + 0.1, f.Ts + FISH.turnT, a);
  return lerp(lerp(2.2, FISH.depth, rise), FISH.deepDepth, dive) + 0.08 * Math.sin(2.1 * a + f.ph);
}

/** 0..1 visibility (water attenuation does the rest). */
export function fishAlpha(f, a) {
  if (a < 0 || a > f.life) return 0;
  return smoothstep(0, FISH.rise * 0.8, a) * (1 - smoothstep(f.Ts + 0.35 * FISH.turnT, f.life, a));
}

const _a = [0, 0], _b = [0, 0], _c = [0, 0];
/**
 * Full pose at age a: { x, z, depth, hx, hz (unit heading on the water), pitch (+ nose up), bend (body curvature from
 * the turn rate, + = curving left), tail (tail-beat phase, rad), amp (0..1), alpha }.
 */
export function fishPose(f, a, out = {}) {
  const h = 0.04;
  fishXZ(f, a - h, _a); fishXZ(f, a, _b); fishXZ(f, a + h, _c);
  let vx = (_c[0] - _a[0]) / (2 * h), vz = (_c[1] - _a[1]) / (2 * h);
  const sp = Math.hypot(vx, vz) || 1;
  const ax = (_c[0] - 2 * _b[0] + _a[0]) / (h * h), az = (_c[1] - 2 * _b[1] + _a[1]) / (h * h);
  out.x = _b[0]; out.z = _b[1];
  out.hx = vx / sp; out.hz = vz / sp;
  out.depth = fishDepth(f, a);
  out.pitch = -Math.max(-0.5, Math.min(0.5, (fishDepth(f, a + h) - fishDepth(f, a - h)) / (2 * h) / sp));
  // curvature κ = (v × acc) / |v|³ (left of the heading in the x–z plane is (hz, −hx)... sign: + = turning toward +left)
  const kappa = (vx * az - vz * ax) / (sp * sp * sp);
  out.bend = Math.max(-0.12, Math.min(0.12, kappa));
  const turn = smoothstep(f.Ts - 0.1, f.Ts + 0.4, a);
  // tail phase: cruise rate, then a faster burst for the dive (integral of a smooth rate, closed form)
  const r0 = FISH.tailHz, r1 = FISH.tailHz * 1.6;
  const at = Math.max(0, a - f.Ts);
  out.tail = f.ph + TAU * (r0 * a + (r1 - r0) * Math.max(0, at - 0.25));
  out.amp = lerp(0.8, 1.0, turn);
  out.alpha = fishAlpha(f, a);
  out.speed = sp;
  return out;
}

export const fishLive = (f, t) => t - f.t0 >= 0 && t - f.t0 <= f.life;
