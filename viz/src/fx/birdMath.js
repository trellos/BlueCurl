// BlueCurl Swell — note birds + flocks (WP13): pure helpers, no three.js.
//
// Births: Fx.step() records, once per sim step, every new ImpulseFx (→ splash + cfg.birds.perNote birds) and every
// riders 'flock' RideEvent (→ small splash + cfg.birds.flock birds). Births are sim-derived state (rebuilt by the
// same steps on a replay / ?t0 fast-forward) and every bird is a closed-form function of (birth, age): no dt
// integration, no Math.random. Live birds are capped at cfg.birds.max, oldest births culled first.
import { hash01, DT, DEFAULT_CFG } from '../contracts.js';
import { splashParams, splashX, jetTop, SPLASH } from './splashMath.js';
import { laneColor, clamp, clamp01, lerp, smoothstep } from './fxMath.js';

export const BIRD = {
  emerge: 0.26,        // s after the hit the note bird bursts out of the column
  burstT: 2.2,         // s blend from the burst climb into the circling
  leaveTau: 1.4,       // s: circling slows / escape speeds up over this
  fadeStart: 3.2,      // s after leaving: fade out
  fadeEnd: 6.5,
  span: 5.2,           // m wingspan of a note bird (fantasy scale: reads from the lineup camera)
  flockSpan: 3.4,
  flapHz: 2.5, flockFlapHz: 3.6,
  lineup: { x: 170, z: 0 },   // where the note birds drift to while circling (above the lineup)
  noteLife: 11,        // s minimum a note birth is kept (≥ the ImpulseFx ring, so ids stay deduplicated)
};
const SUN0 = [0.99, 0.105, -0.06];  // fallback toward-the-sun direction (east, low)
const TAU = Math.PI * 2;
const smoother = (a, b, x) => { const s = clamp01((x - a) / (b - a)); return s * s * s * (s * (s * 6 - 15) + 10); };

/** Exit direction: up and away toward the sun (the dawn sky / "the heavens"), with a seeded spread. */
function escapeDir(sun, h1, h2, h3) {
  const s = sun || SUN0;
  const x = s[0] ?? s.x, y = s[1] ?? s.y, z = s[2] ?? s.z;
  const ex = x + 0.45 * (h1 - 0.5), ey = Math.max(0.05, y) + 0.42 + 0.25 * h2, ez = z + 0.7 * (h3 - 0.5);
  const n = Math.hypot(ex, ey, ez);
  return [ex / n, ey / n, ez / n];
}
/** Escape displacement s seconds after leaving: speed ramps 0 → v over tau (C¹), then cruises. */
const escapeDist = (s, v, tau) => (s <= 0 ? 0 : s < tau ? (v * s * s) / (2 * tau) : v * (s - tau / 2));
/** Time warp of the circling after leaving: keeps turning, slowing to a stop over tau (C¹ at s = 0). */
const circleTime = (a, TL, tau) => (a <= TL ? a : TL + tau * (1 - Math.exp(-(a - TL) / tau)));

/** Note bird j of an impulse birth. sp = splashParams of the birth. */
export function noteBirdParams(id, j, seed, sp, y0, lane, sun) {
  const h = (k) => hash01(id * 13 + j * 7919, seed, 300 + k);
  const ox = sp.x + 1.2 * (h(0) - 0.5), oz = sp.z + 1.2 * (h(1) - 0.5);
  const oy = y0 + jetTop(sp, BIRD.emerge) * 0.9;
  // circling: starts right above the splash, drifts toward the lineup
  const c0x = ox - 20 - 15 * h(2), c0z = oz + 30 * (h(3) - 0.5);
  // drift ≤ 90 m over the whole circling (peak drift speed stays well under the flying speed)
  let c1x = lerp(c0x, BIRD.lineup.x, 0.5) + 40 * (h(4) - 0.5), c1z = lerp(c0z, BIRD.lineup.z, 0.35) + 40 * (h(5) - 0.5);
  const dd = Math.hypot(c1x - c0x, c1z - c0z);
  if (dd > 90) { c1x = c0x + ((c1x - c0x) * 90) / dd; c1z = c0z + ((c1z - c0z) * 90) / dd; }
  const R = 22 + 18 * h(6), v = 20 + 8 * h(7);
  const dir = h(8) < 0.5 ? -1 : 1;
  const Tc = 6 + 4 * h(9);
  return {
    kind: 0, ox, oy, oz, c0x, c0z, c1x, c1z, cy: 68 + 34 * h(10),
    R, w: (dir * v) / R, th0: Math.atan2(oz - c0z, ox - c0x), Rw: 0.8 + 0.5 * h(11), Rph: TAU * h(12),
    yA: 5 + 5 * h(13), yW: 0.5 + 0.3 * h(14), yPh: TAU * h(15),
    bx: -7 * (0.5 + h(16)), bz: 10 * (h(17) - 0.5), vb: Math.max(36 + 8 * h(18), 1.3 * sp.vJet),
    TL: BIRD.burstT + Tc, vL: 22 + 10 * h(19), E: escapeDir(sun, h(20), h(21), h(22)),
    flapPh: TAU * h(23), glidePh: TAU * h(24), span: BIRD.span * (0.9 + 0.2 * h(25)), hz: BIRD.flapHz * (0.92 + 0.16 * h(26)),
    col: laneColor(Number.isFinite(lane) ? lane : 0.5),
    t0: BIRD.emerge, life: BIRD.emerge + BIRD.burstT + Tc + BIRD.fadeEnd, trail: true,
  };
}

/** Flock bird i of n bursting from a rider at pos. key = flock seed (rider id + step). */
export function flockBirdParams(key, i, n, seed, pos, sun) {
  const h = (k) => hash01(key, seed * 977 + i, 500 + k);
  const hf = (k) => hash01(key, seed, 700 + k);                      // shared by the whole flock
  const az = TAU * (i + 0.6 * h(0)) / Math.max(1, n), el = 0.35 + 0.8 * h(1), sp = 15 + 9 * h(2);
  const swirlDir = hf(0) < 0.5 ? -1 : 1;
  const E = escapeDir(sun, hf(1) + 0.3 * (h(3) - 0.5), hf(2), hf(3) + 0.3 * (h(4) - 0.5));
  return {
    kind: 1, ox: pos.x, oy: Math.max(0, pos.y ?? 0) + 0.8, oz: pos.z,
    vx: sp * Math.cos(el) * Math.cos(az), vy: sp * Math.sin(el), vz: sp * Math.cos(el) * Math.sin(az),
    cy: 27 + 8 * hf(4), cdx: -2 + 4 * (hf(5) - 0.5), cdz: 4 * (hf(6) - 0.5),
    ph: TAU * i / Math.max(1, n) + 0.7 * h(5), w: swirlDir * (1.3 + 0.3 * hf(7)), r: 6 + 6 * h(6),
    rW: 1.1 + 0.4 * h(7), rPh: TAU * h(8), yA: 2 + 2.5 * h(9), yW: 1.6 + 0.6 * h(10), yPh: TAU * h(11), tilt: 0.25 + 0.2 * hf(8),
    TL: 4.0 + 1.4 * h(12), vL: 20 + 8 * h(13), E,
    flapPh: TAU * h(14), glidePh: TAU * h(15), span: BIRD.flockSpan * (0.85 + 0.3 * h(16)), hz: BIRD.flockFlapHz * (0.9 + 0.2 * h(17)),
    col: [1.0, 0.82, 0.5], t0: 0.05 * h(18), life: 0, trail: false,
  };
}
export const flockLife = (bp) => bp.t0 + bp.TL + BIRD.fadeEnd;

/** Bird position at age a (s since the birth). out = [x, y, z]. */
export function birdPos(bp, a, out = [0, 0, 0]) {
  const t = Math.max(0, a - bp.t0);
  const s = t - bp.TL;
  const tc = circleTime(t, bp.TL, BIRD.leaveTau);
  const D = escapeDist(s, bp.vL, BIRD.leaveTau);
  let x, y, z;
  if (bp.kind === 0) {
    // circling: centre drifts from above the splash to above the lineup; radius breathes; altitude bobs
    const m = smoother(0, bp.TL, t);
    const cx = lerp(bp.c0x, bp.c1x, m), cz = lerp(bp.c0z, bp.c1z, m);
    const th = bp.th0 + bp.w * tc, R = bp.R * (1 + 0.28 * Math.sin(bp.Rw * tc + bp.Rph));
    const qx = cx + R * Math.cos(th), qz = cz + R * Math.sin(th);
    const qy = bp.cy + bp.yA * Math.sin(bp.yW * tc + bp.yPh) + 0.8 * tc;
    // burst: straight up out of the column, decelerating
    const bx = bp.ox + bp.bx * t, bz = bp.oz + bp.bz * t, by = bp.oy + bp.vb * t - (bp.vb / 4.8) * t * t;
    const w = smoother(0, BIRD.burstT, t);
    x = lerp(bx, qx, w); y = lerp(by, qy, w); z = lerp(bz, qz, w);
  } else {
    // burst outward from the rider (drag, closed form), then a shared swirl (murmuration-ish tilted ring)
    const k = 1.5, e = (1 - Math.exp(-k * t)) / k;
    const bx = bp.ox + bp.vx * e, by = bp.oy + bp.vy * e + 1.5 * t, bz = bp.oz + bp.vz * e;
    const Sx = bp.ox + bp.cdx * tc, Sz = bp.oz + bp.cdz * tc, Sy = bp.oy + bp.cy * (1 - Math.exp(-tc / 1.3)) + 1.2 * tc;
    const ang = bp.ph + bp.w * tc, r = bp.r * (1 + 0.25 * Math.sin(bp.rW * tc + bp.rPh));
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const qx = Sx + r * ca, qz = Sz + r * sa, qy = Sy + bp.tilt * r * sa + bp.yA * Math.sin(bp.yW * tc + bp.yPh);
    const w = smoother(0.25, 2.0, t);
    x = lerp(bx, qx, w); y = lerp(by, qy, w); z = lerp(bz, qz, w);
  }
  out[0] = x + bp.E[0] * D; out[1] = y + bp.E[1] * D; out[2] = z + bp.E[2] * D;
  return out;
}

/** 0..1 visibility at age a (fade in as it bursts out, fade out while leaving). */
export function birdAlpha(bp, a) {
  const t = a - bp.t0;
  if (t < 0) return 0;
  return smoothstep(0, 0.12, t) * (1 - smoothstep(BIRD.fadeStart, BIRD.fadeEnd, t - bp.TL));
}

/** Wing flap amplitude 0 (glide) … 1 (full flap): flapping out of the splash and when leaving, glide phases while circling. */
export function flapAmp(bp, a) {
  const t = Math.max(0, a - bp.t0), s = t - bp.TL;
  const glide = smoothstep(-0.1, 0.5, Math.sin(0.75 * t + bp.glidePh));
  const circ = bp.kind === 0 ? 0.15 + 0.85 * glide : 0.55 + 0.45 * glide;
  const burst = 1 - smoothstep(BIRD.burstT * 0.6, BIRD.burstT, t);
  const leave = smoothstep(0, 0.8, s);
  return clamp(Math.max(circ, burst, leave), 0, 1);
}

const _p0 = [0, 0, 0], _p1 = [0, 0, 0], _p2 = [0, 0, 0];
/**
 * Full pose at age a: { x,y,z, fx,fy,fz (unit heading, pitch flattened), roll (bank, + = right wing down), flap
 * (phase rad), amp, alpha }. Heading / bank from central differences of the analytic path (h = 0.05 s).
 */
export function birdPose(bp, a, out = {}) {
  const h = 0.05;
  birdPos(bp, a - h, _p0); birdPos(bp, a, _p1); birdPos(bp, a + h, _p2);
  let vx = (_p2[0] - _p0[0]) / (2 * h), vy = (_p2[1] - _p0[1]) / (2 * h), vz = (_p2[2] - _p0[2]) / (2 * h);
  const ax = (_p2[0] - 2 * _p1[0] + _p0[0]) / (h * h), az = (_p2[2] - 2 * _p1[2] + _p0[2]) / (h * h);
  const vh = Math.hypot(vx, vz);
  // heading: flatten steep climbs so the silhouette keeps reading as a bird
  let fx = vh > 1e-4 ? vx / vh : 1, fz = vh > 1e-4 ? vz / vh : 0;
  const pitch = clamp(Math.atan2(vy, Math.max(vh, 4)), -0.6, 0.85);
  const cp = Math.cos(pitch);
  out.x = _p1[0]; out.y = _p1[1]; out.z = _p1[2];
  out.fx = fx * cp; out.fy = Math.sin(pitch); out.fz = fz * cp;
  // bank: lateral (horizontal) acceleration across the heading; right = heading × up = (−fz, 0, fx)
  const lat = ax * -fz + az * fx;
  out.roll = clamp(Math.atan((0.7 * lat) / 9.81), -0.95, 0.95);
  out.flap = TAU * bp.hz * Math.max(0, a - bp.t0) + bp.flapPh;
  out.amp = flapAmp(bp, a);
  out.alpha = birdAlpha(bp, a);
  out.speed = Math.hypot(vx, vy, vz);
  return out;
}

// ------------------------------------------------------------------------------- births (sim-derived)
/**
 * Birth record of splashes and birds. step(t, swell, riders, cfg, sun) once per sim step; reset() on a rewind.
 * list: [{ kind:'note'|'flock', key, t0, sp (splashParams), y0, lane color, birds: params[] }] in birth order.
 */
export class BirthLog {
  constructor() { this.reset(); }
  reset() { this.list = []; this._imp = new Set(); this._flock = new Set(); }

  step(t, swell, riders, cfg, sun) {
    const seed = cfg?.seed ?? DEFAULT_CFG.seed;
    const bc = cfg?.birds || DEFAULT_CFG.birds;
    // new impulses (append-only ring: walk back from the end until one already seen)
    const imps = swell?.impulses || [];
    let i = imps.length - 1;
    while (i >= 0 && !this._imp.has(imps[i].id)) i--;
    for (let k = i + 1; k < imps.length; k++) {
      const imp = imps[k];
      this._imp.add(imp.id);
      if (!(t - imp.t <= SPLASH.life)) continue;   // stale (e.g. log loaded mid-run): no splash, no bird
      // dense playing: later splashes in a run get smaller (≥ 50 %), so fast notes don't build a white wall
      let recent = 0;
      for (let q = this.list.length - 1; q >= 0 && imp.t - this.list[q].t0 < 1.5; q--) if (this.list[q].kind === 'note') recent++;
      // the splash erupts IN the lineup (reads big and close from the wide camera), on the lane's crest z, nearest the
      // front's side; the flash/glow stays on the front where the note landed (Fx._impact)
      const sx = splashX(imp.x, imp.id, seed);
      const sp = splashParams(sx, imp.z, imp.t, imp.strength, 1, Math.max(0.5, 1 / (1 + 0.15 * recent)));
      const u = Number.isFinite(imp.u) ? imp.u : 0.5;
      const n = Math.max(0, Math.min(8, Math.round(bc.perNote ?? 1)));
      const birds = [];
      for (let j = 0; j < n; j++) birds.push(noteBirdParams(imp.id, j, seed, sp, 0, u, sun));
      this.list.push({ kind: 'note', key: imp.id, t0: imp.t, sp, col: laneColor(u), birds,
        life: Math.max(BIRD.noteLife, SPLASH.life, ...birds.map((b) => b.life)) });
    }
    // riders 'flock' events (tolerates riders without events / without the flock type)
    const evs = riders?.events;
    let added = false;
    if (Array.isArray(evs)) {
      for (let e = evs.length - 1; e >= 0; e--) {
        const ev = evs[e];
        if (!ev || !(ev.t >= t - 1.0)) break;
        if (ev.type !== 'flock' || !ev.pos) continue;
        const key = (ev.riderId | 0) * 1000003 + Math.round(ev.t / DT);
        if (this._flock.has(key)) continue;
        this._flock.add(key);
        const n = Math.max(0, Math.min(64, Math.round(bc.flock ?? 16)));
        const sp = splashParams(ev.pos.x, ev.pos.z, ev.t, 1, SPLASH.flockSize, 0.7);
        const birds = [];
        for (let j = 0; j < n; j++) { const b = flockBirdParams(key, j, n, seed, ev.pos, sun); b.life = flockLife(b); birds.push(b); }
        added = true;
        this.list.push({ kind: 'flock', key, t0: ev.t, sp, col: [1.0, 0.8, 0.45], birds, pos: { ...ev.pos },
          life: Math.max(SPLASH.life, ...birds.map((b) => b.life)) });
      }
      // keep birth order chronological when several flocks land on one step
      if (added) this.list.sort((p, q) => p.t0 - q.t0 || (p.kind === q.kind ? p.key - q.key : p.kind === 'note' ? -1 : 1));
    }
    // prune finished births (and their dedupe keys)
    let cut = 0;
    while (cut < this.list.length && t - this.list[cut].t0 > this.list[cut].life) cut++;
    if (cut) {
      for (let k = 0; k < cut; k++) {
        const b = this.list[k];
        if (b.kind === 'note') this._imp.delete(b.key); else this._flock.delete(b.key);
      }
      this.list.splice(0, cut);
    }
    // ids whose impulse left the ring and whose birth is gone can be forgotten; bound the set otherwise
    if (this._imp.size > 4096) { const keep = new Set(imps.map((m) => m.id)); for (const id of this._imp) if (!keep.has(id)) this._imp.delete(id); }
  }

  /**
   * Live birds at time t, newest births first, capped at max (oldest culled first). Calls fn(bp, age, birth) per bird.
   * Returns the number of live birds visited.
   */
  forBirds(t, max, fn) {
    let n = 0;
    for (let b = this.list.length - 1; b >= 0 && n < max; b--) {
      const br = this.list[b], age = t - br.t0;
      if (age < 0) continue;
      for (const bp of br.birds) {
        if (age < bp.t0 || age > bp.life) continue;
        if (n >= max) break;
        fn(bp, age, br);
        n++;
      }
    }
    return n;
  }
}
