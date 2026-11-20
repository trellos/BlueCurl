// BlueCurl Swell — input feedback FX (WP5): impact flash + rings + crest streak, analytic sparkle bursts, front
// shimmer ribbons, horizon pre-charge band, decorative dolphin jumps. Reads app.swell.impulses / fronts.
//
// Visual state is a pure function of (swell state, t): every effect is evaluated from the impulse's age
// (t − imp.t) and seeded by its id. The only cache is per-impulse constants (keyed by id, pruned with the ring).
// Effects ride with the front they hit (anchor x = the front's current crest x), so they stay on the swell.
import * as THREE from 'three';
import { NCOLS, uToZ, DEFAULT_CFG } from '../contracts.js';
import { surfaceHeight, lip } from '../wave/field.js';
import {
  FX_LIFE, WHITE, impactLook, strengthStyle, emitterCount, KIND_BURST, KIND_SPLASH, jumpParams, dolphinPose,
  jumpSplashes, shimmerLevel, clamp01, lerp,
} from './fxMath.js';
import { Sprites, SHAPE_GLOW, SHAPE_FLARE, SHAPE_RING, SHAPE_STREAK, MODE_BILLBOARD, MODE_AXIS, MODE_FLAT } from './Sprites.js';
import { Particles } from './Particles.js';
import { Shimmer, RIB_PTS } from './Shimmer.js';
import { Dolphins } from './Dolphins.js';

const SURF_EXACT_MAX = 3;          // impacts per frame that use the exact surfaceHeight (the rest: crest via lip())
const SURF_EXACT_AGE = 0.5;        // s
const RIBBON_FADE = 2.0;           // s after a front stops being the input target

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
    this._size = new THREE.Vector2();
    this.stats = { impulses: 0, emitters: 0, sprites: 0, ribbons: 0, dolphins: 0 };
  }

  step(t, dt) {}
  reset() { this._cache.clear(); }

  _const(imp) {
    let c = this._cache.get(imp.id);
    if (!c) {
      const seed = this.app.cfg?.seed ?? DEFAULT_CFG.seed;
      c = { st: strengthStyle(imp.strength), jp: imp.jump ? jumpParams(imp.id, seed) : null };
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
    const pulse = new Map();          // frontId → summed recent-impulse pulse
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
      pulse.set(imp.frontId, (pulse.get(imp.frontId) || 0) + st.size * Math.exp(-age / 0.35));
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

    // ---------------------------------------------------------------- front shimmer + horizon pre-charge band
    const commitLead = this.app.cfg?.commitLead ?? DEFAULT_CFG.commitLead;
    for (const f of fronts) this._ribbon(f, t, pulse.get(f.id) || 0, commitLead);

    const pxm = this._pxm();
    S.end(pxm); P.end(t, pxm); R.end(t, pxm); D.end();
    this.stats = { impulses: nImp, emitters: P.n, sprites: S.n, ribbons: R.n, dolphins: D.n };
  }

  _impact(imp, c, age, ax, ay, az, f) {
    const S = this.sprites, P = this.particles;
    const L = impactLook(imp.strength, age, imp.lanes);
    const st = c.st, col = st.color, acc = st.accent;
    const pre = !!imp.precharge && (!f || f.alpha <= 0);
    const yc = ay + 1.5;                                   // flash centre slightly above the crest
    const bias = 0.6 * L.glowR;                            // depth bias: keep the halo from sinking into the water
    const hot = [lerp(WHITE[0], col[0], 0.6), lerp(WHITE[1], col[1], 0.6), lerp(WHITE[2], col[2], 0.6)];
    // core flash (hot, above bloom threshold) + lingering coloured glow
    if (L.coreI > 0.02) S.add(ax, yc, az, 0, 0, 0, MODE_BILLBOARD, L.coreR, 11, bias, SHAPE_GLOW, hot[0] * L.coreI, hot[1] * L.coreI, hot[2] * L.coreI);
    S.add(ax, yc, az, 0, 0, 0, MODE_BILLBOARD, L.glowR, 26, bias, SHAPE_GLOW, col[0] * L.glowI, col[1] * L.glowI, col[2] * L.glowI);
    if (L.flareI > 0.02) S.add(ax, yc, az, 0, 0, 0, MODE_BILLBOARD, L.flareL, 44, bias, SHAPE_FLARE, hot[0] * L.flareI, hot[1] * L.flareI, hot[2] * L.flareI);
    // glow streak along the crest (± a lane), wider + longer at the horizon for pre-charge
    const sl = L.streakL * (pre ? 1.5 : 1), sw = L.streakW * (pre ? 1.6 : 1);
    S.add(ax, ay + 0.8, az, 0, 0, sl, MODE_AXIS, sw, pre ? 5 : 3, bias, SHAPE_STREAK, col[0] * L.streakI, col[1] * L.streakI, col[2] * L.streakI);
    // vertical light geyser
    if (L.geyserI > 0.02) S.add(ax, ay + L.geyserH * 0.5, az, 0, L.geyserH * 0.5, 0, MODE_AXIS, L.geyserW, 3, bias,
      SHAPE_STREAK, hot[0] * L.geyserI, hot[1] * L.geyserI, hot[2] * L.geyserI);
    // expanding rings on the water (flat): coloured + accent ring
    const RQ = 1.15;                                         // quad half-size relative to the ring radius
    if (L.ringI > 0.02) S.add(ax, ay + 0.35, az, L.ringR * RQ, 0, 0, MODE_FLAT, 0, 0, 1.5, SHAPE_RING,
      col[0] * L.ringI, col[1] * L.ringI, col[2] * L.ringI, 1 / RQ);
    if (L.ring2I > 0.02) S.add(ax, ay + 0.3, az, L.ring2R * RQ, 0, 0, MODE_FLAT, 0, 0, 1.5, SHAPE_RING,
      acc[0] * L.ring2I, acc[1] * L.ring2I, acc[2] * L.ring2I, 1 / RQ);
    // sparkle burst (rides with the front: origin = current anchor)
    P.add(ax, ay + 0.5, az, imp.t, st.size, imp.id * 4, KIND_BURST, emitterCount(KIND_BURST, st.size), col, 0.25 + 0.5 * st.warm);
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

  _ribbon(f, t, pulse, commitLead) {
    let E = 0, gmax = 0, emax = 0;
    for (let c = 0; c < NCOLS; c++) { E += f.energy[c]; if (f.glow[c] > gmax) gmax = f.glow[c]; if (f.energy[c] > emax) emax = f.energy[c]; }
    const tC = f.tLine ? f.tLine[0] - commitLead : Infinity;
    const after = clamp01(1 - (t - tC) / RIBBON_FADE);
    const targetW = f.target ? 1 : (E > 0.02 ? after : 0);
    if (targetW < 0.01 && gmax < 0.01 && pulse < 0.01) return;
    const r = this.shimmer.ribbon();
    if (r === null) return;
    const unspawned = !(f.alpha > 0) && t < (f.tSpawn ?? -Infinity);
    const lv = shimmerLevel(E, pulse, targetW);
    const fade = unspawned ? 1 : Math.max(0.0, Math.min(1, f.alpha + 0.6));  // keep the band continuous at spawn
    const hw0 = (unspawned ? 4.5 : 2.6) * lv.width, minPx = unspawned ? 7 : 4;
    const xs = new Float64Array(RIB_PTS), ys = new Float64Array(RIB_PTS);
    for (let i = 0; i < RIB_PTS; i++) {
      const u = i / (RIB_PTS - 1);
      let x = f.x, y = 0;
      try { const p = lip(f, u, t); if (Number.isFinite(p.x)) x = p.x; if (Number.isFinite(p.y)) y = p.y; } catch {}
      xs[i] = x; ys[i] = y;
    }
    for (let i = 0; i < RIB_PTS; i++) {
      const u = i / (RIB_PTS - 1), z = uToZ(u);
      const c = Math.min(NCOLS - 1, Math.floor(u * NCOLS));
      const g = f.glow[c], rel = emax > 1e-6 ? f.energy[c] / emax : 0;
      const ends = Math.min(1, u * 14, (1 - u) * 14);                   // taper the ends
      const prof = (0.55 + 0.45 * rel) * ends * fade;
      const core = lv.core * prof + (5 * g * g + 2 * g) * ends;
      const halo = lv.halo * prof + 1.2 * g * ends;
      const i0 = Math.max(0, i - 1), i1 = Math.min(RIB_PTS - 1, i + 1);
      const tx = xs[i1] - xs[i0], tz = uToZ((i1) / (RIB_PTS - 1)) - uToZ(i0 / (RIB_PTS - 1));
      this.shimmer.set(r, i, xs[i], ys[i] + 0.6, z, tx, tz, core, halo, clamp01(0.15 + g * 1.2 + 0.3 * lv.eN), hw0 * (1 + 1.5 * g), minPx);
    }
  }

  dispose() {
    this.app.scene?.remove(this.group);
    this.sprites.dispose(); this.particles.dispose(); this.shimmer.dispose(); this.dolphins.dispose();
  }
}
