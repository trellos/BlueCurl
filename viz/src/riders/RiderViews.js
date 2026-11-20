// Rider meshes + animation (WP6b). For every RiderState in app.riders.riders: a model by kind (surfer on a board,
// dolphin, seal), posed as a pure function of (RiderState, t), plus a wake ribbon and spray built from the rider's
// recent path. Orientation comes from fwd/up; pos is the contact point on the water (board bottom for surfers,
// the water line for animals, which sink per action). app.cfg.riderScale (default 1.4, read live) enlarges every
// rider about its contact point so silhouettes read from the wide camera (~150–250 m).
//
// Optional RiderState fields used when present (see contracts.js; all default sensibly):
//   prevAction, prevActionT, actionStart (s) → 0.3 s cross-fade between actions
//   vel {x,y,z}                              → wake/spray path fallback instead of fwd·speed
// Optional rider-system hook: app.riders.trail(id, age, out:Vector3) → world contact position `age` s ago
//   (sampled sim path); else rider.trail = [{x,y,z}, ...] newest first with rider.trailDt spacing.
import * as THREE from 'three';
import { RIDERS } from '../contracts.js';
import { SurferModel, surferPose, blendPose } from './models/surfer.js';
import { DolphinModel, dolphinPose } from './models/dolphin.js';
import { SealModel, sealPose } from './models/seal.js';
import { Wake, wakeUniforms } from './models/wake.js';

export const DEFAULT_RIDER_SCALE = 1.4;
const XFADE = 0.3;
const RIDE_ACTIONS = new Set(['trim', 'bottomTurn', 'lipHit', 'cutback', 'crouch']);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (a, b, x) => { const s = clamp((x - a) / (b - a), 0, 1); return s * s * (3 - 2 * s); };
const lerpObj = (a, b, k) => { const o = {}; for (const key in b) o[key] = typeof b[key] === 'number' && typeof a[key] === 'number' ? a[key] + (b[key] - a[key]) * k : b[key]; return o; };

const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _p = new THREE.Vector3();

/** Rider frame matrix: x = fwd, y = up (orthogonalised), z = fwd × up; scaled by s; origin pos. */
export function riderFrame(r, s, out = new THREE.Matrix4()) {
  _x.set(r.fwd?.x ?? 1, r.fwd?.y ?? 0, r.fwd?.z ?? 0);
  if (_x.lengthSq() < 1e-8) _x.set(1, 0, 0);
  _x.normalize();
  _y.set(r.up?.x ?? 0, r.up?.y ?? 1, r.up?.z ?? 0);
  _y.addScaledVector(_x, -_y.dot(_x));
  if (_y.lengthSq() < 1e-8) _y.set(0, 1, 0).addScaledVector(_x, -_x.y);
  _y.normalize();
  _z.crossVectors(_x, _y).normalize();
  out.makeBasis(_x.multiplyScalar(s), _y.multiplyScalar(s), _z.multiplyScalar(s));
  out.setPosition(r.pos?.x ?? 0, r.pos?.y ?? 0, r.pos?.z ?? 0);
  return out;
}

function hashSeed(id) { return ((Math.imul((id | 0) + 1, 0x9e3779b1) >>> 0) % 1000) / 1000; }

/** Pose for any kind with the optional cross-fade from prevAction. */
export function evalPose(kind, r, t) {
  const seed = hashSeed(r.id);
  const one = (action, at) => {
    if (kind === 'surfer') return surferPose(action, at, t, seed, r.speed || 0);
    if (kind === 'dolphin') return dolphinPose(action, r.state, at, t, seed, r.speed || 0);
    return sealPose(action, r.state, at, t, seed, r.speed || 0);
  };
  const cur = one(r.action || 'idle', r.actionT ?? 0);
  if (r.prevAction && r.prevAction !== r.action && Number.isFinite(r.actionStart) && t - r.actionStart < XFADE) {
    const k = smooth(0, XFADE, t - r.actionStart);
    const prev = one(r.prevAction, r.prevActionT ?? 1);
    if (kind === 'surfer') {
      return { pose: blendPose(prev.pose, cur.pose, k), board: lerpObj(prev.board, cur.board, k), detach: k > 0.5 ? cur.detach : prev.detach };
    }
    return lerpObj(prev, cur, k);
  }
  return cur;
}

/** Wake/spray parameters for a rider. */
function wakeParams(kind, r, a, goofy) {
  const act = r.action || 'idle', s = clamp(r.actionT ?? 0, 0, 1), v = r.speed || 0;
  const o = { wake: 0, width: 0.45, spray: 0, side: 0, lift: 0, burst: 0, tailBack: 0.6 };
  const riding = RIDE_ACTIONS.has(act) || r.state === 'RIDE';
  const mirror = goofy ? -1 : 1;
  const env = Math.sin(Math.PI * s);
  if (kind === 'surfer') {
    if (act === 'paddle' || act === 'swim') { o.wake = 0.45 * smooth(0.2, 1.2, v); o.width = 0.35; o.tailBack = 0.2; }
    else if (act === 'idle') o.wake = 0;
    else if (act === 'wipe') { o.wake = 0.6 * (1 - smooth(0, 0.3, s)); o.burst = 0.8 * smooth(0.25, 0.35, s) * (1 - smooth(0.45, 0.65, s)); o.tailBack = -1.5; }
    else {
      o.wake = smooth(1.0, 5.0, v) * (act === 'pop' ? smooth(0.2, 0.8, s) : 1);
      o.width = 0.5;
      if (act === 'bottomTurn') { o.spray = 0.8 * env; o.side = -mirror; }
      else if (act === 'cutback') { o.spray = 1.0 * env; o.side = mirror; o.lift = 1.5; }
      else if (act === 'lipHit') { o.spray = 1.0 * smooth(0.3, 0.5, s) * (1 - smooth(0.6, 0.9, s)); o.lift = 3.5; o.side = 0; }
      else if (act === 'kickout') { o.spray = 0.7 * smooth(0.15, 0.3, s) * (1 - smooth(0.4, 0.6, s)); o.lift = 2; o.wake *= 1 - smooth(0.3, 0.5, s); }
      else if (riding) o.spray = 0.18 * smooth(4, 9, v);
    }
  } else {
    const jump = act === 'jump' || act === 'kickout';
    if (jump) { o.wake = 0; o.burst = 0.7 * (1 - smooth(0.0, 0.15, s)) + 0.9 * smooth(0.85, 0.97, s); o.tailBack = 0; }
    else if (act === 'wipe') { o.wake = 0.4; o.burst = 0.5 * env; }
    else if (riding || r.state === 'TAKEOFF') { o.wake = 0.75 * smooth(1, 4, v); o.width = kind === 'dolphin' ? 0.3 : 0.38; o.spray = 0.3 * smooth(3, 8, v); o.tailBack = kind === 'dolphin' ? 0.05 : 0.3; o.lift = -0.8; }
    else if (act === 'swim' || act === 'paddle') { o.wake = 0.35 * smooth(0.3, 1.5, v); o.width = 0.3; o.tailBack = 0.2; }
  }
  return o;
}

export class RiderViews {
  constructor(app) {
    this.app = app;
    this.group = new THREE.Group();
    this.group.name = 'riderViews';
    app.scene?.add(this.group);
    this.sunDir = app.sunDir || new THREE.Vector3(0.95, 0.1, -0.3).normalize();
    this.wakeU = wakeUniforms(app);
    this.models = new Map();      // id → { kind, model, wake }
    for (const def of RIDERS) this._ensure(def);
    this._frame = new THREE.Matrix4();
  }

  _ensure(r) {
    let e = this.models.get(r.id);
    if (e && e.kind === r.kind) return e;
    const def = { ...(RIDERS.find((d) => d.id === r.id) || {}), ...r };
    if (!def.kind) return null;
    const model = def.kind === 'surfer' ? new SurferModel(def, this.sunDir)
      : def.kind === 'dolphin' ? new DolphinModel(def, this.sunDir) : new SealModel(def, this.sunDir);
    const wake = new Wake(this.wakeU, def.id | 0);
    this.group.add(model.group, wake.ribbon, wake.spray);
    model.group.visible = wake.ribbon.visible = wake.spray.visible = false;
    e = { kind: def.kind, model, wake };
    this.models.set(r.id, e);
    return e;
  }

  get triangles() {
    const o = {};
    for (const [id, e] of this.models) o[id] = e.model.triangles;
    return o;
  }

  /** Trail function for a rider: age (s) → world contact position. */
  _trail(r) {
    const sys = this.app.riders;
    if (sys && typeof sys.trail === 'function') return (age, out) => sys.trail(r.id, age, out) || out.set(r.pos.x, r.pos.y, r.pos.z);
    if (Array.isArray(r.trail) && r.trail.length > 1 && r.trailDt > 0) {
      const tr = r.trail, dt = r.trailDt;
      return (age, out) => {
        const f = clamp(age / dt, 0, tr.length - 1), i = Math.min(Math.floor(f), tr.length - 2), k = f - i;
        const a = tr[i], b = tr[i + 1];
        return out.set(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, a.z + (b.z - a.z) * k);
      };
    }
    const v = r.vel || { x: (r.fwd?.x ?? 0) * (r.speed || 0), y: (r.fwd?.y ?? 0) * (r.speed || 0), z: (r.fwd?.z ?? 0) * (r.speed || 0) };
    const vy = r.action === 'jump' ? 0 : v.y;
    return (age, out) => out.set(r.pos.x - v.x * age, r.pos.y - vy * age, r.pos.z - v.z * age);
  }

  reset() {}

  update(t) {
    const list = this.app.riders?.riders || [];
    const scale = Number(this.app.cfg?.riderScale) > 0 ? Number(this.app.cfg.riderScale) : DEFAULT_RIDER_SCALE;
    const cam = this.app.camera;
    if (cam?.isPerspectiveCamera) {
      const h = this.app.renderer?.getDrawingBufferSize ? this.app.renderer.getDrawingBufferSize(new THREE.Vector2()).y : 720;
      this.wakeU.uProj.value = h / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2));
    }
    const seen = new Set();
    for (const r of list) {
      if (!r || !r.pos) continue;
      const e = this._ensure(r);
      if (!e) continue;
      seen.add(r.id);
      const a = evalPose(e.kind, r, t);
      const F = riderFrame(r, scale, this._frame);
      if (e.kind !== 'surfer' && (r.action === 'jump' || r.action === 'kickout')) {
        // the sim's fwd may already follow the arc: then don't pitch twice
        a.pitch *= 1 - smooth(0.15, 0.45, Math.abs(r.fwd?.y ?? 0));
      }
      e.model.apply(F, a);
      e.model.group.visible = true;
      const goofy = e.kind === 'surfer' && e.model.look?.goofy;
      const wp = wakeParams(e.kind, r, a, goofy);
      wp.scale = scale;
      wp.fwd = _x.set(r.fwd?.x ?? 1, 0, r.fwd?.z ?? 0).normalize().clone();
      wp.right = new THREE.Vector3(-wp.fwd.z, 0, wp.fwd.x);
      e.wake.update(t, this._trail(r), wp);
    }
    for (const [id, e] of this.models) {
      if (!seen.has(id)) e.model.group.visible = e.wake.ribbon.visible = e.wake.spray.visible = false;
    }
    void _p;
  }

  dispose() {
    this.group.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
    this.group.removeFromParent();
  }
}
