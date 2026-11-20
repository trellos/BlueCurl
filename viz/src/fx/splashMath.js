// BlueCurl Swell — note splash (WP13): pure helpers, no three.js. A splash is a pure function of (birth, age):
// where it erupts, how big, and the jet's closed-form rise. The particle motion itself lives in Splash.js (GLSL);
// the jet top / landing formulas here are mirrored 1:1 there (G, vJet) and are what the birds burst out of.
import { strengthStyle, clamp } from './fxMath.js';
import { hash01 } from '../contracts.js';

export const SPLASH = {
  life: 5.5,             // s a splash keeps drawing (mist + foam outlast the jet)
  g: 12.0,               // m/s² (slightly heavy: snappier rise and fall at fantasy scale)
  maxX: 580,             // splashes never erupt farther than this (pre-charge hits land on the spawn line x = 600, in the haze)
  eye: [0, 55, 70],      // reference eye (the 'lineup' wide preset) for the distance boost
  boostD: 80,            // m: beyond this, the splash grows ∝ distance so it keeps its size on screen
  boostMax: 6.0,
  flockSize: 0.55,       // style size of the small splash a flock bursts out of
};

/** Lineup band (x) the note splashes erupt in: inside the visible water of the default 'lineup' camera. */
export const SPLASH_X = [120, 260];
/**
 * Where a note's splash erupts along x: the front's x clamped into the lineup band (fronts farther out → the
 * seaward side of the band), with a deterministic per-impulse jitter of up to 45 m toward the shore.
 */
export function splashX(frontX, id, seed = 1) {
  const fx = Number.isFinite(frontX) ? frontX : SPLASH_X[1];
  const j = 45 * hash01(id | 0, seed | 0, 77);
  return clamp(clamp(fx, SPLASH_X[0], SPLASH_X[1]) - j, SPLASH_X[0], SPLASH_X[1]);
}

/** Distance boost (≥ 1): far splashes grow ∝ distance from the reference eye (fantasy perspective). */
export function splashBoost(x, z) {
  const d = Math.hypot(x - SPLASH.eye[0], SPLASH.eye[1], z - SPLASH.eye[2]);
  return clamp(d / SPLASH.boostD, 1, SPLASH.boostMax);
}

/**
 * Splash of an ImpulseFx: erupts where the note landed (imp.x, imp.z: the front's crest at the hit; pre-charge hits
 * land on the spawn line), pulled in to SPLASH.maxX. Size from the strength (soft 0.45 … full 1 … 1.3), height
 * 9 + 9·size m (soft ≈ 13, full 18) × boost × scale, gravity g·√boost. Returns { x, z, t0, size, boost, H, vJet, S } (S = lateral scale).
 */
export function splashParams(x, z, t0, strength, sizeMul = 1, scale = 1) {
  const sx = Math.min(Number.isFinite(x) ? x : SPLASH.maxX, SPLASH.maxX);
  const sz = Number.isFinite(z) ? z : 0;
  const size = strengthStyle(strength).size * sizeMul;
  const boost = splashBoost(sx, sz);
  const H = (9 + 9 * size) * boost * scale;
  const g = SPLASH.g * Math.sqrt(boost);            // bigger (farther) splashes also run a bit faster: same feel on screen
  return { x: sx, z: sz, t0, size, boost, H, g, vJet: Math.sqrt(2 * g * H), S: boost * scale * (0.6 + 0.4 * size) };
}

/** Height (m above the water) of the jet's leading top at age a (0 before the hit and after it falls back). */
export function jetTop(sp, a) {
  if (!(a > 0)) return 0;
  return Math.max(0, sp.vJet * a - 0.5 * sp.g * a * a);
}
/** Age when the jet top reaches its apex (= H). */
export const jetApexT = (sp) => sp.vJet / sp.g;
