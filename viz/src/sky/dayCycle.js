// BlueCurl Swell — day cycle (WP14, contract: src/contracts.js "day cycle"). Pure maths, no three.js.
//
// One cycle = sunrise → sunset on a tilted great circle:
//   rises at azimuth DAY.riseAz (just right of the old dawn sun at 108°, in front of the default 'lineup' camera,
//   which looks toward azimuth ~122°; note azimuth = atan2(x, z) DEcreases toward screen right in this world),
//   climbs to DAY.peakEl at azimuth riseAz − 90° (up and to the right of / slightly behind the lineup view, so the
//   day scene is front-lit and saturated), sets at riseAz − 180° (behind the lineup camera, ~16° off its back axis).
//   phase is linear in the arc angle; phase 0 / 1 = DAY.twilightEl below the eastern / western horizon.
// Every light / colour quantity is a function of the sun's ELEVATION only (rising and setting look alike), and at
// the twilight elevation the sky carries no sun-side asymmetry, so phase 1 (sun below the west) and phase 0 (sun
// below the east) look identical: the wrap is invisible.
//
// sunAt(phase) → { phase, elevationDeg, azimuthDeg, dir:[x,y,z] (unit, toward the sun; +X east, +Y up, +Z north),
//   color:[r,g,b] linear (direct sun irradiance colour, max channel 1), intensity (so irradiance = color·intensity;
//   0 once the disc is below the horizon), glow:[r,g,b] (sun disc / aureole / cloud-lining radiance scale, fades
//   out below the horizon), ambient:[r,g,b] (sky radiance seen by an up-facing white surface), sky:{zen, hzSun,
//   hzMid, hzAnti, midSun, midAnti, cloudSun, cloudAnti, cloudHi} (sky gradient keys), skyMisc:[belt, aureole,
//   cloudGain, 0], deep:[r,g,b] (water in-scatter radiance), exposure, saturation, rim (rim-light strength 0..1),
//   shadow (shadow strength 0..1) }

const D2R = Math.PI / 180;
export const DAY = {
  riseAz: 106,        // deg, azimuth of the horizon crossing at sunrise (6° up: ~103°)
  peakEl: 64,         // deg, elevation at local noon (azimuth riseAz − 90)
  peakAzOffset: -90,  // deg
  twilightEl: -4.2,   // deg below the horizon at phase 0 / 1 (dim blue-hour twilight). Chosen so phase 0.06 = 6.0°
};

const sinPeak = Math.sin(DAY.peakEl * D2R);
/** Arc angle (rad) at phase 0; phase 1 is at π − THETA0. */
export const THETA0 = Math.asin(Math.sin(DAY.twilightEl * D2R) / sinPeak);

const frac = (x) => x - Math.floor(x);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/**
 * Day phase 0..1 from the Beat bar clock: frac(startPhase + speed · (measure + frac) / measures).
 * beat: { measure, measureT0, measureLen } (src/beat/beat.js); t = sim time; cfg.day { measures, startPhase, speed }.
 * Without a beat (tools / tests) the clock runs at cfg.bpm from t = 0.
 */
export function dayPhase(beat, t, cfg) {
  const d = (cfg && cfg.day) || {};
  const measures = d.measures > 0 ? d.measures : 64;
  const start = Number.isFinite(d.startPhase) ? d.startPhase : 0.06;
  const speed = Number.isFinite(d.speed) ? d.speed : 1;
  let m;
  if (beat && Number.isFinite(beat.measureT0) && beat.measureLen > 0) m = beat.measure + (t - beat.measureT0) / beat.measureLen;
  else m = t / (240 / ((cfg && cfg.bpm) || 120));
  return frac(start + speed * m / measures);
}

/** Sun direction for a phase: [x, y, z] unit + elevation / azimuth (deg). */
export function sunPath(phase) {
  const p = frac(phase);
  const th = THETA0 + p * (Math.PI - 2 * THETA0);
  const az0 = DAY.riseAz * D2R, az1 = (DAY.riseAz + DAY.peakAzOffset) * D2R, el1 = DAY.peakEl * D2R;
  // R: horizon point at sunrise; M: noon direction (orthogonal to R)
  const R = [Math.sin(az0), 0, Math.cos(az0)];
  const M = [Math.cos(el1) * Math.sin(az1), Math.sin(el1), Math.cos(el1) * Math.cos(az1)];
  const c = Math.cos(th), s = Math.sin(th);
  const dir = [c * R[0] + s * M[0], c * R[1] + s * M[1], c * R[2] + s * M[2]];
  const elevationDeg = Math.asin(clamp(dir[1], -1, 1)) / D2R;
  let azimuthDeg = Math.atan2(dir[0], dir[2]) / D2R;
  if (azimuthDeg < 0) azimuthDeg += 360;
  return { phase: p, dir, elevationDeg, azimuthDeg };
}

// ---------------------------------------------------------------- colour keys by sun elevation (deg)
// The 6° row is the original hand-tuned dawn look (skyModel.js before WP14). Rows are linear HDR radiance.
const K = (el, o) => ({ el, ...o });
const KEYS = [
  K(-4.2, { sun: [0, 0, 0], glow: [0, 0, 0], amb: [0.050, 0.060, 0.115],
    zen: [0.007, 0.014, 0.052], hzSun: [0.085, 0.075, 0.150], hzMid: [0.085, 0.075, 0.150], hzAnti: [0.085, 0.075, 0.150],
    midSun: [0.030, 0.034, 0.090], midAnti: [0.030, 0.034, 0.090],
    cloudSun: [0.040, 0.038, 0.075], cloudAnti: [0.040, 0.038, 0.075], cloudHi: [0.040, 0.038, 0.075],
    misc: [0.0, 0.0, 1.0], exposure: 1.7, saturation: 1.0, rim: 0.0 }),
  K(-2.0, { sun: [0, 0, 0], glow: [0.55, 0.13, 0.03], amb: [0.085, 0.080, 0.135],
    zen: [0.010, 0.020, 0.072], hzSun: [0.55, 0.18, 0.09], hzMid: [0.20, 0.09, 0.12], hzAnti: [0.11, 0.08, 0.16],
    midSun: [0.16, 0.07, 0.10], midAnti: [0.040, 0.040, 0.105],
    cloudSun: [0.30, 0.08, 0.07], cloudAnti: [0.045, 0.035, 0.075], cloudHi: [0.16, 0.06, 0.11],
    misc: [0.35, 0.6, 1.0], exposure: 1.5, saturation: 1.0, rim: 0.0 }),
  K(0.0, { sun: [1.55, 0.42, 0.07], glow: [1.7, 0.50, 0.10], amb: [0.17, 0.14, 0.20],
    zen: [0.015, 0.032, 0.11], hzSun: [1.9, 0.55, 0.12], hzMid: [0.65, 0.20, 0.15], hzAnti: [0.24, 0.12, 0.22],
    midSun: [0.55, 0.19, 0.13], midAnti: [0.055, 0.055, 0.16],
    cloudSun: [0.70, 0.18, 0.09], cloudAnti: [0.22, 0.07, 0.09], cloudHi: [0.38, 0.11, 0.20],
    misc: [0.8, 1.0, 1.0], exposure: 1.3, saturation: 1.0, rim: 0.7 }),
  K(2.5, { sun: [2.75, 1.0, 0.27], glow: [2.7, 1.05, 0.30], amb: [0.23, 0.19, 0.26],
    zen: [0.018, 0.038, 0.13], hzSun: [2.6, 0.80, 0.16], hzMid: [0.90, 0.28, 0.17], hzAnti: [0.30, 0.15, 0.26],
    midSun: [0.78, 0.28, 0.17], midAnti: [0.065, 0.065, 0.19],
    cloudSun: [0.85, 0.22, 0.11], cloudAnti: [0.30, 0.11, 0.13], cloudHi: [0.50, 0.16, 0.24],
    misc: [0.9, 1.0, 1.0], exposure: 1.12, saturation: 1.0, rim: 0.9 }),
  K(6.0, { sun: [3.6, 1.75, 0.62], glow: [3.6, 1.75, 0.62], amb: [0.30, 0.25, 0.33],
    zen: [0.022, 0.045, 0.15], hzSun: [3.10, 1.05, 0.20], hzMid: [1.15, 0.36, 0.20], hzAnti: [0.36, 0.17, 0.30],
    midSun: [0.95, 0.36, 0.20], midAnti: [0.08, 0.08, 0.22],
    cloudSun: [0.95, 0.26, 0.12], cloudAnti: [0.36, 0.14, 0.17], cloudHi: [0.60, 0.20, 0.28],
    misc: [1.0, 1.0, 1.0], exposure: 1.0, saturation: 1.0, rim: 1.0 }),
  K(14.0, { sun: [4.1, 2.75, 1.45], glow: [4.1, 2.75, 1.45], amb: [0.36, 0.38, 0.50],
    zen: [0.040, 0.095, 0.30], hzSun: [2.10, 1.15, 0.50], hzMid: [0.95, 0.66, 0.55], hzAnti: [0.50, 0.48, 0.62],
    midSun: [0.55, 0.42, 0.42], midAnti: [0.14, 0.20, 0.42],
    cloudSun: [1.45, 0.90, 0.55], cloudAnti: [0.55, 0.45, 0.55], cloudHi: [0.85, 0.55, 0.55],
    misc: [0.3, 0.8, 1.0], exposure: 0.80, saturation: 1.0, rim: 0.75 }),
  K(28.0, { sun: [4.4, 3.65, 2.65], glow: [4.4, 3.65, 2.65], amb: [0.42, 0.52, 0.74],
    zen: [0.055, 0.16, 0.50], hzSun: [1.25, 1.20, 1.15], hzMid: [0.95, 1.00, 1.10], hzAnti: [0.72, 0.84, 1.05],
    midSun: [0.32, 0.50, 0.85], midAnti: [0.20, 0.38, 0.82],
    cloudSun: [2.00, 1.85, 1.70], cloudAnti: [1.30, 1.32, 1.42], cloudHi: [1.50, 1.48, 1.55],
    misc: [0.0, 0.6, 1.0], exposure: 0.60, saturation: 1.06, rim: 0.45 }),
  K(64.0, { sun: [4.6, 4.2, 3.6], glow: [4.6, 4.2, 3.6], amb: [0.46, 0.60, 0.90],
    zen: [0.060, 0.20, 0.66], hzSun: [1.20, 1.28, 1.40], hzMid: [0.95, 1.08, 1.30], hzAnti: [0.85, 1.00, 1.28],
    midSun: [0.24, 0.48, 1.00], midAnti: [0.20, 0.44, 0.98],
    cloudSun: [2.30, 2.25, 2.20], cloudAnti: [1.70, 1.75, 1.85], cloudHi: [1.80, 1.82, 1.90],
    misc: [0.0, 0.5, 1.0], exposure: 0.55, saturation: 1.08, rim: 0.35 }),
];

const lerp = (a, b, t) => a + (b - a) * t;
const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
function keyAt(el) {
  if (el <= KEYS[0].el) return [KEYS[0], KEYS[0], 0];
  for (let i = 1; i < KEYS.length; i++) {
    if (el <= KEYS[i].el) {
      const a = KEYS[i - 1], b = KEYS[i];
      const t = (el - a.el) / (b.el - a.el);
      return [a, b, t * t * (3 - 2 * t) * 0.5 + t * 0.5];   // eased but never flat at the keys
    }
  }
  const L = KEYS[KEYS.length - 1];
  return [L, L, 0];
}
const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** Original dawn water in-scatter radiance (tuned at 6°) and the downwelling irradiance it was tuned for. */
export const DEEP_DAWN = [0.004, 0.034, 0.036];
const E_DAWN = lum(KEYS[3].sun) * Math.sin(6 * D2R) + Math.PI * lum(KEYS[3].amb);

/** Full lighting state for a phase (see the header). Pure; identical at phase 0 and 1. */
export function sunAt(phase) {
  const path = sunPath(phase);
  const el = path.elevationDeg;
  const [a, b, t] = keyAt(el);
  const v = (k) => lerp3(a[k], b[k], t);
  const s = (k) => lerp(a[k], b[k], t);
  // direct sun: the disc sinks behind the sea horizon over ~1° (half a stylised disc + refraction)
  const sunRaw = v('sun');
  const vis = smooth(-0.9, 0.6, el);
  const sunC = sunRaw.map((x) => x * vis);
  const intensity = Math.max(sunC[0], sunC[1], sunC[2]);
  const color = intensity > 0 ? sunC.map((x) => x / intensity) : [1, 0.5, 0.2];
  const ambient = v('amb');
  // deep-water in-scatter follows the downwelling irradiance (sun on the horizontal + sky), a little bluer at noon
  const E = lum(sunC) * Math.max(Math.sin(el * D2R), 0) + Math.PI * lum(ambient);
  const kE = E / E_DAWN;
  const blue = smooth(8, 50, el);
  const deep = [DEEP_DAWN[0] * kE * (1 - 0.3 * blue), DEEP_DAWN[1] * kE, DEEP_DAWN[2] * kE * (1 + 0.45 * blue)];
  const misc = v('misc');
  return {
    phase: path.phase, elevationDeg: el, azimuthDeg: path.azimuthDeg, dir: path.dir,
    color, intensity,
    glow: v('glow'),
    ambient,
    sky: {
      zen: v('zen'), hzSun: v('hzSun'), hzMid: v('hzMid'), hzAnti: v('hzAnti'),
      midSun: v('midSun'), midAnti: v('midAnti'),
      cloudSun: v('cloudSun'), cloudAnti: v('cloudAnti'), cloudHi: v('cloudHi'),
    },
    skyMisc: [misc[0], misc[1], misc[2], 0],
    deep,
    exposure: s('exposure'),
    saturation: s('saturation'),
    rim: s('rim') * smooth(-1.0, 1.5, el),
    shadow: smooth(-0.6, 3.0, el),
  };
}
