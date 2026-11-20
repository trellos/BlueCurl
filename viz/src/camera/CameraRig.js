// BlueCurl Swell — camera rig (WP7): wide default view + automatic picture-in-picture follow cams.
//
// step(t, dt)  (fixed sim step, after riders.step): new RideEvents → pipPolicy.pipStep → one FollowCam per tile.
// render(app)  (per frame, pure function of the stepped state + t): wide pose → main Post into the canvas; then per
//              tile a scissored clear for the frame/border and a second Post (app.createPost(w·size, h·size)) into
//              the tile's viewport; DOM labels (rider name + style; hidden with ?nohud).
// this.pip = { active, riderId, rect {x,y,w,h} normalized (origin top-left), alpha, startedAt, tiles: [...] }.
//
// URL (debug): ?fakeride=1|all (src/camera/fakeRide.js test fixture; its events/riders are read too)
//   ?fakewave=1 (debug wave patch around the fake ride) · ?widecam=px,py,pz,tx,ty,tz,fov · ?drift=0 · ?zonelines=1
import * as THREE from 'three';
import { DT, ZONES, uToZ, ambientHeight } from '../contracts.js';
import * as field from '../wave/field.js';
import { WIDE, widePose } from './wide.js';
import { FollowCam } from './followCam.js';
import { createPipState, pipStep, pipLayout, PIP_DEFAULTS } from './pipPolicy.js';
import { FakeRides } from './fakeRide.js';

const query = () => (typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams());
const STYLE_LABEL = { cruise: 'cruising', carve: 'carving', tube: 'in the tube', porpoise: 'porpoising', breach: 'breaching' };
const STATE_LABEL = { TAKEOFF: 'take-off', KICKOUT: 'kick-out', CLOSEOUT: 'closed out', RETURN: 'paddling back', LINEUP: 'lineup', POSITION: 'positioning' };

export const PIP_BORDER = { px720: 2, outer720: 1, color: [0.96, 0.9, 0.78], outerColor: [0.02, 0.05, 0.07] };

export class CameraRig {
  constructor(app) {
    this.app = app;
    const qs = query();
    const flag = (k) => qs.has(k) && qs.get(k) !== '0' && qs.get(k) !== 'false';
    this.base = { ...WIDE };
    if (qs.get('widecam')) {
      const v = qs.get('widecam').split(',').map(Number);
      if (v.length >= 6 && v.every(Number.isFinite)) this.base = { position: v.slice(0, 3), target: v.slice(3, 6), fov: v[6] || WIDE.fov };
    }
    this.drift = qs.has('drift') ? Number(qs.get('drift')) : 1;
    this.fake = flag('fakeride') ? new FakeRides(app, { all: qs.get('fakeride') === 'all', wave: flag('fakewave') }) : null;
    this.showLabels = app.opts?.hud !== false && !qs.has('nohud');
    this.pipCam = new THREE.PerspectiveCamera(52, 16 / 9, 0.2, 20000);
    this.pipCam.rotation.order = 'YXZ';
    this.pipPost = null;
    this._pose = {};
    this._clear = new THREE.Color();
    this._buf = new THREE.Vector2();
    this.labels = [];
    if (flag('zonelines')) this._zoneLines(app);
    this.reset();
  }

  reset() {
    this.state = createPipState();
    this.cams = new Map();
    this._seen = new WeakSet();
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

  _surface(t) {
    const fronts = this.app.swell?.fronts || [], amb = this.app.cfg?.ambient;
    return field.surfaceHeight ? (x, z) => field.surfaceHeight(fronts, x, z, t) : (x, z) => ambientHeight(x, z, t, amb);
  }

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
    this.state = pipStep(this.state, evs, t, app.cfg?.pip, (ev) => this.heightOf(ev));

    const live = new Set();
    let surface = null;
    for (const tile of [...this.state.leaving, ...this.state.tiles]) {
      if (tile.hidden) continue;
      live.add(tile.key);
      const r = this.rider(tile.riderId);
      if (!r || !r.pos) continue;                         // rider gone: the cam holds its last pose
      let fc = this.cams.get(tile.key);
      if (!fc) { fc = new FollowCam(); this.cams.set(tile.key, fc); }
      const fid = r.frontId ?? tile.frontId, zi = r.zi != null && r.zi >= 0 ? r.zi : tile.zi;
      const zb = this._break(fid, zi);
      surface = surface || this._surface(t);
      fc.step(dt, { pos: r.pos, fwd: r.fwd, kind: r.kind, style: r.style, H: zb ? zb.H : 1.5, dir: zb ? zb.dir : 0, surface });
    }
    for (const k of [...this.cams.keys()]) if (!live.has(k)) this.cams.delete(k);
  }

  // ---------------------------------------------------------------- rendering
  render(app) {
    const t = app.simTime, r = app.renderer;
    this.fake?.update(t);

    const p = widePose(t, this.base, this.drift, this._pose), cam = app.camera;
    cam.position.set(p.px, p.py, p.pz);
    cam.lookAt(p.tx, p.ty, p.tz);
    if (cam.fov !== p.fov) { cam.fov = p.fov; cam.updateProjectionMatrix(); }
    cam.updateMatrixWorld();
    app.post.render(app.scene, cam);

    const buf = r.getDrawingBufferSize(this._buf);
    const pcfg = { ...PIP_DEFAULTS, ...(app.cfg?.pip || {}) };
    const tiles = pipLayout(this.state, t, pcfg, buf.x / buf.y).filter((x) => this.cams.get(x.key)?.init);
    for (const tile of tiles) this._renderTile(app, tile, buf, pcfg);

    const main = tiles.filter((x) => !x.leaving).sort((a, b) => a.slot - b.slot)[0] || tiles[0];
    this.pip = main
      ? { active: true, riderId: main.riderId, rect: main.rect, alpha: main.alpha, startedAt: main.startedAt, phase: main.phase, tiles }
      : { active: false, riderId: null, rect: null, alpha: 0, startedAt: null, tiles: [] };
    this._labels(app, tiles);
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
    if (c.fov !== pose.fov) c.fov = pose.fov;
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
  }

  // ---------------------------------------------------------------- DOM labels
  _labels(app, tiles) {
    if (!this.showLabels || typeof document === 'undefined') return;
    const canvas = app.renderer.domElement, box = canvas.getBoundingClientRect();
    while (this.labels.length < tiles.length) {
      const el = document.createElement('div');
      el.className = 'bc-pip-label';
      el.style.cssText = 'position:fixed;z-index:9;pointer-events:none;font:600 13px/1.2 ui-sans-serif,system-ui,sans-serif;'
        + 'color:#fff7e8;background:rgba(6,18,24,.62);border-left:3px solid #ffc65a;padding:3px 8px 4px;'
        + 'text-shadow:0 1px 0 rgba(0,0,0,.5);white-space:nowrap;letter-spacing:.02em';
      document.body.appendChild(el);
      this.labels.push(el);
    }
    this.labels.forEach((el, i) => {
      const tile = tiles[i];
      if (!tile) { el.style.display = 'none'; return; }
      const rd = this.rider(tile.riderId);
      const name = rd?.name ?? `rider ${tile.riderId}`;
      const style = rd ? (rd.state === 'RIDE' || rd.state === 'TAKEOFF' ? STYLE_LABEL[rd.style] || STATE_LABEL[rd.state] || '' : STATE_LABEL[rd.state] || '') : '';
      const txt = style ? `${name} · ${style}` : name;
      if (el.textContent !== txt) el.textContent = txt;
      el.style.display = '';
      el.style.left = `${box.left + (tile.rect.x * box.width) + 8}px`;
      el.style.top = `${box.top + (tile.rect.y * box.height) + 8}px`;
      el.style.opacity = String(tile.alpha);
      el.style.borderLeftColor = tile.barrel ? '#5ff0e0' : '#ffc65a';
    });
  }

  dispose() {
    this.pipPost?.dispose();
    this.fake?.dispose();
    for (const el of this.labels) el.remove();
    this.labels = [];
  }
}
