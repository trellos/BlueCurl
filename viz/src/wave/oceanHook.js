// BlueCurl Swell — ocean coupling for the wave meshes (WP4b).
//
// The FFT ocean (WP1) is a heightfield; the swept-profile wave meshes are sheets laid over it. Under each
// front's footprint the ocean is pushed down (bcWaveMask → uMaskDepth, plus an extra drop for deep troughs via
// bcWaveHeight) so it never pokes through the mesh. The mesh's own edges are flat (profile y = 0) and carry the
// same ambient swell + FFT chop as the ocean, so the sea is continuous across the boundary.
//
// Footprint of front i = a box in world x (crest x − xiMax … crest x − xiMin) × z (front ends). At a free edge the
// mask ramps 0 → 1 over RAMP metres INSIDE the mesh; at an edge clipped against a neighbour the box overshoots the
// cut a little (the neighbour's mesh covers that strip), so the union of the boxes stays 1 across the cut.

export const MAX_HOOK_FRONTS = 12;
export const RAMP = 3.0;          // m, mask ramp inside a free mesh edge
export const CUT_OVERSHOOT = 1.5; // m, box overshoot past a clipped edge

export const OCEAN_HOOK_GLSL = /* glsl */ `
uniform vec4 uWvBoxA[${MAX_HOOK_FRONTS}];   // xMin, xMax (world), ramp at xMin, ramp at xMax
uniform vec4 uWvBoxB[${MAX_HOOK_FRONTS}];   // zMin, zMax, ramp z, extra push-down (m)
uniform int uWvN;
float bcWvBox(int i, vec2 xz) {
  vec4 A = uWvBoxA[i], B = uWvBoxB[i];
  // free edges: the ramp starts one ocean cell inside the mesh (the polar grid spacing ≈ 0.014·r), so no ocean
  // triangle that crosses the mesh edge is lowered (that would open a gap onto the shallow sea bed)
  float cell = max(0.6, 0.016 * length(xz - cameraPosition.xz));
  vec2 ix = vec2(A.z > 1.0 ? cell : 0.0, A.w > 1.0 ? cell : 0.0);
  float mx = smoothstep(A.x + ix.x, A.x + ix.x + A.z, xz.x) * (1.0 - smoothstep(A.y - ix.y - A.w, A.y - ix.y, xz.x));
  float mz = smoothstep(B.x + cell, B.x + cell + B.z, xz.y) * (1.0 - smoothstep(B.y - cell - B.z, B.y - cell, xz.y));
  return mx * mz;
}
float bcWaveMask(vec2 xz) {
  float m = 0.0;
  for (int i = 0; i < ${MAX_HOOK_FRONTS}; i++) { if (i >= uWvN) break; m = max(m, bcWvBox(i, xz)); }
  return m;
}
float bcWaveHeight(vec2 xz) {
  float h = 0.0;
  for (int i = 0; i < ${MAX_HOOK_FRONTS}; i++) { if (i >= uWvN) break; h = min(h, -uWvBoxB[i].w * bcWvBox(i, xz)); }
  return h;
}
`;

export class OceanHook {
  constructor() {
    this.uniforms = {
      uWvBoxA: { value: new Float32Array(MAX_HOOK_FRONTS * 4) },
      uWvBoxB: { value: new Float32Array(MAX_HOOK_FRONTS * 4) },
      uWvN: { value: 0 },
    };
    this.installed = null;
  }

  /** Install into app.ocean (idempotent). */
  install(ocean) {
    if (!ocean || typeof ocean.setWaveHook !== 'function' || this.installed === ocean) return;
    ocean.setWaveHook(OCEAN_HOOK_GLSL, this.uniforms);
    this.installed = ocean;
  }

  uninstall() {
    if (this.installed) this.installed.setWaveHook(null);
    this.installed = null;
  }

  /**
   * boxes: [{ x0, x1, clip0, clip1, z0, z1, down }] — world x range of the mesh, whether each x edge is clipped
   * against a neighbour, z range and the extra push-down (m).
   */
  set(boxes) {
    const A = this.uniforms.uWvBoxA.value, B = this.uniforms.uWvBoxB.value;
    const n = Math.min(MAX_HOOK_FRONTS, boxes.length);
    A.fill(0); B.fill(0);
    for (let i = 0; i < n; i++) {
      const b = boxes[i], k = i * 4;
      A[k] = b.clip0 ? b.x0 - CUT_OVERSHOOT : b.x0;
      A[k + 1] = b.clip1 ? b.x1 + CUT_OVERSHOOT : b.x1;
      A[k + 2] = b.clip0 ? 0.5 : RAMP;
      A[k + 3] = b.clip1 ? 0.5 : RAMP;
      B[k] = b.z0; B[k + 1] = b.z1; B[k + 2] = RAMP; B[k + 3] = b.down;
    }
    this.uniforms.uWvN.value = n;
  }
}
