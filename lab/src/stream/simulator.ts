// Performance-stream simulator: one packet every 500 ms (magnitude, stability, events).
// Deterministic per seed. Packets are applied immediately (no playout delay, owner decision).
// Maneuver events are requests: the lab commits them, the body starts on the next frame and
// the board follows ~0.2 s later.

import { mulberry32 } from '../core/clock.ts';
import type { StreamPacket } from '../rider/rider.ts';
import type { ManeuverKind } from '../surfsim/boardMotion.ts';

export type StreamPreset = 'off' | 'cruise' | 'escalating' | 'struggling' | 'wipeout';
export const PACKET_DT = 0.5;

const MANEUVERS: ManeuverKind[] = ['pump', 'bottomTurn', 'topTurn', 'cutback'];

export class StreamSimulator {
  preset: StreamPreset = 'cruise';
  seed = 1;
  /** Packets emitted so far (the recorder). */
  readonly log: StreamPacket[] = [];
  private next = 0;
  private rng = mulberry32(1);
  private lastManeuverT = -10;
  private busyUntil = 0;

  reset(): void {
    this.next = 0;
    this.log.length = 0;
    this.rng = mulberry32(this.seed);
    this.lastManeuverT = -10;
    this.busyUntil = 0;
  }

  /** Call every tick; returns a packet when one is due at time t. */
  poll(t: number): StreamPacket | null {
    if (this.preset === 'off' || t + 1e-9 < this.next) return null;
    const k = Math.round(this.next / PACKET_DT);
    this.next += PACKET_DT;
    const pk = this.make(k * PACKET_DT);
    this.log.push(pk);
    return pk;
  }

  private make(t: number): StreamPacket {
    const r = this.rng;
    const n = () => r() * 2 - 1;
    let magnitude = 0.5;
    let stability = 0.85;
    const events: string[] = [];
    let maneuverEvery = 5;
    switch (this.preset) {
      case 'cruise':
        magnitude = 0.5 + 0.06 * n();
        stability = 0.85 + 0.05 * n();
        maneuverEvery = 5.5;
        break;
      case 'escalating': {
        const k = Math.min(1, t / 40);
        magnitude = 0.2 + 0.8 * k + 0.04 * n();
        stability = 0.8 + 0.15 * k + 0.03 * n();
        maneuverEvery = 7 - 4 * k;
        if (k > 0.5 && r() < 0.06) events.push('great');
        break;
      }
      case 'struggling':
        magnitude = 0.3 + 0.05 * n();
        stability = 0.45 + 0.15 * Math.sin(t * 0.7) + 0.05 * n();
        maneuverEvery = 9;
        if (r() < 0.12) events.push('bad');
        break;
      case 'wipeout': {
        const k = Math.min(1, t / 9);
        magnitude = 0.45 - 0.2 * k;
        stability = 0.85 - 0.75 * k + 0.04 * n();
        maneuverEvery = 99;
        if (t > 4 && r() < 0.25 * k) events.push('bad');
        if (Math.abs(t - 10) < 1e-6) events.push('wipeout');
        break;
      }
    }
    if (t >= this.busyUntil && t - this.lastManeuverT >= maneuverEvery && t > 1.5) {
      // repertoire grows with magnitude
      const allowed = magnitude > 0.65 ? MANEUVERS : magnitude > 0.4 ? MANEUVERS.slice(0, 3) : MANEUVERS.slice(0, 2);
      const m = allowed[Math.floor(r() * allowed.length) % allowed.length];
      events.push(m);
      this.lastManeuverT = t;
      this.busyUntil = t + 3;
    }
    return { t, magnitude: clamp01(magnitude), stability: clamp01(stability), events };
  }
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}
