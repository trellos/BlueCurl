// BlueCurl Swell — input feedback FX (WP5): lane-coloured impact flash + rings + crest streak, analytic sparkles, light
// on the water along every charged front (+ horizon pre-charge band), decorative dolphin jumps. Reads app.swell.
// WP13: a massive splash + escaping bird per note, bird flocks from riders' 'flock' events (Splash.js, Birds.js, birdMath.js).
// WP15: a bird flock spelling the key on every guitar key change (keyFlockMath.js, keyGlyphs.js; main view only) and a
// reef fish under the water in the shallows on every beat level change (fishMath.js, Fish.js).
//
// Visual state is a pure function of (swell state, t): every effect is evaluated from the impulse's age
// (t − imp.t) and seeded by its id. The only cache is per-impulse constants (keyed by id, pruned with the ring).
// Effects ride with the front they hit (anchor x = the front's current crest x), so they stay on the swell.
import * as THREE from 'three';
import { NCOLS, uToZ, localTau, DEFAULT_CFG, ambientHeight } from '../contracts.js';
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
import { Splash } from './Splash.js';
import { Birds } from './Birds.js';
import { BirthLog } from './birdMath.js';
import { SPLASH } from './splashMath.js';
import { KeyFlockLog, keyBirdPose, KEY_FLOCK } from './keyFlockMath.js';
import { FishLog, fishPose } from './fishMath.js';
import { Fish } from './Fish.js';
import { widePose } from '../camera/wide.js';

const smoothstep01 = (x) => { const s = Math.min(1, Math.max(0, x)); return s * s * (3 - 2 * s); };
const lum3 = (v) => (v ? 0.2126 * (v.x ?? v[0]) + 0.7152 * (v.y ?? v[1]) + 0.0722 * (v.z ?? v[2]) : 0);

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
    this.splash = new Splash();       // WP13: massive note splash
    this.birds = new Birds();         // WP13: note birds + flocks
    this.births = new BirthLog();     // sim-derived splash/bird births (recorded in step)
    // WP15: key-letter flock (camera-space poses, drawn in the main view only) + beat fish
    this.keyBirds = new Birds({ max: 160, minPx: KEY_FLOCK.minPx, camSpace: true, shade: KEY_FLOCK.shade });
    this.keyBirds.mesh.name = 'keyFlock';
    this.keyBirds.mesh.onBeforeRender = (r, s, cam) => { this.keyBirds.geometry.instanceCount = cam === this.app.camera ? this.keyBirds.n : 0; };
    this.keyFlock = new KeyFlockLog(app.cfg?.guitar?.key ?? null);
    this.fishLog = new FishLog();
    this.fish = new Fish(app.waterUniforms || null);
    const wu = app.waterUniforms;
    // dawn reference (the initial uniforms = day phase cfg.day.startPhase; fx looks were tuned there)
    this._lightRef = { sun: wu?.uSunColor ? wu.uSunColor.value.clone() : null, sky: wu?.uSkyAmb ? lum3(wu.uSkyAmb.value) : 0,
      skyV: wu?.uSkyAmb ? wu.uSkyAmb.value.clone() : null };
    this._kp = {}; this._fp = {}; this._wp = {}; this._bed = { x: 0, y: 0, z: 0 };
    this.group.add(this.shimmer.mesh, this.splash.mesh, this.sprites.mesh, this.particles.mesh, this.dolphins.group,
      this.birds.mesh, this.birds.trail, this.keyBirds.mesh, this.fish.group);
    app.scene?.add(this.group);
    this._cache = new Map();          // impulse id → per-impulse constants
    this._byId = new Map();
    this._fcol = new Map();           // front id → lane-colour accumulation per column (incremental by impulse count)
    this._tmp = { core: new Float32Array(RIB_PTS), halo: new Float32Array(RIB_PTS), hw: new Float32Array(RIB_PTS),
      px: new Float32Array(RIB_PTS), th: new Float32Array(RIB_PTS), dn: new Float32Array(RIB_PTS), x: new Float64Array(RIB_PTS), y: new Float64Array(RIB_PTS), c: new Float32Array(RIB_PTS * 3) };
    this._size = new THREE.Vector2();
    this.stats = { impulses: 0, emitters: 0, sprites: 0, ribbons: 0, dolphins: 0, splashes: 0, birds: 0, keyBirds: 0, fish: 0 };
  }

  /**
   * Per sim step: record new impulses / riders 'flock' events as splash + bird births, guitar key changes (cfg events
   * are applied before the step) and beat level changes (beat.step runs before fx.step) — sim-derived, replayable.
   */
  step(t, dt) {
    this.births.step(t, this.app.swell, this.app.riders, this.app.cfg, this.app.sunDir);
    this.keyFlock.step(t, this.app.cfg);
    this.fishLog.step(t, this.app.beat, this.app.cfg);
  }
  reset() {
    this._cache.clear(); this._fcol.clear(); this.births.reset();
    this.keyFlock.reset(this.app.cfg?.guitar?.key ?? null);   // app.cfg is already restored to t = 0 here
    this.fishLog.reset();
  }

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

  /**
   * Main-view fov (deg) / aspect AT TIME t. The camera rig poses app.camera only after the visuals update, so
   * reading app.camera here would give the previous frame's fov (push-in zoom) — a history dependence (a resumed
   * capture's first frame differed). Evaluate the rig's pose for t instead (pure: rig state + t).
   */
  _view(t) {
    const cam = this.app.camera, rig = this.app.cameraRig, r = this.app.renderer;
    let fov = cam?.fov || 72;
    try { if (rig?.widePreset) fov = widePose(t, rig.widePreset(), rig.drift ?? 1, this._wp).fov || fov; } catch {}
    let w = 1280, h = 720;
    if (r) { const b = r.getDrawingBufferSize(this._size); w = b.x; h = b.y; }
    return { fov, aspect: Math.max(1e-3, w / Math.max(1, h)), h, tanY: Math.tan((fov * Math.PI) / 360) };
  }

  /** Metres per pixel at 1 m view depth for the main view at t / drawing buffer. */
  _pxm(v) { return (2 * v.tanY) / Math.max(1, v.h); }

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

    const view = this._view(t), pxm = this._pxm(view);
    this._light();
    this._splashesAndBirds(t, pxm);
    this._keyFlock(t, pxm, view);
    this._fish(t);
    S.end(pxm); P.end(t, pxm); R.end(t, pxm); D.end();
    this.stats = { impulses: nImp, emitters: P.n, sprites: S.n, ribbons: R.n, dolphins: D.n, splashes: this.splash.n, birds: this.birds.n,
      keyBirds: this.keyBirds.n, fish: this.fish.n };
  }

  /**
   * Day cycle (WP14): every fx look was tuned at dawn (exposure 1). Emissive fx (shimmer, sprites, sparkles, note
   * flashes) scale by gain = 1 / post exposure, so they keep their on-screen brightness from dawn to dusk (no hard
   * glow at twilight); lit fx (splash white water, birds) follow the shared sun / sky uniforms (intensity and colour,
   * relative to their t = 0 dawn values), like the sea's own foam. Pure function of the uniforms app.updateSun set for this frame.
   */
  _light() {
    const app = this.app, wu = app.waterUniforms, ref = this._lightRef;
    const exp = app.dayGrade?.exposure;
    const gain = Number.isFinite(exp) && exp > 0 ? Math.min(2.2, Math.max(0.4, 1 / exp)) : 1;
    let sunTint = [1, 1, 1], skyTint = [1, 1, 1], k = 1, sky = 1;
    const hue = (c, r) => { const lc = lum3(c), lr = lum3(r); if (!(lc > 1e-6) || !(lr > 1e-6)) return [1, 1, 1];
      return [c.x / lc / (r.x / lr || 1), c.y / lc / (r.y / lr || 1), c.z / lc / (r.z / lr || 1)].map((v) => Math.min(2.2, Math.max(0.3, v))); };
    if (wu?.uSunColor && ref.sun) {
      const c = wu.uSunColor.value;
      k = Math.min(3, lum3(c) / (lum3(ref.sun) || 1));
      sunTint = hue(c, ref.sun);
    }
    if (wu?.uSkyAmb && ref.skyV) { sky = ref.sky > 0 ? Math.min(4, lum3(wu.uSkyAmb.value) / ref.sky) : 1; skyTint = hue(wu.uSkyAmb.value, ref.skyV); }
    const sy = app.sunDir?.y ?? 0.1, sunUp = smoothstep01((sy + 0.02) / 0.08);
    this.birds.setLight(k, sky, sunTint);
    this.keyBirds.setLight(k, sky, sunTint);
    this.splash.setLight(gain, k, sky, sunTint, skyTint, sunUp);
    this.sprites.uniforms.uGain.value = gain;
    this.particles.uniforms.uGain.value = gain;
    this.shimmer.uniforms.uGain.value = gain;
    this.gain = gain;
  }

  /** WP15: key-change flocks spelling the key across the main view (camera-space poses). */
  _keyFlock(t, pxm, view) {
    const B = this.keyBirds, seed = this.app.cfg?.seed ?? DEFAULT_CFG.seed;
    B.begin();
    const p = this._kp;
    this.keyFlock.forLive(t, (rec, age, sc) => {
      const slots = this.keyFlock.slots(rec);
      for (let i = 0; i < slots.n; i++) B.addPose(keyBirdPose(rec, slots, i, age, sc, view, seed, p));
    });
    B.end(pxm, this.app.sunDir);
  }

  /** WP15: beat fish under the water in the shallows (+ their soft shadows on the bed). */
  _fish(t) {
    const F = this.fish, p = this._fp, bed = this._bed, sun = this.app.sunDir, wu = this.app.waterUniforms;
    F.begin();
    // shadow strength: share of direct sun in the light reaching the bed
    let sunK = 0.5, lx = 0, lz = 0;
    if (sun) {
      const cs = Math.sqrt(Math.max(0, 1 - (1 - sun.y * sun.y) / (1.333 * 1.333)));
      const ls = wu?.uSunColor ? lum3(wu.uSunColor.value) : 3, la = wu?.uSkyAmb ? lum3(wu.uSkyAmb.value) : 0.3;
      sunK = sun.y > 0 ? (ls * cs) / (ls * cs + Math.PI * la + 1e-6) : 0;
      const ly = Math.max(cs, 0.2);
      lx = sun.x / 1.333 / ly; lz = sun.z / 1.333 / ly;           // horizontal shift per metre of depth (toward the sun)
    }
    for (const f of this.fishLog.list) {
      const a = t - f.t0;
      if (a < 0 || a > f.life) continue;
      fishPose(f, a, p);
      let d = 2;
      try { d = depthAt(p.x, p.z); } catch {}
      const below = Math.max(0, (Number.isFinite(d) ? d : 2) - p.depth);
      let sx = -lx * below, sz = -lz * below;
      const sl = Math.hypot(sx, sz);
      if (sl > 4) { sx *= 4 / sl; sz *= 4 / sl; }
      bed.x = p.x + sx; bed.z = p.z + sz; bed.y = -(Number.isFinite(d) ? d : 2);
      F.add(p, f, bed, 0.6 * p.alpha * sunK * smoothstep01(below / 0.6));
    }
    F.end();
  }

  /** WP13: splashes (newest win the slots) and birds (≤ cfg.birds.max, oldest culled) from the birth log. */
  _splashesAndBirds(t, pxm) {
    const cfg = this.app.cfg || DEFAULT_CFG, sun = this.app.sunDir;
    const SP = this.splash, B = this.birds, list = this.births.list;
    SP.begin(); B.begin();
    for (let b = list.length - 1; b >= 0; b--) {
      const br = list[b], age = t - br.t0;
      if (age < 0 || age > SPLASH.life) continue;
      let y = 0;
      try { y = ambientHeight(br.sp.x, br.sp.z, t, cfg.ambient || DEFAULT_CFG.ambient); } catch {}
      if (!Number.isFinite(y)) y = 0;
      const seed = ((br.key % 1000003) * 31 + (cfg.seed ?? 1) * 7 + (br.kind === 'flock' ? 5 : 0)) % 16777213;
      SP.add(br.sp, y, seed, br.col, br.kind === 'note' ? 1 : 0.4);
      // a flock bursts out of its rider in a shower of gold sparkles
      if (br.kind === 'flock' && age < 2.5) {
        this.particles.add(br.sp.x, y + 1.5, br.sp.z, br.t0, 1.1, (seed % 65536) * 4 + 3, KIND_BURST, emitterCount(KIND_BURST, 1.1), br.col, 0.5);
      }
    }
    const max = Math.max(0, cfg.birds?.max ?? DEFAULT_CFG.birds.max);
    this.births.forBirds(t, max, (bp, age) => B.add(bp, age));
    SP.end(t, pxm, sun); B.end(pxm, sun);
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
      const Pc = Math.min(1.5, P);
      // any charged column reads (ramp → floor), and it grows strongly with energy: 3 soft notes ≈ lvl 0.3, 20 ≈ 1
      const on = Math.min(1, lvl / 0.06);
      T.core[i] = on * (0.8 + 2.2 * lvl) + 2.4 * Pc;                            // glow (brightened water, HDR)
      T.halo[i] = on * (3.5 + 10 * lvl) + 8.0 * Pc;                             // glints (HDR)
      T.hw[i] = 2 + 7 * lvl + 5 * Pc;                                           // min half-width (m)
      T.th[i] = (lvl > 0 || P > 0.02) ? on * (9 + 24 * lvl) + 16 * Pc + (unspawned ? 4 : 0) : 0; // half-thickness (px)
      T.dn[i] = Math.min(0.95, 0.3 + 0.55 * lvl + 0.3 * Pc);                   // glint density
      T.px[i] = fade;
      const sw = fc.sw[c0] * (1 - w) + fc.sw[c0 + 1] * w;
      const lc = sw > 1e-6 ? null : laneColor(u);
      for (let j = 0; j < 3; j++) {
        const cj = lc ? lc[j] : (fc.w[c0 * 3 + j] * (1 - w) + fc.w[(c0 + 1) * 3 + j] * w) / sw;
        T.c[i * 3 + j] = lerp(WATER_WHITE[j], cj, 0.8);
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
        T.px[i], T.hw[i], T.th[i], T.dn[i]);
    }
  }

  dispose() {
    this.app.scene?.remove(this.group);
    this.sprites.dispose(); this.particles.dispose(); this.shimmer.dispose(); this.dolphins.dispose();
    this.splash.dispose(); this.birds.dispose(); this.keyBirds.dispose(); this.fish.dispose();
  }
}
