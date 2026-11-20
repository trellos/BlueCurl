// GPU frame timing with EXT_disjoint_timer_query_webgl2 (one TIME_ELAPSED query in flight per frame;
// results are collected a few frames later). Falls back to null when the extension is unavailable.
export class GpuTimer {
  constructor(gl) {
    this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.pending = [];
    this.active = null;
    this.ms = null;          // smoothed GPU ms per frame
    this.last = null;        // last raw sample
  }
  get available() { return !!this.ext; }

  begin() {
    if (!this.ext || this.active) return;
    const q = this.gl.createQuery();
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = q;
  }

  end() {
    if (!this.ext || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
    this.poll();
  }

  /** Collect finished queries; returns the number collected. */
  poll() {
    const gl = this.gl;
    let n = 0;
    while (this.pending.length) {
      const q = this.pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      this.pending.shift();
      const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
      if (!disjoint) {
        const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
        this.last = ms;
        this.ms = this.ms == null ? ms : this.ms + (ms - this.ms) * 0.1;
        n++;
      }
      gl.deleteQuery(q);
    }
    if (this.pending.length > 8) { this.pending.splice(0, this.pending.length - 8).forEach((q) => gl.deleteQuery(q)); }
    return n;
  }

  /** Time fn() n times (each in its own query) and return the mean GPU ms, waiting for results. */
  async measure(fn, n = 60) {
    if (!this.ext) return null;
    const gl = this.gl, ext = this.ext, qs = [];
    for (let i = 0; i < n; i++) {
      const q = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q); fn(); gl.endQuery(ext.TIME_ELAPSED_EXT);
      qs.push(q);
    }
    const samples = [];
    for (const q of qs) {
      for (let k = 0; k < 400 && !gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE); k++) await new Promise((r) => setTimeout(r, 5));
      if (!gl.getParameter(ext.GPU_DISJOINT_EXT) && gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) samples.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(q);
    }
    if (!samples.length) return null;
    samples.sort((a, b) => a - b);
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    return { mean, median: samples[samples.length >> 1], min: samples[0], max: samples[samples.length - 1], n: samples.length };
  }
}
