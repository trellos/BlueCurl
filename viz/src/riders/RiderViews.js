// Rider meshes + animation (WP6b). For every RiderState in app.riders.riders: a model by kind (surfer on a board,
// dolphin, seal), posed as a pure function of (RiderState, t), plus a wake ribbon and spray built from the rider's
// recent path. Orientation comes from fwd/up; pos is the contact point on the water (board bottom for surfers,
// the water line for animals, which sink per action). app.cfg.riderScale (default 1.4, read live) enlarges every
// rider about its contact point so silhouettes read from the wide camera (~150–250 m).
//
// Kinds: surfer, dolphin, seal, turtle (WP12b); an unknown kind falls back to the seal model.
// Presence (WP12): present === false or state ASHORE → hidden (model, wake, spray). ENTER / LEAVE riders use the
// paddle (surfers) / swim (animals) animation whatever their action (animals may still 'dive'). `present`
// undefined counts as present.
// Optional RiderState fields used when present (see contracts.js; all default sensibly):
//   prevAction, prevActionT, actionStart (s) → 0.3 s cross-fade between actions
//   vel {x,y,z}                              → wake/spray path fallback instead of fwd·speed
//   enterT (s)                               → appear: rise out of the water and grow over APPEAR s from enterT
//   exitT | goneT (s, planned ASHORE time)   → disappear: the same in reverse over the last APPEAR s of a LEAVE
// Optional rider-system hook: app.riders.trail(id, age, out:Vector3) → world contact position `age` s ago
//   (sampled sim path); else rider.trail = [{x,y,z}, ...] newest first with rider.trailDt spacing.
import * as THREE from 'three';
import { RIDERS } from '../contracts.js';
import { SurferModel, surferPose, blendPose } from './models/surfer.js';
import { DolphinModel, dolphinPose } from './models/dolphin.js';
import { SealModel, sealPose } from './models/seal.js';
import { TurtleModel, turtlePose } from './models/turtle.js';
import { Wake, wakeUniforms } from './models/wake.js';
import { surfaceHeight } from '../wave/field.js';

export const DEFAULT_RIDER_SCALE = 1.4;
const XFADE = 0.3;
export const APPEAR = 0.5;       // s: fade (sink + grow) in after enterT / out before exitT
const APPEAR_SINK = { surfer: 1.1, dolphin: 0.7, seal: 0.5, turtle: 0.45 };   // m below the contact point when hidden
const KINDS = new Set(['surfer', 'dolphin', 'seal', 'turtle']);
/** Model kind for a rider kind (unknown kinds → seal: a generic surface animal). */
export const modelKind = (kind) => (KINDS.has(kind) ? kind : 'seal');
const SURFER_MAX_BANK = 0.5;     // rad, soft
const RIDE_ACTIONS = new Set(['trim', 'bottomTurn', 'lipHit', 'cutback', 'crouch']);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (a, b, x) => { const s = clamp((x - a) / (b - a), 0, 1); return s * s * (3 - 2 * s); };
const lerp = (a, b, k) => a + (b - a) * k;
const lerpObj = (a, b, k) => { const o = {}; for (const key in b) o[key] = typeof b[key] === 'number' && typeof a[key] === 'number' ? a[key] + (b[key] - a[key]) * k : b[key]; return o; };

const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();

/** Rider frame matrix: x = fwd, y = up (orthogonalised), z = fwd × up; scaled by s; origin pos. */
const _v = new THREE.Vector3(), _c = new THREE.Vector3(), _q = new THREE.Quaternion();
/** maxBank (rad): soft cap on the roll of up about fwd relative to vertical (surfers: the sim's banked face normal
 *  plus a steep face can reach 50–60°, which with a stance perpendicular to the deck reads as a fall). */
export function riderFrame(r, s, out = new THREE.Matrix4(), maxBank = Infinity) {
  _x.set(r.fwd?.x ?? 1, r.fwd?.y ?? 0, r.fwd?.z ?? 0);
  if (_x.lengthSq() < 1e-8) _x.set(1, 0, 0);
  _x.normalize();
  _y.set(r.up?.x ?? 0, r.up?.y ?? 1, r.up?.z ?? 0);
  _y.addScaledVector(_x, -_y.dot(_x));
  if (_y.lengthSq() < 1e-8) _y.set(0, 1, 0).addScaledVector(_x, -_x.y);
  _y.normalize();
  if (Number.isFinite(maxBank)) {
    _v.set(0, 1, 0).addScaledVector(_x, -_x.y);
    if (_v.lengthSq() > 1e-6) {
      _v.normalize();
      const bank = Math.atan2(_c.crossVectors(_v, _y).dot(_x), _v.dot(_y)), ab = Math.abs(bank);
      if (ab > maxBank) {
        const nb = Math.sign(bank) * (maxBank + (ab - maxBank) * 0.25);
        _y.copy(_v).applyQuaternion(_q.setFromAxisAngle(_x, nb));
      }
    }
  }
  _z.crossVectors(_x, _y).normalize();
  out.makeBasis(_x.multiplyScalar(s), _y.multiplyScalar(s), _z.multiplyScalar(s));
  out.setPosition(r.pos?.x ?? 0, r.pos?.y ?? 0, r.pos?.z ?? 0);
  return out;
}

/**
 * Presence → appearance 0..1 (pure in (r, t)): 0 = hidden. Riders ASHORE / present === false are hidden; after
 * enterT they rise and grow in over APPEAR s; before exitT (or goneT) of a LEAVE they sink out over APPEAR s.
 */
export function appearance(r, t) {
  if (!r || r.present === false || r.state === 'ASHORE') return 0;
  let k = 1;
  if (Number.isFinite(r.enterT) && t >= r.enterT - 1e-6) k = Math.min(k, smooth(0, APPEAR, t - r.enterT));
  const exitT = Number.isFinite(r.exitT) ? r.exitT : r.goneT;
  if (r.state === 'LEAVE' && Number.isFinite(exitT)) k = Math.min(k, smooth(0, APPEAR, exitT - t));
  return k;
}

/** ENTER / LEAVE: paddle (surfers) / swim (animals) whatever the sim's cue; returns r itself otherwise. */
export function presenceRider(r, kind) {
  if (r.state !== 'ENTER' && r.state !== 'LEAVE') return r;
  const want = kind === 'surfer' ? 'paddle' : 'swim';
  if (r.action === want || (kind !== 'surfer' && (r.action === 'dive' || r.action === 'paddle'))) return r;
  return { ...r, action: want, prevAction: null };
}

function hashSeed(id) { return ((Math.imul((id | 0) + 1, 0x9e3779b1) >>> 0) % 1000) / 1000; }

/** Pose for any kind with the optional cross-fade from prevAction. */
export function evalPose(kind, r, t) {
  const seed = hashSeed(r.id);
  const one = (action, at) => {
    if (kind === 'surfer') return surferPose(action, at, t, seed, r.speed || 0);
    if (kind === 'dolphin') return dolphinPose(action, r.state, at, t, seed, r.speed || 0);
    if (kind === 'turtle') return turtlePose(action, r.state, at, t, seed, r.speed || 0);
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
function wakeParams(kind, r, a, goofy, t = 0) {
  const act = r.action || 'idle', s = clamp(r.actionT ?? 0, 0, 1), v = r.speed || 0;
  const o = { wake: 0, width: 0.45, spray: 0, side: 0, lift: 0, burst: 0, tailBack: 0.6 };
  const riding = RIDE_ACTIONS.has(act) || r.state === 'RIDE';
  const mirror = goofy ? -1 : 1;
  const env = Math.sin(Math.PI * s);
  if (kind === 'surfer') {
    if (act === 'paddle' || act === 'swim') { o.wake = 0.55 * smooth(0.2, 1.2, v); o.width = 0.4; o.tailBack = 0.2; }
    else if (act === 'idle') o.wake = 0;
    else if (act === 'wipe') { o.wake = 0.6 * (1 - smooth(0, 0.3, s)); o.burst = 0.8 * smooth(0.25, 0.35, s) * (1 - smooth(0.45, 0.65, s)); o.tailBack = -1.5; }
    else {
      o.wake = smooth(1.0, 5.0, v) * (act === 'pop' ? smooth(0.2, 0.8, s) : 1);
      o.width = 0.75;
      if (act === 'bottomTurn') { o.spray = 0.9 * env; o.side = -mirror; o.lift = 0.8; }
      else if (act === 'cutback') { o.spray = 1.0 * env; o.side = mirror; o.lift = 1.5; }
      else if (act === 'lipHit') { o.spray = 1.0 * smooth(0.3, 0.5, s) * (1 - smooth(0.6, 0.9, s)); o.lift = 3.5; o.side = 0; }
      else if (act === 'kickout') { o.spray = 0.7 * smooth(0.15, 0.3, s) * (1 - smooth(0.4, 0.6, s)); o.lift = 2; o.wake *= 1 - smooth(0.3, 0.5, s); }
      else if (riding) o.spray = 0.25 * smooth(3, 8, v) * (0.6 + 0.4 * Math.abs(Math.sin(t * 2.1 + r.id)));
    }
  } else {
    const jump = act === 'jump' || act === 'kickout';
    if (jump) { o.wake = 0; o.burst = 0.7 * (1 - smooth(0.0, 0.15, s)) + 0.9 * smooth(0.85, 0.97, s); o.tailBack = 0; }
    else if (act === 'wipe') { o.wake = 0.4; o.burst = 0.5 * env; }
    else if (riding || r.state === 'TAKEOFF') { o.wake = 0.9 * smooth(1, 4, v); o.width = kind === 'dolphin' ? 0.45 : 0.5; o.spray = 0.3 * smooth(3, 8, v); o.tailBack = kind === 'dolphin' ? 0.05 : 0.3; o.lift = -0.8; }
    else if (act === 'swim' || act === 'paddle') { o.wake = 0.5 * smooth(0.3, 1.5, v); o.width = 0.4; o.tailBack = 0.2; }
    if (kind === 'turtle') { o.wake *= 0.6; o.spray *= 0.6; o.width = Math.max(o.width, 0.5); }   // slow, broad, gentle
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
    // debug: ?riderwake=0 hides wakes and spray (isolates them in app stills)
    this._noWake = typeof location !== 'undefined' && new URLSearchParams(location.search).get('riderwake') === '0';
  }

  _ensure(r) {
    let e = this.models.get(r.id);
    if (e && (r.kind == null || e.srcKind === r.kind)) return e;
    if (e) { e.model.group.removeFromParent(); e.wake.ribbon.removeFromParent(); e.wake.spray.removeFromParent(); }
    const def = { ...(RIDERS.find((d) => d.id === r.id) || {}), ...r };
    if (!def.kind) return null;
    const mk = modelKind(def.kind);
    const model = mk === 'surfer' ? new SurferModel(def, this.sunDir) : mk === 'dolphin' ? new DolphinModel(def, this.sunDir)
      : mk === 'turtle' ? new TurtleModel(def, this.sunDir) : new SealModel(def, this.sunDir);
    model.group.traverse((o) => { if (o.isMesh) o.castShadow = true; });   // day cycle: riders on the beach / rocks cast
    const wake = new Wake(this.wakeU, def.id | 0);
    this.group.add(model.group, wake.ribbon, wake.spray);
    model.group.visible = wake.ribbon.visible = wake.spray.visible = false;
    e = { kind: mk, srcKind: def.kind, model, wake };
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

  /**
   * Animals: pos may be the water line (stub / fake drivers) or the body itself, already offset by the sim (WP6a:
   * submerged swimming, leaps). Airborne (pos clearly above the sea surface) → the body sits on pos and follows the
   * trajectory; otherwise the body centre goes to min(pos.y, surface − pose depth), so the sim's depth wins when it
   * is deeper and the pose's waterline (dorsal fin / head out) applies at the surface.
   */
  _surfaceAt(x, z) {
    try { return surfaceHeight(this.app.swell?.fronts || [], x, z, this._tNow); } catch { return NaN; }
  }

  _surface(r, t) {
    let w = r.pos.y;
    try { w = surfaceHeight(this.app.swell?.fronts || [], r.pos.x, r.pos.z, t); } catch { /* keep pos.y */ }
    return Number.isFinite(w) ? w : r.pos.y;
  }

  _waterline(r, a, t, scale) {
    const w = this._surface(r, t);
    const above = r.pos.y - w;
    if (above > 0.08) {
      a.depth = 0;
      // the sim's fwd may already follow the arc: then don't pitch twice
      a.pitch *= 1 - smooth(0.15, 0.45, Math.abs(r.fwd?.y ?? 0));
    } else {
      const centre = Math.min(r.pos.y, w - a.depth * scale);
      a.depth = (r.pos.y - centre) / scale;
    }
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
    for (const r0 of list) {
      if (!r0 || !r0.pos) continue;
      const e = this._ensure(r0);
      if (!e) continue;
      const vis = appearance(r0, t);
      if (vis <= 0) continue;                    // ASHORE / not present: hidden below (not in `seen`)
      seen.add(r0.id);
      const r = presenceRider(r0, e.kind);
      const a = evalPose(e.kind, r, t);
      // appear / leave: grow from 55 % and rise from below the surface (the water hides the start)
      const sc = scale * (vis < 1 ? lerp(0.55, 1, vis) : 1);
      const F = riderFrame(r, sc, this._frame, e.kind === 'surfer' ? SURFER_MAX_BANK : Infinity);
      if (e.kind !== 'surfer') this._waterline(r, a, t, sc);
      else if (a.board.lift > 0 && this._surface(r, t) < r.pos.y - 0.08) a.board.lift = 0;   // the sim already hops
      if (vis < 1) F.elements[13] -= (1 - vis) ** 2 * (APPEAR_SINK[e.kind] ?? 0.6) * scale;
      e.model.apply(F, a);
      e.model.group.visible = true;
      const goofy = e.kind === 'surfer' && e.model.look?.goofy;
      const wp = wakeParams(e.kind, r, a, goofy, t);
      if (vis < 1) { wp.wake *= vis; wp.spray *= vis; wp.burst *= vis; }
      wp.scale = scale;
      wp.surface = this._surfFn || (this._surfFn = (x, z) => this._surfaceAt(x, z));
      this._tNow = t;
      wp.fwd = _x.set(r.fwd?.x ?? 1, 0, r.fwd?.z ?? 0).normalize().clone();
      wp.right = new THREE.Vector3(-wp.fwd.z, 0, wp.fwd.x);
      if (this._noWake) { e.wake.ribbon.visible = e.wake.spray.visible = false; continue; }
      e.wake.update(t, this._trail(r), wp);
    }
    for (const [id, e] of this.models) {
      if (!seen.has(id)) e.model.group.visible = e.wake.ribbon.visible = e.wake.spray.visible = false;
    }
  }

  dispose() {
    this.group.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
    this.group.removeFromParent();
  }
}
