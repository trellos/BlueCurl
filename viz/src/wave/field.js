// STUB (owner WP4a). JS mirror of the wave surface. See contracts.js "wave geometry API".
import { ambientHeight, uToZ } from '../contracts.js';
export function sampleFront(front, u, sigma, t) { const x = front.x - (sigma - 0.5) * 80, z = uToZ(u);
  return { x, y: ambientHeight(x, z, t), z, nx: 0, ny: 1, nz: 0, vx: front.vx, vy: 0, vz: 0, tau: -1, zi: -1, H: 0 }; }
export function surfaceHeight(fronts, x, z, t) { return ambientHeight(x, z, t); }
export function barrel(front, u, t) { return null; }
export function lip(front, u, t) { const s = sampleFront(front, u, 0.5, t); return { x: s.x, y: s.y, z: s.z }; }
