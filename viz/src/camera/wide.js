// BlueCurl Swell — wide default view (WP7, owner of the pose since review round 1). Elevated above the headland's
// west foot, centred on the point (~110 m away) so the breaking waves are big; the inside bay (left) and the
// outer reef (right, under the sunrise) sit toward the edges, and the incoming swell runs out to the horizon on the
// sun side. Foreground land ≈ 10 % of the frame; horizon ~31 % from the top. The PiP corner (PIP_CORNER) covers the
// near water at the cliff foot, the least important area. WP2's SPOT_CAMERAS stays as a reference pose.
// Drift: a very slow, sub-metre float, a pure function of t (no state).

export const WIDE = { position: [0, 30, 30], target: [130, -6, -35], fov: 66 };
/** Default PiP corner for this frame (used while cfg.pip.corner is the contracts' default). */
export const PIP_CORNER = 'bottom-right';

const TAU = 2 * Math.PI;

/** Wide pose at time t: { px, py, pz, tx, ty, tz, fov }. base = { position, target, fov } (default WIDE). */
export function widePose(t, base = WIDE, drift = 1, out = {}) {
  const [px, py, pz] = base.position, [tx, ty, tz] = base.target;
  const d = Number.isFinite(drift) ? drift : 1;
  out.px = px + d * (0.5 * Math.sin(TAU * t / 47) + 0.2 * Math.sin(TAU * t / 29 + 1.1));
  out.py = py + d * (0.3 * Math.sin(TAU * t / 53 + 0.4));
  out.pz = pz + d * (0.5 * Math.sin(TAU * t / 61 + 2.0));
  out.tx = tx + d * (1.0 * Math.sin(TAU * t / 67 + 0.7));
  out.ty = ty + d * (0.4 * Math.sin(TAU * t / 43 + 2.6));
  out.tz = tz + d * (1.2 * Math.sin(TAU * t / 71 + 1.9));
  out.fov = base.fov;
  return out;
}
