// BlueCurl Swell — input bus (WP3). Contract: src/contracts.js "input API".
//
// Every note and every config change becomes an InputEvent in `log`, quantised to the sim step it applies on.
// The log is the replay record: state(t) = f(cfg, log). The log is kept sorted by (t, seq).
import { DT, STEP_TOL, DEFAULT_CFG, laneToU } from '../contracts.js';

/** Smallest step boundary k·DT strictly after time t (with half a step tolerance). */
export const boundaryAfter = (t) => (Math.floor((t + STEP_TOL / 2) / DT) + 1) * DT;
/** Nearest step boundary to t (same rounding as contracts.stepsFor). */
export const quantize = (t) => Math.max(0, Math.floor(t / DT + 0.5 + STEP_TOL)) * DT;

/** Read a dotted config key ('pip.enabled'). */
export function cfgGet(cfg, key) {
  let o = cfg;
  for (const k of String(key).split('.')) { if (o == null) return undefined; o = o[k]; }
  return o;
}
/** Write a dotted config key. Used by the App (and tools/tests) to apply 'cfg' events. */
export function cfgSet(cfg, key, value) {
  const parts = String(key).split('.');
  let o = cfg;
  for (let i = 0; i < parts.length - 1; i++) {
    if (o[parts[i]] == null || typeof o[parts[i]] !== 'object') o[parts[i]] = {};
    o = o[parts[i]];
  }
  o[parts[parts.length - 1]] = value;
}
/** Apply one InputEvent of type 'cfg' to a live config object. No-op for other events. */
export function applyCfgEvent(cfg, ev) { if (ev && ev.type === 'cfg') cfgSet(cfg, ev.key, ev.value); }

/** Flatten a cfg override object into [key, value] pairs ({pip:{enabled:false}} → ['pip.enabled', false]). */
function flattenCfg(obj, prefix = '', out = []) {
  for (const k of Object.keys(obj)) {
    const v = obj[k], key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flattenCfg(v, key, out);
    else out.push([key, v]);
  }
  return out;
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const BPM_MIN = 40, BPM_MAX = 300, TRAVEL_MIN = 6, TRAVEL_MAX = 30;

export class InputBus {
  /** @param {() => number} now  current sim time (the time of the last applied step). */
  constructor(now = () => 0) {
    this.now = now;
    this.log = [];
    this.cfg = null;          // optional: the App may set input.cfg = app.cfg (used for keyboard cycling)
    this._cursor = 0; this._seq = 0; this._id = 0;
    this._drainedT = -Infinity;
    this._ons = new Map();    // id → 'on' event
    this._offs = new Set();   // ids with a logged 'off'
  }

  // ------------------------------------------------------------ timing
  /** Resolve a requested time to the step boundary it applies on (live → next boundary; past → clamped). */
  _resolve(time) {
    const floor = boundaryAfter(Math.max(this.now(), this._drainedT));
    if (time == null || !Number.isFinite(time)) return floor;
    const tq = quantize(time);
    return tq < floor - STEP_TOL / 2 ? floor : tq;
  }
  _insert(ev) {
    // keep log sorted by (t, seq); new events always have the largest seq
    let i = this.log.length;
    while (i > this._cursor && this.log[i - 1].t > ev.t) i--;
    this.log.splice(i, 0, ev);
    return ev;
  }

  // ------------------------------------------------------------ API
  impulse({ lane = 0, lanes = 8, scale = 1, velocity = 1, duration = null, time = null } = {}) {
    const id = ++this._id;
    const t = this._resolve(time);
    const on = { seq: this._seq++, t, type: 'on', id, lane, lanes, u: laneToU(lane, lanes), scale, velocity };
    if (duration != null && Number.isFinite(duration)) on.duration = duration;
    this._insert(on);
    this._ons.set(id, on);
    if (on.duration != null) this._logOff(id, Math.max(t + DT, quantize(t + duration)));
    return id;
  }

  release(id, time = null) {
    const on = this._ons.get(id);
    if (!on || this._offs.has(id)) return;
    let t = this._resolve(time);
    if (t < on.t + DT - STEP_TOL) t = on.t + DT;
    this._logOff(id, t);
  }

  _logOff(id, t) {
    const on = this._ons.get(id);
    this._offs.add(id);
    this._insert({ seq: this._seq++, t, type: 'off', id, duration: on ? t - on.t : undefined });
  }

  setConfig(key, value, time = null) {
    this._insert({ seq: this._seq++, t: this._resolve(time), type: 'cfg', key, value });
  }

  /** Events with ev.t <= t not yet returned, in seq order. */
  drainUntil(t) {
    const out = [];
    const lim = t + STEP_TOL / 2;
    while (this._cursor < this.log.length && this.log[this._cursor].t <= lim) out.push(this.log[this._cursor++]);
    if (t > this._drainedT) this._drainedT = t;
    if (out.length > 1) out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  /**
   * Replace the log. Accepts an InputEvent[] or a demo `{ version, cfg, log }`; cfg overrides become 'cfg' events
   * at t = 0 ahead of everything else. Events are quantised, sorted by (t, seq) and renumbered; 'on' events with a
   * duration but no 'off' get one.
   */
  load(logOrDemo) {
    const src = Array.isArray(logOrDemo) ? { log: logOrDemo } : (logOrDemo || {});
    const pre = src.cfg ? flattenCfg(src.cfg).map(([key, value]) => ({ t: 0, type: 'cfg', key, value })) : [];
    const evs = (src.log || []).map((e, i) => ({ ...e, t: quantize(e.t || 0), _o: Number.isFinite(e.seq) ? e.seq : i }));
    evs.sort((a, b) => a.t - b.t || a._o - b._o);
    this.log = []; this._ons = new Map(); this._offs = new Set();
    this._seq = 0; this._id = 0;
    for (const e of pre) this.log.push({ seq: this._seq++, ...e });
    for (const e of evs) {
      delete e._o;
      e.seq = this._seq++;
      if (e.type === 'on') {
        e.lanes = e.lanes ?? 8;
        if (e.u == null) e.u = laneToU(e.lane ?? 0, e.lanes);
        this._ons.set(e.id, e);
      } else if (e.type === 'off') this._offs.add(e.id);
      if (Number.isFinite(e.id)) this._id = Math.max(this._id, e.id);
      this.log.push(e);
    }
    // synthesise missing offs for 'on' events that carry a duration
    for (const [id, on] of this._ons) {
      if (!this._offs.has(id) && on.duration != null) {
        const t = Math.max(on.t + DT, quantize(on.t + on.duration));
        this._offs.add(id);
        this.log.push({ seq: this._seq++, t, type: 'off', id, duration: t - on.t });
      }
    }
    this.log.sort((a, b) => a.t - b.t || a.seq - b.seq);
    this.reset();
  }

  /** Rewind the drain cursor (replay from the start). */
  reset() { this._cursor = 0; this._drainedT = -Infinity; }

  /** Latest value of a config key: last logged change, else the live cfg, else the default. */
  _cfgValue(key) {
    for (let i = this.log.length - 1; i >= 0; i--) {
      const e = this.log[i];
      if (e.type === 'cfg' && e.key === key) return e.value;
    }
    const v = this.cfg ? cfgGet(this.cfg, key) : undefined;
    return v !== undefined ? v : cfgGet(DEFAULT_CFG, key);
  }

  /**
   * Keyboard: Digit/Numpad 1–8 → lanes 0–7 (Shift = soft 0.4), keyup releases. I = cycle bars, [ ] = bpm ∓5,
   * , . = travel ∓1 s, S = setSize 1..4, P = toggle PiP. Returns an unbind function. Safe in node.
   */
  bindKeyboard(target = (typeof window !== 'undefined' ? window : null)) {
    if (!target || typeof target.addEventListener !== 'function') return () => {};
    const held = new Map(); // code → impulse id
    const laneOf = (e) => {
      const m = /^(?:Digit|Numpad)([1-8])$/.exec(e.code || '');
      if (m) return +m[1] - 1;
      if (!e.code && /^[1-8]$/.test(e.key || '')) return +e.key - 1;
      return -1;
    };
    const typing = (e) => {
      const el = e.target;
      return !!(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || '')));
    };
    const onDown = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || typing(e)) return;
      const lane = laneOf(e);
      if (lane >= 0) {
        if (e.repeat || held.has(e.code || e.key)) return;
        held.set(e.code || e.key, this.impulse({ lane, lanes: 8, scale: 1, velocity: e.shiftKey ? 0.4 : 1.0 }));
        e.preventDefault?.();
        return;
      }
      if (e.repeat) return;
      const code = e.code || '';
      let handled = true;
      if (code === 'KeyI') {
        const opts = this._cfgValue('barsOptions') || [2, 8, 16], cur = this._cfgValue('bars');
        const i = opts.indexOf(cur);
        this.setConfig('bars', opts[(i + 1) % opts.length]);
      } else if (code === 'BracketLeft' || code === 'BracketRight') {
        const d = code === 'BracketLeft' ? -5 : 5;
        this.setConfig('bpm', clamp(this._cfgValue('bpm') + d, BPM_MIN, BPM_MAX));
      } else if (code === 'Comma' || code === 'Period') {
        const d = code === 'Comma' ? -1 : 1;
        this.setConfig('travel', clamp(this._cfgValue('travel') + d, TRAVEL_MIN, TRAVEL_MAX));
      } else if (code === 'KeyS') {
        this.setConfig('setSize', (clamp(Math.round(this._cfgValue('setSize')), 1, 4) % 4) + 1);
      } else if (code === 'KeyP') {
        this.setConfig('pip.enabled', !this._cfgValue('pip.enabled'));
      } else handled = false;
      if (handled) e.preventDefault?.();
    };
    const onUp = (e) => {
      const k = e.code || e.key;
      if (!held.has(k)) return;
      this.release(held.get(k));
      held.delete(k);
    };
    const onBlur = () => { for (const id of held.values()) this.release(id); held.clear(); };
    target.addEventListener('keydown', onDown);
    target.addEventListener('keyup', onUp);
    target.addEventListener('blur', onBlur);
    return () => {
      target.removeEventListener?.('keydown', onDown);
      target.removeEventListener?.('keyup', onUp);
      target.removeEventListener?.('blur', onBlur);
    };
  }
}
