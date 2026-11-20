// Deterministic layout of spot props (palms, boulders, sea stacks, bushes). Pure JS, no three.js, so the node
// tests can check that nothing hides the break zones from the camera poses below.
import { ZONES, mulberry32, uToZ } from '../contracts.js';
import { depthAt, headlandS, xBay, SPOT } from './bathymetry.js';

/**
 * Camera poses the layout keeps the zones visible from. `default` (proposed for WP7): on the high bluff of the
 * headland, ~20 m above ground; all three zones in frame (point ≈ 200 m away), sunrise upper-right of centre,
 * horizon at ~70 % height, the bottom-right third over headland. target is where the view ray meets the sea.
 */
export const SPOT_CAMERAS = {
  default: { pos: [-70, 54, 90], target: [150, 0, -37], fov: 55 },
};

/** Sight targets on and around each zone's break line (water level and wave-crest height). */
export function sightTargets(step = 6) {
  const out = [];
  for (const zn of ZONES) {
    const z0 = uToZ(zn.u0), z1 = uToZ(zn.u1);
    for (let z = z0; z <= z1 + 1e-6; z += step) {
      for (const dx of [-6, 0, 10]) for (const y of [0.3, 4.0]) out.push([zn.lineX + dx, y, z, zn.key]);
    }
  }
  return out;
}

/** True when a vertical cylinder (x, z, radius r, from y0 to y1) blocks no camera→target sightline. */
export function clearOfSightlines(x, z, r, y1, cams, targets, margin = 1.5) {
  for (const c of cams) {
    const [cx, cy, cz] = c.pos;
    for (const t of targets) {
      const dx = t[0] - cx, dz = t[2] - cz, L2 = dx * dx + dz * dz, L = Math.sqrt(L2);
      let s = ((x - cx) * dx + (z - cz) * dz) / L2;             // closest approach along the ray (0..1)
      const px = cx + dx * s - x, pz = cz + dz * s - z;
      const d = Math.sqrt(px * px + pz * pz), rr = r + margin;
      if (d > rr) continue;
      const sFar = Math.min(0.92, s + Math.sqrt(rr * rr - d * d) / L); // lowest ray point inside the disc
      if (sFar <= 0) continue;
      const yRay = cy + (t[1] - cy) * sFar;
      if (yRay < y1 + margin) return false;
    }
  }
  return true;
}

const ground = (x, z) => -depthAt(x, z);
function seaDir(x, z) {                                       // horizontal direction toward the sea
  const e = 2, sx = headlandS(x + e, z) - headlandS(x - e, z), sz = headlandS(x, z + e) - headlandS(x, z - e);
  const l = Math.hypot(sx, sz) || 1;
  return [-sx / l, -sz / l];
}

/**
 * Build the layout. Returns arrays of plain records.
 * palms:   { x, y, z, yaw, scale, variant, lean, phase }   yaw rotates local +X (lean direction) about +Y
 * rocks:   { x, y, z, sx, sy, sz, rx, ry, rz, shade }
 * stacks:  { x, y, z, r, h, yaw, seed }
 * bushes:  { x, y, z, r, h, yaw, shade, far }
 */
export function buildLayout({ seed = 7, cams = Object.values(SPOT_CAMERAS) } = {}) {
  const rnd = mulberry32(seed * 7919 + 13);
  const targets = sightTargets(6);
  const clear = (x, z, r, top) => clearOfSightlines(x, z, r, top, cams, targets);
  const palms = [], rocks = [], stacks = [], bushes = [];
  const near = (list, x, z, d) => list.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < d * d);

  // --- palms on the headland, near the cliff edge, leaning out to sea
  let tries = 0;
  while (palms.length < 18 && tries++ < 4000) {
    const x = -100 + rnd() * 175, z = SPOT.headZ - 3 + rnd() * 180;
    const s = headlandS(x, z);
    if (s < 4 || s > 26) continue;
    const y = ground(x, z);
    if (y < 6) continue;
    const scale = 0.85 + rnd() * 0.35, variant = rnd() < 0.6 ? 0 : 1;
    const h = (variant ? 9.5 : 13) * scale;
    if (near(palms, x, z, 7)) continue;
    if (!clear(x, z, 5.5 * scale, y + h + 1.5)) continue;
    const [dx, dz] = seaDir(x, z);
    const a = Math.atan2(dz, dx) + (rnd() - 0.5) * 0.7;
    palms.push({ x, y: y - 0.3, z, yaw: Math.atan2(-Math.sin(a), Math.cos(a)), scale, variant, lean: 0.8 + rnd() * 0.5, phase: rnd() * 6.283 });
  }
  // --- palms along the bay, behind the beach berm, leaning east
  tries = 0;
  let nBay = 0;
  while (nBay < 16 && tries++ < 4000) {
    const z = SPOT.beachZ0 - 30 + rnd() * (SPOT.beachZ1 - SPOT.beachZ0 + 55), x = xBay(z) - 6 - rnd() * 14;
    if (z > SPOT.headZ - 15) continue;
    const y = ground(x, z);
    if (y < 1.5) continue;
    if (near(palms, x, z, 7)) continue;
    const scale = 0.85 + rnd() * 0.35, variant = rnd() < 0.5 ? 0 : 1;
    if (!clear(x, z, 5.5 * scale, y + 14 * scale)) continue;
    const a = (rnd() - 0.5) * 0.9;
    palms.push({ x, y: y - 0.3, z, yaw: Math.atan2(-Math.sin(a), Math.cos(a)), scale, variant, lean: 0.7 + rnd() * 0.6, phase: rnd() * 6.283 });
    nBay++;
  }

  // --- sea stacks off the north side of the tip (west faces seen from the headland)
  const tx = SPOT.tipX, tz = SPOT.tipZ;     // relative to the tip, north of the point break
  const stackCands = [[9, 22, 4.5, 14], [4, 39, 3.6, 10], [15, 13, 3, 8], [1, 57, 4, 12], [20, 27, 2.4, 6]];
  for (const [ox, oz, r, h] of stackCands) {
    const x = tx + ox, z = tz + oz;
    const y = ground(x, z);
    if (!clear(x, z, r, y + h)) continue;
    stacks.push({ x, y: y - 1.0, z, r, h: h - y + 1.0, yaw: rnd() * 6.283, seed: stacks.length + 1 });
  }

  // --- boulders along the cliff toe and on the point's rock platform
  tries = 0;
  while (rocks.length < 60 && tries++ < 6000) {
    const x = -6 + rnd() * 115, z = SPOT.headZ - 24 + rnd() * 160;
    const s = headlandS(x, z);
    const onToe = s > -5 && s < 1.5, onShelf = s < -4 && s > -24 && x > SPOT.tipX - 10 && x < ZONES[1].lineX - 17 && z < SPOT.tipZ + 21;
    if (!onToe && !(onShelf && rnd() < 0.35)) continue;
    const y = ground(x, z);
    if (y > 4 || y < -3.5) continue;
    const k = onShelf ? 0.5 + rnd() * 1.1 : 0.8 + rnd() * 2.0;
    if (!clear(x, z, k, y + k * 1.2)) continue;
    rocks.push({ x, y: y - k * 0.25, z, sx: k * (1 + rnd() * 0.5), sy: k * (0.6 + rnd() * 0.5), sz: k * (1 + rnd() * 0.5),
      rx: rnd() * 0.6, ry: rnd() * 6.283, rz: rnd() * 0.6, shade: 0.75 + rnd() * 0.4 });
  }
  // a few at the bay corner, where the beach meets the headland
  for (let i = 0; i < 8; i++) {
    const z = SPOT.beachZ1 + 25 + rnd() * 18, x = xBay(z) + 1 + rnd() * 11, y = ground(x, z), k = 0.7 + rnd() * 1.4;
    if (y < -2) continue;
    rocks.push({ x, y: y - k * 0.3, z, sx: k * 1.3, sy: k * 0.8, sz: k * 1.1, rx: rnd() * 0.5, ry: rnd() * 6.283, rz: rnd() * 0.5, shade: 0.8 + rnd() * 0.3 });
  }

  // --- bushes / scrub on the headland top (low, checked against sightlines)
  tries = 0;
  let nScrub = 0;
  while (nScrub < 130 && tries++ < 8000) {
    const x = -150 + rnd() * 220, z = SPOT.headZ + 2 + rnd() * 230;
    const s = headlandS(x, z);
    if (s < 3) continue;
    const y = ground(x, z);
    if (y < 6) continue;
    const r = 1.6 + rnd() * 2.2, h = r * (0.55 + rnd() * 0.25);
    if (!clear(x, z, r, y + h)) continue;
    bushes.push({ x, y: y - 0.4, z, r, h, yaw: rnd() * 6.283, shade: rnd(), far: false });
    nScrub++;
  }
  // --- jungle canopy on the hills behind the bay and the far south arm
  tries = 0;
  let nJ = 0;
  while (nJ < 250 && tries++ < 12000) {
    const z = -1030 + rnd() * 1060, x = xBay(z) - 27 - rnd() * 260;
    const y = ground(x, z);
    if (y < 2.5 || headlandS(x, z) > 2) continue;
    const r = 4 + rnd() * 5.5, h = r * (0.7 + rnd() * 0.35);
    if (!clear(x, z, r, y + h)) continue;
    bushes.push({ x, y: y - 1.0, z, r, h, yaw: rnd() * 6.283, shade: rnd(), far: true });
    nJ++;
  }
  return { palms, rocks, stacks, bushes };
}
