// DOM overlay (toggle with H): fps, GPU ms, sim time, timing config, schedule countdown, fronts and
// their committed zone breaks, recent impulses, riders, beat (level / target / notes / bar position), guitar.
// Reads app state only; robust to stub systems. The overlay ignores the pointer except for its control row
// (tempo slider + number, mute button); every control change goes through app.input.setConfig (logged).
import { intervalSec } from '../contracts.js';

const f = (v, d = 1) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '–');
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
/** MIDI number → note name with octave (60 → C4). */
export const midiToName = (m) => (Number.isFinite(m) ? NOTE[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1) : '–');
export const BPM_MIN = 40, BPM_MAX = 300;

const CSS = `
#bc-hud { position: fixed; left: 10px; top: 10px; z-index: 10; max-width: min(720px, calc(100vw - 20px));
  max-height: calc(100vh - 20px); overflow: hidden; pointer-events: none; margin: 0;
  font: 11px/1.35 ui-monospace, SFMono-Regular, Consolas, monospace; color: #eaf6f4;
  background: rgba(6, 18, 24, 0.62); border: 1px solid rgba(120, 230, 220, 0.25); border-radius: 6px;
  padding: 8px 10px; text-shadow: 0 1px 0 rgba(0,0,0,0.6); }
#bc-hud pre { margin: 0; font: inherit; white-space: pre; }
#bc-hud .k { color: #7fe3d6; } #bc-hud .g { color: #ffc65a; } #bc-hud .d { color: #9fb3b8; } #bc-hud .w { color: #ff8a5c; }
#bc-hud .on { color: #06121a; background: #7fe3d6; border-radius: 2px; }
#bc-hud .one { color: #ffc65a; font-weight: bold; } #bc-hud .one.on { color: #06121a; background: #ffc65a; }
#bc-hud .ctl { display: inline-flex; align-items: center; gap: 6px; margin-bottom: 4px; pointer-events: auto; }
#bc-hud .ctl input[type=range] { width: 150px; accent-color: #7fe3d6; margin: 0; }
#bc-hud .ctl input[type=number] { width: 48px; font: inherit; color: #eaf6f4; background: rgba(0,0,0,0.35);
  border: 1px solid rgba(120,230,220,0.35); border-radius: 3px; padding: 1px 3px; }
#bc-hud .ctl button { font: inherit; color: #eaf6f4; background: rgba(0,0,0,0.35); cursor: pointer;
  border: 1px solid rgba(120,230,220,0.35); border-radius: 3px; padding: 1px 6px; }
#bc-hud .ctl button.muted { color: #ff8a5c; border-color: rgba(255,138,92,0.6); }
`;

export class Hud {
  constructor(app, { visible = true } = {}) {
    this.app = app;
    if (!document.getElementById('bc-hud-style')) {
      const st = document.createElement('style'); st.id = 'bc-hud-style'; st.textContent = CSS; document.head.appendChild(st);
    }
    this.el = document.createElement('div');
    this.el.id = 'bc-hud';
    this._buildControls();
    this.pre = document.createElement('pre');
    this.el.appendChild(this.pre);
    document.body.appendChild(this.el);
    this.visible = visible;
    this.el.style.display = visible ? '' : 'none';
    this.fps = null;
    this._frames = 0; this._acc = 0; this._sinceDraw = 1e9;
  }

  _buildControls() {
    const ctl = document.createElement('div');
    ctl.className = 'ctl';
    ctl.innerHTML = `<span class="k">tempo</span><input type="range" min="${BPM_MIN}" max="${BPM_MAX}" step="1" aria-label="bpm">`
      + `<input type="number" min="${BPM_MIN}" max="${BPM_MAX}" step="1" aria-label="bpm value"><span class="d">bpm</span>`
      + `<button type="button" title="mute beat (M)">mute</button>`;
    this.el.appendChild(ctl);
    this.ctl = ctl;
    const [range, num] = ctl.querySelectorAll('input');
    const btn = ctl.querySelector('button');
    this.bpmRange = range; this.bpmNum = num; this.muteBtn = btn;
    const commit = (el) => {
      const v = Math.round(Number(el.value));
      if (Number.isFinite(v)) this.setBpm(v);
      el.blur();                                  // hand the keyboard back to the lanes / global keys
      this._syncControls(true);
    };
    range.addEventListener('input', () => { num.value = range.value; });        // preview; logged on release
    range.addEventListener('change', () => commit(range));
    num.addEventListener('change', () => commit(num));
    num.addEventListener('keydown', (e) => { if (e.key === 'Escape') { num.blur(); this._syncControls(true); } });
    btn.addEventListener('click', () => {
      this.app.input?.setConfig('beat.mute', !this.app.cfg.beat?.mute);
      btn.blur();
    });
    // keep keystrokes inside the control row from reaching window handlers when typing in the number box
    ctl.addEventListener('keydown', (e) => { if (e.target === num) e.stopPropagation(); });
  }

  /** Log a tempo change (clamped 40..300); swell and beat follow (beat from the next downbeat). */
  setBpm(v) {
    const bpm = Math.min(BPM_MAX, Math.max(BPM_MIN, Math.round(v)));
    if (bpm !== this.app.cfg.bpm) this.app.input?.setConfig('bpm', bpm);
    this._pendingBpm = bpm;
  }

  _syncControls(force = false) {
    const cfg = this.app.cfg || {};
    let bpm = cfg.bpm;
    if (this._pendingBpm != null) { if (this._pendingBpm === cfg.bpm) this._pendingBpm = null; else bpm = this._pendingBpm; }
    const active = document.activeElement;
    if (force || active !== this.bpmRange) { if (this.bpmRange.value !== String(bpm)) this.bpmRange.value = String(bpm); }
    if (force || active !== this.bpmNum) { if (this.bpmNum.value !== String(bpm)) this.bpmNum.value = String(bpm); }
    const muted = !!cfg.beat?.mute;
    if (this._muted !== muted) {
      this._muted = muted;
      this.muteBtn.textContent = muted ? 'unmute' : 'mute';
      this.muteBtn.classList.toggle('muted', muted);
    }
  }

  setVisible(v) { this.visible = !!v; this.el.style.display = this.visible ? '' : 'none'; if (this.visible) this._sinceDraw = 1e9; }
  toggle() { this.setVisible(!this.visible); }

  /** Called once per real frame with the wall-clock frame time (s); maintains the fps estimate. */
  frame(wallDt) {
    this._frames++; this._acc += wallDt; this._sinceDraw += wallDt;
    if (this._acc >= 0.5) { this.fps = this._frames / this._acc; this._frames = 0; this._acc = 0; }
  }

  update(app = this.app, force = false) {
    if (!this.visible) return;
    if (!force && this._sinceDraw < 0.12) return;       // ~8 Hz DOM updates
    this._sinceDraw = 0;
    this._syncControls();
    this.pre.innerHTML = this.text(app);
  }

  beatLines(app) {
    const L = [];
    const beat = app.beat, cfg = app.cfg || {};
    if (beat && Number.isFinite(beat.level)) {
      const max = beat.maxLevel ?? 8;
      const bars = '▮'.repeat(Math.max(0, Math.min(max, beat.level))) + '▯'.repeat(Math.max(0, max - beat.level));
      const ph = typeof beat.barPhase === 'function' ? beat.barPhase(app.simTime) : null;
      const pos = [0, 1, 2, 3].map((b) => `<span class="${b === 0 ? 'one' : ''}${ph && ph.beat === b ? ' on' : ''}">${b + 1}</span>`).join(' ');
      const nextTarget = Math.min(max, Math.max(1, beat.notes | 0));
      const barBpm = 240 / beat.measureLen;
      const bpmNote = Math.abs(barBpm - cfg.bpm) > 1e-6 ? ` <span class="d">(bar at ${f(barBpm, 0)}, ${cfg.bpm} from next bar)</span>` : '';
      L.push(`<span class="k">beat</span> <span class="g">${bars}</span> L${beat.level} → target ${beat.target} · notes ${beat.notes} <span class="d">(next ${nextTarget})</span> · bar ${beat.measure} · ${pos}${bpmNote}`);
    } else L.push('<span class="k">beat</span> –');
    const au = app.beatAudio;
    if (au) {
      const st = au.state;
      const muted = !!cfg.beat?.mute;
      const lat = au.latency != null ? `lat ${f(au.latency * 1000, 0)} ms + out ${f((au.outputLatency || 0) * 1000, 0)} ms` : '';
      const cpu = au.stats ? ` · ${f(au.stats.avgMs, 2)} ms cpu` : '';
      L.push(`  audio ${st === 'running' ? 'on' : st === 'off' ? '<span class="d">off (click / key to start)</span>' : esc(st)} · vol ${f(cfg.beat?.volume, 2)}${muted ? ' <span class="w">MUTED</span>' : ''} · ${lat}${cpu}`);
    }
    const gs = app.guitar?.status;
    if (gs) {
      const st = gs.state === 'listening' ? `<span class="g">listening</span>` : gs.state === 'error' ? `<span class="w">error</span>` : esc(gs.state ?? '–');
      const oct = Number.isFinite(gs.lowRoot) ? `${midiToName(gs.lowRoot)}–${midiToName(gs.lowRoot + 12)}` : '–';
      const last = gs.last ? `${esc(gs.last.name ?? '?')} → lane ${gs.last.lane ?? '–'}` : '–';
      L.push(`<span class="k">guitar</span> ${st} · ${esc(gs.key ?? '–')} · octave ${oct} · last ${last}${gs.message ? ` <span class="d">${esc(gs.message)}</span>` : ''}`);
    }
    return L;
  }

  text(app) {
    const cfg = app.cfg || {}, swell = app.swell || {}, t = app.simTime;
    const L = [];
    const gpu = app.gpuTimer?.ms;
    L.push(`<span class="k">BlueCurl Swell</span>  t <span class="g">${f(t, 2)}</span> s   fps ${f(this.fps, 0)}   gpu ${gpu == null ? (app.gpuTimer?.available ? '…' : 'n/a') : f(gpu, 2) + ' ms'}${app.paused ? '   <span class="w">PAUSED</span>' : ''}${app.capture ? '   <span class="d">capture</span>' : ''}`);
    const iv = swell.schedule?.intervalSec ?? (cfg.bars ? intervalSec(cfg) : NaN);
    const next = swell.schedule?.nextPointT;
    L.push(`bpm ${cfg.bpm} · bars ${cfg.bars} · interval ${f(iv, 1)} s · travel ${f(cfg.travel, 1)} s · set ${cfg.setSize} × ${f(cfg.setSpacing, 1)} s`);
    L.push(...this.beatLines(app));
    L.push(`next point break in <span class="g">${Number.isFinite(next) ? f(next - t, 1) + ' s' : '–'}</span>${Number.isFinite(next) ? ` <span class="d">(@ ${f(next, 1)} s)</span>` : ''}`);
    const fronts = Array.isArray(swell.fronts) ? swell.fronts : [];
    L.push(`<span class="k">fronts</span> ${fronts.length}`);
    for (const fr of fronts) {
      let E = 0;
      if (fr.energy) for (let i = 0; i < fr.energy.length; i++) E += fr.energy[i];
      L.push(` #${fr.id} x ${f(fr.x, 0).padStart(4)}  E ${f(E, 1).padStart(5)}  α ${f(fr.alpha, 2)}${fr.target ? '  <span class="g">◀ target</span>' : ''}`);
      for (const zb of fr.breaks || []) {
        const q = zb.quality || {};
        L.push(`   <span class="d">${esc(zb.zone).padEnd(6)}</span> H ${f(zb.H, 2)} st ${f(zb.steep, 2)} cu ${f(zb.curl, 2)} mu ${f(zb.mush, 2)} vP ${f(zb.vPeel, 1)} dir ${zb.dir}${zb.closeout ? ' <span class="w">CLOSEOUT</span>' : ''} sec ${zb.sections} Q sz ${f(q.size, 2)} st ${f(q.steepness, 2)} bt ${f(q.barrelTime, 2)} pl ${f(q.peelLength, 2)}`);
      }
    }
    const imps = Array.isArray(swell.impulses) ? swell.impulses.slice(-5) : [];
    L.push(`<span class="k">impulses</span>${imps.length ? '' : ' –'}`);
    for (const im of imps.reverse()) {
      L.push(` t ${f(im.t, 2)} lane ${im.lane}/${im.lanes} s ${f(im.strength, 2)} → ${im.frontId == null ? 'horizon' : '#' + im.frontId}${im.jump ? ' jump' : ''}`);
    }
    const riders = Array.isArray(app.riders?.riders) ? app.riders.riders : [];
    const present = riders.filter((r) => r.present !== false).length;
    L.push(`<span class="k">riders</span>${riders.length ? ` in the water <span class="g">${present}</span>/${riders.length}` : ' –'}`);
    for (let i = 0; i < riders.length; i += 2) {
      L.push(' ' + riders.slice(i, i + 2).map((r) => `${esc(r.name).padEnd(6)} ${String(r.state).padEnd(8)} ${String(r.style ?? '-').padEnd(8)}`).join('  '));
    }
    const pip = app.cameraRig?.pip;
    if (pip) L.push(`pip ${cfg.pip?.enabled ? 'on' : 'off'}${pip.active ? ` → rider ${pip.riderId}` : ''}`);
    L.push('<span class="d">1–8 lanes (⇧ soft) · G guitar · M mute · I bars · [ ] bpm · , . travel · S set · P pip · C camera · H hud · space pause</span>');
    return L.join('\n');
  }

  dispose() { this.el.remove(); }
}
