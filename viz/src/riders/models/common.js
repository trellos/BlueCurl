// Shared helpers for the rider models (WP6b): a skinned-geometry builder (parts with per-vertex colour and bone
// weights merged into one BufferGeometry → one draw per character), a lit material with a warm sun rim (reads
// against the backlit dawn water from far away), small vector helpers and 2-bone IK.
import * as THREE from 'three';

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const smooth = (a, b, x) => { const s = clamp((x - a) / (b - a), 0, 1); return s * s * (3 - 2 * s); };
export const lerp = (a, b, k) => a + (b - a) * k;
export const mix3 = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
export const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scl3 = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len3 = (a) => Math.hypot(a[0], a[1], a[2]);
export const norm3 = (a) => { const l = len3(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
/** Rotate v about unit axis k by angle a (Rodrigues). */
export function rot3(v, k, a) {
  const c = Math.cos(a), s = Math.sin(a), d = dot3(k, v) * (1 - c), x = cross3(k, v);
  return [v[0] * c + x[0] * s + k[0] * d, v[1] * c + x[1] * s + k[1] * d, v[2] * c + x[2] * s + k[2] * d];
}

/** Smooth (smoothstep-blended) piecewise interpolation of a table [[x, v0, v1, ...], ...] → value column `col`. */
export function table(T, x, col = 1) {
  if (x <= T[0][0]) return T[0][col];
  for (let i = 0; i < T.length - 1; i++) if (x <= T[i + 1][0]) {
    const k = smooth(T[i][0], T[i + 1][0], x); return T[i][col] + (T[i + 1][col] - T[i][col]) * k;
  }
  return T[T.length - 1][col];
}

/** Bone frame matrix: origin o, Y axis along y, Z axis toward z (orthogonalised), X = Y × Z. */
export function frameMatrix(m, o, y, z) {
  const Y = norm3(y);
  let Z = sub3(z, scl3(Y, dot3(z, Y)));
  if (len3(Z) < 1e-5) Z = Math.abs(Y[0]) < 0.9 ? cross3([1, 0, 0], Y) : cross3([0, 0, 1], Y);
  Z = norm3(Z);
  const X = cross3(Y, Z);
  m.set(X[0], Y[0], Z[0], o[0], X[1], Y[1], Z[1], o[1], X[2], Y[2], Z[2], o[2], 0, 0, 0, 1);
  return m;
}

/** 2-bone IK: root a, target t, lengths l1 l2, pole direction p → middle joint and the (reach-clamped) end. */
export function ik2(a, t, l1, l2, p) {
  let d = sub3(t, a);
  let dist = len3(d);
  const dir = dist > 1e-6 ? scl3(d, 1 / dist) : [0, -1, 0];
  dist = clamp(dist, Math.abs(l1 - l2) + 1e-3, (l1 + l2) * 0.999);
  const ca = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(l1 * l1 - ca * ca, 0));
  let po = sub3(p, scl3(dir, dot3(p, dir)));
  if (len3(po) < 1e-5) po = Math.abs(dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  po = norm3(sub3(po, scl3(dir, dot3(po, dir))));
  return { mid: add3(add3(a, scl3(dir, ca)), scl3(po, h)), end: add3(a, scl3(dir, dist)) };
}

// ---------------------------------------------------------------- geometry builder
const _v = new THREE.Vector3(), _n = new THREE.Vector3(), _nm = new THREE.Matrix3();
export class SkinBuilder {
  constructor() { this.pos = []; this.nor = []; this.col = []; this.si = []; this.sw = []; this.idx = []; }
  /**
   * Add a three.js geometry transformed by matrix m.
   * color: THREE.Color | (p:Vector3 (transformed), n:Vector3) => THREE.Color
   * bones: number | (p:Vector3) => [[bone, w], ...] (≤ 4)
   */
  add(geo, m, color, bones) {
    const g = geo.index ? geo : geo;   // indexed or not
    const P = g.attributes.position, N = g.attributes.normal;
    _nm.getNormalMatrix(m);
    const base = this.pos.length / 3;
    const c = new THREE.Color();
    for (let i = 0; i < P.count; i++) {
      _v.fromBufferAttribute(P, i).applyMatrix4(m);
      _n.fromBufferAttribute(N, i).applyMatrix3(_nm).normalize();
      this.pos.push(_v.x, _v.y, _v.z); this.nor.push(_n.x, _n.y, _n.z);
      const cc = typeof color === 'function' ? color(_v, _n) : color;
      c.copy(cc); this.col.push(c.r, c.g, c.b);
      const bw = typeof bones === 'function' ? bones(_v) : [[bones, 1]];
      for (let k = 0; k < 4; k++) { this.si.push(bw[k] ? bw[k][0] : 0); this.sw.push(bw[k] ? bw[k][1] : 0); }
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) this.idx.push(base + g.index.getX(i));
    else for (let i = 0; i < P.count; i++) this.idx.push(base + i);
    geo.dispose();
    return this;
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4));
    g.setIndex(this.idx);
    return g;
  }
}

/** Matrix from position, a rotation (Euler XYZ radians) and a scale. */
export function M(p = [0, 0, 0], r = [0, 0, 0], s = [1, 1, 1]) {
  return new THREE.Matrix4().compose(new THREE.Vector3(...p), new THREE.Quaternion().setFromEuler(new THREE.Euler(...r)),
    new THREE.Vector3(...(Array.isArray(s) ? s : [s, s, s])));
}

/** Tapered capsule along +Y from 0 to len, radius r0 at 0 and r1 at len, flattened by sz in Z / sx in X. */
export function taper(len, r0, r1, radial = 10, rings = 6, sx = 1, sz = 1) {
  const pts = [];
  const capN = 4;
  for (let i = 0; i <= capN; i++) {                       // bottom cap
    const a = -Math.PI / 2 + (i / capN) * Math.PI / 2;
    pts.push(new THREE.Vector2(Math.cos(a) * r0, Math.sin(a) * r0));
  }
  for (let i = 1; i < rings; i++) { const k = i / rings; pts.push(new THREE.Vector2(lerp(r0, r1, k), len * k)); }
  for (let i = 0; i <= capN; i++) {                       // top cap
    const a = (i / capN) * Math.PI / 2;
    pts.push(new THREE.Vector2(Math.max(Math.cos(a) * r1, i === capN ? 0 : 1e-4), len + Math.sin(a) * r1));
  }
  pts[0].x = 0;
  const g = new THREE.LatheGeometry(pts, radial);
  if (sx !== 1 || sz !== 1) g.scale(sx, 1, sz);
  g.computeVertexNormals();
  return g;
}

/** Matrix placing +Y along direction d (unnormalised) at position p. */
export function Mdir(p, d) {
  const v = new THREE.Vector3(...d).normalize();
  return new THREE.Matrix4().compose(new THREE.Vector3(...p), new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), v),
    new THREE.Vector3(1, 1, 1));
}

export function ellipsoid(rx, ry, rz, ws = 12, hs = 8) {
  const g = new THREE.SphereGeometry(1, ws, hs);
  g.scale(rx, ry, rz);
  g.computeVertexNormals();
  return g;
}

/**
 * Loft a body along X: rings at stations s ∈ [0,1] (0 tail .. 1 nose), x = x0 + s * L, each ring an ellipse
 * (half-height h(s), half-width w(s), centre height yc(s)), with `belly` flattening the lower half.
 */
export function loftBody(L, x0, NU, NV, h, w, yc, belly = 1) {
  const pos = [], idx = [];
  for (let i = 0; i <= NU; i++) {
    const s = 0.5 - 0.5 * Math.cos(Math.PI * i / NU);     // denser at the tips
    const hh = Math.max(h(s), 1e-4), ww = Math.max(w(s), 1e-4), y0 = yc(s);
    for (let j = 0; j <= NV; j++) {
      const a = (j / NV) * Math.PI * 2;
      const cy = Math.cos(a), cz = Math.sin(a);
      pos.push(x0 + s * L, y0 + cy * hh * (cy < 0 ? belly : 1), cz * ww);
    }
  }
  const row = NV + 1;
  for (let i = 0; i < NU; i++) for (let j = 0; j < NV; j++) {
    const a = i * row + j, b = a + 1, c = a + row, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** A thin fin: polygon outline in the XY plane (array of [x,y]), extruded ±thick/2 in Z with tapered edges. */
export function finGeometry(outline, thick) {
  const shape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: true, bevelThickness: thick * 0.5,
    bevelSize: thick * 0.6, bevelSegments: 1, curveSegments: 4 });
  g.translate(0, 0, -thick / 2);
  const ng = g.toNonIndexed ? g : g;
  ng.computeVertexNormals();
  return ng;
}

// ---------------------------------------------------------------- material
/**
 * Lit, vertex-coloured MeshStandardMaterial with a warm rim/back light from the low sun (stylised, GTA-ish):
 * edges that face the sun glow, and silhouettes seen against the sun get a thin hot outline so they read on
 * the backlit water from 200 m. uniforms.uRim (strength) is shared so a viewer can tune it.
 */
export function riderMaterial(sunDir, { roughness = 0.6, rim = 1.5, sheen = 0.0, emissive = 0.0 } = {}) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness, metalness: 0.0 });
  const u = {
    uRSun: { value: sunDir },
    uRimColor: { value: new THREE.Color(1.0, 0.62, 0.32) },
    uRim: { value: rim },
    uSelfLit: { value: emissive },
    uSheen: { value: sheen },
  };
  mat.userData.rim = u;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform vec3 uRSun; uniform vec3 uRimColor; uniform float uRim; uniform float uSelfLit; uniform float uSheen;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{
  vec3 sunV = normalize((viewMatrix * vec4(uRSun, 0.0)).xyz);
  vec3 vdir = normalize(vViewPosition);
  float ndv = clamp(dot(normal, vdir), 0.0, 1.0);
  float back = clamp(dot(-vdir, sunV), 0.0, 1.0);              // camera looks toward the sun
  float edge = pow(1.0 - ndv, 2.5);
  float facing = smoothstep(-0.35, 0.6, dot(normal, sunV));
  vec3 rim = uRimColor * (0.35 + 0.65 * diffuseColor.rgb) * edge * (facing * (0.3 + 0.7 * back) + 0.6 * pow(back, 4.0));
  // readability at range: the rim widens/brightens and the albedo lifts a little with distance, so the riders'
  // colours and silhouettes still pop from the wide camera (150–300 m) without changing the close-up look
  float far = smoothstep(50.0, 220.0, length(vViewPosition));
  rim *= 1.0 + 2.5 * far;
  rim += uRimColor * (0.35 + 0.65 * diffuseColor.rgb) * pow(1.0 - ndv, 1.2) * far * 0.9 * (0.3 + 0.7 * back);
  totalEmissiveRadiance += rim * uRim + diffuseColor.rgb * (uSelfLit + 0.22 * far);
  totalEmissiveRadiance += vec3(0.9, 0.95, 1.0) * uSheen * pow(1.0 - ndv, 4.0) * 0.4;   // wet sheen
}`);
  };
  mat.customProgramCacheKey = () => 'bcRider';
  return mat;
}

/** Skinned mesh with flat bones (children of the mesh, matrices set directly in mesh space each frame). */
export function makeSkinned(geometry, material, boneInverses) {
  const mesh = new THREE.SkinnedMesh(geometry, material);
  const bones = boneInverses.map(() => { const b = new THREE.Bone(); b.matrixAutoUpdate = false; return b; });
  for (const b of bones) mesh.add(b);
  mesh.bind(new THREE.Skeleton(bones, boneInverses), new THREE.Matrix4());
  mesh.frustumCulled = false;
  return { mesh, bones };
}

/** Set bone i's matrix (mesh space) and keep matrixWorld in sync later via updateMatrixWorld. */
export function setBone(bones, i, m) { bones[i].matrix.copy(m); }

export const color = (hex) => new THREE.Color(hex);
