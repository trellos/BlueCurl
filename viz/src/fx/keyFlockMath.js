// BlueCurl Swell — key-change flock (WP15): pure helpers, no three.js.
//
// Fx.step() compares app.cfg.guitar.key with the key it saw on the previous step (cfg events are applied before the
// step, so live play and replays see the change on the same step) and records { t0, key, label }. Each record
// releases cfg.keyFlock.birds birds that flutter across the MAIN view in formation spelling the key (keyGlyphs.js):
// they swirl in from the left while closing into the letters, hold the letters (slowly drifting) through the middle
// of the screen, then break up and scatter off to the right. Bird poses are in CAMERA space (x right, y up, −z into
// the view), a pure function of (record, bird index, t, fov, aspect): the letters stay legible whatever the camera
// does. A newer key change makes the previous formation scatter at once.
import { hash01, DEFAULT_CFG } from '../contracts.js';
import { keyLabel, labelSlots } from './keyGlyphs.js';
import { clamp01, lerp, smoothstep } from './fxMath.js';

export const KEY_FLOCK = {
  depth: 120,          // m in front of the camera (formation plane)
  height: 0.5,         // cap height in NDC units (2 = full height) → 25 % of the screen height
  y: 0.71,             // NDC y of the letter centre: in the sky (the lineup horizon is at ≈ 0.54), feet near the horizon
  margin: 0.12,        // NDC beyond the screen edge where the formation starts / ends
  slow: 0.86,          // 0..1: how much the crossing slows in the middle (0 = constant speed)
  gather: 0.26,         // fraction of the crossing spent closing into the letters
  scatter: 0.68,       // fraction of the crossing when the letters break up
  fade: 0.3,           // fraction (after the break-up) over which the birds fade out
  span: 7.0,           // m, nominal wingspan (capped at ~1.25 × the slot spacing: wings nearly touch, strokes read solid)
  minPx: 11,           // minimum on-screen wingspan (px)
  shade: 0.86,         // 0..1 darkening toward a backlit silhouette (dark birds read on a bright sky at any time of day)
  yaw: 0.85,           // rad: headings turn this far from screen-right into the view (shows the wing planform)
};
const TAU = Math.PI * 2;
const smoother = (x) => { const s = clamp01(x); return s * s * s * (s * (s * 6 - 15) + 10); };

/** Crossing progress warp: slow in the middle (letters legible), fast at the ends. Monotone for slow < 1. */
export const crossWarp = (s, slow = KEY_FLOCK.slow) => s + (slow * Math.sin(TAU * s)) / TAU;

/** Key-change records (sim-derived; rebuilt by the same steps on a replay / ?t0 fast-forward). */
export class KeyFlockLog {
  constructor(key = null) { this.reset(key); }
  reset(key = null) { this.list = []; this.key = key; this._slots = new Map(); }

  /** Per sim step: record a change of cfg.guitar.key. Returns the new record or null. */
  step(t, cfg) {
    const key = cfg?.guitar?.key ?? null;
    if (key === this.key) return null;
    const prev = this.key;
    this.key = key;
    if (prev == null || key == null) return null;          // first sighting / cleared: no flock
    const label = keyLabel(key);
    if (!label) return null;
    const kc = cfg?.keyFlock || DEFAULT_CFG.keyFlock;
    const rec = { t0: t, key, label, n: Math.max(0, Math.min(160, Math.round(kc.birds ?? 72))), T: Math.max(1, +kc.seconds || 6),
      id: this.list.length ? this.list[this.list.length - 1].id + 1 : 1 };
    this.list.push(rec);
    // prune finished formations (keep the last one so the id counter continues)
    while (this.list.length > 1 && t - this.list[0].t0 > this.list[0].T * 2 + 2) this.list.shift();
    return rec;
  }

  /** Bird slots of a record (cached by label + count). */
  slots(rec) {
    const k = rec.label + '|' + rec.n;
    let s = this._slots.get(k);
    if (!s) { s = labelSlots(rec.label, rec.n); this._slots.set(k, s); if (this._slots.size > 32) this._slots.delete(this._slots.keys().next().value); }
    return s;
  }

  /** Crossing fraction at which record i breaks up: its own schedule, or earlier when the next key change comes. */
  scatterAt(i) {
    const r = this.list[i], nx = this.list[i + 1];
    let sc = KEY_FLOCK.scatter;
    if (nx) sc = Math.min(sc, Math.max(0, (nx.t0 - r.t0) / r.T));
    return sc;
  }

  /** Live records at t (newest last): calls fn(rec, age, scatterAt). */
  forLive(t, fn) {
    for (let i = 0; i < this.list.length; i++) {
      const r = this.list[i], age = t - r.t0, sc = this.scatterAt(i);
      if (age < 0 || age > (sc + KEY_FLOCK.fade) * r.T + 0.05) continue;
      fn(r, age, sc);
    }
  }
}

/**
 * Camera-space pose of bird i of record rec at age a. view = { tanY (tan of half the vertical fov), aspect }.
 * slots = labelSlots(rec.label, rec.n). out: { x,y,z (camera space, m), fx,fy,fz (camera-space heading), roll,
 * flap, amp, alpha, span }.
 */
export function keyBirdPose(rec, slots, i, a, sc, view, seed = 1, out = {}) {
  const K = KEY_FLOCK, T = rec.T, s = a / T;
  const h = (k) => hash01(rec.id * 7919 + i, seed * 131 + 17, 900 + k);
  const tanY = view.tanY, asp = view.aspect;
  const D = K.depth, mY = D * tanY, mX = mY * asp;            // metres per NDC unit at the formation depth
  const Hm = K.height * mY;                                     // cap height (m)
  const halfW = (0.5 * slots.width * K.height) / asp;           // half label width in NDC x
  const x0 = -1 - halfW - K.margin, x1 = 1 + halfW + K.margin;
  const xc = lerp(x0, x1, crossWarp(clamp01(s)));
  const yc = K.y + 0.025 * Math.sin(1.1 * a + rec.id);
  const px = slots.pts[2 * i] ?? 0, py = slots.pts[2 * i + 1] ?? 0;
  const spacing = Math.max(1e-3, slots.spacing) * Hm;
  // slot + flutter (each bird bobs around its slot; the letter holds)
  const jf = 0.55 + 0.5 * h(0);
  const jA = Math.min(0.24 * spacing, 0.04 * Hm);
  let x = xc * mX + px * Hm + jA * Math.sin(TAU * jf * a + TAU * h(1));
  let y = yc * mY + py * Hm + jA * 1.2 * Math.sin(TAU * jf * 1.3 * a + TAU * h(2));
  let z = -D + 2.5 * Math.sin(TAU * 0.4 * a + TAU * h(3));
  // gathering: start loose (a wide, deep swirl) and close into the letters
  const g = 1 - smoother(s / K.gather);
  if (g > 0) {
    const ang = TAU * h(4) + 2.2 * s;
    const r = (0.35 + 0.65 * h(5)) * Hm * 1.1;
    x += g * (r * Math.cos(ang) - 0.4 * Hm);
    y += g * r * 0.7 * Math.sin(ang);
    z += g * 40 * (h(6) - 0.5);
  }
  // break-up: each bird peels off on its own heading (mostly up / onward / into the view), accelerating
  const e = Math.max(0, s - sc) * T;                               // s since the break-up
  let sdx = 0, sdy = 0, sdz = 0;
  if (e > 0) {
    const dx = 0.5 + 1.0 * h(7), dy = 1.6 * (h(8) - 0.35), dz = -0.4 - 1.4 * h(9);
    const L = Math.hypot(dx, dy, dz), v = 9 + 9 * h(10), acc = 7 + 6 * h(11);
    const d = v * e + 0.5 * acc * e * e;
    sdx = dx / L; sdy = dy / L; sdz = dz / L;
    x += sdx * d; y += sdy * d; z += sdz * d;
  }
  // heading: onward (screen right), turned into the view so the wings show; scatter: along the peel-off direction
  const yaw = K.yaw + 0.25 * (h(12) - 0.5);
  let fx = Math.cos(yaw), fy = 0.06 * Math.sin(TAU * jf * a + h(13)), fz = -Math.sin(yaw);
  const ws = smoothstep(0, 0.6, e);
  if (ws > 0) { fx = lerp(fx, sdx, ws); fy = lerp(fy, sdy, ws); fz = lerp(fz, sdz, ws); }
  const fl = Math.hypot(fx, fy, fz) || 1;
  out.x = x; out.y = y; out.z = z;
  out.fx = fx / fl; out.fy = fy / fl; out.fz = fz / fl;
  out.roll = 0.18 * Math.sin(TAU * 0.7 * a + TAU * h(14));
  const hz = 3.4 + 1.4 * h(15);
  out.flap = TAU * hz * a + TAU * h(16);
  out.amp = Math.max(smoothstep(0, 0.4, e), 0.5 + 0.5 * smoothstep(-0.3, 0.5, Math.sin(1.4 * a + TAU * h(17))));
  out.alpha = smoothstep(0, 0.05, s) * (1 - smoothstep(sc + 0.15 * K.fade, sc + K.fade, s));
  out.span = Math.min(K.span * (0.9 + 0.2 * h(18)), 1.25 * spacing);
  return out;
}
