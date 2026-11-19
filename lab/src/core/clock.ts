// Fixed-step simulation clock. The simulation advances in exact 1/120 s ticks so runs are
// deterministic and replayable; rendering happens at display rate on the latest tick.

export const SIM_HZ = 120;
export const SIM_DT = 1 / SIM_HZ;

export class SimClock {
  /** Simulation time in seconds (always a whole number of ticks). */
  time = 0;
  tick = 0;
  paused = false;
  /** 0.05–2: slow motion / fast forward. */
  timeScale = 1;
  private acc = 0;
  private pendingSteps = 0;

  /** Queue `frames` render frames worth of sim time (1/60 s each) while paused. */
  stepFrames(frames = 1): void {
    this.pendingSteps += Math.round((frames * SIM_HZ) / 60);
  }

  /** Returns the number of fixed ticks to run for this render frame. */
  advance(realDt: number): number {
    let n = 0;
    if (!this.paused) {
      this.acc += Math.min(realDt, 0.1) * this.timeScale;
      n = Math.floor(this.acc / SIM_DT + 1e-9);
      this.acc -= n * SIM_DT;
    }
    n += this.pendingSteps;
    this.pendingSteps = 0;
    return Math.min(n, 24);
  }

  onTick(): void {
    this.tick++;
    this.time = this.tick * SIM_DT;
  }

  reset(): void {
    this.tick = 0;
    this.time = 0;
    this.acc = 0;
    this.pendingSteps = 0;
  }
}

/** Mulberry32 seeded PRNG (public domain). */
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth 1D value noise in [-1, 1], deterministic per seed. */
export function makeNoise1(seed: number): (t: number) => number {
  const rnd = mulberry32(seed);
  const N = 256;
  const tab = new Float32Array(N);
  for (let i = 0; i < N; i++) tab[i] = rnd() * 2 - 1;
  return (t: number) => {
    const i = Math.floor(t);
    const f = t - i;
    const u = f * f * f * (f * (f * 6 - 15) + 10);
    const a = tab[((i % N) + N) % N];
    const b = tab[(((i + 1) % N) + N) % N];
    return a + (b - a) * u;
  };
}

/** Pink-ish noise: octaves at the given frequencies with 1/f amplitudes, normalised to ~[-1, 1]. */
export function makePinkNoise(seed: number, freqs = [0.25, 0.7, 1.8, 4.0]): (t: number) => number {
  const ns = freqs.map((_, i) => makeNoise1(seed * 7919 + i * 104729));
  const amps = freqs.map((f) => 1 / f);
  const sum = amps.reduce((a, b) => a + b, 0);
  const rnd = mulberry32(seed);
  const phases = freqs.map(() => rnd() * 100);
  return (t: number) => {
    let s = 0;
    for (let i = 0; i < freqs.length; i++) s += amps[i] * ns[i](t * freqs[i] + phases[i]);
    return s / sum * 1.6;
  };
}
