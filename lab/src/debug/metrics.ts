// Acceptance metrics run (deterministic, no real time): foot drift, lean vs atan(v²/rg),
// body-leads-board timing, per-frame rider CPU. Exposed as window.__lab.metrics(...).

import * as THREE from 'three';
import type { Lab } from '../app.ts';
import type { RiderSystem } from '../riderSystem.ts';
import type { OverlaySystem } from './overlays.ts';
import type { StreamSystem } from '../streamSystem.ts';
import type { ManeuverKind } from '../surfsim/boardMotion.ts';
import type { StreamPreset } from '../stream/simulator.ts';

export interface MetricsOptions {
  seconds: number;
  stream?: StreamPreset;
  seed?: number;
  /** [time, maneuver] commits (in addition to the stream). */
  script?: Array<[number, ManeuverKind]>;
  stability?: number;
  chop?: number;
}

function pct(a: number[], p: number): number {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
}

export function runMetrics(lab: Lab, rs: RiderSystem, ov: OverlaySystem, ss: StreamSystem, o: MetricsOptions) {
  const prevPreset = ss.sim.preset;
  ss.sim.preset = o.stream ?? 'off';
  if (o.seed) ss.sim.seed = o.seed;
  const prevStab = rs.rider.p.stabilityOverride;
  if (o.stability !== undefined) rs.rider.p.stabilityOverride = o.stability;
  const prevChop = lab.wave.p.chop;
  if (o.chop !== undefined) lab.wave.p.chop = o.chop;
  lab.reset();
  const frames = Math.round(o.seconds * 60);
  const script = [...(o.script ?? [])].sort((a, b) => a[0] - b[0]);
  const footErr: number[] = [];
  const riderMs: number[] = [];
  const lean: number[] = [];
  const theory: number[] = [];
  const roll: number[] = [];
  const be: number[] = [];
  const ec: number[] = [];
  const et: number[] = [];
  const fe: number[] = [];
  const st: number[] = [];
  let falls = 0;
  let steps = 0;
  let wasFallen = false;
  let wasStep = false;
  // warm-up (JIT) is part of the run but excluded from CPU stats
  for (let f = 0; f < frames; f++) {
    const t = lab.clock.time;
    while (script.length && script[0][0] <= t) lab.commit(script.shift()![1]);
    lab.advanceFrames(1, false);
    const r = rs.rider;
    if (f > 120) riderMs.push(rs.lastMs);
    const stepping = r.footErrorMm.some((x) => Number.isNaN(x));
    if (stepping && !wasStep) steps++;
    wasStep = stepping;
    if (r.fallen > 0 && !wasFallen) falls++;
    wasFallen = r.fallen > 0;
    if (r.fallen === 0) for (const e of r.footErrorMm) if (!Number.isNaN(e)) footErr.push(e);
    lean.push(ov.leanDeg);
    theory.push(ov.leanTheoryDeg);
    // board roll (world) across the heading, for the lead/lag measurement
    roll.push(boardRollDeg(lab));
    be.push(r.balanceError);
    ec.push(r.eCom);
    et.push(r.eTilt);
    fe.push(Math.max(...r.footErrorMm.map((x) => (Number.isNaN(x) ? -1 : x))));
    st.push(r.fallen > 0 ? 2 : stepping ? 1 : 0);
  }
  // lag of body lean vs board roll by cross-correlation (positive = body leads)
  const lag = bestLag(lean, roll, 40);
  const lagTheory = bestLag(lean, theory, 40);
  let maxAbsLean = 0;
  let maxAbsTheory = 0;
  for (let i = 0; i < lean.length; i++) {
    maxAbsLean = Math.max(maxAbsLean, Math.abs(lean[i]));
    maxAbsTheory = Math.max(maxAbsTheory, Math.abs(theory[i]));
  }
  ss.sim.preset = prevPreset;
  rs.rider.p.stabilityOverride = prevStab;
  lab.wave.p.chop = prevChop;
  return {
    seconds: o.seconds,
    footErrorMm: { max: Math.max(0, ...footErr), p99: pct(footErr, 0.99), mean: footErr.reduce((a, b) => a + b, 0) / Math.max(1, footErr.length) },
    riderCpuMs: { mean: riderMs.reduce((a, b) => a + b, 0) / Math.max(1, riderMs.length), p95: pct(riderMs, 0.95), max: Math.max(0, ...riderMs) },
    lean: {
      maxAbsLeanDeg: maxAbsLean,
      maxAbsTheoryDeg: maxAbsTheory,
      rmsErrorDeg: Math.sqrt(lean.reduce((a, v, i) => a + (v - theory[i]) ** 2, 0) / lean.length),
      bodyLeadsBoardRollMs: (lag * 1000) / 60,
      bodyVsTheoryLagMs: (lagTheory * 1000) / 60,
    },
    steps,
    falls,
    series: { lean: decimate(lean), theory: decimate(theory), roll: decimate(roll), balanceError: decimate(be), eCom: decimate(ec, 3), eTilt: decimate(et, 3), footErr: decimate(fe), state: decimate(st) },
  };
}

function decimate(a: number[], k = 6): number[] {
  const out: number[] = [];
  for (let i = 0; i < a.length; i += k) out.push(Math.round(a[i] * 10) / 10);
  return out;
}

/** Lag (frames) maximising the correlation of a(t) with b(t + lag): positive = a leads b. */
function bestLag(a: number[], b: number[], maxLag: number): number {
  let best = 0;
  let bestC = -Infinity;
  const ma = a.reduce((x, y) => x + y, 0) / a.length;
  const mb = b.reduce((x, y) => x + y, 0) / b.length;
  for (let L = -maxLag; L <= maxLag; L++) {
    let c = 0;
    for (let i = Math.max(0, -L); i < a.length && i + L < b.length; i++) c += (a[i] - ma) * (b[i + L] - mb);
    if (c > bestC) {
      bestC = c;
      best = L;
    }
  }
  return best;
}

function boardRollDeg(lab: Lab): number {
  const S = lab.motion.state;
  const h = S.velocity.clone().setY(0);
  if (h.lengthSq() < 0.25) return 0;
  h.normalize();
  const v = new THREE.Vector3(0, 1, 0).applyQuaternion(S.quaternion);
  return (Math.atan2(v.x * -h.z + v.z * h.x, v.y) * 180) / Math.PI;
}
