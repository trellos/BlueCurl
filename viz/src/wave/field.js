// BlueCurl Swell — JS mirror of the swept-profile wave surface (WP4a). See contracts.js "wave geometry API".
// Mirrored 1:1 by PROFILE_GLSL (profile.glsl.js); test/wave-parity.mjs checks GPU vs JS to < 1e-3 m.
//
// Column data: front.cols holds NCOLS columns; column c sits at u = (c + 0.5) / NCOLS (cell centres, as in
//   sim/swell.js), linearly interpolated in u and clamped to the end columns (= texture LINEAR + CLAMP_TO_EDGE).
// Break phase: tau = contracts.localTau(front, u, t). Shape phase (what the profile shows) is the same, except
//   while a column re-forms (zi ≥ 0) and a LATER zone break of the same column is less than its Tb away:
//   then P = mix(P(tau), P(tauNext), smoothstep(-1, 0, tauNext)), tauNext = (t - tsNext) / TbNext ∈ (-1, 0),
//   so the 2 → 0 jump of localTau at the next zone's start is continuous (P(2) == P(-1)).
// World: x = front.x - xi, z = uToZ(u), y = y + ambientHeight(x, z, t).
// Normal: normalize(cross(dP/dsigma, dP/du)), dP/du by central difference (DU) of the local profile; it points
//   out of the water (into the tube under a lip). Velocity: front.vx plus central difference (DT_FD) of the
//   local profile in t (front.x / cols are only known at t).

import { NCOLS, FRONT_W, uToZ, zToU, localTau, breakStartTime, DEFAULT_CFG } from '../contracts.js';
import { profileInto, profileExtents } from './profile.js';
import { NPTS, SIGMA_CREST, SIGMA_LIP, SIGMA_TROUGH } from './keyframes.js';

export const DU = 1e-3;          // crest-coordinate step for the u tangent (≈ 0.52 m)
export const DT_FD = 1e-3;       // s, time step for the velocity
export const colU = (c) => (c + 0.5) / NCOLS;

let AMB = DEFAULT_CFG.ambient;
/** Ambient parameters used by the JS mirror (keep in sync with the uAmbient uniform). */
export function setFieldAmbient(a) { AMB = a; }

/** ambient height and its gradient: returns [A, dA/dx, dA/dz, dA/dt] (same formula as contracts.ambientHeight). */
export function ambientGrad(x, z, t, a = AMB, out = new Float64Array(4)) {
  const k1 = (2 * Math.PI) / (9.81 * a.period * a.period / (2 * Math.PI));
  const k2 = (2 * Math.PI) / (9.81 * a.period2 * a.period2 / (2 * Math.PI));
  const w1 = (2 * Math.PI) / a.period, w2 = (2 * Math.PI) / a.period2;
  const p1 = k1 * (x + 0.12 * z) + w1 * t, p2 = k2 * (x - 0.3 * z) + w2 * t + 1.3;
  const c1 = a.amp * Math.cos(p1), c2 = a.amp2 * Math.cos(p2);
  out[0] = a.amp * Math.sin(p1) + a.amp2 * Math.sin(p2);
  out[1] = k1 * c1 + k2 * c2;
  out[2] = 0.12 * k1 * c1 - 0.3 * k2 * c2;
  out[3] = w1 * c1 + w2 * c2;
  return out;
}

/** Per-column [H, steep, curl, mush] at u (linear between columns). */
export function colsAt(cols, u, out = new Float64Array(4)) {
  const f = Math.min(NCOLS - 1, Math.max(0, u * NCOLS - 0.5));
  const i = Math.min(Math.floor(f), NCOLS - 2), s = f - i;
  for (let j = 0; j < 4; j++) out[j] = cols[i * 4 + j] * (1 - s) + cols[(i + 1) * 4 + j] * s;
  return out;
}

/**
 * Column state at (u, t): { u, H, steep, curl, mush, tau, zi, tStart, tauA, tauB, wB }.
 * tau/zi/tStart are exactly contracts.localTau; tauA/tauB/wB is the shape phase (see header).
 */
export function columnState(front, u, t, cs = {}) {
  const c = colsAt(front.cols, u, CS_TMP);
  cs.u = u; cs.H = c[0]; cs.steep = c[1]; cs.curl = c[2]; cs.mush = c[3];
  const lt = localTau(front, u, t);
  cs.tau = lt.tau; cs.zi = lt.zi; cs.tStart = lt.tStart;
  cs.tauA = lt.tau; cs.tauB = 0; cs.wB = 0;
  if (lt.zi >= 0) {
    let next = Infinity, Tb = 2.5;
    for (const zb of front.breaks) { const ts = breakStartTime(zb, u); if (ts > t && ts < next) { next = ts; Tb = zb.Tb; } }
    if (Number.isFinite(next)) {
      const tn = (t - next) / Tb;
      if (tn > -1) { const w = tn + 1; cs.tauB = tn; cs.wB = w * w * (3 - 2 * w); }
    }
  }
  return cs;
}
const CS_TMP = new Float64Array(4);

const PA = { xi: 0, y: 0, dxi: 0, dy: 0, thick: 0 }, PB = { xi: 0, y: 0, dxi: 0, dy: 0, thick: 0 };
/** Local cross-section point (metres, front frame) of a column state: { xi, y, dxi, dy, thick }. */
export function evalLocal(cs, sigma, out = { xi: 0, y: 0, dxi: 0, dy: 0, thick: 0 }) {
  profileInto(PA, cs.tauA, sigma, cs.H, cs.steep, cs.curl, cs.mush);
  if (cs.wB > 0) {
    profileInto(PB, cs.tauB, sigma, cs.H, cs.steep, cs.curl, cs.mush);
    const w = cs.wB, v = 1 - w;
    out.xi = PA.xi * v + PB.xi * w; out.y = PA.y * v + PB.y * w; out.dxi = PA.dxi * v + PB.dxi * w;
    out.dy = PA.dy * v + PB.dy * w; out.thick = PA.thick * v + PB.thick * w;
  } else {
    out.xi = PA.xi; out.y = PA.y; out.dxi = PA.dxi; out.dy = PA.dy; out.thick = PA.thick;
  }
  return out;
}

const CS0 = {}, CS1 = {}, L0 = {}, L1 = {}, L2 = {}, AG = new Float64Array(4);

/** World sample: { x,y,z, nx,ny,nz, vx,vy,vz, tau, zi, H, thick, xi, yl } (yl = local height without ambient). */
export function sampleFront(front, u, sigma, t) {
  const cs = columnState(front, u, t, CS0);
  const L = evalLocal(cs, sigma, L0);
  const xi = L.xi, yl = L.y, dxi = L.dxi, dy = L.dy, thick = L.thick;
  const x = front.x - xi, z = uToZ(u);
  ambientGrad(x, z, t, AMB, AG);
  const A = AG[0], Ax = AG[1], Az = AG[2], At = AG[3];
  // d/du (local) by central difference
  evalLocal(columnState(front, u + DU, t, CS1), sigma, L1);
  evalLocal(columnState(front, u - DU, t, CS1), sigma, L2);
  const dxiU = (L1.xi - L2.xi) / (2 * DU), dyU = (L1.y - L2.y) / (2 * DU);
  // tangents (world)
  const sx = -dxi, sy = dy - Ax * dxi, sz = 0;
  const ux = -dxiU, uy = dyU - Ax * dxiU + Az * FRONT_W, uz = FRONT_W;
  let nx = sy * uz - sz * uy, ny = sz * ux - sx * uz, nz = sx * uy - sy * ux;
  const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
  // d/dt (local) by central difference, front frame fixed
  evalLocal(columnState(front, u, t + DT_FD, CS1), sigma, L1);
  evalLocal(columnState(front, u, t - DT_FD, CS1), sigma, L2);
  const dxiT = (L1.xi - L2.xi) / (2 * DT_FD), dyT = (L1.y - L2.y) / (2 * DT_FD);
  const vx = front.vx - dxiT, vy = dyT + Ax * vx + At;
  return { x, y: yl + A, z, nx, ny, nz, vx, vy, vz: 0, tau: cs.tau, zi: cs.zi, H: cs.H, thick, xi, yl };
}

// ------------------------------------------------------------------ cross-section queries
const NSCAN = 4 * (NPTS - 1);           // scan resolution in sigma
const LQ = {};

function xiAt(cs, s) { return evalLocal(cs, s, LQ).xi; }

/** All crossings of the vertical line xi = xiT with the local profile, as heights (unsorted). */
export function crossings(cs, xiT, s0 = 0, s1 = 1, out = []) {
  out.length = 0;
  const n = Math.max(1, Math.round(NSCAN * (s1 - s0)));
  let sa = s0, fa = xiAt(cs, sa) - xiT;
  for (let j = 1; j <= n; j++) {
    const sb = s0 + ((s1 - s0) * j) / n, fb = xiAt(cs, sb) - xiT;
    if ((fa <= 0) !== (fb <= 0)) {
      let lo = sa, hi = sb, flo = fa;
      for (let it = 0; it < 30; it++) {
        const m = 0.5 * (lo + hi), fm = xiAt(cs, m) - xiT;
        if ((flo <= 0) === (fm <= 0)) { lo = m; flo = fm; } else hi = m;
      }
      out.push(evalLocal(cs, 0.5 * (lo + hi), LQ).y);
    }
    sa = sb; fa = fb;
  }
  return out;
}

const CSS = {}, CR = [];
/**
 * Single-valued sea surface at (x, z): ambient + the highest front contribution, where a front contributes the
 * LOWEST crossing of its cross-section at that x (the face / trough under any lip, never the lip itself).
 * Fronts whose profile extent does not contain x contribute nothing.
 */
export function surfaceHeight(fronts, x, z, t) {
  const u = zToU(z);
  let best = -Infinity;
  if (u >= 0 && u <= 1) {
    for (const f of fronts) {
      const cs = columnState(f, u, t, CSS);
      const e = profileExtents(cs.H), xiT = f.x - x;
      if (!(xiT > e.back && xiT < e.front)) continue;
      crossings(cs, xiT, 0, 1, CR);
      let lo = Infinity;
      for (const y of CR) if (y < lo) lo = y;
      if (lo < Infinity && lo > best) best = lo;
    }
  }
  const A = ambientGrad(x, z, t, AMB, AG)[0];
  return A + (best > -Infinity ? best : 0);
}

/** Lip tip (landmark C) in world coordinates: { x, y, z, sigma }. */
export function lip(front, u, t) {
  const cs = columnState(front, u, t, CSS);
  const L = evalLocal(cs, SIGMA_LIP, LQ);
  const x = front.x - L.xi, z = uToZ(u);
  return { x, y: L.y + ambientGrad(x, z, t, AMB, AG)[0], z, sigma: SIGMA_LIP };
}

export const BARREL_MIN_OVERHANG = 0.5;   // × H: horizontal lip throw beyond the tube wall
export const BARREL_MIN_RADIUS = 0.12;    // × H

/**
 * Tube while the lip is thrown over the face: { x, y, z, r, overhang, tipSigma, wallSigma } or null.
 * overhang = xi(lip tip) - xi(tube wall) (m); centre = midway between tip and wall, vertically midway between
 * the floor (lowest crossing) and the ceiling (lip underside, next crossing above it).
 */
export function barrel(front, u, t) {
  const cs = columnState(front, u, t, CSS);
  if (!(cs.H > 0.05)) return null;
  const n = Math.round(NSCAN * (SIGMA_TROUGH - SIGMA_CREST));
  // tube wall: min xi in [lip, trough]; tip: max xi in [crest, wall]
  let wallS = SIGMA_LIP, wallXi = Infinity;
  for (let j = 0; j <= n; j++) {
    const s = SIGMA_CREST + ((SIGMA_TROUGH - SIGMA_CREST) * j) / n;
    if (s < SIGMA_LIP) continue;
    const xi = xiAt(cs, s);
    if (xi < wallXi) { wallXi = xi; wallS = s; }
  }
  let tipS = SIGMA_CREST, tipXi = -Infinity;
  for (let j = 0; j <= n; j++) {
    const s = SIGMA_CREST + ((SIGMA_TROUGH - SIGMA_CREST) * j) / n;
    if (s > wallS) break;
    const xi = xiAt(cs, s);
    if (xi > tipXi) { tipXi = xi; tipS = s; }
  }
  const over = tipXi - wallXi;
  if (!(over > BARREL_MIN_OVERHANG * cs.H)) return null;
  const xc = 0.5 * (tipXi + wallXi);
  crossings(cs, xc, 0, 1, CR);
  CR.sort((a, b) => a - b);
  if (CR.length < 2) return null;
  const floor = CR[0], ceil = CR[1];
  const r = Math.min(0.5 * (ceil - floor), 0.5 * over);
  if (!(r > BARREL_MIN_RADIUS * cs.H)) return null;
  const x = front.x - xc, z = uToZ(u);
  const y = 0.5 * (floor + ceil) + ambientGrad(x, z, t, AMB, AG)[0];
  return { x, y, z, r, overhang: over, tipSigma: tipS, wallSigma: wallS };
}
