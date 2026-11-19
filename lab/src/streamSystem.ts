// Lab system: performance stream simulator + board-motion controls (manual sliders, impulses,
// maneuver generators) + stream recorder.

import type GUI from 'lil-gui';
import type { Lab, LabSystem } from './app.ts';
import type { RiderSystem } from './riderSystem.ts';
import { StreamSimulator, type StreamPreset } from './stream/simulator.ts';
import type { StreamPacket } from './rider/rider.ts';
import type { ManeuverKind } from './surfsim/boardMotion.ts';

const MANEUVER_EVENTS = new Set(['pump', 'bottomTurn', 'topTurn', 'cutback', 'chop']);

export class StreamSystem implements LabSystem {
  readonly sim = new StreamSimulator();
  last: StreamPacket | null = null;
  private riderSys: RiderSystem;

  constructor(riderSys: RiderSystem) {
    this.riderSys = riderSys;
  }

  init(lab: Lab): void {
    const q = new URLSearchParams(location.search);
    if (q.has('stream')) this.sim.preset = q.get('stream') as StreamPreset;
    if (q.has('seed')) this.sim.seed = parseInt(q.get('seed')!, 10);
    this.sim.reset();
    void lab;
  }

  reset(): void {
    this.sim.reset();
    this.last = null;
  }

  tick(lab: Lab, t: number): void {
    const pk = this.sim.poll(t);
    if (!pk) return;
    this.last = pk;
    this.riderSys.onPacket(pk);
    for (const e of pk.events) if (MANEUVER_EVENTS.has(e) && lab.motion.mode === 'generator') lab.commit(e as ManeuverKind);
  }

  gui(lab: Lab, gui: GUI): void {
    const f = gui.addFolder('Performance stream (500 ms)');
    f.add(this.sim, 'preset', ['off', 'cruise', 'escalating', 'struggling', 'wipeout']).onChange(() => lab.reset());
    f.add(this.sim, 'seed', 1, 99, 1).onFinishChange(() => lab.reset());
    const rec = {
      download: () => {
        const blob = new Blob([JSON.stringify({ preset: this.sim.preset, seed: this.sim.seed, packets: this.sim.log }, null, 1)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `stream_${this.sim.preset}_${this.sim.seed}.json`;
        a.click();
      },
    };
    f.add(rec, 'download').name('download recording (JSON)');

    const m = gui.addFolder('Board motion');
    m.add(lab.motion, 'mode', ['generator', 'manual']).onChange(() => lab.reset());
    const gen = {
      pump: () => lab.commit('pump'),
      bottomTurn: () => lab.commit('bottomTurn'),
      topTurn: () => lab.commit('topTurn'),
      cutback: () => lab.commit('cutback'),
      chop: () => lab.commit('chop'),
    };
    const g = m.addFolder('Generators (wave face)');
    g.add(gen, 'pump');
    g.add(gen, 'bottomTurn').name('bottom turn');
    g.add(gen, 'topTurn').name('top turn');
    g.add(gen, 'cutback');
    g.add(gen, 'chop').name('chop burst');
    g.add(lab.motion.params, 'trimSpeed', 4, 11, 0.1).name('trim speed (m/s)');
    g.add(lab.motion.params, 'trimLine', 0.1, 0.9, 0.01).name('trim line (face)');
    g.add(lab.motion.params, 'railFollow', 0, 1, 0.01).name('rail follow');
    g.add(lab.motion.params, 'boardLag', 0, 0.5, 0.01).name('board lag after body (s)');
    g.add(lab.wave.p, 'height', 0.6, 3, 0.05).name('wave height (m)');
    g.add(lab.wave.p, 'faceAngleDeg', 15, 45, 0.5).name('face angle (°)');
    g.add(lab.wave.p, 'chop', 0, 0.2, 0.005).name('chop (m)');
    g.add(lab.motion.params, 'chopGain', 0, 4, 0.05).name('chop → board gain');
    const man = m.addFolder('Manual');
    man.add(lab.motion.manual, 'pitchDeg', -25, 25, 0.5).name('pitch (°)');
    man.add(lab.motion.manual, 'rollDeg', -35, 35, 0.5).name('roll (°)');
    man.add(lab.motion.manual, 'yawDeg', -30, 30, 0.5).name('yaw (°)');
    man.add(lab.motion.manual, 'heave', -0.2, 0.2, 0.005).name('heave (m)');
    const imp = {
      bump: () => lab.motion.impulseKick('bump'),
      decel: () => lab.motion.impulseKick('decel'),
      lateral: () => lab.motion.impulseKick('lateral'),
    };
    man.add(imp, 'bump').name('impulse: chop bump');
    man.add(imp, 'decel').name('impulse: deceleration');
    man.add(imp, 'lateral').name('impulse: lateral kick');
  }
}
