// DOM overlay (toggle with H): fps, GPU ms, sim time, timing config, schedule countdown, fronts and
// their committed zone breaks, recent impulses, riders. Reads app state only; robust to stub systems.
import { intervalSec } from '../contracts.js';

const f = (v, d = 1) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '–');
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const CSS = `
#bc-hud { position: fixed; left: 10px; top: 10px; z-index: 10; max-width: min(640px, calc(100vw - 20px));
  max-height: calc(100vh - 20px); overflow: hidden; pointer-events: none; margin: 0;
  font: 11px/1.35 ui-monospace, SFMono-Regular, Consolas, monospace; color: #eaf6f4;
  background: rgba(6, 18, 24, 0.62); border: 1px solid rgba(120, 230, 220, 0.25); border-radius: 6px;
  padding: 8px 10px; white-space: pre; text-shadow: 0 1px 0 rgba(0,0,0,0.6); }
#bc-hud .k { color: #7fe3d6; } #bc-hud .g { color: #ffc65a; } #bc-hud .d { color: #9fb3b8; } #bc-hud .w { color: #ff8a5c; }
`;

export class Hud {
  constructor(app, { visible = true } = {}) {
    this.app = app;
    if (!document.getElementById('bc-hud-style')) {
      const st = document.createElement('style'); st.id = 'bc-hud-style'; st.textContent = CSS; document.head.appendChild(st);
    }
    this.el = document.createElement('pre');
    this.el.id = 'bc-hud';
    document.body.appendChild(this.el);
    this.visible = visible;
    this.el.style.display = visible ? '' : 'none';
    this.fps = null;
    this._frames = 0; this._acc = 0; this._sinceDraw = 1e9;
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
    this.el.innerHTML = this.text(app);
  }

  text(app) {
    const cfg = app.cfg || {}, swell = app.swell || {}, t = app.simTime;
    const L = [];
    const gpu = app.gpuTimer?.ms;
    L.push(`<span class="k">BlueCurl Swell</span>  t <span class="g">${f(t, 2)}</span> s   fps ${f(this.fps, 0)}   gpu ${gpu == null ? (app.gpuTimer?.available ? '…' : 'n/a') : f(gpu, 2) + ' ms'}${app.paused ? '   <span class="w">PAUSED</span>' : ''}${app.capture ? '   <span class="d">capture</span>' : ''}`);
    const iv = swell.schedule?.intervalSec ?? (cfg.bars ? intervalSec(cfg) : NaN);
    const next = swell.schedule?.nextPointT;
    L.push(`bpm ${cfg.bpm} · bars ${cfg.bars} · interval ${f(iv, 1)} s · travel ${f(cfg.travel, 1)} s · set ${cfg.setSize} × ${f(cfg.setSpacing, 1)} s`);
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
    L.push(`<span class="k">riders</span>${riders.length ? '' : ' –'}`);
    for (let i = 0; i < riders.length; i += 2) {
      L.push(' ' + riders.slice(i, i + 2).map((r) => `${esc(r.name).padEnd(6)} ${String(r.state).padEnd(8)} ${String(r.style ?? '-').padEnd(8)}`).join('  '));
    }
    const pip = app.cameraRig?.pip;
    if (pip) L.push(`pip ${cfg.pip?.enabled ? 'on' : 'off'}${pip.active ? ` → rider ${pip.riderId}` : ''}`);
    L.push('<span class="d">1–8 lanes (⇧ soft) · I bars · [ ] bpm · , . travel · S set · P pip · H hud · space pause</span>');
    return L.join('\n');
  }

  dispose() { this.el.remove(); }
}
