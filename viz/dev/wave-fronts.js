// BlueCurl Swell — synthetic FrontStates for the WP4a tests (node tests + GPU parity page). Deterministic.
import { NCOLS, ZONES, zToU, mulberry32, breakStartTime } from '../src/contracts.js';

export function zoneBreak(zi, o = {}) {
  const Z = ZONES[zi];
  return {
    zone: Z.key, zi, tBreak: 0, uPeak: 0.5 * (Z.u0 + Z.u1), u0: Z.u0, u1: Z.u1, dir: Z.peelBias, vPeel: Z.vPeel,
    Tb: Z.Tb, peelLen: 120, backLen: 25, closeout: false, sections: 1, H: 2, steep: 0.7, curl: 0.8, mush: 0.1,
    quality: { size: 0, steepness: 0, barrelTime: 0, peelLength: 0 }, ...o,
  };
}

/** cols(u) → [H, steep, curl, mush] */
export function makeFront({ id = 1, x = 165, vx = -12, breaks = [], cols, tPoint = 0 } = {}) {
  const c = new Float32Array(NCOLS * 4);
  for (let i = 0; i < NCOLS; i++) {
    const v = cols((i + 0.5) / NCOLS);
    for (let j = 0; j < 4; j++) c[i * 4 + j] = v[j];
  }
  return { id, set: 0, k: 0, tSpawn: tPoint - 14, tPoint, x, vx, alpha: 1, cols: c,
    energy: new Float32Array(NCOLS), glow: new Float32Array(NCOLS), breaks, target: false };
}

const bump = (u, c, w) => Math.exp(-(((u - c) / w) ** 2));

/** The standard synthetic set: 1–3 breaks, A-frame, closeout, sections, re-forming between zones. */
export function syntheticFronts() {
  const P = ZONES[1], O = ZONES[0], I = ZONES[2];
  return [
    // 0: single clean peel at the point, hollow
    makeFront({ id: 1, x: 165, vx: -9, breaks: [zoneBreak(1, { tBreak: 1.0, uPeak: zToU(40), dir: -1, peelLen: 140, backLen: 20 })],
      cols: (u) => [0.6 + 2.2 * bump(u, zToU(30), 0.25), 0.85, 0.95, 0.05] }),
    // 1: outer (A-frame) then point re-break; shapes vary along the crest
    makeFront({ id: 2, x: 240, vx: -20, breaks: [
      zoneBreak(0, { tBreak: 0.5, uPeak: 0.5 * (O.u0 + O.u1), dir: 0, peelLen: 70, backLen: 0 }),
      zoneBreak(1, { tBreak: 5.5, uPeak: zToU(60), dir: -1, peelLen: 150, backLen: 30 })],
      cols: (u) => [0.8 + 3.0 * bump(u, 0.6, 0.3), 0.5 + 0.5 * Math.sin(9 * u), 0.5 + 0.5 * Math.cos(7 * u), 0.3 * bump(u, 0.35, 0.1)] }),
    // 2: closeout at the outer reef, sectiony point, inside beach break
    makeFront({ id: 3, x: 120, vx: -8.5, breaks: [
      zoneBreak(0, { tBreak: 0.2, closeout: true, peelLen: 200, backLen: 200 }),
      zoneBreak(1, { tBreak: 3.0, uPeak: zToU(20), dir: -1, sections: 3, peelLen: 120, backLen: 15 }),
      zoneBreak(2, { tBreak: 7.0, uPeak: 0.5 * (I.u0 + I.u1), dir: 0, peelLen: 80, backLen: 0, Tb: 3.0 })],
      cols: (u) => [0.4 + 1.6 * bump(u, 0.4, 0.4), 0.6, 0.4 + 0.5 * bump(u, 0.3, 0.15), 0.2 + 0.6 * bump(u, 0.15, 0.1)] }),
    // 3: unbroken swell with no breaks (pure approach)
    makeFront({ id: 4, x: 420, vx: -40, breaks: [], cols: (u) => [0.5 + 0.5 * bump(u, 0.5, 0.3), 0.4, 0.3, 0.2] }),
  ];
}

/**
 * n deterministic (front, u, sigma, t) samples over the synthetic set: 1/3 uniform in (u, t), 2/3 targeted at a
 * random zone break (u inside its range, t = start + Tb·[-0.5, 2.2]) so breaking, tube, re-form and blend states
 * are well covered. t is local time (the parity page adds the time offset).
 */
export function parityCases(n = 2400, seed = 7) {
  const rnd = mulberry32(seed), fronts = syntheticFronts(), out = [];
  for (let i = 0; i < n; i++) {
    const fi = i % fronts.length, f = fronts[fi];
    let u = rnd(), t = -2 + 14 * rnd();
    if (i % 3 !== 0 && f.breaks.length) {
      const zb = f.breaks[Math.floor(rnd() * f.breaks.length)];
      const uu = zb.u0 + (zb.u1 - zb.u0) * rnd(), ts = breakStartTime(zb, uu);
      if (Number.isFinite(ts)) { u = uu; t = ts + zb.Tb * (-0.5 + 2.7 * rnd()); }
    }
    out.push({ fi, u, sigma: rnd(), t });
  }
  return { fronts, cases: out };
}
