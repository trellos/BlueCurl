// Monotone cubic Hermite interpolation (Fritsch–Carlson). Cannot overshoot between knots,
// which is what shaper-style "value at a station" knots need.

export class MonotoneCurve {
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  private ms: Float64Array;

  constructor(knots: ReadonlyArray<readonly [number, number]>) {
    const k = [...knots].sort((a, b) => a[0] - b[0]);
    const n = k.length;
    this.xs = new Float64Array(n);
    this.ys = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.xs[i] = k[i][0];
      this.ys[i] = k[i][1];
    }
    this.ms = new Float64Array(n);
    if (n < 2) return;
    const d = new Float64Array(n - 1);
    for (let i = 0; i < n - 1; i++) d[i] = (this.ys[i + 1] - this.ys[i]) / (this.xs[i + 1] - this.xs[i]);
    this.ms[0] = d[0];
    this.ms[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) this.ms[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) {
        this.ms[i] = 0;
        this.ms[i + 1] = 0;
        continue;
      }
      const a = this.ms[i] / d[i];
      const b = this.ms[i + 1] / d[i];
      const s = a * a + b * b;
      if (s > 9) {
        const t = 3 / Math.sqrt(s);
        this.ms[i] = t * a * d[i];
        this.ms[i + 1] = t * b * d[i];
      }
    }
  }

  at(x: number): number {
    const xs = this.xs;
    const n = xs.length;
    if (n === 1) return this.ys[0];
    if (x <= xs[0]) return this.ys[0] + this.ms[0] * (x - xs[0]);
    if (x >= xs[n - 1]) return this.ys[n - 1] + this.ms[n - 1] * (x - xs[n - 1]);
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= x) lo = mid;
      else hi = mid;
    }
    const h = xs[hi] - xs[lo];
    const t = (x - xs[lo]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * this.ys[lo] +
      (t3 - 2 * t2 + t) * h * this.ms[lo] +
      (-2 * t3 + 3 * t2) * this.ys[hi] +
      (t3 - t2) * h * this.ms[hi]
    );
  }
}
