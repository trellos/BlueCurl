// BlueCurl Swell — camera rig (WP7): wide default view + automatic picture-in-picture follow cams.
//
// step(t, dt)  (fixed sim step, after riders.step): new RideEvents (+ rides still going) → pipPolicy.pipStep →
//              one FollowCam per tile (constraints: water clearance, crest side, wave-sheet occlusion).
// render(app)  (per frame, pure function of the stepped state + t): wide pose → main Post into the canvas; then per
//              tile a scissored clear for the frame/border, a second Post (app.createPost(w·size, h·size)) into the
//              tile's viewport, and the in-canvas label (rider name + style; captures include it).
// this.pip = { active, riderId, rect {x,y,w,h} normalized (origin top-left), alpha, startedAt, phase, tiles: [...] }.
//
// Camera presets (wide.js): key C cycles lineup → point → cliff via app.input.setConfig('camera', name) (a logged
// cfg event, so replays reproduce it); the rig reads app.cfg.camera. ?camera=<name> picks the start preset.
// URL (debug): ?fakeride=1|all (src/camera/fakeRide.js test fixture; its events/riders are read too)
//   ?fakewave=1 (debug wave patch around the fake ride) · ?widecam=px,py,pz,tx,ty,tz,fov · ?drift=0 · ?zonelines=1
//   ?piplabel=0 (no tile label)
import * as THREE from 'three';
import { DT, ZONES, DEFAULT_CFG, uToZ, zToU, ambientHeight } from '../contracts.js';
import * as field from '../wave/field.js';
import * as KF from '../wave/keyframes.js';
import { profileExtents } from '../wave/profile.js';
import { DEFAULT_PRESET, presetFor, nextPreset, widePose } from './wide.js';
import { FollowCam } from './followCam.js';
import { createPipState, pipStep, pipLayout, PIP_DEFAULTS } from './pipPolicy.js';
import { FakeRides } from './fakeRide.js';
import { PushIn, calmFrom } from './push.js';

const query = () => (typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams());
const STYLE_LABEL = { cruise: 'cruising', carve: 'carving', tube: 'in the tube', porpoise: 'porpoising', breach: 'breaching' };
// state labels per kind (surfers paddle, animals swim)
const STATE_LABEL = {
  surfer: { TAKEOFF: 'take-off', KICKOUT: 'kick-out', CLOSEOUT: 'wipe-out', RETURN: 'paddling back', LINEUP: 'in the lineup', POSITION: 'paddling into position', ENTER: 'paddling out', LEAVE: 'heading in' },
  animal: { TAKEOFF: 'catching the wave', KICKOUT: 'pulling off', CLOSEOUT: 'tumbling', RETURN: 'swimming back', LINEUP: 'cruising the lineup', POSITION: 'swimming into position', ENTER: 'swimming in', LEAVE: 'heading out to sea' },
};
export function riderLabel(rd) {
  if (!rd) return '';
  const S = STATE_LABEL[rd.kind === 'surfer' ? 'surfer' : 'animal'];
  if (rd.state === 'RIDE') return rd.tube ? STYLE_LABEL.tube : rd.style === 'tube' ? 'pulling in' : STYLE_LABEL[rd.style] || 'riding';
  if (rd.state === 'TAKEOFF' && rd.tube) return STYLE_LABEL.tube;
  return S[rd.state] || '';
}
const RIDING = new Set(['TAKEOFF', 'RIDE']);
const SIGMA_CREST = KF.SIGMA_CREST ?? 24 / 95;

export const PIP_BORDER = { px720: 2, outer720: 1, color: [0.96, 0.9, 0.78], outerColor: [0.02, 0.05, 0.07] };

// ------------------------------------------------------------------ wave occlusion helpers (pure, JS mirror)
const CS = {}, CR = [];
/** True if (x, y, z) is inside water: under the sea surface or inside an overhanging sheet (lip) of any front. */
export function inWater(fronts, x, y, z, t, amb) {
  const A = ambientHeight(x, z, t, amb), u = zToU(z);
  let covered = false;
  if (u >= 0 && u <= 1 && field.columnState && field.crossings) {
    for (const f of fronts) {
      const cs = field.columnState(f, u, t, CS), e = profileExtents(cs.H), xiT = f.x - x;
      if (!(xiT > e.back && xiT < e.front)) continue;
      covered = true;
      field.crossings(cs, xiT, 0, 1, CR);
      let above = 0;
      for (const c of CR) if (c + A > y) above++;
      if (above % 2 === 1) return true;
    }
  }
  return !covered && y < A;
}
/** True if the segment a → b passes through water (sampled; the last 1.2 m at b — the rider — are ignored). */
export function segmentBlocked(fronts, ax, ay, az, bx, by, bz, t, amb, n = 7, margin = 0.6) {
  const L = Math.hypot(bx - ax, by - ay, bz - az) || 1, end = Math.max(0, 1 - 1.2 / L);
  for (let i = 0; i < n; i++) {
    const s = (end * (i + 0.5)) / n;
    const x = ax + (bx - ax) * s, y = ay + (by - ay) * s, z = az + (bz - az) * s;
    if (inWater(fronts, x, y - margin, z, t, amb) || inWater(fronts, x, y + margin, z, t, amb)) return true;
  }
  return false;
}

// ------------------------------------------------------------------ in-canvas tile label
class LabelPainter {
  constructor() {
    this.canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
    if (!this.canvas) return;
    this.canvas.width = 1024; this.canvas.height = 96;
    this.ctx = this.canvas.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.minFilter = THREE.LinearFilter; this.tex.generateMipmaps = false;
    this.mat = new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    this.scene = new THREE.Scene(); this.scene.add(this.mesh);
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.text = null; this.accent = null; this.w = 1;
  }
  /** Draws `text` into the texture (only when it changes); returns the used width fraction of the canvas. */
  set(text, accent) {
    if (!this.canvas || (text === this.text && accent === this.accent)) return this.w;
    const c = this.ctx, H = this.canvas.height;
    c.clearRect(0, 0, this.canvas.width, H);
    c.font = `600 ${Math.round(H * 0.56)}px ui-sans-serif, system-ui, "Segoe UI", sans-serif`;
    const tw = Math.min(this.canvas.width - 40, c.measureText(text).width), W = Math.ceil(tw + H * 0.62);
    c.fillStyle = 'rgba(6, 18, 24, 0.66)'; c.fillRect(0, 0, W, H);
    c.fillStyle = accent; c.fillRect(0, 0, Math.round(H * 0.09), H);
    c.fillStyle = '#fff7e8'; c.textBaseline = 'middle';
    c.fillText(text, Math.round(H * 0.3), H * 0.54, this.canvas.width - 40);
    this.tex.needsUpdate = true;
    this.text = text; this.accent = accent; this.w = W / this.canvas.width;
    const uw = this.w;
    this.tex.repeat.set(uw, 1); this.tex.offset.set(0, 0);
    return uw;
  }
}

export class CameraRig {
  constructor(app) {
    this.app = app;
    const qs = query();
    const flag = (k) => qs.has(k) && qs.get(k) !== '0' && qs.get(k) !== 'false';
    this.startPreset = ['lineup', 'point', 'cliff'].includes(qs.get('camera')) ? qs.get('camera') : DEFAULT_PRESET;
    this.override = null;                                  // ?widecam= (debug) replaces every preset
    if (qs.get('widecam')) {
      const v = qs.get('widecam').split(',').map(Number);
      if (v.length >= 6 && v.every(Number.isFinite)) this.override = { position: v.slice(0, 3), target: v.slice(3, 6), fov: v[6] || 60, pipCorner: null };
    }
    this.drift = qs.has('drift') ? Number(qs.get('drift')) : 1;
    this.fake = flag('fakeride') ? new FakeRides(app, { all: qs.get('fakeride') === 'all', wave: flag('fakewave') }) : null;
    this.showLabels = !(qs.has('piplabel') && !flag('piplabel'));
    this.pipCam = new THREE.PerspectiveCamera(45, 16 / 9, 0.2, 20000);
    this.pipCam.rotation.order = 'YXZ';
    this.pipPost = null;
    this.label = new LabelPainter();
    this._pose = {};
    this._clear = new THREE.Color();
    this._buf = new THREE.Vector2();
    this._warm = false;
    if (flag('zonelines')) this._zoneLines(app);
    this._bindKeys();
    this.reset();
  }

  /** Active wide preset name (app.cfg.camera, else the start preset). */
  presetName() { const n = this.app.cfg?.camera; return ['lineup', 'point', 'cliff'].includes(n) ? n : this.startPreset; }
  /** Active wide pose: { position, target, fov, pipCorner }. */
  preset() { return this.override || presetFor(this.presetName()); }

  /** Active wide pose incl. the lineup push-in (cfg.cameraPush; 'point' / 'cliff' and ?widecam stay static). */
  widePreset() {
    const base = this.preset();
    if (this.override || this.presetName() !== 'lineup') return base;
    const amt = Number(this.app.cfg?.cameraPush ?? 0.6);
    return Number.isFinite(amt) && amt > 0 ? this.push.apply(base, amt) : base;
  }

  /** C: next camera preset, logged as a cfg event (deterministic replay). */
  _bindKeys() {
    if (typeof window === 'undefined' || !window.addEventListener) return;
    window.addEventListener('keydown', (e) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.code !== 'KeyC') return;
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const next = nextPreset(this.presetName());
      if (this.app.input?.setConfig) this.app.input.setConfig('camera', next);
      else if (this.app.cfg) this.app.cfg.camera = next;
    });
  }

  reset() {
    this.state = createPipState();
    this.cams = new Map();
    this._seen = new WeakSet();
    this._since = new Map();          // riderId → take-off time of the current ride
    this.push = new PushIn();         // lineup push-in toward the active break (calmed while riders enter / leave)
    this._flocks = [];                // recent riders 'flock' events (calm the push-in)
    this.fake?.reset();
    this.pip = { active: false, riderId: null, rect: null, alpha: 0, startedAt: null, tiles: [] };
  }

  /** Debug (?zonelines=1): each zone's break line at y = 1 m (outer red, point yellow, inside cyan). */
  _zoneLines(app) {
    const cols = [0xff5040, 0xffe040, 0x40e0ff];
    ZONES.forEach((zn, i) => {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(zn.lineX, 1, uToZ(zn.u0)), new THREE.Vector3(zn.lineX, 1, uToZ(zn.u1))]);
      app.scene.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: cols[i], toneMapped: false })));
    });
  }

  /** PiP config; corner 'auto' (or the contracts' default) means the active preset's corner. */
  pipCfg() {
    const c = { ...PIP_DEFAULTS, ...(this.app.cfg?.pip || {}) };
    if (!c.corner || c.corner === 'auto' || c.corner === DEFAULT_CFG.pip.corner) c.corner = this.preset().pipCorner || 'bottom-right';
    return c;
  }

  // ---------------------------------------------------------------- lookups
  _riderLists() {
    const lists = [];
    if (Array.isArray(this.app.riders?.riders)) lists.push(this.app.riders.riders);
    if (this.fake) lists.push(this.fake.riders);
    return lists;
  }
  rider(id) {
    for (const l of this._riderLists()) { const r = l.find((x) => x.id === id); if (r) return r; }
    return null;
  }
  _front(id) { return (this.app.swell?.fronts || []).find((f) => f.id === id) || null; }
  _break(frontId, zi) { const f = this._front(frontId); return f ? (f.breaks || []).find((b) => b.zi === zi) || null : null; }
  /** ZoneBreak H of the ride an event belongs to (null = unknown → not filtered). */
  heightOf(ev) { const zb = this._break(ev.frontId, ev.zi); return zb ? zb.H : null; }
  /** Tile priority of a ride: surfers 2 (readable, the show), animals 1. */
  priorityOf(ev) { const r = this.rider(ev.riderId); return r && r.kind !== 'surfer' ? 1 : 2; }

  // ---------------------------------------------------------------- simulation
  step(t, dt = DT) {
    const app = this.app;
    this.fake?.step(t, dt, app.swell);
    const evs = [];
    for (const src of [app.riders?.events, this.fake?.events]) {
      if (!Array.isArray(src)) continue;
      for (const ev of src) {
        if (!ev || typeof ev !== 'object' || this._seen.has(ev)) continue;
        this._seen.add(ev);
        evs.push(ev);
      }
    }
    evs.sort((a, b) => (a.t ?? t) - (b.t ?? t));           // stable: emission order within a time
    for (const ev of evs) {
      if (ev.type === 'takeoff') this._since.set(ev.riderId, ev.t ?? t);
      else if (ev.type === 'rideEnd') this._since.delete(ev.riderId);
      else if (ev.type === 'flock' && ev.pos) this._flocks.push({ t: ev.t ?? t, riderId: ev.riderId, pos: { ...ev.pos } });
    }
    this._flocks = this._flocks.filter((f) => t - f.t <= 10);
    this.push.step(t, dt, app.swell?.fronts, calmFrom(t, this._riderLists(), this._flocks));
    const ongoing = [];
    for (const l of this._riderLists()) {
      for (const r of l) {
        if (!RIDING.has(r.state) || r.frontId == null) continue;
        ongoing.push({ riderId: r.id, frontId: r.frontId, zi: r.zi, tube: !!(r.tube || r.style === 'tube'), since: this._since.get(r.id) ?? t });
      }
    }
    this.state = pipStep(this.state, evs, t, this.pipCfg(), (ev) => this.heightOf(ev), ongoing, (ev) => this.priorityOf(ev));

    const live = new Set();
    const fronts = app.swell?.fronts || [], amb = app.cfg?.ambient;
    const surface = field.surfaceHeight ? (x, z) => field.surfaceHeight(fronts, x, z, t) : (x, z) => ambientHeight(x, z, t, amb);
    const blocked = (ax, ay, az, bx, by, bz) => segmentBlocked(fronts, ax, ay, az, bx, by, bz, t, amb);
    for (const tile of [...this.state.leaving, ...this.state.tiles]) {
      if (tile.hidden) continue;
      live.add(tile.key);
      const r = this.rider(tile.riderId);
      if (!r || !r.pos) continue;                         // rider gone: the cam holds its last pose
      let fc = this.cams.get(tile.key);
      if (!fc) { fc = new FollowCam(); this.cams.set(tile.key, fc); }
      const fid = r.frontId ?? tile.frontId, zi = r.zi != null && r.zi >= 0 ? r.zi : tile.zi;
      const front = this._front(fid), zb = this._break(fid, zi);
      let crestX = null;
      if (front && field.sampleFront && RIDING.has(r.state)) {
        const u = Number.isFinite(r.u) ? r.u : zToU(r.pos.z);
        crestX = field.sampleFront(front, u, SIGMA_CREST, t).x;
      }
      // tube framing only while inside; a flock show tile frames the rider + the birds climbing above it
      const style = tile.show === 'flock' && !RIDING.has(r.state) ? 'flock' : r.tube ? 'tube' : r.style === 'tube' ? 'carve' : r.style;
      fc.step(dt, { pos: r.pos, fwd: r.fwd, kind: r.kind, style, state: r.state, H: zb ? zb.H : 1.5, dir: zb ? zb.dir : 0,
        surface, blocked, crestX });
    }
    for (const k of [...this.cams.keys()]) if (!live.has(k)) this.cams.delete(k);
  }

  // ---------------------------------------------------------------- rendering
  render(app) {
    const t = app.simTime, r = app.renderer;
    this.fake?.update(t);
    const buf = r.getDrawingBufferSize(this._buf);
    const pcfg = this.pipCfg();
    if (!this._warm) this._warmUp(app, buf, pcfg);

    const p = widePose(t, this.widePreset(), this.drift, this._pose), cam = app.camera;
    cam.position.set(p.px, p.py, p.pz);
    cam.lookAt(p.tx, p.ty, p.tz);
    if (cam.fov !== p.fov) { cam.fov = p.fov; cam.updateProjectionMatrix(); }
    cam.updateMatrixWorld();
    app.post.render(app.scene, cam);

    const tiles = pipLayout(this.state, t, pcfg, buf.x / buf.y).filter((x) => this.cams.get(x.key)?.init);
    for (const tile of tiles) this._renderTile(app, tile, buf, pcfg);

    const main = tiles.filter((x) => !x.leaving).sort((a, b) => a.slot - b.slot)[0] || tiles[0];
    this.pip = main
      ? { active: true, riderId: main.riderId, rect: main.rect, alpha: main.alpha, startedAt: main.startedAt, phase: main.phase, tiles }
      : { active: false, riderId: null, rect: null, alpha: 0, startedAt: null, tiles: [] };
  }

  /** First frame: allocate the PiP Post and run one PiP pass (programs, render targets) so the first tile doesn't hitch. */
  _warmUp(app, buf, pcfg) {
    this._warm = true;
    const pw = Math.max(16, Math.round(buf.x * pcfg.size)), ph = Math.max(16, Math.round(buf.y * pcfg.size));
    this.pipPost = app.createPost(pw, ph);
    const c = this.pipCam, z = ZONES[1];
    c.position.set(z.lineX - 25, 4, uToZ((z.u0 + z.u1) / 2) + 10);
    c.lookAt(z.lineX, 1, uToZ((z.u0 + z.u1) / 2));
    c.aspect = pw / ph; c.updateProjectionMatrix(); c.updateMatrixWorld();
    try { app.renderer.compile(app.scene, c); } catch (e) { /* optional */ }
    this.pipPost.render(app.scene, c, null, { x: 0, y: 0, w: 1, h: 1 });   // overwritten by the main view
    if (this.label.canvas) {
      this.label.set('warm', '#ffc65a');
      const r = app.renderer, pr = r.getPixelRatio(), prevAuto = r.autoClear;
      r.autoClear = false; r.setViewport(0, 0, 1 / pr, 1 / pr);
      r.render(this.label.scene, this.label.cam);
      r.autoClear = prevAuto; r.setViewport(0, 0, buf.x / pr, buf.y / pr);
    }
  }

  _renderTile(app, tile, buf, pcfg) {
    const r = app.renderer, pr = r.getPixelRatio();
    const W = buf.x, Hh = buf.y;
    const pw = Math.max(16, Math.round(W * pcfg.size)), ph = Math.max(16, Math.round(Hh * pcfg.size));
    if (!this.pipPost) this.pipPost = app.createPost(pw, ph);
    else this.pipPost.resize(pw, ph);

    // tile rect in drawing-buffer px, GL origin bottom-left
    const x = Math.round(tile.rect.x * W), w = pw, h = ph;
    const y = Math.round((1 - tile.rect.y - tile.rect.h) * Hh);
    const bw = Math.max(1, Math.round(PIP_BORDER.px720 * Hh / 720)), ow = Math.max(1, Math.round(PIP_BORDER.outer720 * Hh / 720));

    const pose = this.cams.get(tile.key).out, c = this.pipCam;
    c.position.set(pose.x, pose.y, pose.z);
    c.rotation.set(pose.pitch, pose.yaw, 0);
    c.aspect = w / h;
    c.fov = pose.fov;
    c.updateProjectionMatrix();
    c.updateMatrixWorld();

    // frame: scissored clears (outer dark hairline, then the light border)
    const prevColor = r.getClearColor(this._clear).clone(), prevAlpha = r.getClearAlpha();
    r.setRenderTarget(null);
    r.setScissorTest(true);
    const clearRect = (m, rgb) => {
      r.setScissor((x - m) / pr, (y - m) / pr, (w + 2 * m) / pr, (h + 2 * m) / pr);
      r.setClearColor(new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace), 1);
      r.clear(true, false, false);
    };
    clearRect(bw + ow, PIP_BORDER.outerColor);
    clearRect(bw, PIP_BORDER.color);
    r.setScissorTest(false);
    r.setScissor(0, 0, W / pr, Hh / pr);
    r.setClearColor(prevColor, prevAlpha);

    this.pipPost.render(app.scene, c, null, { x, y, w, h });
    if (this.showLabels) this._renderLabel(app, tile, x, y, w, h, buf);
  }

  _labelText(tile) {
    const rd = this.rider(tile.riderId);
    const name = rd?.name ?? `rider ${tile.riderId}`;
    const style = tile.show === 'flock' && !RIDING.has(rd?.state) ? 'flock!' : riderLabel(rd);
    return style ? `${name} · ${style}` : name;
  }

  _renderLabel(app, tile, x, y, w, h, buf) {
    const L = this.label;
    if (!L.canvas) return;
    const rd = this.rider(tile.riderId);
    const uw = L.set(this._labelText(tile), rd?.tube || tile.barrel ? '#5ff0e0' : tile.show === 'flock' ? '#ffe9a8' : '#ffc65a');
    const r = app.renderer, pr = r.getPixelRatio();
    const lh = Math.max(14, Math.round(h * 0.085)), lw = Math.min(w - 16, Math.round(lh * (L.canvas.width / L.canvas.height) * uw));
    const m = Math.round(lh * 0.45), lx = x + m, ly = y + h - m - lh;
    // the label rides with the tile (clip to the tile while it slides)
    const prevAuto = r.autoClear;
    r.autoClear = false;
    r.setRenderTarget(null);
    r.setViewport(lx / pr, ly / pr, lw / pr, lh / pr);
    r.setScissor(Math.max(lx, x) / pr, ly / pr, Math.max(0, Math.min(lw, x + w - lx)) / pr, lh / pr);
    r.setScissorTest(true);
    r.render(L.scene, L.cam);
    r.setScissorTest(false);
    r.setViewport(0, 0, buf.x / pr, buf.y / pr);
    r.setScissor(0, 0, buf.x / pr, buf.y / pr);
    r.autoClear = prevAuto;
  }

  dispose() {
    this.pipPost?.dispose();
    this.fake?.dispose();
  }
}
