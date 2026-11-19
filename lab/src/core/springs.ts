// Spring and damper library (closed-form, frame-rate independent).
// Ported from the formulas in Daniel Holden's "Spring-It-On" (MIT): halflife-parameterised
// critically damped springs. Allocation-free: state lives in small plain objects.

const LN2 = Math.LN2;

export function halflifeToDamping(halflife: number): number {
  return (4 * LN2) / (halflife + 1e-5);
}

/** Cheap, accurate-enough exp(-x) for x >= 0. */
export function fastNegExp(x: number): number {
  return 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
}

/** Exponential damper: move x toward goal, halving the gap every `halflife` seconds. */
export function damp(x: number, goal: number, halflife: number, dt: number): number {
  return x + (goal - x) * (1 - fastNegExp((0.69314718056 * dt) / (halflife + 1e-5)));
}

export function dampAngle(a: number, goal: number, halflife: number, dt: number): number {
  return a + wrapPi(goal - a) * (1 - fastNegExp((0.69314718056 * dt) / (halflife + 1e-5)));
}

export function wrapPi(a: number): number {
  a = (a + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a - Math.PI;
}

/** 1D critically damped spring with velocity. */
export class Spring1 {
  x = 0;
  v = 0;
  constructor(x = 0) {
    this.x = x;
  }
  reset(x: number): void {
    this.x = x;
    this.v = 0;
  }
  /** Critically damped step toward `goal`. */
  step(goal: number, halflife: number, dt: number): number {
    const y = halflifeToDamping(halflife) / 2;
    const j0 = this.x - goal;
    const j1 = this.v + j0 * y;
    const eydt = fastNegExp(y * dt);
    this.x = eydt * (j0 + j1 * dt) + goal;
    this.v = eydt * (this.v - j1 * y * dt);
    return this.x;
  }
}

/**
 * Asymmetric critically damped spring: fast "attack" when the goal moves away from the
 * neutral value (|goal - neutral| > |x - neutral|), slower "release" when returning.
 * This is how inputs show on the next frame without snapping back abruptly.
 */
export class AsymSpring {
  readonly s: Spring1;
  attack: number;
  release: number;
  neutral: number;
  constructor(attack: number, release: number, neutral = 0, x = neutral) {
    this.attack = attack;
    this.release = release;
    this.neutral = neutral;
    this.s = new Spring1(x);
  }
  get x(): number {
    return this.s.x;
  }
  get v(): number {
    return this.s.v;
  }
  reset(x: number): void {
    this.s.reset(x);
  }
  step(goal: number, dt: number): number {
    const away = Math.abs(goal - this.neutral) > Math.abs(this.s.x - this.neutral);
    return this.s.step(goal, away ? this.attack : this.release, dt);
  }
}

/**
 * Under-damped mass-spring (semi-implicit Euler, call at fixed steps). Used for inertial lag:
 * the body is thrown by unplanned accelerations, overshoots and recovers.
 * f0 in Hz, zeta damping ratio. `force` is an acceleration input (m/s^2-like units).
 */
export class MassSpring {
  x = 0;
  v = 0;
  step(force: number, f0: number, zeta: number, dt: number, target = 0): number {
    const w = 2 * Math.PI * f0;
    const a = -w * w * (this.x - target) - 2 * zeta * w * this.v + force;
    this.v += a * dt;
    this.x += this.v * dt;
    return this.x;
  }
  reset(x = 0): void {
    this.x = x;
    this.v = 0;
  }
}
