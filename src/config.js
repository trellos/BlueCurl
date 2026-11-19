// World conventions (all SI units: meters, seconds):
//   x : along-shore, +x to the right of the camera view
//   y : up; still-water level (SWL) is y = 0
//   z : cross-shore, +z toward the beach / camera; waves travel +z
//   The still-water shoreline (SWL ∩ beach face) is at z = 0.
//
// Numbers are calibrated against the reference clip (camera, geometry, colour and
// swash analyses). JS and GLSL share them through glslDefines().

const QS = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
const EXPLORE = typeof location !== 'undefined' && !QS.has('clip');

// ---- surfing demonstration mode (?surf) -------------------------------------------------------
// A continuously peeling breaker built from the scheduled-breaker model (glsl/breaker.js OPT_SURF)
// plus a programmatically ridden shortboard and chase camera (src/surf/). Every parameter can be
// given on the URL, e.g. ?surf&height=2.2&peel=7&dir=-1&curl=0.9&steep=1.2&chop=1.5
const qn = (k, d, lo, hi) => { const v = Number.parseFloat(QS.get(k)); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
function parseSurf() {
  if (!EXPLORE || !QS.has('surf')) return null;
  return {
    height: qn('height', 1.8, 0.6, 3.5),     // rendered trough-to-crest face height at the break (m)
    steep: qn('steep', 1.0, 0.6, 1.8),       // face steepness: front/back face lengths divided by this
    curl: qn('curl', 0.85, 0, 1),            // 0 spilling .. 1 hollow plunging lip (throw distance, roundness)
    peel: qn('peel', 6.0, 2.0, 14.0),        // peeling speed along the crest (m/s)
    dir: QS.get('dir') === '-1' || QS.get('dir') === 'left' ? -1 : 1, // +1: the break moves toward +x
    chop: qn('chop', 1.0, 0, 3),             // wind-sea (FFT) amplitude multiplier
    zBreak: qn('zbreak', -7.0, -12, -4),     // cross-shore landing line of the lip (m, shore at z = 0)
    period: qn('period', 12.0, 7, 20),       // time between successive peeling waves (s)
    seed: qn('seed', 7, 0, 1e6),
  };
}
export const CONFIG = {
  g: 9.81,
  // full-window first-person mode (?explore): the world must hold up around a moving focus
  explore: EXPLORE,
  surf: parseSurf(),

  // ---- camera: iPhone main camera, 4K60 portrait with EIS ------------------
  camera: {
    aspect: 9 / 16,
    vfov: 64.0,
    position: [0.0, 2.30, 4.10],  // eye 2.30 m above SWL, 4.10 m landward of the SWL shoreline
    pitchDeg: -10.853,
    rollDeg: -0.364,
    yawDeg: 0.0,
    near: 0.05,
    far: 12000.0,
  },

  // ---- beach / bathymetry --------------------------------------------------
  // Piecewise-linear slopes (dy/dz) joined with smooth (softplus) knees; y(0) = 0.
  // Reflective pebble face, a steep step whose toe is the plunge point, gentle
  // nearshore (1.8 m deep at the swimmer, z = -11.6), deeper Baie des Anges shelf.
  beach: {
    knees: [ // [z, slope seaward of z, slope shoreward of z, knee width]
      // offshore (z < -6, outside the shallow-water domain): the pale pebble terrace
      // (≈2.3 m deep) ends in a steep drop-off at z ≈ -16.8 .. -22.5 (to ≈7.5 m), then the
      // Baie des Anges shelf. The drop-off is the sharp turquoise → teal colour step seen
      // at image row v ≈ 0.44 (D ≈ 19–20 m from the camera).
      [-60.0, 0.10, 0.20, 5.0],
      [-22.5, 0.20, 1.00, 1.2],
      [-16.8, 1.00, 0.10, 0.5],
      [-12.0, 0.10, 0.12, 2.0],
      [-2.3, 0.12, 0.35, 0.22],
      [-0.6, 0.35, 0.135, 0.18],
      // landward (explore mode): the pebble face keeps rising behind the photographer to a
      // storm-berm crest (≈2.2 m) at z ≈ 19 m, then falls away gently
      [11.0, 0.135, 0.085, 1.5],
      [19.0, 0.085, -0.05, 1.2],
    ],
    minY: -30.0,
  },

  // ---- sun & light rig (display-referred "phone" normalisation) --------------
  sun: {
    dir: [0.26, 0.91, -0.31],      // toward the sun: high (≈66°) and ahead-right
    color: [1.0, 0.95, 0.91],
    intensity: 2.1,
  },

  // ---- simulation ----------------------------------------------------------
  sim: {
    dt: 1 / 120,
    // (?warmup=N shortens the settling run for development / slow software renderers)
    warmup: qn('warmup', 12.0, 0.5, 12.0),
    videoDuration: 8.5167,
  },

  // ---- swash / shallow-water domain -----------------------------------------
  swe: {
    xMin: -4.8, xMax: 4.8,
    // Add dry reserve landward of large run-up. Retain the exact old cell
    // spacing / centres, timestep and physics over the original domain.
    zMin: -6.0, zMax: EXPLORE ? 3.8 + 288 * 9.8 / 328 : 3.8,
    nx: 320, nz: EXPLORE ? 616 : 328, // same ~3.0 cm cells
    substeps: 6,
    manning: 0.022,                // smooth wet sand
    infiltration: 0.004,            // m/s effective drainage into sandy swash substrate
  },
};

export function deg(v) { return (v * Math.PI) / 180; }

export function sunDirection() {
  const [x, y, z] = CONFIG.sun.dir;
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
}

// JS mirror of GLSL bedProfile() (used for placing things on the CPU).
const softplus = (x) => (x > 20 ? x : Math.log1p(Math.exp(x)));
function bedRaw(z) {
  const K = CONFIG.beach.knees;
  let y = K[0][1] * z;
  for (const [zk, s0, s1, w] of K) y += (s1 - s0) * w * softplus((z - zk) / w);
  return y;
}
const BED_OFFSET = -bedRaw(0);
export function bedProfileJS(z) { return Math.max(bedRaw(z) + BED_OFFSET, CONFIG.beach.minY); }

/** GLSL #defines shared by every shader so constants never drift apart. */
export function glslDefines() {
  const s = CONFIG.swe;
  const f = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));
  const K = CONFIG.beach.knees;
  const knees = K.map(([zk, s0, s1, w]) => `  y += ${f(s1 - s0)} * ${f(w)} * softplus_((z - (${f(zk)})) / ${f(w)});`).join('\n');
  return `
#define G_ACC ${f(CONFIG.g)}
#define SWE_XMIN ${f(s.xMin)}
#define SWE_XMAX ${f(s.xMax)}
#define SWE_ZMIN ${f(s.zMin)}
#define SWE_ZMAX ${f(s.zMax)}
float softplus_(float x) { return x > 20.0 ? x : log(1.0 + exp(x)); }
float bedProfile(float z) {
  float y = ${f(K[0][1])} * z;
${knees}
  return max(y + (${f(BED_OFFSET)}), ${f(CONFIG.beach.minY)});
}
`;
}
