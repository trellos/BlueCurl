// Analytic stand-in wave face. NOT the wave renderer: a cheap, smooth, inclined surface that
// gives correct gravity directions for trim and turns. Real wave queries (ShoreBreak) replace it
// through the same WaveQuery interface.
//
// World frame (matches ShoreBreak): metres, +Y up, +Z shoreward (the wave travels toward +Z).
// The lab works in the wave's own frame (the face is stationary), as ShoreBreak's surf spike
// does: constant wave speed adds no acceleration, so body reactions are unaffected.
// The crest line runs along X at z = 0; the face falls toward +Z.

export interface WaveQuery {
  /** Surface height at (x, z), time t. */
  height(x: number, z: number, t: number): number;
  /** Writes the unit surface normal into out [nx, ny, nz]. */
  normal(x: number, z: number, t: number, out: Float64Array | number[]): void;
}

export interface WaveParams {
  /** Face height at the crest, m. */
  height: number;
  /** Steepest face angle, degrees. */
  faceAngleDeg: number;
  /** Back-of-wave length scale, m. */
  backLength: number;
  /** Chop amplitude (m, sum of components). */
  chop: number;
}

export const defaultWave: WaveParams = { height: 1.8, faceAngleDeg: 33, backLength: 9, chop: 0.035 };

// chop components: [dirX, dirZ, wavelength m, relative amplitude]
const CHOP: number[][] = [
  [0.31, 0.95, 7.3, 0.45],
  [-0.62, 0.78, 3.9, 0.3],
  [0.88, 0.47, 2.2, 0.17],
  [-0.2, 0.98, 1.3, 0.08],
];
const G = 9.81;
const CHOP_K = CHOP.map((c) => (2 * Math.PI) / c[2]);
const CHOP_W = CHOP_K.map((k) => Math.sqrt(G * k));

export class WaveFace implements WaveQuery {
  p: WaveParams;
  constructor(p: WaveParams = { ...defaultWave }) {
    this.p = p;
  }

  /** Face width from crest to toe for the configured steepness. */
  get faceWidth(): number {
    return (this.p.height * Math.PI) / (2 * Math.tan((this.p.faceAngleDeg * Math.PI) / 180));
  }

  /** Along-crest height variation (sections). */
  crestHeight(x: number): number {
    return this.p.height * (1 + 0.07 * Math.sin((2 * Math.PI * x) / 70) + 0.04 * Math.sin((2 * Math.PI * x) / 23 + 1.3));
  }

  /** Swell profile only (no chop). */
  profile(x: number, z: number): number {
    const H = this.crestHeight(x);
    const Wf = (H * Math.PI) / (2 * Math.tan((this.p.faceAngleDeg * Math.PI) / 180));
    if (z >= 0) return z < Wf ? H * 0.5 * (1 + Math.cos((Math.PI * z) / Wf)) : 0;
    const q = z / this.p.backLength;
    return H * Math.exp(-q * q);
  }

  chopHeight(x: number, z: number, t: number): number {
    let h = 0;
    for (let i = 0; i < CHOP.length; i++) {
      const c = CHOP[i];
      h += c[3] * Math.sin(CHOP_K[i] * (c[0] * x + c[1] * z) - CHOP_W[i] * t + i * 1.7);
    }
    return h * this.p.chop;
  }

  height(x: number, z: number, t: number): number {
    return this.profile(x, z) + this.chopHeight(x, z, t);
  }

  normal(x: number, z: number, t: number, out: Float64Array | number[]): void {
    const e = 0.05;
    const hx = (this.height(x + e, z, t) - this.height(x - e, z, t)) / (2 * e);
    const hz = (this.height(x, z + e, t) - this.height(x, z - e, t)) / (2 * e);
    const l = Math.hypot(hx, 1, hz);
    out[0] = -hx / l;
    out[1] = 1 / l;
    out[2] = -hz / l;
  }

  /** Swell-only normal (planned surface, used by trajectory generators). */
  profileNormal(x: number, z: number, out: Float64Array | number[]): void {
    const e = 0.05;
    const hx = (this.profile(x + e, z) - this.profile(x - e, z)) / (2 * e);
    const hz = (this.profile(x, z + e) - this.profile(x, z - e)) / (2 * e);
    const l = Math.hypot(hx, 1, hz);
    out[0] = -hx / l;
    out[1] = 1 / l;
    out[2] = -hz / l;
  }
}

/** GLSL mirror of WaveFace.height (keep in sync). Uniforms: uWaveH, uFaceTan, uBackL, uChop, uTime. */
export const waveGLSL = /* glsl */ `
uniform float uWaveH;
uniform float uFaceTan;
uniform float uBackL;
uniform float uChop;
uniform float uTime;
float wCrestH(float x) {
  return uWaveH * (1.0 + 0.07 * sin(6.2831853 * x / 70.0) + 0.04 * sin(6.2831853 * x / 23.0 + 1.3));
}
float wProfile(float x, float z) {
  float H = wCrestH(x);
  float Wf = H * 3.14159265 / (2.0 * uFaceTan);
  if (z >= 0.0) return z < Wf ? H * 0.5 * (1.0 + cos(3.14159265 * z / Wf)) : 0.0;
  float q = z / uBackL;
  return H * exp(-q * q);
}
float wChop(float x, float z, float t) {
  float h = 0.0;
  ${CHOP.map((c, i) => `h += ${c[3].toFixed(4)} * sin(${CHOP_K[i].toFixed(6)} * (${c[0].toFixed(4)} * x + ${c[1].toFixed(4)} * z) - ${CHOP_W[i].toFixed(6)} * t + ${(i * 1.7).toFixed(4)});`).join('\n  ')}
  return h * uChop;
}
float wHeight(float x, float z) { return wProfile(x, z) + wChop(x, z, uTime); }
`;
