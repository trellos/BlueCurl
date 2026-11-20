// BlueCurl Swell — swell simulation (WP3). Contract: src/contracts.js "swell state".
//
// Fronts are scheduled on the interval grid, roll in along contracts.PATH, collect energy from key notes while they
// are the input target, and freeze one ZoneBreak per zone `commitLead` seconds before the crest reaches the zone
// line. Everything is a deterministic function of (cfg, input log): no Math.random, no clocks.
import {
  DT, STEP_TOL, NCOLS, FRONT_W, ZONES, PATH, intervalSec, uToZ, zToU, laneToU, hash01, breakStartTime,
} from '../contracts.js';

// ===================================================================================== TUNING
/**
 * All constants of the swell model in one place. Inputs to the energy → wave mapping, per front × zone:
 *   E        sum of (decayed) column energy inside the zone            → power = 1 − e^(−E/H.E0)
 *   strength mean impulse strength (scale·velocity), frac-weighted     → sN    = (strength − lo)/(hi − lo)  ∈ 0..1
 *   count    effective number of impulses in the zone                  → nN    = 1 − e^(−count/n0)
 *   spread   std of impulse u / zone width                              → spN   = spread/full ∈ 0..1, conc = 1 − spN
 *   erratic  rhythmic jitter of the onsets (non power-of-two interval ratios) + CV of strengths ∈ 0..1
 */
export const TUNING = {
  // height: H = zone.Hscale · (base + gain·power). base keeps zero-input fronts below every Hbreak.
  H: { base: 0.35, gain: 2.4, E0: 6 },
  strength: { lo: 0.3, hi: 0.9 },
  count: { n0: 4 },
  spread: { full: 0.3 },
  erratic: { onsetMerge: 0.06, pause: 1.6, wTime: 0.8, wStrength: 1.0, minImpulses: 3, minFrac: 0.25 },
  // mush = base + weak·(1−sN)·(1−0.5·power) + erratic·er − many·nN·sN
  mush: { base: 0.08, weak: 0.6, erratic: 0.85, many: 0.1 },
  // steep = base + strength·sN + power·power + spread·spN − mush·mush
  steep: { base: 0.2, strength: 0.45, power: 0.3, spread: 0.1, mush: 0.5 },
  // curl = zoneCurl · sN · (base + conc·conc) · (p0 + p1·power) · (1 − mush·mush)
  curl: { base: 0.15, conc: 0.85, p0: 0.35, p1: 0.65, mush: 0.9 },
  zoneCurl: { outer: 1.15, point: 1.0, inside: 0.6 },
  // A-frame when the centroid is within ±aframe of the zone centre; peelBias shifts ambiguous (spread) input by
  // bias·spN² (a spread wall at the point peels south, away from the headland, instead of a short A-frame)
  dir: { aframe: 0.08, bias: 0.12 },
  // vPeel = zone.vPeel · (v0 + v1·steep)
  vPeel: { v0: 0.6, v1: 0.8 },
  // peelLen = available length ahead of the peak · clamp(base + spread·spN + steep·steep − mush·mush) · zonePeel
  peel: { base: 0.3, spread: 0.45, steep: 0.3, mush: 0.2, min: 0.2, minLen: 12 },
  zonePeel: { outer: 0.6, point: 1.0, inside: 0.85 },
  back: { base: 0.1, mush: 0.5 },              // backLen = length behind the peak · (base + mush·mush)
  Tb: { mush: 0.45, curl: 0.15 },             // Tb = zone.Tb · (1 + mush·mush − curl·curl)
  sections: { score2: 0.28, score3: 0.55, mushW: 0.5, mushAt: 0.6 }, // score = er + mushW·max(0, mush − mushAt)
  closeout: { erratic: 0.4, strength: 0.45, power: 0.45 },          // erratic AND strong AND big
  barrel: { k: 0.55, pow: 1.5 },              // barrelTime = k · curl^pow · peelLen / vPeel   (s in the tube)
  // Peel timing: every column of a zone starts breaking before the crest passes endX (world x). With the default
  // PATH the crest is at x 50 about 7 s after tPoint, so the point peel is capped at vPeel·7 s (≈ 55–80 m).
  peelEndX: { outer: 120, point: 50, inside: 4 },
  // Headland: columns north of z0…z1 run into the cliff once x < 66. They fade out as the crest goes x0 → x1, and
  // no peel (or back crumble) reaches them after the crest passes breakX.
  headland: { z0: 30, z1: 42, x0: 80, x1: 66, breakX: 70 },
  // Hide breakStartTime jumps (peel end, backLen end, zone edges): within `band` m of such an edge, published H eases
  // toward floorFrac·(zone swell height) and steep/curl toward plain swell, while the zone is active
  // (ramps in from commit to tBreak, out over fadeOut s after the last column has re-formed).
  taper: { band: 10, floorFrac: 0.5, fadeOut: 1.5 },
  // per-column swell lumps
  cols: {
    shoal0: 0.45,          // fraction of the potential height at the horizon (shoals to 1.0 at the zone line)
    ambient: 0.3,          // zero-energy lump = zone.Hscale · ambient (below every Hbreak, incl. the next zone's)
                           // columns outside a zone's range: H = zone.Hscale · (ambient + outGain·(1 − e^(−e·nRef/E0)))
    outGain: 1.2,
    nRef: 40,              // columns: converts a column's energy density into a zone-like E
    gExp: 0.6,             // taper exponent of the energy shape away from the peak
    edge: 3,               // zone membership ramp half-width (columns)
    steep0: 0.12, mush0: 0.25, mushReform: 0.55,
    smoothTau: 0.25,       // s, first-order smoothing of every column channel (keeps cols smooth in time)
  },
  unbrokenLoss: 0.9,       // energy factor for in-range columns that pass a zone unbroken (−10 %)
  glow: { tau: 0.6, gain: 1.0 },
  fade: { in: 2, out: 3 },
  impulseRing: 10,         // s of ImpulseFx kept
  eventRing: 60,           // s of SwellEvents kept
  jump: { base: 0.15, perStrength: 0.2 },
};

// ===================================================================================== helpers
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, s) => a + (b - a) * s;
const smooth = (s) => s * s * (3 - 2 * s);
const colU = (c) => (c + 0.5) / NCOLS;

/** Column index range [c0, c1] whose centres lie inside each zone. */
const ZC = ZONES.map((z) => ({ c0: Math.ceil(z.u0 * NCOLS - 0.5), c1: Math.floor(z.u1 * NCOLS - 0.5) }));
/** Smooth zone membership per column (1 inside, ramps to 0 across the edges). */
const MEMBER = ZONES.map((z) => {
  const m = new Float32Array(NCOLS);
  for (let c = 0; c < NCOLS; c++) {
    const u = colU(c), d = Math.min(u - z.u0, z.u1 - u) * NCOLS;
    m[c] = smooth(clamp01(0.5 + d / (2 * TUNING.cols.edge)));
  }
  return m;
});

/** Headland membership per column (0 south of z0, 1 north of z1). */
const HEAD = (() => {
  const m = new Float32Array(NCOLS), { z0, z1 } = TUNING.headland;
  for (let c = 0; c < NCOLS; c++) m[c] = smooth(clamp01((uToZ(colU(c)) - z0) / (z1 - z0)));
  return m;
})();

/** Effective set size: the set must fit inside the interval. */
export function effectiveSetSize(cfg, I = intervalSec(cfg)) {
  const sp = cfg.setSpacing > 0 ? cfg.setSpacing : 1e9;
  return Math.max(1, Math.min(Math.round(cfg.setSize), Math.floor((0.6 * I) / sp + 1e-9) + 1));
}

// ----------------------------------------------------------------------------- crest path (Fritsch–Carlson)
const SPLINES = new Map();
/** Monotone cubic through PATH with pre-point times scaled by travel/14. Cached per travel value. */
export function pathSpline(travel) {
  let sp = SPLINES.get(travel);
  if (sp) return sp;
  const k = travel / 14;
  const ts = PATH.map((p) => (p.t < 0 ? p.t * k : p.t)), xs = PATH.map((p) => p.x);
  const n = ts.length, d = new Array(n - 1), m = new Array(n);
  for (let i = 0; i < n - 1; i++) d[i] = (xs[i + 1] - xs[i]) / (ts[i + 1] - ts[i]);
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], h = a * a + b * b;
    if (h > 9) { const s = 3 / Math.sqrt(h); m[i] = s * a * d[i]; m[i + 1] = s * b * d[i]; }
  }
  sp = { ts, xs, m };
  SPLINES.set(travel, sp);
  return sp;
}
/** Crest x and dx/dt at time tau = t − tPoint. */
export function pathEval(sp, tau) {
  const { ts, xs, m } = sp, n = ts.length;
  if (tau <= ts[0]) return { x: xs[0] + m[0] * (tau - ts[0]), vx: m[0] };
  if (tau >= ts[n - 1]) return { x: xs[n - 1] + m[n - 1] * (tau - ts[n - 1]), vx: m[n - 1] };
  let i = 0;
  while (i < n - 2 && tau > ts[i + 1]) i++;
  const h = ts[i + 1] - ts[i], u = (tau - ts[i]) / h, u2 = u * u, u3 = u2 * u;
  const x = (2 * u3 - 3 * u2 + 1) * xs[i] + (u3 - 2 * u2 + u) * h * m[i] + (-2 * u3 + 3 * u2) * xs[i + 1] + (u3 - u2) * h * m[i + 1];
  const vx = ((6 * u2 - 6 * u) / h) * xs[i] + (3 * u2 - 4 * u + 1) * m[i] + ((-6 * u2 + 6 * u) / h) * xs[i + 1] + (3 * u2 - 2 * u) * m[i + 1];
  return { x, vx };
}
/** tau at which the crest reaches world x (exact on PATH nodes, bisection otherwise). */
function pathTimeAt(sp, x) {
  const i = sp.xs.indexOf(x);
  if (i >= 0) return sp.ts[i];
  let a = sp.ts[0], b = sp.ts[sp.ts.length - 1];
  for (let it = 0; it < 60; it++) { const mid = 0.5 * (a + b); if (pathEval(sp, mid).x > x) a = mid; else b = mid; }
  return 0.5 * (a + b);
}

// ----------------------------------------------------------------------------- energy → wave
/** Statistics of a front's input inside zone zi (see TUNING header). */
export function zoneStats(front, zi, tNow, halfLife) {
  const z = ZONES[zi], { c0, c1 } = ZC[zi], e = front.energy, s = front._s;
  let E = 0, eu = 0;
  for (let c = c0; c <= c1; c++) { E += e[c]; eu += e[c] * colU(c); }
  const tRef = Math.min(tNow, s.tCommit0);
  let fsum = 0, fs = 0, wsum = 0, wu = 0, wuu = 0;
  const list = [];
  for (const imp of s.imps) {
    const f = imp.frac[zi];
    if (f < 0.02) continue;
    const dec = tRef > imp.t ? Math.pow(2, -(tRef - imp.t) / halfLife) : 1;
    fsum += f; fs += f * imp.s;
    const w = f * imp.s * dec;
    wsum += w; wu += w * imp.u; wuu += w * imp.u * imp.u;
    if (f >= TUNING.erratic.minFrac) list.push(imp);
  }
  const width = z.u1 - z.u0;
  const mu = wsum > 1e-12 ? wu / wsum : (E > 1e-12 ? eu / E : 0.5 * (z.u0 + z.u1));
  const spread = wsum > 1e-12 ? Math.sqrt(Math.max(0, wuu / wsum - mu * mu)) / width : 0;
  return {
    E, count: fsum, strength: fsum > 0 ? fs / fsum : 0, spread, centroid: mu,
    centroidE: E > 1e-12 ? eu / E : 0.5 * (z.u0 + z.u1), erratic: erraticOf(s.imps, list),
  };
}

/**
 * 0..1 irregularity of the player: rhythmic jitter of the front's onsets (all of its notes, chords merged) plus the
 * CV of the strengths of the notes that land in the zone. Jitter compares consecutive inter-onset intervals: a ratio
 * that is a power of two (1:1, 1:2, …) counts as regular, anything in between as irregular; pauses are skipped.
 * Needs at least TUNING.erratic.minImpulses notes in the zone.
 */
function erraticOf(all, list) {
  const T = TUNING.erratic;
  if (list.length < T.minImpulses) return 0;
  const onsets = [];
  for (const imp of all) if (!onsets.length || imp.t - onsets[onsets.length - 1] > T.onsetMerge) onsets.push(imp.t);
  let jit = 0, nj = 0, prev = 0;
  for (let i = 1; i < onsets.length; i++) {
    const iv = onsets[i] - onsets[i - 1];
    if (iv > T.pause) { prev = 0; continue; }
    if (prev > 0) { const r = Math.log2(iv / prev); jit += 2 * Math.abs(r - Math.round(r)); nj++; }
    prev = iv;
  }
  const jitter = nj ? jit / nj : 0;
  const cvS = cv(list.map((i) => i.s));
  return clamp01(T.wTime * jitter + T.wStrength * cvS);
}
function cv(a) {
  let m = 0;
  for (const v of a) m += v;
  m /= a.length;
  if (m <= 1e-9) return 0;
  let q = 0;
  for (const v of a) q += (v - m) * (v - m);
  return Math.sqrt(q / a.length) / m;
}

/**
 * Map zone statistics to wave parameters (everything in a ZoneBreak except tBreak). `lim` = { tEnd, tHead }: seconds
 * from tBreak until the crest passes TUNING.peelEndX / TUNING.headland.breakX; caps peelLen/backLen (omit = no caps).
 */
export function mapZone(st, zi, lim = null) {
  const z = ZONES[zi], T = TUNING;
  const power = 1 - Math.exp(-st.E / T.H.E0);
  const H = z.Hscale * (T.H.base + T.H.gain * power);
  const sN = clamp01((st.strength - T.strength.lo) / (T.strength.hi - T.strength.lo));
  const nN = 1 - Math.exp(-st.count / T.count.n0);
  const spN = clamp01(st.spread / T.spread.full), conc = 1 - spN;
  const er = st.erratic;
  const mush = clamp01(T.mush.base + T.mush.weak * (1 - sN) * (1 - 0.5 * power) + T.mush.erratic * er - T.mush.many * nN * sN);
  const steep = clamp01(T.steep.base + T.steep.strength * sN + T.steep.power * power + T.steep.spread * spN - T.steep.mush * mush);
  const curl = clamp01((T.zoneCurl[z.key] ?? 1) * sN * (T.curl.base + T.curl.conc * conc) * (T.curl.p0 + T.curl.p1 * power) * (1 - T.curl.mush * mush));
  // peak + direction
  const width = z.u1 - z.u0;
  const uPeak = clamp(st.centroid, z.u0 + 0.03 * width, z.u1 - 0.03 * width);
  const d = (uPeak - z.u0) / width - 0.5 - T.dir.bias * z.peelBias * spN * spN;
  const dir = Math.abs(d) <= T.dir.aframe ? 0 : d > 0 ? -1 : 1;     // peel away from the heavy side
  const vPeel = z.vPeel * (T.vPeel.v0 + T.vPeel.v1 * steep);
  const left = (uPeak - z.u0) * FRONT_W, right = (z.u1 - uPeak) * FRONT_W;
  const ahead = dir > 0 ? right : dir < 0 ? left : Math.max(left, right);
  const behind = dir > 0 ? left : dir < 0 ? right : 0;
  const peelFrac = clamp(T.peel.base + T.peel.spread * spN + T.peel.steep * steep - T.peel.mush * mush, T.peel.min, 1) * (T.zonePeel[z.key] ?? 1);
  let peelLen = Math.max(T.peel.minLen, ahead * peelFrac);
  let backLen = behind * clamp01(T.back.base + T.back.mush * mush);
  if (lim) {
    const vBack = 0.5 * vPeel;
    peelLen = Math.min(peelLen, Math.max(T.peel.minLen, vPeel * lim.tEnd));
    backLen = Math.min(backLen, vBack * lim.tEnd);
    // the north side must not reach the headland after the crest passes breakX
    const sHead = Math.max(0, (zToU(T.headland.z0) - uPeak) * FRONT_W);
    if (dir >= 0) peelLen = Math.min(peelLen, Math.max(sHead, T.peel.minLen, vPeel * lim.tHead));
    else backLen = Math.min(backLen, Math.max(sHead, vBack * lim.tHead));
  }
  const Tb = z.Tb * (1 + T.Tb.mush * mush - T.Tb.curl * curl);
  const closeout = er >= T.closeout.erratic && sN >= T.closeout.strength && power >= T.closeout.power;
  const score = er + T.sections.mushW * Math.max(0, mush - T.sections.mushAt);
  const sections = 1 + (score > T.sections.score2 ? 1 : 0) + (score > T.sections.score3 ? 1 : 0);
  const barrelTime = closeout ? 0 : T.barrel.k * Math.pow(curl, T.barrel.pow) * peelLen / vPeel;
  return {
    H, steep, curl, mush, uPeak, dir, vPeel, Tb, peelLen, backLen, closeout, sections,
    quality: { size: H, steepness: steep, barrelTime, peelLength: closeout ? 0 : peelLen },
    norm: { power, sN, nN, spN, er },
  };
}

/** Per-column target lumps for a front heading to zone zi with parameters p → out (NCOLS*4). */
function zoneProfile(front, zi, p, out) {
  const z = ZONES[zi], C = TUNING.cols, e = front.energy, mem = MEMBER[zi], { c0, c1 } = ZC[zi];
  let emax = 0;
  for (let c = c0; c <= c1; c++) if (e[c] > emax) emax = e[c];
  const Hamb = z.Hscale * C.ambient;
  for (let c = 0; c < NCOLS; c++) {
    const m = mem[c];
    const g = emax > 1e-9 ? Math.pow(clamp01(e[c] / emax), C.gExp) : 0;
    const Pin = Hamb + (p.H - Hamb) * g;
    const Pout = z.Hscale * (C.ambient + C.outGain * (1 - Math.exp(-e[c] * C.nRef / TUNING.H.E0)));
    const w = g * m, i4 = c * 4;
    out[i4] = m * Pin + (1 - m) * Pout;
    out[i4 + 1] = C.steep0 + (p.steep - C.steep0) * w;
    out[i4 + 2] = p.curl * w;
    out[i4 + 3] = C.mush0 + (p.mush - C.mush0) * w;
  }
  return out;
}

// ===================================================================================== Swell
export class Swell {
  constructor(cfg) { this.cfg = cfg; this.reset(); }

  reset() {
    this.t = 0;
    this.fronts = [];
    this.impulses = [];
    this.events = [];
    this.schedule = { intervalSec: intervalSec(this.cfg), nextPointT: 0, setSize: effectiveSetSize(this.cfg), travel: this.cfg.travel };
    this.targetId = null;
    this._nextId = 1;
    this._set = 0;
    this._plan = [];          // planned, not yet created fronts of the current set
    this._floorT = null;      // next set's tPoint >= this (initialised on the first step)
    this._imp = new Map();    // impulse id → impulse record (for 'off')
  }

  // ------------------------------------------------------------------- schedule
  _gridAt(floorT) {
    const I = intervalSec(this.cfg);
    return Math.max(1, Math.ceil(floorT / I - 1e-9)) * I;
  }
  _planSet() {
    const cfg = this.cfg, T = this._gridAt(this._floorT), n = effectiveSetSize(cfg);
    for (let j = 0; j < n; j++) this._plan.push({ set: this._set, k: j, tPoint: T + j * cfg.setSpacing, travel: cfg.travel });
    this._set++;
    this._floorT = T + 1e-3;
  }
  /**
   * bars/bpm/travel changed: spawned fronts keep their timing; planned fronts are dropped and the grid restarts at
   * the first k·interval leaving travel + 0.5 s of travel (and a set spacing after the last spawned front).
   * Pre-charged fronts that have not spawned yet move to the first new slots (they keep their energy).
   */
  _reschedule(t) {
    this._plan.length = 0;
    let last = -Infinity;
    const waiting = [];
    let set = 0;
    for (const f of this.fronts) {
      if (f._s.spawned) { last = Math.max(last, f.tPoint); set = Math.max(set, f.set + 1); } else waiting.push(f);
    }
    if (this.fronts.length) this._set = set;
    this._floorT = Math.max(t + this.cfg.travel + 0.5, last + this.cfg.setSpacing);
    for (const f of waiting) {
      if (!this._plan.length) this._planSet();
      this._retime(f, this._plan.shift());
    }
  }
  _timing(p) {
    const sp = pathSpline(p.travel);
    const tLine = ZONES.map((z) => p.tPoint + pathTimeAt(sp, z.lineX));
    const tHeadX = pathTimeAt(sp, TUNING.headland.breakX);
    const lim = ZONES.map((z, zi) => ({
      tEnd: Math.max(0.5, pathTimeAt(sp, TUNING.peelEndX[z.key] ?? 0) - (tLine[zi] - p.tPoint)),
      tHead: Math.max(0, tHeadX - (tLine[zi] - p.tPoint)),
    }));
    return { sp, tLine, lim, tShore: p.tPoint + sp.ts[sp.ts.length - 1] };
  }
  _retime(f, p) {
    const { sp, tLine, tShore, lim } = this._timing(p);
    f._s.lim = lim;
    Object.assign(f, { set: p.set, k: p.k, tSpawn: p.tPoint - p.travel, tPoint: p.tPoint, travel: p.travel, tLine, tShore });
    f._s.sp = sp;
    f._s.tCommit0 = tLine[0] - this.cfg.commitLead;
    f._s.t0.fill(f.tSpawn);
  }

  _createFront(p, t) {
    const id = this._nextId++, { sp, tLine, tShore, lim } = this._timing(p);
    const f = {
      id, set: p.set, k: p.k, tSpawn: p.tPoint - p.travel, tPoint: p.tPoint,
      x: sp.xs[0], vx: 0, alpha: 0,
      cols: new Float32Array(NCOLS * 4), energy: new Float32Array(NCOLS), glow: new Float32Array(NCOLS),
      breaks: [], target: false,
      travel: p.travel, tLine, tShore, charge: 0,
    };
    Object.defineProperty(f, '_s', {
      enumerable: false, writable: true,
      value: {
        sp, lim, spawned: false, raw: new Float32Array(NCOLS * 4), tk: [null, null, null], tw: [null, null, null], tCommit0: tLine[0] - this.cfg.commitLead,
        committed: [false, false, false], prof: [null, null, null], bst: [null, null, null], zb: [null, null, null],
        broke: [false, false, false], live: [null, null, null], imps: [], init: false,
        zp: new Int8Array(NCOLS), rel: new Uint8Array(NCOLS).fill(1), t0: new Float64Array(NCOLS).fill(p.tPoint - p.travel),
        h0: new Float32Array(NCOLS), s0: new Float32Array(NCOLS), c0: new Float32Array(NCOLS), m0: new Float32Array(NCOLS),
        bt: new Float64Array(NCOLS).fill(NaN), ref: new Uint8Array(NCOLS),
        hb: new Float32Array(NCOLS), sb: new Float32Array(NCOLS), cb: new Float32Array(NCOLS), mb: new Float32Array(NCOLS),
      },
    });
    this.fronts.push(f);
    this.fronts.sort((a, b) => a.id - b.id);
    return f;
  }

  /** Earliest-arriving alive front whose outer commit is still in the future (no creation). */
  _findTarget(t) {
    let best = null;
    for (const f of this.fronts) {
      if (!f._s.committed[0] && f.tLine[0] - this.cfg.commitLead > t + STEP_TOL / 2 && (!best || f.tPoint < best.tPoint)) best = f;
    }
    return best;
  }
  _target(t) {
    const f = this._findTarget(t);
    if (f) return f;
    if (!this._plan.length) this._planSet();
    return this._createFront(this._plan.shift(), t);   // pre-charge: invisible at the horizon until tSpawn
  }

  _emit(t, type, frontId, zone) {
    const ev = { t, type, frontId };
    if (zone !== undefined) ev.zone = zone;
    this.events.push(ev);
  }

  // ------------------------------------------------------------------- step
  step(t, dt, events = []) {
    const cfg = this.cfg, tol = STEP_TOL / 2;
    this.t = t;
    if (this._floorT === null) this._floorT = t + cfg.travel + 0.5;

    // 1. config reactions
    for (const ev of events) {
      if (ev.type === 'cfg' && (ev.key === 'bars' || ev.key === 'bpm' || ev.key === 'travel')) this._reschedule(t);
    }

    // 2. plan + create fronts whose spawn time has come
    for (let guard = 0; guard < 64; guard++) {
      if (!this._plan.length) {
        const T = this._gridAt(this._floorT);
        if (T - cfg.travel > t + tol) break;
        this._planSet();
      }
      const p = this._plan[0];
      if (p.tPoint - p.travel > t + tol) break;
      this._createFront(this._plan.shift(), t);
    }

    // 3. kinematics, spawn events, decay
    const decay = Math.pow(2, -dt / cfg.energyHalfLife), gdec = Math.exp(-dt / TUNING.glow.tau);
    for (const f of this.fronts) {
      const s = f._s;
      if (!s.spawned && t >= f.tSpawn - tol) { s.spawned = true; this._emit(t, 'spawn', f.id); }
      if (s.spawned) {
        const pe = pathEval(s.sp, t - f.tPoint);
        f.x = pe.x; f.vx = pe.vx;
        f.alpha = clamp01((t - f.tSpawn) / TUNING.fade.in) * clamp01((f.tShore - t) / TUNING.fade.out);
      } else { f.x = s.sp.xs[0]; f.vx = 0; f.alpha = 0; }
      if (!s.committed[0]) for (let c = 0; c < NCOLS; c++) f.energy[c] *= decay;
      for (let c = 0; c < NCOLS; c++) f.glow[c] *= gdec;
    }

    // 4. input
    for (const ev of events) {
      if (ev.type === 'on') this._deposit(ev, t);
      else if (ev.type === 'off') { const imp = this._imp.get(ev.id); if (imp) imp.dur = ev.duration ?? t - imp.t; }
    }

    // 5. commits and breaks
    for (const f of this.fronts) {
      const s = f._s;
      for (let zi = 0; zi < ZONES.length; zi++) {
        if (!s.committed[zi] && t >= f.tLine[zi] - cfg.commitLead - tol) this._commit(f, zi, t);
        if (s.zb[zi] && !s.broke[zi] && t >= f.tLine[zi] - tol) { s.broke[zi] = true; this._emit(t, 'break', f.id, ZONES[zi].key); }
      }
    }

    // 6. columns
    for (const f of this.fronts) { this._updateCols(f, t, dt); this._publish(f, t); }

    // 7. deaths
    for (let i = this.fronts.length - 1; i >= 0; i--) {
      const f = this.fronts[i];
      if (t >= f.tShore - tol) {
        this.fronts.splice(i, 1);
        for (const imp of f._s.imps) this._imp.delete(imp.id);
        this._emit(t, 'die', f.id);
      }
    }

    // 8. bookkeeping
    const tgt = this._findTarget(t);
    this.targetId = tgt ? tgt.id : null;
    for (const f of this.fronts) f.target = f === tgt;
    let cut = 0;
    while (cut < this.impulses.length && this.impulses[cut].t < t - TUNING.impulseRing) cut++;
    if (cut) this.impulses.splice(0, cut);
    cut = 0;
    while (cut < this.events.length && (this.events[cut].t < t - TUNING.eventRing || this.events.length - cut > 512)) cut++;
    if (cut) this.events.splice(0, cut);
    this._updateSchedule(t);
  }

  _updateSchedule(t) {
    const cfg = this.cfg;
    let next = Infinity;
    for (const f of this.fronts) if (f.k === 0 && f.tPoint > t && f.tPoint < next) next = f.tPoint;
    for (const p of this._plan) if (p.k === 0 && p.tPoint > t && p.tPoint < next) next = p.tPoint;
    if (!Number.isFinite(next)) next = this._gridAt(this._floorT);
    const sc = this.schedule;
    sc.intervalSec = intervalSec(cfg); sc.nextPointT = next; sc.setSize = effectiveSetSize(cfg); sc.travel = cfg.travel;
  }

  // ------------------------------------------------------------------- energy
  _deposit(ev, t) {
    const cfg = this.cfg, f = this._target(t), s = f._s;
    const lanes = ev.lanes ?? 8, u = ev.u ?? laneToU(ev.lane ?? 0, lanes);
    const str = (ev.scale ?? 1) * (ev.velocity ?? 1);
    const sig = Math.max(0.5, (cfg.laneSigma * NCOLS) / lanes);
    const w = new Float64Array(NCOLS);
    let sum = 0, wmax = 0;
    for (let c = 0; c < NCOLS; c++) {
      const d = (colU(c) - u) * NCOLS / sig;
      w[c] = Math.exp(-0.5 * d * d); sum += w[c]; if (w[c] > wmax) wmax = w[c];
    }
    const frac = ZONES.map(() => 0);
    for (let c = 0; c < NCOLS; c++) {
      const wn = w[c] / sum;
      f.energy[c] += str * wn;
      f.glow[c] = Math.min(1, f.glow[c] + TUNING.glow.gain * str * w[c] / wmax);
      for (let zi = 0; zi < ZONES.length; zi++) if (c >= ZC[zi].c0 && c <= ZC[zi].c1) frac[zi] += wn;
    }
    const imp = { id: ev.id, t, u, s: str, frac, dur: ev.duration ?? null };
    s.imps.push(imp);
    this._imp.set(ev.id, imp);
    this.impulses.push({
      id: ev.id, t, u, lane: ev.lane, lanes, strength: str, frontId: f.id, precharge: !s.spawned,
      x: f.x, z: uToZ(u), jump: hash01(ev.id, cfg.seed) < TUNING.jump.base + TUNING.jump.perStrength * str,
    });
  }

  _params(f, zi, t) {
    const s = f._s;
    if (s.committed[zi]) return s.live[zi];
    const L = s.live[zi];
    if (L && L.t === t) return L;
    const st = zoneStats(f, zi, t, this.cfg.energyHalfLife);
    const p = mapZone(st, zi, s.lim[zi]);
    const prof = zoneProfile(f, zi, p, L ? L.prof : new Float32Array(NCOLS * 4));
    s.live[zi] = { t, st, p, prof };
    return s.live[zi];
  }

  _commit(f, zi, t) {
    const s = f._s, z = ZONES[zi];
    const L = this._params(f, zi, t);
    const { st, p } = L;
    s.prof[zi] = Float32Array.from(L.prof);
    s.committed[zi] = true;
    if (zi === 0) { let E = 0; for (let c = 0; c < NCOLS; c++) E += f.energy[c]; f.charge = E; }
    let bst = null;
    if (p.H >= z.Hbreak) {
      const zb = {
        zone: z.key, zi, tBreak: f.tLine[zi], uPeak: p.uPeak, u0: z.u0, u1: z.u1, dir: p.dir, vPeel: p.vPeel,
        Tb: p.Tb, peelLen: p.peelLen, backLen: p.backLen, closeout: p.closeout, sections: p.sections,
        H: p.H, steep: p.steep, curl: p.curl, mush: p.mush,
        quality: Object.freeze({ ...p.quality }),
        stats: Object.freeze({ E: st.E, count: st.count, strength: st.strength, spread: st.spread, centroid: st.centroid, erratic: st.erratic }),
      };
      Object.freeze(zb);
      f.breaks.push(zb);
      s.zb[zi] = zb;
      bst = new Float64Array(NCOLS);
      for (let c = 0; c < NCOLS; c++) bst[c] = breakStartTime(zb, colU(c));
      s.bst[zi] = bst;
      this._taper(f, zi, zb, bst, t);
      this._emit(t, 'commit', f.id, z.key);
    }
    // what breaks keeps `retain` of its energy, what passes through in range loses 10 %
    const { c0, c1 } = ZC[zi];
    for (let c = c0; c <= c1; c++) f.energy[c] *= bst && Number.isFinite(bst[c]) ? z.retain : TUNING.unbrokenLoss;
  }

  /** Edge taper of a committed break: k[c] = 0 at a finite/Infinity edge of breakStartTime → 1 at `band` m away. */
  _taper(f, zi, zb, bst, t) {
    const T = TUNING.taper, s = f._s, k = new Float32Array(NCOLS).fill(1), edges = [];
    let tEnd = zb.tBreak;
    for (let c = 0; c < NCOLS; c++) {
      if (Number.isFinite(bst[c])) tEnd = Math.max(tEnd, bst[c]);
      if (c < NCOLS - 1 && Number.isFinite(bst[c]) !== Number.isFinite(bst[c + 1])) edges.push((c + 1) / NCOLS);
    }
    for (let c = 0; c < NCOLS; c++) {
      let d = Infinity;
      for (const ue of edges) d = Math.min(d, Math.abs(colU(c) - ue) * FRONT_W);
      k[c] = smooth(clamp01(d / T.band));
    }
    tEnd += 2 * zb.Tb;
    s.tk[zi] = k;
    s.tw[zi] = [t, Math.max(t + DT, zb.tBreak), tEnd, tEnd + T.fadeOut];
  }

  /** Publish cols = raw lumps with the edge and headland tapers applied (both smooth in time). */
  _publish(f, t) {
    const s = f._s, raw = s.raw, cols = f.cols, C = TUNING.cols, Hd = TUNING.headland, T = TUNING.taper;
    const aw = [0, 0, 0];
    for (let zi = 0; zi < ZONES.length; zi++) {
      const w = s.tw[zi];
      if (!w) continue;
      aw[zi] = t <= w[0] ? 0 : t < w[1] ? smooth((t - w[0]) / (w[1] - w[0])) : t < w[2] ? 1 : t < w[3] ? 1 - smooth((t - w[2]) / (w[3] - w[2])) : 0;
    }
    const hx = smooth(clamp01((Hd.x0 - f.x) / (Hd.x0 - Hd.x1)));
    for (let c = 0; c < NCOLS; c++) {
      const i4 = c * 4;
      let H = raw[i4], st = raw[i4 + 1], cu = raw[i4 + 2];
      for (let zi = 0; zi < ZONES.length; zi++) {
        if (!aw[zi]) continue;
        const K = 1 - aw[zi] * (1 - s.tk[zi][c]);
        if (K >= 1) continue;
        const floor = T.floorFrac * ZONES[zi].Hscale * C.ambient;
        if (H > floor) H = floor + (H - floor) * K;
        st = C.steep0 + (st - C.steep0) * K;
        cu *= K;
      }
      const kh = 1 - HEAD[c] * hx;
      cols[i4] = H * kh; cols[i4 + 1] = st; cols[i4 + 2] = cu * kh; cols[i4 + 3] = raw[i4 + 3];
    }
  }

  // ------------------------------------------------------------------- columns
  _updateCols(f, t, dt) {
    const s = f._s, C = TUNING.cols, cols = s.raw, tol = STEP_TOL / 2;
    const a = s.init ? 1 - Math.exp(-dt / C.smoothTau) : 1;
    s.init = true;
    for (let c = 0; c < NCOLS; c++) {
      const i4 = c * 4;
      // local break phase (mirror of contracts.localTau on cached start times)
      let zi = -1, tStart = Infinity;
      for (const zb of f.breaks) {
        const ts = s.bst[zb.zi][c];
        if (ts <= t && (zi < 0 || ts > tStart)) { zi = zb.zi; tStart = ts; }
      }
      let tH, tS, tC, tM, breaking = false;
      if (zi >= 0) {
        if (s.bt[c] !== tStart) {      // a new break reached this column: hold its current shape
          s.bt[c] = tStart; s.ref[c] = 0;
          s.hb[c] = cols[i4]; s.sb[c] = cols[i4 + 1]; s.cb[c] = cols[i4 + 2]; s.mb[c] = cols[i4 + 3];
        }
        const tau = (t - tStart) / s.zb[zi].Tb;
        if (tau < 2) {
          breaking = true;
          const e = tau < 1 ? 0 : smooth(tau - 1), r = ZONES[zi].retain;
          tH = s.hb[c] * (1 - e * (1 - r));
          tS = lerp(s.sb[c], C.steep0, e); tC = lerp(s.cb[c], 0, e); tM = lerp(s.mb[c], C.mushReform, e);
        } else if (!s.ref[c]) {        // re-formed: carry on from here toward the next zone
          s.ref[c] = 1; this._anchor(s, c, t, cols);
          if (s.zp[c] < zi + 1) s.zp[c] = zi + 1;
        }
      }
      if (!breaking) {
        // advance past zone lines this column will not break at
        while (s.zp[c] < ZONES.length) {
          const z = s.zp[c];
          const b = s.bst[z];
          if (s.committed[z] && b && Number.isFinite(b[c]) && b[c] > t) break;        // pending break here: hold toward it
          if (t >= f.tLine[z] - tol || (b && b[c] <= t)) { this._anchor(s, c, t, cols); s.zp[c]++; continue; }
          break;
        }
        const z = s.zp[c];
        let PH, PS, PC, PM, tT;
        if (z >= ZONES.length) { PH = 0; PS = C.steep0; PC = 0; PM = C.mushReform; tT = f.tShore; }
        else {
          const prof = s.committed[z] ? s.prof[z] : this._params(f, z, t).prof;
          PH = prof[i4]; PS = prof[i4 + 1]; PC = prof[i4 + 2]; PM = prof[i4 + 3];
          const b = s.bst[z];
          tT = b && Number.isFinite(b[c]) && b[c] > t ? b[c] : f.tLine[z];
        }
        const t0 = s.t0[c];
        const sv = smooth(tT > t0 + 1e-9 ? clamp01((t - t0) / (tT - t0)) : 1);
        if (s.rel[c]) {
          tH = PH * lerp(C.shoal0, 1, sv); tS = lerp(C.steep0, PS, sv); tC = PC * sv; tM = lerp(C.mush0, PM, sv);
        } else {
          tH = lerp(s.h0[c], PH, sv); tS = lerp(s.s0[c], PS, sv); tC = lerp(s.c0[c], PC, sv); tM = lerp(s.m0[c], PM, sv);
        }
      }
      cols[i4] += (tH - cols[i4]) * a;
      cols[i4 + 1] += (tS - cols[i4 + 1]) * a;
      cols[i4 + 2] += (tC - cols[i4 + 2]) * a;
      cols[i4 + 3] += (tM - cols[i4 + 3]) * a;
    }
  }

  _anchor(s, c, t, cols) {
    const i4 = c * 4;
    s.rel[c] = 0; s.t0[c] = t;
    s.h0[c] = cols[i4]; s.s0[c] = cols[i4 + 1]; s.c0[c] = cols[i4 + 2]; s.m0[c] = cols[i4 + 3];
  }
}
