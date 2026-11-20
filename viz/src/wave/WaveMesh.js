// BlueCurl Swell — wave renderer (WP4b): one double-sided swept-profile sheet per alive front (pooled, ≤ 12),
// coupled to the FFT ocean, with analytic foam and spray. Visual state is a pure function of (swell state, t).
//
// Per frame, for every alive front (sorted by crest x):
//   - packFront → per-slot uniforms + NCOLS×1 RGBA32F column texture (WP4a quick start)
//   - clip window in xi: half the distance to the neighbouring fronts (bay sets are ~20 m apart, profiles ~40–70 m
//     wide), else the profile extent at the front's max H; the mesh eases to flat ambient sea at the cut so
//     neighbours meet without intersecting
//   - ocean hook: the sea is pushed down under each mesh footprint (oceanHook.js)
//   - spray: up to SPRAY_MAX_FRONTS fronts with an active zone break draw SPRAY_PER_FRONT analytic points
// Exposes: stats { fronts, verts, spray }, look (shared look uniforms), sprayLook, slots, computeClips() (pure).
import * as THREE from 'three';
import { NCOLS, FRONT_W, FRONT_Z0 } from '../contracts.js';
import { packFront, makeKeyTextureSpec } from './profile.glsl.js';
import { extentBack, extentFront } from './profile.js';
import { makeFoamNoise } from '../water/foamNoise.js';
import { makeWaveGeometry, makeWaveMaterial, createWaveLookUniforms, createFrontUniforms, WAVE_COLS, WAVE_ROWS } from './waveMaterial.js';
import { OceanHook } from './oceanHook.js';
import {
  makeSprayGeometry, makeSprayMaterial, createSprayUniforms, createSprayLookUniforms, activeSprayBreaks,
  fillCrestHistory, SPRAY_PER_FRONT, SPRAY_MAX_FRONTS,
} from './spray.js';
import { pathSpline, pathEval } from '../sim/swell.js';

export const MAX_FRONT_MESHES = 12;

/** Max column height of a front (m, ≥ 0.3). */
export function frontHmax(front) {
  let h = 0.3;
  const c = front.cols;
  for (let i = 0; i < NCOLS; i++) if (c[i * 4] > h) h = c[i * 4];
  return h;
}

/**
 * Clip windows for fronts (any order). Returns, per input front (same order):
 * { xiMin, xiMax, bandB, bandF, clipB, clipF, Hmax } — xi local (+ shoreward). Pure.
 */
export function computeClips(fronts) {
  const order = fronts.map((f, i) => i).sort((a, b) => fronts[a].x - fronts[b].x);
  const out = new Array(fronts.length);
  for (const i of order) {
    const Hmax = frontHmax(fronts[i]);
    out[i] = { xiMin: -extentBack(Hmax), xiMax: extentFront(Hmax), bandB: 0.5, bandF: 0.5, clipB: false, clipF: false, Hmax };
  }
  // each adjacent pair (A shoreward, B seaward, gap d): if A's back and B's front overlap, both are cut at one
  // shared line inside the overlap (the midpoint when possible) so the two meshes meet exactly — never a strip
  // that only one ocean-mask box covers
  for (let k = 0; k + 1 < order.length; k++) {
    const A = out[order[k]], B = out[order[k + 1]];
    const d = fronts[order[k + 1]].x - fronts[order[k]].x;
    const eA = -A.xiMin, eB = B.xiMax;
    if (eA + eB <= d) continue;
    const c = Math.min(Math.max(d / 2, d - eB), eA);      // cut distance behind A's crest
    A.xiMin = -Math.max(c, 0.5); A.clipB = true;
    B.xiMax = Math.max(d - c, 0.5); B.clipF = true;
  }
  for (const o of out) {
    if (o.clipF) o.bandF = Math.min(8, Math.max(1.0, 0.45 * o.xiMax));
    if (o.clipB) o.bandB = Math.min(8, Math.max(1.0, -0.45 * o.xiMin));
  }
  return out;
}

export class WaveMesh {
  constructor(app) {
    this.app = app;
    const wu = app.waterUniforms || {};
    const ks = makeKeyTextureSpec();
    const keyTex = new THREE.DataTexture(ks.data, ks.width, ks.height, THREE.RGBAFormat, THREE.FloatType);
    keyTex.minFilter = keyTex.magFilter = THREE.NearestFilter; keyTex.generateMipmaps = false; keyTex.needsUpdate = true;
    this.keyTex = keyTex;
    this.foamTex = makeFoamNoise();
    this.look = createWaveLookUniforms();
    this.look.uFoamTex.value = this.foamTex;
    this.sprayLook = createSprayLookUniforms();
    const own = (app.ocean && app.ocean.own) || {};
    const extra = {
      uLeanBias: own.uLeanBias || { value: 0 },
      uChopFade: own.uChopFade || { value: new THREE.Vector2(350, 1600) },
    };
    this.geometry = makeWaveGeometry();
    this.sprayGeometry = makeSprayGeometry();
    this.group = new THREE.Group();
    this.group.name = 'waves';
    this.slots = [];
    for (let i = 0; i < MAX_FRONT_MESHES; i++) {
      const colsTex = new THREE.DataTexture(new Float32Array(NCOLS * 4), NCOLS, 1, THREE.RGBAFormat, THREE.FloatType);
      colsTex.minFilter = colsTex.magFilter = THREE.NearestFilter; colsTex.generateMipmaps = false; colsTex.needsUpdate = true;
      const fu = createFrontUniforms(keyTex, colsTex);
      const mat = makeWaveMaterial(wu, this.look, fu, extra);
      const mesh = new THREE.Mesh(this.geometry, mat);
      mesh.frustumCulled = false; mesh.visible = false; mesh.name = 'wave' + i;
      mesh.renderOrder = -1;          // before the ocean: early-z rejects the (pushed-down) sea under the sheet
      const su = createSprayUniforms();
      const smat = makeSprayMaterial(wu, fu, su, this.sprayLook, this.look.uFoamTex);
      const points = new THREE.Points(this.sprayGeometry, smat);
      points.frustumCulled = false; points.visible = false; points.name = 'spray' + i;
      points.renderOrder = 10;
      points.onBeforeRender = (renderer) => { su.uViewH.value = renderer.getCurrentViewport(this._vp).w; };
      this.group.add(mesh, points);
      this.slots.push({ i, colsTex, fu, su, mat, smat, mesh, points, frontId: null, pk: null, breaks: [] });
    }
    this._vp = new THREE.Vector4();
    if (app.scene) app.scene.add(this.group);
    this.hook = new OceanHook();
    this.hook.install(app.ocean);
    this.stats = { fronts: 0, verts: 0, spray: 0, sprayFronts: 0 };
    this._boxes = [];
  }

  /** Crest x of front at local time tl (relative to tRef) — the sim's path when available, else linear. */
  _xAt(f, tRef) {
    if (Number.isFinite(f.travel) && Number.isFinite(f.tPoint)) {
      const sp = pathSpline(f.travel);
      return (tl) => pathEval(sp, tl + tRef - f.tPoint).x;
    }
    if (typeof f.xAt === 'function') return (tl) => f.xAt(tl + tRef);
    const t = this._t;
    return (tl) => f.x + (f.vx || 0) * (tl + tRef - t);
  }

  update(t) {
    this._t = t;
    const all = (this.app.swell && this.app.swell.fronts) || [];
    let fronts = all.filter((f) => f && f.cols && f.alpha > 0 && Number.isFinite(f.x));
    if (fronts.length > MAX_FRONT_MESHES) fronts = fronts.slice().sort((a, b) => a.x - b.x).slice(0, MAX_FRONT_MESHES);
    // slot assignment (stable by front id)
    const want = new Set(fronts.map((f) => f.id));
    for (const s of this.slots) if (s.frontId !== null && !want.has(s.frontId)) s.frontId = null;
    const byId = new Map(this.slots.filter((s) => s.frontId !== null).map((s) => [s.frontId, s]));
    for (const f of fronts) {
      if (byId.has(f.id)) continue;
      const s = this.slots.find((q) => q.frontId === null);
      s.frontId = f.id; byId.set(f.id, s);
    }
    for (const s of this.slots) { s.mesh.visible = false; s.points.visible = false; }

    const clips = computeClips(fronts);
    const boxes = this._boxes; boxes.length = 0;
    let sprayFronts = 0;
    for (let k = 0; k < fronts.length; k++) {
      const f = fronts[k], s = byId.get(f.id), c = clips[k], u = s.fu;
      const tRef = Number.isFinite(f.tPoint) ? f.tPoint : 0;
      s.pk = packFront(f, tRef, s.pk);
      u.uFrontZB.value = s.pk.zb;
      u.uFrontNZB.value = s.pk.nzb;
      u.uFrontX.value = s.pk.frontX;
      u.uFrontTRef.value = tRef;
      u.uFrontTime.value = t - tRef;
      u.uFrontVX.value = f.vx || 0;
      u.uAlpha.value = Math.min(1, Math.max(0, f.alpha));
      u.uClip.value.set(c.xiMin, c.xiMax, c.bandB, c.bandF);
      s.colsTex.image.data.set(s.pk.cols);
      s.colsTex.needsUpdate = true;
      s.mesh.visible = true;
      boxes.push({ x0: f.x - c.xiMax, x1: f.x - c.xiMin, clip0: c.clipF, clip1: c.clipB, z0: FRONT_Z0, z1: FRONT_Z0 + FRONT_W,
        down: 0.45 * c.Hmax * u.uAlpha.value + 0.3 });
      // spray
      activeSprayBreaks(f, t, s.breaks);
      if (s.breaks.length && sprayFronts < SPRAY_MAX_FRONTS) {
        const b = s.breaks;
        s.su.uSprayB.value.set(b[0] ?? 0, b[1] ?? 0, b[2] ?? 0, b.length);
        fillCrestHistory(this._xAt(f, tRef), t - tRef, s.su.uXHist.value, s.su.uXHistT.value);
        s.points.visible = true;
        sprayFronts++;
      }
    }
    this.hook.set(boxes);
    this.stats.fronts = fronts.length;
    this.stats.verts = fronts.length * WAVE_COLS * WAVE_ROWS;
    this.stats.sprayFronts = sprayFronts;
    this.stats.spray = sprayFronts * SPRAY_PER_FRONT;
  }

  reset() {}

  dispose() {
    this.hook.uninstall();
    this.group.removeFromParent();
    this.geometry.dispose(); this.sprayGeometry.dispose();
    for (const s of this.slots) { s.mat.dispose(); s.smat.dispose(); s.colsTex.dispose(); }
    this.keyTex.dispose(); this.foamTex.dispose();
  }
}
