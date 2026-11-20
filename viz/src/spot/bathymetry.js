// STUB (owner WP2). depthAt(x,z) metres below mean sea level (negative = land above water).
export function depthAt(x, z) { return Math.max(-5, x * 0.06); }
export const BATHY_GLSL = /* glsl */ `float bcDepth(vec2 xz){ return max(-5.0, xz.x * 0.06); }`;
