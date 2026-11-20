// BlueCurl Swell — input feedback FX (WP5): pure helpers, no three.js. Everything here is a function of
// (impulse, age) so the visuals are a pure function of (swell state, t). The particle trajectory is mirrored
// 1:1 in GLSL by Particles.js (PARTICLE_GLSL); test/fx.test.mjs covers the JS side.
import { hash01, FRONT_W } from '../contracts.js';

export const FX_LIFE = 3.0;              // s an impulse keeps producing visuals (burst, rings, dolphin + splashes)
export const WHITE = [1.0, 0.97, 0.9];

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => clamp(v, 0, 1);
export const lerp = (a, b, s) => a + (b - a) * s;
export const smoothstep = (a, b, x) => { const s = clamp01((x - a) / (b - a)); return s * s * (3 - 2 * s); };
export const mix3 = (a, b, s) => [lerp(a[0], b[0], s), lerp(a[1], b[1], s), lerp(a[2], b[2], s)];

/**
 * Lane colour: a warm → cool gradient across the crest (u = 0 south/screen-left … 1 north/right), gold → amber →
 * light gold → seafoam → aqua → cyan (never magenta/purple), one stop per lane centre of the 8-lane keyboard.
 */
export const LANE_STOPS = [
  [1.0, 0.6, 0.08], [1.0, 0.46, 0.08], [1.0, 0.56, 0.16], [1.0, 0.74, 0.2],
  [0.3, 0.95, 0.68], [0.2, 0.88, 0.92], [0.12, 0.74, 1.0], [0.08, 0.58, 1.0],
];
/** Base of the tint for light on the water (warm, sun-glint like); the lane colour is mixed in at 80 %. */
export const WATER_WHITE = [1.0, 0.86, 0.62];
export function laneColor(u, out = [0, 0, 0]) {
  const n = LANE_STOPS.length, f = clamp(u * n - 0.5, 0, n - 1), i = Math.min(n - 2, Math.floor(f)), w = f - i;
  const a = LANE_STOPS[i], b = LANE_STOPS[i + 1];
  out[0] = lerp(a[0], b[0], w); out[1] = lerp(a[1], b[1], w); out[2] = lerp(a[2], b[2], w);
  return out;
}

/**
 * Strength (scale·velocity; keyboard 1.0, Shift 0.4) → size 0.45 (soft) … 1.0 (full) … 1.3 (cap) and gain
 * (brightness multiplier, soft notes dimmer). Colour comes from the lane (laneColor), not the strength.
 */
export function strengthStyle(strength) {
  const s = clamp(Number.isFinite(strength) ? strength : 1, 0.05, 1.8);
  const size = clamp(0.45 + (0.55 * (s - 0.4)) / 0.6, 0.3, 1.3);
  return { s, size, gain: 0.55 + 0.45 * clamp(size, 0, 1.2) };
}

const ex = (age, tau) => (age < 0 ? 0 : Math.exp(-age / tau));

/**
 * Sizes (m) and HDR intensities (before the lane colour) of the impact sprites at `age` s after the hit. All
 * envelopes peak at age 0 (instant attack) so the hit is visible on the next rendered frame. Intensities stay
 * moderate (≤ ~5) and the sprites blend with coverage, so stacked hits converge to their colour, never white.
 */
export function impactLook(strength, age, lanes = 8) {
  const st = strengthStyle(strength), k = st.size, g = st.gain, a = Math.max(0, age);
  const lane = FRONT_W / (lanes || 8);
  const grow = 1 - Math.exp(-a / 0.35);
  return {
    st,
    coreR: (10 + 14 * k) * (1 + 0.5 * (1 - ex(a, 0.08))), coreI: (2.6 + 3.2 * g) * ex(a, 0.2),
    glowR: (26 + 30 * k) * (0.8 + 0.4 * grow),           glowI: (0.9 + 1.3 * g) * ex(a, 0.6),
    ringR: (6 + (20 + 30 * k) * grow),                   ringI: (1.2 + 2.2 * g) * ex(a, 0.5),
    ring2R: a < 0.15 ? 0 : 4 + (13 + 20 * k) * (1 - Math.exp(-(a - 0.15) / 0.4)),
    ring2I: a < 0.15 ? 0 : (0.9 + 1.6 * g) * ex(a - 0.15, 0.45),
    streakL: lane * (0.6 + 0.8 * k) * (0.45 + 0.55 * (1 - Math.exp(-a / 0.12))),
    streakW: 2.5 + 3 * k,                                streakI: (1.2 + 2.4 * g) * ex(a, 0.55),
  };
}

// ------------------------------------------------------------------------------- particles (analytic)
/** Emitter kinds. Keep in sync with PARTICLE_GLSL (Particles.js). */
export const KIND_BURST = 0, KIND_SPLASH = 1;
export const PARTICLE = [
  // burst: sparkles flung off the crest, spread along it (along), linear drag so they burst then hang
  { speed: [14, 38], elev: [0.3, 1.45], drag: 1.15, g: 7.5, life: [1.1, 2.4], size: [0.8, 1.8], along: 1.9, I: [1.6, 4.5], n: 320 },
  // splash: white water at a dolphin exit/entry
  { speed: [2.5, 8], elev: [0.95, 1.52], drag: 0.45, g: 9.81, life: [0.5, 1.1], size: [0.25, 0.55], along: 1.0, I: [1.4, 3.0], n: 150 },
];
export const PARTICLES_PER_EMITTER = 320;
/** Live particle count of an emitter (≤ PARTICLES_PER_EMITTER). */
export function emitterCount(kind, size) {
  const P = PARTICLE[kind];
  return Math.min(PARTICLES_PER_EMITTER, Math.round(P.n * (kind === KIND_BURST ? 0.3 + 0.7 * clamp(size, 0, 1.3) : 1)));
}

/**
 * Particle k of emitter `seed` (integer) at `age`, local offset from the emitter origin (m).
 * Ballistic with linear drag, closed form (no integration):
 *   e = (1 − e^(−d·a))/d ; x = vx·e ; z = vz·e ; y = (vy + g/d)·e − g·a/d
 */
export function particleLocal(seed, k, kind, size, age, out = {}) {
  const P = PARTICLE[kind];
  const r0 = hash01(seed, k, 0), r1 = hash01(seed, k, 1), r2 = hash01(seed, k, 2), r3 = hash01(seed, k, 3);
  const r4 = hash01(seed, k, 4), r5 = hash01(seed, k, 5), r6 = hash01(seed, k, 6);
  const sc = 0.55 + 0.45 * size;
  const speed = lerp(P.speed[0], P.speed[1], r0 * r0 * 0.6 + r0 * 0.4) * sc;
  const el = lerp(P.elev[0], P.elev[1], r1), az = 6.283185307 * r2;
  const life = lerp(P.life[0], P.life[1], r3) * (0.7 + 0.3 * size);
  const a = age - 0.06 * r4;
  const ce = Math.cos(el);
  const vx = speed * ce * Math.cos(az), vz = speed * ce * Math.sin(az) * P.along, vy = speed * Math.sin(el);
  const ac = Math.max(0, a);
  const e = (1 - Math.exp(-P.drag * ac)) / P.drag;
  out.x = vx * e; out.z = vz * e; out.y = (vy + P.g / P.drag) * e - (P.g * ac) / P.drag;
  out.alive = a >= 0 && a < life;
  const f = clamp01(ac / life);
  out.life = life;
  out.size = lerp(P.size[0], P.size[1], r5) * (0.6 + 0.4 * size);
  out.bright = out.alive ? lerp(P.I[0], P.I[1], r6) * Math.pow(1 - f, 1.5) : 0;
  out.warm = r6;
  return out;
}

// ------------------------------------------------------------------------------- dolphin jump
export const DOLPHIN_LEN = 2.6;
/** Seeded jump of impulse `id`: delay after the hit, duration, horizontal run, peak height, heading. */
export function jumpParams(id, seed = 1) {
  const h = (j) => hash01(id, seed, 100 + j);
  const side = h(0) < 0.5 ? -1 : 1;
  const D = 1.3 + 0.2 * h(1);
  const L = 10 + 4 * h(2);
  const Hpk = 3.6 + 1.8 * h(3);
  const dx = -(0.25 + 0.35 * h(4)), dz = side;              // shoreward and along the crest
  const n = Math.hypot(dx, dz);
  return { delay: 0.1 + 0.15 * h(5), D, L, Hpk, dirX: dx / n, dirZ: dz / n, off: 3 + 4 * h(6), sink: 1.4 };
}
/**
 * Dolphin pose relative to the impact anchor (crest point) at `age`: { visible, s, x, y, z, yaw, pitch }.
 * Arc from y = −sink (under water) up to Hpk and back; pitch follows the tangent. Exit at s = 0, entry at s = 1.
 */
export function dolphinPose(jp, age, out = {}) {
  const s = (age - jp.delay) / jp.D;
  // a short underwater lead-in/out so the body slides through the surface instead of popping
  out.visible = s > -0.08 && s < 1.08;
  out.s = s;
  const sc = clamp(s, -0.08, 1.08);
  const x0 = -jp.off - (jp.dirX * jp.L) / 2, z0 = -(jp.dirZ * jp.L) / 2;   // centred on the impact, shoreward of the crest
  out.x = x0 + jp.dirX * jp.L * sc;
  out.z = z0 + jp.dirZ * jp.L * sc;
  const A = jp.Hpk + jp.sink;
  out.y = -jp.sink + 4 * A * sc * (1 - sc);
  out.yaw = Math.atan2(-jp.dirZ, jp.dirX);                 // rotation about +Y taking +X (nose) to dir
  out.pitch = Math.atan2(4 * A * (1 - 2 * sc), jp.L);
  return out;
}
/** Splash points (local) and times (age) for a jump: [{x,z,t}, {x,z,t}] = exit, entry (where y crosses 0). */
export function jumpSplashes(jp) {
  const A = jp.Hpk + jp.sink;
  // y(s) = −sink + 4A s(1−s) = 0 → s = (1 ∓ sqrt(1 − sink/A))/2
  const q = Math.sqrt(Math.max(0, 1 - jp.sink / A));
  return [(1 - q) / 2, (1 + q) / 2].map((s) => {
    const p = dolphinPose(jp, jp.delay + s * jp.D);
    return { x: p.x, z: p.z, t: jp.delay + s * jp.D };
  });
}

// ------------------------------------------------------------------------------- front shimmer
export const SHIMMER = {
  e0: 0.12,          // column energy giving 63 % of full strength (one strong hit peaks ≈ 0.031 per column: 3 notes ≈ 0.5, 20 ≈ 1)
  minE: 0.004,       // below this a column has no line (ambient fronts: none at all)
  pulseV: 32,        // m/s a hit's pulse travels along the line (both ways)
  pulseLife: 1.4,    // s
};
/** 0..1 line strength of a column from its accumulated energy. */
export const lineLevel = (e) => (e > SHIMMER.minE ? 1 - Math.exp(-(e - SHIMMER.minE) / SHIMMER.e0) : 0);
/**
 * Pulse of one hit at distance dz (m, along the crest) and age a: a local flash plus two packets travelling
 * outward along the line, widening and fading.
 */
export function hitPulse(dz, a, gain = 1) {
  if (a < 0 || a > SHIMMER.pulseLife) return 0;
  const d = Math.abs(dz), w = 10 + 14 * a, r = SHIMMER.pulseV * a;
  const travel = Math.exp(-(((d - r) / w) ** 2)) * Math.exp(-a / 0.6);
  const flash = Math.exp(-((d / 22) ** 2)) * Math.exp(-a / 0.35);
  return gain * (travel + 1.4 * flash);
}
/**
 * Fade of a column's shimmer as it breaks (contracts.localTau): 1 while unbroken (zi < 0), fading once τ > 0 and gone
 * by τ = 0.3, then 0 on broken and re-forming water (the wave renderer's foam takes over).
 */
export function breakFade(tau, zi) {
  if (zi < 0) return 1;
  return 1 - smoothstep(0, 0.3, tau);
}
/** Fade by water depth (m): none over land / the shore (< 0.5 m), full from 2 m. */
export const depthFade = (d) => smoothstep(0.5, 2.0, d);
/** Fade by crest x: gone once the front is inside the point (x < ~90). */
export const insideFade = (x) => smoothstep(88, 112, x);
