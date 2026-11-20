// BlueCurl Swell — input feedback FX (WP5): lane-coloured impact flash + rings + crest streak, analytic sparkles, light
// on the water along every charged front (+ horizon pre-charge band), decorative dolphin jumps. Reads app.swell.
//
// Visual state is a pure function of (swell state, t): every effect is evaluated from the impulse's age
// (t − imp.t) and seeded by its id. The only cache is per-impulse constants (keyed by id, pruned with the ring).
// Effects ride with the front they hit (anchor x = the front's current crest x), so they stay on the swell.
import * as THREE from 'three';
import { NCOLS, uToZ, localTau, DEFAULT_CFG } from '../contracts.js';
import { surfaceHeight, lip } from '../wave/field.js';
import { depthAt } from '../spot/bathymetry.js';
import {
  FX_LIFE, WHITE, impactLook, strengthStyle, emitterCount, KIND_BURST, KIND_SPLASH, jumpParams, dolphinPose,
  jumpSplashes, laneColor, lineLevel, hitPulse, breakFade, depthFade, insideFade, SHIMMER, WATER_WHITE, clamp01, lerp,
} from './fxMath.js';
import { Sprites, SHAPE_GLOW, SHAPE_RING, SHAPE_STREAK, MODE_BILLBOARD, MODE_AXIS, MODE_FLAT } from './Sprites.js';
import { Particles } from './Particles.js';
import { Shimmer, RIB_PTS } from './Shimmer.js';
import { Dolphins } from './Dolphins.js';

const SURF_EXACT_MAX = 3;          // impacts per frame that use the exact surfaceHeight (the rest: crest via lip())
const SURF_EXACT_AGE = 0.5;        // s
const SHORE_FADE = 3.0;            // s before the front dies at the shore

/** Crest height of front f at crest coordinate u (lip landmark; cheap). Falls back to 0 if the mirror throws. */
function crestY(f, u, t) {
  try { const p = lip(f, u, t); return Number.isFinite(p.y) ? p.y : 0; } catch { return 0; }
}

export class Fx {
  constructor(app) {
    this.app = app;
    this.group = new THREE.Group();
    this.group.name = 'fx';
    this.sprites = new Sprites();
    this.particles = new Particles();
    this.shimmer = new Shimmer();
    this.dolphins = new Dolphins(6);
    this.group.add(this.shimmer.mesh, this.sprites.mesh, this.particles.mesh, this.dolphins.group);
    app.scene?.add(this.group);
    this._cache = new Map();          // impulse id → per-impulse constants
    this._byId = new Map();
    this._fcol = new Map();           // front id → lane-colour accumulation per column (incremental by impulse count)
    this._tmp = { core: new Float32Array(RIB_PTS), halo: new Float32Array(RIB_PTS), hw: new Float32Array(RIB_PTS),
      px: new Float32Array(RIB_PTS), x: new Float64Array(RIB_PTS), y: new Float64Array(RIB_PTS), c: new Float32Array(RIB_PTS * 3) };
    this._size = new THREE.Vector2();
    this.stats = { impulses: 0, emitters: 0, sprites: 0, ribbons: 0, dolphins: 0 };
  }

  step(t, dt) {}
  reset() { this._cache.clear(); this._fcol.clear(); }

  _const(imp) {
    let c = this._cache.get(imp.id);
    if (!c) {
      const seed = this.app.cfg?.seed ?? DEFAULT_CFG.seed;
      c = { st: strengthStyle(imp.strength), col: laneColor(imp.u), jp: imp.jump ? jumpParams(imp.id, seed) : null };
      c.splashes = c.jp ? jumpSplashes(c.jp) : null;
      this._cache.set(imp.id, c);
    }
    return c;
  }

  /** Metres per pixel at 1 m view depth for the main camera / drawing buffer. */
  _pxm() {
    const cam = this.app.camera, r = this.app.renderer;
    const h = r ? r.getDrawingBufferSize(this._size).y : 720;
    const p11 = cam?.projectionMatrix?.elements?.[5] || 2.1;
    return 2 / (p11 * Math.max(1, h));
  }

  update(t) {
    const sw = this.app.swell;
    if (!sw) return;
    const fronts = sw.fronts || [], imps = sw.impulses || [];
    const S = this.sprites, P = this.particles, R = this.shimmer, D = this.dolphins;
    S.begin(); P.begin(); R.begin(); D.begin();
    this._byId.clear();
    for (const f of fronts) this._byId.set(f.id, f);

    // ---------------------------------------------------------------- impacts (newest first: they win the slots)
    const hits = new Map();           // frontId → [{ z, age, gain }] recent hits (travelling pulses on the line)
    let exact = 0, nImp = 0;
    const live = new Set();
    for (let i = imps.length - 1; i >= 0; i--) {
      const imp = imps[i];
      const age = t - imp.t;
      live.add(imp.id);
      if (age < -1e-6 || age > FX_LIFE) continue;
      nImp++;
      const c = this._const(imp), st = c.st;
      const f = this._byId.get(imp.frontId);
      if (age < SHIMMER.pulseLife) {
        let h = hits.get(imp.frontId);
        if (!h) hits.set(imp.frontId, (h = []));
        h.push({ z: imp.z, age, gain: st.gain });
      }
      const ax = f ? f.x : imp.x, az = imp.z;
      let ay;
      if (exact < SURF_EXACT_MAX && age < SURF_EXACT_AGE) {
        exact++;
        try { ay = surfaceHeight(fronts, ax, az, t); } catch { ay = NaN; }
        if (!Number.isFinite(ay)) ay = f ? crestY(f, imp.u, t) : 0;
      } else ay = f ? crestY(f, imp.u, t) : 0;
      this._impact(imp, c, age, ax, ay, az, f);
    }
    for (const id of this._cache.keys()) if (!live.has(id)) this._cache.delete(id);

    // ---------------------------------------------------------------- front shimmer lines + horizon pre-charge band
    const alive = new Set();
    for (const f of fronts) { alive.add(f.id); this._ribbon(f, t, hits.get(f.id), imps); }
    for (const id of this._fcol.keys()) if (!alive.has(id)) this._fcol.delete(id);

    const pxm = this._pxm();
    S.end(pxm); P.end(t, pxm); R.end(t, pxm); D.end();
    this.stats = { impulses: nImp, emitters: P.n, sprites: S.n, ribbons: R.n, dolphins: D.n };
  }

  _impact(imp, c, age, ax, ay, az, f) {
    const S = this.sprites, P = this.particles;
    const L = impactLook(imp.strength, age, imp.lanes);
    const st = c.st, col = c.col;
    const pre = !!imp.precharge && (!f || f.alpha <= 0);
    const yc = ay + 1.5;                                   // flash centre slightly above the crest
    const bias = 0.6 * L.glowR;                            // depth bias: keep the halo from sinking into the water
    const hot = [lerp(col[0], WHITE[0], 0.3), lerp(col[1], WHITE[1], 0.3), lerp(col[2], WHITE[2], 0.3)];
    // core flash (lane colour, lightly whitened, ≤ ~5 HDR) + lingering coloured glow
    if (L.coreI > 0.02) S.add(ax, yc, az, 0, 0, 0, MODE_BILLBOARD, L.coreR, 9 + 9 * st.size, bias, SHAPE_GLOW, hot[0] * L.coreI, hot[1] * L.coreI, hot[2] * L.coreI);
    S.add(ax, yc, az, 0, 0, 0, MODE_BILLBOARD, L.glowR, 20 + 20 * st.size, bias, SHAPE_GLOW, col[0] * L.glowI, col[1] * L.glowI, col[2] * L.glowI);
    // glow streak along the crest (± a lane), wider + longer at the horizon for pre-charge
    const sl = L.streakL * (pre ? 1.5 : 1), sw = L.streakW * (pre ? 1.6 : 1);
    S.add(ax, ay + 0.8, az, 0, 0, sl, MODE_AXIS, sw, pre ? 6 : 4.5, bias, SHAPE_STREAK, hot[0] * L.streakI, hot[1] * L.streakI, hot[2] * L.streakI);
    // expanding rings on the water (flat)
    const RQ = 1.15;                                         // quad half-size relative to the ring radius
    if (L.ringI > 0.02) S.add(ax, ay + 0.35, az, L.ringR * RQ, 0, 0, MODE_FLAT, 0, 0, 1.5, SHAPE_RING,
      col[0] * L.ringI, col[1] * L.ringI, col[2] * L.ringI, 1 / RQ);
    if (L.ring2I > 0.02) S.add(ax, ay + 0.3, az, L.ring2R * RQ, 0, 0, MODE_FLAT, 0, 0, 1.5, SHAPE_RING,
      hot[0] * L.ring2I, hot[1] * L.ring2I, hot[2] * L.ring2I, 1 / RQ);
    // sparkle burst in the lane colour (rides with the front: origin = current anchor)
    P.add(ax, ay + 0.5, az, imp.t, st.size, imp.id * 4, KIND_BURST, emitterCount(KIND_BURST, st.size), col, 0.7);
    // dolphin jump + splashes
    if (c.jp) {
      const p = dolphinPose(c.jp, age);
      if (p.visible) this.dolphins.add(ax + p.x, ay + p.y, az + p.z, p.yaw, p.pitch, 0.25 * Math.sin(3 * p.s));
      c.splashes.forEach((sp, j) => {
        const ta = age - sp.t;
        if (ta >= 0 && ta < 1.3) {
          P.add(ax + sp.x, ay + 0.2, az + sp.z, imp.t + sp.t, 1, imp.id * 4 + 1 + j, KIND_SPLASH, emitterCount(KIND_SPLASH, 1), WHITE, 1);
          const e = Math.exp(-ta / 0.35);
          S.add(ax + sp.x, ay + 0.25, az + sp.z, 4 + 6 * (1 - Math.exp(-ta / 0.25)), 0, 0, MODE_FLAT, 0, 0, 1, SHAPE_RING, 1.6 * e, 2.0 * e, 2.2 * e, 0.85);
        }
      });
    }
  }

  /**
   * Per-column line colour of a front: strength-weighted mix of the lane colours of every impulse it received
   * (gaussian over columns like the energy deposit). Uses the front's own impulse record when available (WP3
   * internal front._s.imps: the whole life of the front), else the ImpulseFx ring. Incremental by count.
   */
  _frontColors(f, imps) {
    const own = f._s && Array.isArray(f._s.imps) ? f._s.imps : null;
    let list = own;
    if (!list) { list = []; for (const i of imps) if (i.frontId === f.id) list.push({ u: i.u, s: i.strength }); }
    let e = this._fcol.get(f.id);
    if (!e || e.n > list.length || !own) e = { n: 0, w: new Float32Array(NCOLS * 3), sw: new Float32Array(NCOLS) };
    const sig = ((this.app.cfg?.laneSigma ?? DEFAULT_CFG.laneSigma) * NCOLS) / 8, c3 = [0, 0, 0];
    for (let k = e.n; k < list.length; k++) {
      const im = list[k], s = im.s ?? 1;
      laneColor(im.u, c3);
      const cu = im.u * NCOLS - 0.5, c0 = Math.max(0, Math.floor(cu - 3 * sig)), c1 = Math.min(NCOLS - 1, Math.ceil(cu + 3 * sig));
      for (let c = c0; c <= c1; c++) {
        const d = (c - cu) / sig, w = s * Math.exp(-0.5 * d * d);
        e.sw[c] += w; e.w[c * 3] += w * c3[0]; e.w[c * 3 + 1] += w * c3[1]; e.w[c * 3 + 2] += w * c3[2];
      }
    }
    e.n = list.length;
    this._fcol.set(f.id, e);
    return e;
  }

  /**
   * Shimmer of a front: light on the water along its crest on every front with energy, from the horizon
   * (pre-charge band while unspawned) until each column breaks. Glow + glint density from the column energy, a
   * subtle tint from the lanes that fed it, hit pulses travelling along the crest. Fades per column as it breaks
   * (localTau), over shallow water / land (depthAt < 0.5 m), inside the point (x < ~90) and before the shore.
   */
  _ribbon(f, t, hits, imps) {
    let emax = 0;
    for (let c = 0; c < NCOLS; c++) if (f.energy[c] > emax) emax = f.energy[c];
    if (emax <= SHIMMER.minE && !hits) return;
    const unspawned = !(f.alpha > 0) && t < (f.tSpawn ?? -Infinity);
    const base = (f.tShore ? clamp01((f.tShore - t) / SHORE_FADE) : 1) * insideFade(f.x);
    if (base <= 0) return;
    const fc = this._frontColors(f, imps);
    const T = this._tmp;
    let any = 0;
    for (let i = 0; i < RIB_PTS; i++) {
      const u = i / (RIB_PTS - 1), z = uToZ(u);
      const cu = Math.min(NCOLS - 1, Math.max(0, u * NCOLS - 0.5)), c0 = Math.min(NCOLS - 2, Math.floor(cu)), w = cu - c0;
      const e = f.energy[c0] * (1 - w) + f.energy[c0 + 1] * w;
      let fade = base * Math.min(1, u * 25, (1 - u) * 25);
      if (fade > 0 && f.breaks && f.breaks.length) { const lt = localTau(f, u, t); fade *= breakFade(lt.tau, lt.zi); }
      const lvl = lineLevel(e);
      let P = 0;
      if (hits) for (const h of hits) P += hitPulse(z - h.z, h.age, h.gain);
      if (!(lvl > 0)) P *= 0.4;
      T.core[i] = 1.2 * lvl + 1.4 * P;                                 // glow (soft brightening)
      T.halo[i] = 6.0 * Math.sqrt(lvl) + 5.0 * P;                       // glints
      T.hw[i] = 3 + 5 * lvl + 4 * Math.min(1, P) + (unspawned ? 3 : 0);
      T.px[i] = fade;
      const sw = fc.sw[c0] * (1 - w) + fc.sw[c0 + 1] * w;
      const lc = sw > 1e-6 ? null : laneColor(u);
      for (let j = 0; j < 3; j++) {
        const cj = lc ? lc[j] : (fc.w[c0 * 3 + j] * (1 - w) + fc.w[(c0 + 1) * 3 + j] * w) / sw;
        T.c[i * 3 + j] = lerp(WATER_WHITE[j], cj, 0.4);
      }
      if (fade * (T.core[i] + T.halo[i]) > any) any = fade * (T.core[i] + T.halo[i]);
    }
    if (any < 0.01) return;
    const r = this.shimmer.ribbon();
    if (r === null) return;
    for (let i = 0; i < RIB_PTS; i++) {
      const u = i / (RIB_PTS - 1), z = uToZ(u);
      let x = f.x, y = 0;
      if (T.px[i] * (T.core[i] + T.halo[i]) > 0) {
        try { const p = lip(f, u, t); if (Number.isFinite(p.x)) x = p.x; if (Number.isFinite(p.y)) y = p.y; } catch {}
        let d = 10;
        try { d = depthAt(x, z); } catch {}
        if (Number.isFinite(d)) T.px[i] *= depthFade(d);
      } else if (i > 0) { x = T.x[i - 1]; y = T.y[i - 1]; }
      T.x[i] = x; T.y[i] = y;
      this.shimmer.set(r, i, x, y + 0.3, 0.35 * y + 0.2, z, T.core[i], T.halo[i], T.c[i * 3], T.c[i * 3 + 1], T.c[i * 3 + 2],
        T.px[i], T.hw[i], unspawned ? 0.16 : 0.12);
    }
  }

  dispose() {
    this.app.scene?.remove(this.group);
    this.sprites.dispose(); this.particles.dispose(); this.shimmer.dispose(); this.dolphins.dispose();
  }
}
