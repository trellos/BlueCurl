// BlueCurl Swell — wide view presets (WP7, owner of the poses). Cycled with the C key, logged as cfg 'camera'
// (app.input.setConfig('camera', name)) so replays reproduce it; the rig reads app.cfg.camera (default 'lineup').
//   lineup  default: high above the headland, whose cliff mound and sea stacks frame the lower right (land ≈ 15 %);
//           all three zones' break segments in frame (inside left, point centre ~139 m away, outer right under the
//           sunrise), swell to the horizon, horizon ~23 % from the top. PiP bottom-right: it covers no lineup (only the
//           headland slope / stacks); bottom-left would cut the inside sandbar. Eases toward the active break
//           (push.js, cfg.cameraPush).
//   point   closer on the point (~111 m): big barrels, inside/outer partly past the edges. PiP bottom-right.
//   cliff   WP2's SPOT_CAMERAS.default (src/spot/layout.js) from the high bluff. PiP bottom-right.
// Drift: a very slow, sub-metre float, a pure function of t (no state).
import { SPOT_CAMERAS } from '../spot/layout.js';

const S = SPOT_CAMERAS.default;
export const PRESETS = {
  lineup: { position: [0, 55, 70], target: [130, -6, -10], fov: 72, pipCorner: 'bottom-right' },
  point: { position: [0, 30, 30], target: [130, -6, -35], fov: 66, pipCorner: 'bottom-right' },
  cliff: { position: [...S.pos], target: [...S.target], fov: S.fov, pipCorner: 'bottom-right' },
};
export const PRESET_ORDER = ['lineup', 'point', 'cliff'];
export const DEFAULT_PRESET = 'lineup';
export const WIDE = PRESETS[DEFAULT_PRESET];
/** Default PiP corner of the default preset (the rig uses the active preset's corner while cfg.pip.corner is auto). */
export const PIP_CORNER = WIDE.pipCorner;

export const presetFor = (name) => PRESETS[name] || PRESETS[DEFAULT_PRESET];
export const nextPreset = (name) => PRESET_ORDER[(Math.max(0, PRESET_ORDER.indexOf(name)) + 1) % PRESET_ORDER.length];

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
