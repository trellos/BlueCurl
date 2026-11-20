// BlueCurl Swell — beat audio (WP11). Contract: contracts.js "beat". Output only: never feeds the sim.
//
// Web Audio, fully synthesized (oscillators + one shared seeded noise buffer, envelopes, filters). The pattern
// for each measure comes from patterns.js (level 1 = metronome with an accented high click on the 1 … level 8 =
// full surf/tropical groove); BeatScheduler picks the hits per frame in sim time.
//
// Timing: ctxTime = anchor + simT with anchor chosen so a hit sounds LATENCY s after the sim reaches it.
// Re-anchored on start, resume after pause, rewind/jump, AudioContext (re)start and when the error exceeds
// REANCHOR_ERR; small clock drift is slewed out (≤ 0.25 ms per frame). Pausing / rewinding cuts the voices that
// were already scheduled ahead (bus swap) so nothing plays while paused. Not called in capture mode.
//
// Mic caveat: the beat plays through the speakers and a guitar mic may hear it. Voices are short and percussive;
// the clicks/claves sit above the guitar's fundamental range (> 1.6 kHz); congas/bongos/toms are pitched but
// decay in < 0.3 s. Default volume is moderate (cfg.beat.volume 0.7 × MASTER).
import { mulberry32 } from '../contracts.js';
import { BeatScheduler } from './scheduler.js';

export const LATENCY = 0.07;        // s, sim time → sound
export const LOOKAHEAD = 0.12;      // s of sim time scheduled ahead each frame
const REANCHOR_ERR = 0.03;          // s
const MASTER = 0.55;                // master gain at volume 1
const LATE_DROP = 0.01;             // s: hits whose time already passed by more than this are dropped

export class BeatAudio {
  constructor(app) {
    this.app = app;
    this.ctx = null;
    this.latency = LATENCY;
    this.scheduler = new BeatScheduler({ lookahead: LOOKAHEAD });
    this.anchor = null;
    this._wasRunning = false;
    this.stats = { hits: 0, late: 0, reanchors: 0, byInst: {}, lastMs: 0, avgMs: 0, maxMs: 0, recent: [] };
    this.debug = false;             // true → keep the last 4096 scheduled hits in stats.recent
    this._onKey = (e) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.code !== 'KeyM') return;
      const el = e.target;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || ''))) return;
      this.app.input?.setConfig('beat.mute', !this.app.cfg.beat?.mute);
      e.preventDefault?.();
    };
    if (typeof window !== 'undefined') window.addEventListener('keydown', this._onKey);
  }

  get state() { return this.ctx ? this.ctx.state : 'off'; }
  get outputLatency() { return this.ctx ? (this.ctx.outputLatency || this.ctx.baseLatency || 0) : 0; }

  /** Create / resume the AudioContext (call from a user gesture). */
  unlock() {
    if (this.app.capture) return;
    try {
      if (!this.ctx) {
        const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
        if (!AC) return;
        this.ctx = new AC({ latencyHint: 'interactive' });
        this._build();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    } catch (e) { console.warn('BeatAudio', e); }
  }

  _build() {
    const ctx = this.ctx;
    // shared 1 s seeded white noise (deterministic, no Math.random)
    const n = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, n, n);
    const d = this.noise.getChannelData(0), rnd = mulberry32(0xbea7);
    for (let i = 0; i < n; i++) d[i] = rnd() * 2 - 1;
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -10; this.comp.knee.value = 6; this.comp.ratio.value = 4;
    this.comp.attack.value = 0.003; this.comp.release.value = 0.12;
    this.master = ctx.createGain();
    this.master.gain.value = this._masterGain();
    this.master.connect(this.comp).connect(ctx.destination);
    this._newBus();
  }

  _masterGain() {
    const b = this.app.cfg.beat || {};
    return b.mute ? 0 : MASTER * Math.max(0, Math.min(1, Number(b.volume ?? 0.7)));
  }

  /** Fresh voice bus; the old one (with voices already scheduled ahead) is faded out and dropped. */
  _newBus() {
    const ctx = this.ctx, now = ctx.currentTime;
    if (this.bus) {
      const old = this.bus;
      old.gain.cancelScheduledValues(now);
      old.gain.setValueAtTime(old.gain.value, now);
      old.gain.linearRampToValueAtTime(0, now + 0.01);
      setTimeout(() => { try { old.disconnect(); } catch {} }, 100);
    }
    this.bus = ctx.createGain();
    this.bus.connect(this.master);
  }

  /** Called on every sim rewind. */
  reset() {
    this.scheduler.reset();
    this.anchor = null;
    if (this.ctx && this.bus) this._newBus();
  }

  /** Called once per rendered frame (live loop only) with the sim time. */
  update(t) {
    const app = this.app;
    if (app.capture) return;
    const ctx = this.ctx;
    const running = !!ctx && ctx.state === 'running';
    if (!running || app.paused || !app.beat) {
      if (running && app.paused && this.anchor != null) { this._newBus(); }   // cut what was scheduled ahead
      if (this.anchor != null) this.anchor = null;
      this._wasRunning = false;
      this.scheduler.seek(t);                     // resume from here (no catch-up burst)
      return;
    }
    const c0 = performance.now();
    // master volume / mute (output only)
    const g = this._masterGain();
    if (Math.abs(this.master.gain.value - g) > 1e-4) this.master.gain.setTargetAtTime(g, ctx.currentTime, 0.015);

    const now = ctx.currentTime;
    const want = now + this.latency - t;
    const { hits, jumped } = this.scheduler.frame(t, app.beat, this._out || (this._out = []));
    if (this.anchor == null || jumped || !this._wasRunning || Math.abs(this.anchor - want) > REANCHOR_ERR) {
      // a jump (rewind / skip) cuts the voices scheduled on the old timeline; a plain drift re-anchor keeps them
      // (the scheduler cursor already moved past them, so cutting would drop hits)
      if (this.anchor != null && jumped) this._newBus();
      this.anchor = want;
      this.stats.reanchors++;
    } else {
      // slew small drift between the audio clock and the frame clock (≤ 0.25 ms per frame)
      this.anchor += Math.max(-0.00025, Math.min(0.00025, want - this.anchor)) * 0.5;
    }
    this._wasRunning = true;
    if (g > 0) {
      for (const h of hits) {
        let when = this.anchor + h.t;
        if (when < now - LATE_DROP) { this.stats.late++; continue; }
        if (when < now) when = now;
        this._play(h.inst, when, h.vel);
        this.stats.hits++;
        this.stats.byInst[h.inst] = (this.stats.byInst[h.inst] || 0) + 1;
        if (this.debug) { const r = this.stats.recent; r.push({ ...h, when }); if (r.length > 4096) r.shift(); }
      }
    }
    hits.length = 0;
    const ms = performance.now() - c0;
    this.stats.lastMs = ms;
    this.stats.avgMs += (ms - this.stats.avgMs) * 0.02;
    if (ms > this.stats.maxMs) this.stats.maxMs = ms;
  }

  // ---------------------------------------------------------------- voices
  _env(when, peak, attack, decay) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(peak, when + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, when + attack + decay);
    g.connect(this.bus);
    return g;
  }
  _tone(when, type, f0, f1, sweep, peak, decay, attack = 0.001) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, when);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, when + sweep);
    o.connect(this._env(when, peak, attack, decay));
    o.start(when); o.stop(when + attack + decay + 0.02);
  }
  _noise(when, ftype, freq, q, peak, decay, attack = 0.001) {
    const ctx = this.ctx;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = ftype; f.frequency.value = freq; f.Q.value = q;
    s.connect(f).connect(this._env(when, peak, attack, decay));
    // offset into the noise buffer from the hit time (deterministic, varies hit to hit)
    const off = ((when * 7919.123) % 0.8 + 0.8) % 0.8;
    s.start(when, off, attack + decay + 0.02);
  }

  _play(inst, when, v) {
    switch (inst) {
      case 'clickHi':   // accented "1": bright woodblock-like blip, above the guitar range
        this._tone(when, 'sine', 2400, 2400, 0, 0.55 * v, 0.035);
        this._noise(when, 'highpass', 5000, 0.7, 0.25 * v, 0.006);
        break;
      case 'click':
        this._tone(when, 'sine', 1600, 1600, 0, 0.4 * v, 0.03);
        this._noise(when, 'highpass', 5000, 0.7, 0.15 * v, 0.005);
        break;
      case 'kick':
        this._tone(when, 'sine', 150, 46, 0.11, 1.0 * v, 0.26);
        this._noise(when, 'lowpass', 1800, 0.7, 0.18 * v, 0.008);
        break;
      case 'hat':
        this._noise(when, 'highpass', 7500, 0.8, 0.32 * v, 0.035);
        break;
      case 'ohat':
        this._noise(when, 'highpass', 6800, 0.8, 0.26 * v, 0.17);
        break;
      case 'clap': {      // three quick bursts + short tail
        for (let i = 0; i < 3; i++) this._noise(when + i * 0.011, 'bandpass', 1300, 1.4, 0.55 * v, 0.009);
        this._noise(when + 0.03, 'bandpass', 1200, 1.1, 0.45 * v, 0.11);
        break;
      }
      case 'rim':
        this._tone(when, 'triangle', 1750, 1750, 0, 0.3 * v, 0.025);
        this._noise(when, 'bandpass', 3200, 2, 0.35 * v, 0.02);
        break;
      case 'shaker':
        this._noise(when, 'bandpass', 6200, 0.9, 0.3 * v, 0.045, 0.008);
        break;
      case 'congaHi':
        this._tone(when, 'sine', 360, 320, 0.03, 0.55 * v, 0.14);
        this._noise(when, 'bandpass', 2400, 1.5, 0.12 * v, 0.01);
        break;
      case 'congaLo':
        this._tone(when, 'sine', 240, 205, 0.04, 0.6 * v, 0.2);
        this._noise(when, 'bandpass', 1800, 1.5, 0.1 * v, 0.01);
        break;
      case 'bongo':
        this._tone(when, 'sine', 520, 470, 0.02, 0.45 * v, 0.08);
        this._noise(when, 'bandpass', 3500, 1.5, 0.12 * v, 0.008);
        break;
      case 'tomHi':  this._tone(when, 'sine', 210, 150, 0.08, 0.8 * v, 0.22); break;
      case 'tomMid': this._tone(when, 'sine', 160, 112, 0.09, 0.85 * v, 0.25); break;
      case 'tomLo':  this._tone(when, 'sine', 120, 80, 0.1, 0.9 * v, 0.3); break;
      case 'crash':
        this._noise(when, 'highpass', 4200, 0.6, 0.35 * v, 0.9, 0.002);
        this._noise(when, 'bandpass', 9000, 0.8, 0.2 * v, 0.5, 0.002);
        break;
      case 'clave':
        this._tone(when, 'sine', 2100, 2100, 0, 0.42 * v, 0.05);
        break;
      default: break;
    }
  }

  dispose() {
    if (typeof window !== 'undefined') window.removeEventListener('keydown', this._onKey);
    try { this.ctx?.close(); } catch {}
    this.ctx = null;
  }
}
