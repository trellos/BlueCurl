// BlueCurl Swell — rider brains (WP6a): lineup homes, idle behaviours, wave fit. Pure JS, deterministic.
import { RIDERS, ZONES, uToZ, hash01 } from '../contracts.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (s) => s * s * (3 - 2 * s);

/** Movement per kind (m/s): vPos = positioning before a takeoff, vRet = returning to the lineup. cool = s. */
export const KINDS = {
  surfer:  { vPos: 3, vRet: 2, cool: 4 },
  dolphin: { vPos: 8, vRet: 6, cool: 4 },
  seal:    { vPos: 4, vRet: 3, cool: 4 },
};

/**
 * Lineup spots: for every zone, the riders that list it are spread along the zone around its centre (first-preference
 * riders nearest the centre), a little seaward of the break line (x = lineX + 6 … 14). homes[riderId][zi] = {x, z}.
 */
export function homeSpots(seed) {
  const homes = RIDERS.map(() => ({}));
  ZONES.forEach((Z, zi) => {
    const list = RIDERS.filter((r) => r.zones.includes(Z.key))
      .sort((a, b) => a.zones.indexOf(Z.key) - b.zones.indexOf(Z.key) || a.id - b.id);
    // takeoff area: between the zone centre and where a centred swell peaks (swell clamps uPeak into the zone)
    const z0 = uToZ(Z.u0), z1 = uToZ(Z.u1), w = z1 - z0;
    const zPk = uToZ(Math.min(Math.max(0.5, Z.u0 + 0.03 * (Z.u1 - Z.u0)), Z.u1 - 0.03 * (Z.u1 - Z.u0)));
    const zc = 0.4 * (0.5 * (z0 + z1)) + 0.6 * zPk;
    const sp = Math.min(13, (0.7 * w) / Math.max(1, list.length));
    list.forEach((r, k) => {
      const slot = (k % 2 ? 1 : -1) * (Math.floor(k / 2) + 0.5);   // −½, +½, −1½, +1½ … around the takeoff area
      homes[r.id][zi] = {
        x: Z.lineX + 5 + 7 * hash01(r.id, zi + 10, seed),
        z: Math.min(z1 - 8, Math.max(z0 + 8, zc + slot * sp + 3 * (hash01(r.id, zi, seed) - 0.5))),
      };
    });
  });
  return homes;
}

/** How much a kind likes a wave (> 0). Surfers: big and steep; dolphins/seals: small and mellow; dolphins love barrels. */
export function fit(kind, zb) {
  const size = clamp01(zb.H / 3.5);
  if (kind === 'surfer') return Math.max(0.05, 0.25 + 0.45 * size + 0.35 * zb.steep + 0.25 * zb.curl - 0.2 * zb.mush);
  if (kind === 'dolphin') return Math.max(0.05, 0.25 + 0.35 * (1 - size) + 0.2 * (1 - zb.steep) + 0.8 * zb.curl);
  return Math.max(0.05, 0.25 + 0.45 * (1 - size) + 0.35 * (1 - zb.steep) + 0.15 * zb.mush);
}

/** Deterministic weighted pick: candidates [{w}], h ∈ [0,1). */
export function weightedPick(cands, h) {
  let sum = 0;
  for (const c of cands) sum += c.w;
  let x = h * sum;
  for (const c of cands) { x -= c.w; if (x < 0) return c; }
  return cands[cands.length - 1];
}

const CAP = ZONES.map((Z) => ({ outer: 1, point: 3, inside: 2 })[Z.key] ?? 2);    // riders a lineup holds
const PULL = ZONES.map((Z) => ({ outer: 0, point: 12, inside: 2 })[Z.key] ?? 0);   // the point is the main break

/** Lineup to return to after a ride: cheapest of the rider's zones (travel time, crowding, preference rank). */
export function pickHome(r, b, x, z, all) {
  let best = b.homeZi, bestC = Infinity;
  for (let k = 0; k < r.zones.length; k++) {
    const zi = ZONES.findIndex((Z) => Z.key === r.zones[k]);
    const h = b.homes[zi];
    if (!h) continue;
    let crowd = 0;
    for (const o of all) if (o.r !== r && o.b.homeZi === zi) crowd++;
    const c = Math.hypot(h.x - x, h.z - z) / KINDS[r.kind].vRet + 8 * Math.max(0, crowd + 1 - CAP[zi]) + 2 * k - PULL[zi];
    if (c < bestC) { bestC = c; best = zi; }
  }
  return best;
}

// ------------------------------------------------------------------ idle behaviour in the lineup
/**
 * Advance the idle behaviour of a LINEUP rider. b.idle holds the current segment; segments are chosen with
 * hash01(riderId, n, seed) so the sequence is a pure function of the step history.
 * Returns { x, z, off (vertical offset from the sea surface), act, actT, face: [fx, fz] | null }.
 */
export function idleStep(r, b, t, seed, out = {}) {
  const home = b.homes[b.homeZi];
  let s = b.idle;
  if (!s || t >= s.t1) s = b.idle = nextIdle(r, b, t, seed, home, s);
  const p = clamp01((t - s.t0) / (s.t1 - s.t0));
  out.face = null;
  out.actT = p;
  if (r.kind === 'surfer') {
    if (s.type === 'paddle') {
      const e = smooth(p);
      out.x = s.ax + (s.tx - s.ax) * e; out.z = s.az + (s.tz - s.az) * e;
      out.act = 'paddle'; out.off = 0;
    } else {
      out.x = s.ax; out.z = s.az; out.act = 'idle'; out.off = 0; out.face = [Math.cos(s.yaw), Math.sin(s.yaw)];
    }
  } else if (r.kind === 'dolphin') {
    const ramp = smooth(clamp01((t - s.tc) / 1.5));
    const rho = s.rho0 + (s.R - s.rho0) * ramp;
    const phi = s.phi0 + s.w * (t - s.tc);
    out.x = home.x - 2 + rho * Math.cos(phi); out.z = home.z + rho * Math.sin(phi);
    if (s.type === 'surface') { out.act = 'jump'; out.off = -0.5 + 1.5 * Math.sin(Math.PI * p) ** 2; }
    else { out.act = 'swim'; out.off = -0.5; }
  } else {
    if (s.type === 'dive') {
      const e = smooth(p);
      out.x = s.ax + (s.tx - s.ax) * e; out.z = s.az + (s.tz - s.az) * e;
      out.act = 'dive'; out.off = -0.1 - 1.4 * Math.sin(Math.PI * p) ** 2;
    } else {
      out.x = s.ax; out.z = s.az; out.act = s.type === 'roll' ? 'roll' : 'idle'; out.off = -0.1;
    }
  }
  return out;
}

function nextIdle(r, b, t, seed, home, prev) {
  const n = b.idleN++;
  const h = (k) => hash01(r.id * 977 + k, n, seed + 31);
  const x = prev ? (prev.type === 'paddle' || prev.type === 'dive' ? prev.tx : prev.ax) : b.wx;
  const z = prev ? (prev.type === 'paddle' || prev.type === 'dive' ? prev.tz : prev.az) : b.wz;
  const near = () => {                                        // a new spot within ~3 m of home
    const a = 6.2832 * h(3), rr = 3 * Math.sqrt(h(4));
    return [home.x + rr * Math.cos(a), home.z + rr * Math.sin(a)];
  };
  if (r.kind === 'surfer') {
    const far = Math.hypot(x - home.x, z - home.z) > 3.5;
    if (prev?.type !== 'paddle' && prev && (far || h(1) < 0.55)) {
      const [tx, tz] = near();
      const dur = Math.max(1.6, Math.hypot(tx - x, tz - z) / 1.2);
      return { type: 'paddle', t0: t, t1: t + dur, ax: x, az: z, tx, tz };
    }
    return { type: 'sit', t0: t, t1: t + 3 + 4 * h(2), ax: x, az: z, yaw: 0.35 * (2 * h(5) - 1) };   // facing seaward
  }
  if (r.kind === 'dolphin') {
    // keep circling around home; every other segment a short surfacing leap
    const rho0 = prev ? prev.R : Math.hypot(x - home.x + 2, z - home.z);
    const phi0 = prev ? prev.phi0 + prev.w * (t - prev.tc) : Math.atan2(z - home.z, x - home.x + 2);
    const surf = prev && prev.type === 'circle';
    const w = prev ? prev.w : (h(6) < 0.5 ? 1 : -1) * 0.5;
    return { type: surf ? 'surface' : 'circle', t0: t, t1: t + (surf ? 1.1 : 3.5 + 3 * h(2)), tc: t,
      rho0, phi0, R: prev ? prev.R : 3.5 + 1.5 * h(7), w };
  }
  // seal: float, roll, dive
  if (prev && prev.type === 'float') {
    const k = h(1);
    if (k < 0.4) return { type: 'roll', t0: t, t1: t + 1.2, ax: x, az: z };
    if (k < 0.8) { const [tx, tz] = near(); return { type: 'dive', t0: t, t1: t + 3 + h(2), ax: x, az: z, tx, tz }; }
  }
  return { type: 'float', t0: t, t1: t + 3 + 3 * h(2), ax: x, az: z };
}
