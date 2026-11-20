// BlueCurl Swell — wide default view (WP7): elevated on the headland, the whole lineup (outer reef, point,
// inside) with the swell rolling in from the horizon and the sunrise (az 108°, el 6°) in frame. The
// bottom-right third (PiP corner) falls on the headland / near water, not on the lineup.
// Drift: a very slow, sub-metre float, a pure function of t (no state).

export const WIDE = { position: [-30, 70, 105], target: [160, 0, -25], fov: 56 };

const TAU = 2 * Math.PI;

/** Wide pose at time t: { px, py, pz, tx, ty, tz, fov }. base = { position, target, fov } (default WIDE). */
export function widePose(t, base = WIDE, drift = 1, out = {}) {
  const [px, py, pz] = base.position, [tx, ty, tz] = base.target;
  const d = Number.isFinite(drift) ? drift : 1;
  out.px = px + d * (0.9 * Math.sin(TAU * t / 47) + 0.35 * Math.sin(TAU * t / 29 + 1.1));
  out.py = py + d * (0.5 * Math.sin(TAU * t / 53 + 0.4));
  out.pz = pz + d * (0.9 * Math.sin(TAU * t / 61 + 2.0));
  out.tx = tx + d * (1.6 * Math.sin(TAU * t / 67 + 0.7));
  out.ty = ty + d * (0.6 * Math.sin(TAU * t / 43 + 2.6));
  out.tz = tz + d * (1.8 * Math.sin(TAU * t / 71 + 1.9));
  out.fov = base.fov;
  return out;
}
