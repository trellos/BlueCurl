import * as THREE from 'three';

// A white thruster shortboard, 1.83 m (6'0") long: lofted from a plan-shape outline, a thickness
// foil, a rocker line and a soft-railed cross-section, with three fins. Board space: +x toward the
// nose, +y up (deck), +z to the right rail; the origin is on the bottom at the widest point (the
// stance centre), so placing the origin on the water surface puts the board's planing area on it.
export const BOARD = {
  length: 1.83,
  width: 0.483,       // 19"
  thick: 0.062,       // 2 7/16"
  noseRocker: 0.125,  // bottom lift at the nose (m)
  tailRocker: 0.045,
  wideAt: 0.47,       // widest point, fraction of the length from the tail
};

const smooth = (a, b, v) => { const t = Math.min(Math.max((v - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };
// half-width at u (0 tail .. 1 nose): pulled-in pointed nose, squash tail ~0.36 m wide at 12" up
function halfWidth(u) {
  const W = BOARD.width / 2;
  if (u >= BOARD.wideAt) {
    const v = (u - BOARD.wideAt) / (1 - BOARD.wideAt);
    return W * Math.pow(Math.max(1 - v * v, 0), 0.62) * (1 - 0.06 * v);
  }
  const v = (BOARD.wideAt - u) / BOARD.wideAt;
  return W * (1 - 0.42 * Math.pow(v, 1.9)) * (u < 0.015 ? 0.6 + 0.4 * u / 0.015 : 1);
}
// rocker: bottom height above the stance point
function rocker(u) {
  const c = BOARD.wideAt;
  if (u >= c) { const v = (u - c) / (1 - c); return BOARD.noseRocker * Math.pow(v, 2.3); }
  const v = (c - u) / c; return BOARD.tailRocker * Math.pow(v, 2.0);
}
// thickness foil
function thickness(u) {
  const v = (u - 0.45) / 0.55;
  const t = u >= 0.45 ? 1 - 0.78 * Math.pow(Math.max(v, 0), 1.6) : 1 - 0.55 * Math.pow((0.45 - u) / 0.45, 1.8);
  return BOARD.thick * Math.max(t, 0.12);
}

function buildHull(NU = 72, NV = 28) {
  const pos = [], uv = [], idx = [];
  const L = BOARD.length, x0 = -BOARD.wideAt * L;
  for (let i = 0; i <= NU; i++) {
    // denser stations toward the nose and tail tips
    const s = i / NU, u = 0.5 - 0.5 * Math.cos(Math.PI * s);
    const w = halfWidth(u), th = thickness(u), r = rocker(u);
    for (let j = 0; j <= NV; j++) {
      // around the section: j = 0 bottom centre .. NV/2 deck centre .. NV bottom centre (other rail)
      const a = (j / NV) * 2 * Math.PI - Math.PI / 2;
      const c = Math.cos(a), sn = Math.sin(a);
      // soft "down rail": deck domed, bottom nearly flat with slight vee toward the tail
      const lat = Math.sign(c) * Math.pow(Math.abs(c), 0.42);
      const y = sn >= 0 ? th * (0.32 + 0.68 * Math.pow(sn, 0.55)) : th * 0.32 * (1 - Math.pow(-sn, 0.30));
      const vee = (1 - Math.abs(lat)) * 0.004 * (1 - smooth(0.0, 0.5, u));
      pos.push(x0 + u * L, r + y - vee, w * lat);
      uv.push(u, j / NV);
    }
  }
  const row = NV + 1;
  for (let i = 0; i < NU; i++) for (let j = 0; j < NV; j++) {
    const a = i * row + j, b = a + 1, c = a + row, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// thruster fins: a raked foil outline extruded thin
function buildFins() {
  const L = BOARD.length, x0 = -BOARD.wideAt * L;
  const fin = (xBase, zBase, toe, cant, depth, base) => {
    const pts = [];
    const N = 10;
    for (let k = 0; k <= N; k++) {
      const v = k / N;
      // leading edge raked back, trailing edge slightly swept
      const lead = -base * 0.5 + base * 0.62 * Math.pow(v, 1.4);
      const trail = base * 0.5 - base * 0.25 * Math.pow(v, 0.8) + base * 0.15 * v;
      pts.push([lead, -depth * v], [Math.max(trail, lead + 0.004), -depth * v]);
    }
    const pos = [], idx = [];
    const thick = 0.005;
    for (const side of [-1, 1]) for (const [px, py] of pts) {
      const tz = side * thick * (1 - Math.min(Math.abs(py) / depth, 1) * 0.6);
      // toe-in (yaw) and cant (roll) of the fin plane
      const xx = px * Math.cos(toe) - tz * Math.sin(toe), zz = px * Math.sin(toe) + tz * Math.cos(toe);
      const yy = py * Math.cos(cant), zc = zz + py * Math.sin(cant);
      pos.push(xBase + xx, yy + 0.002, zBase + zc);
    }
    const n = pts.length;
    for (let k = 0; k < N; k++) {
      const a = 2 * k, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, c, b, b, c, d);
      idx.push(n + a, n + b, n + c, n + b, n + d, n + c);
      idx.push(a, n + a, c, c, n + a, n + c);
      idx.push(b, d, n + b, d, n + d, n + b);
    }
    return { pos, idx };
  };
  const parts = [
    fin(x0 + 0.115, 0, 0, 0, 0.112, 0.105),
    fin(x0 + 0.29, 0.195, -0.06, 0.12, 0.115, 0.11),
    fin(x0 + 0.29, -0.195, 0.06, -0.12, 0.115, 0.11),
  ];
  const pos = [], idx = [];
  for (const p of parts) { const o = pos.length / 3; pos.push(...p.pos); idx.push(...p.idx.map((i) => i + o)); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Array((pos.length / 3) * 2).fill(0), 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Lit like the rest of the opaque scene (scene-linear radiance before the post grade): white
// gloss-coated foam (slightly translucent at the thin nose and rails), a wood stringer, a grey
// traction pad on the tail; the bottom darkens where it is wet.
const VERT = /* glsl */ `
out vec3 vN; out vec3 vW; out vec2 vUv; out vec3 vLocal;
void main() {
  vUv = uv; vLocal = position;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const FRAG = /* glsl */ `
uniform vec3 uSunDir, uSunColor, uSkyAmb;
uniform float uFin;
in vec3 vN; in vec3 vW; in vec2 vUv; in vec3 vLocal;
void main() {
  vec3 N = normalize(vN);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(cameraPosition - vW);
  // section parameter: 0 / 1 bottom centre, 0.5 deck centre
  float onDeck = smoothstep(0.0, 0.25, sin(6.2831853 * vUv.y - 1.5707963));
  vec3 alb = vec3(0.86, 0.87, 0.86);
  if (uFin < 0.5) {
    // stringer (deck and bottom), traction pad (deck, tail 30 cm), wax haze on the deck
    float str = 1.0 - smoothstep(0.0025, 0.0045, abs(vLocal.z));
    alb = mix(alb, vec3(0.62, 0.50, 0.36), str * 0.85);
    float pad = onDeck * step(vUv.x, 0.17) * step(abs(vLocal.z), 0.17);
    alb = mix(alb, vec3(0.09, 0.10, 0.11), pad);
    alb *= mix(1.0, 0.94, onDeck * (1.0 - pad));
  } else alb = vec3(0.80, 0.82, 0.83);
  // wet bottom and fins
  float wet = uFin > 0.5 ? 1.0 : 1.0 - onDeck;
  alb *= mix(1.0, 0.82, wet);
  float nl = max(dot(N, uSunDir), 0.0);
  float sky = 0.55 + 0.45 * N.y;
  vec3 col = alb * (uSunColor * nl / 3.14159265 + uSkyAmb * sky);
  // gloss coat
  vec3 H = normalize(V + uSunDir);
  float spec = pow(max(dot(N, H), 0.0), 120.0) * 2.2 + pow(max(dot(N, H), 0.0), 18.0) * 0.08;
  float F = 0.04 + 0.96 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
  col += uSunColor * spec * F * nl;
  col += uSkyAmb * 0.6 * F * (0.4 + 0.6 * max(reflect(-V, N).y, 0.0));
  gl_FragColor = vec4(col, 1.0);
}`;

export class Board {
  constructor(shared) {
    const mk = (fin) => new THREE.ShaderMaterial({
      uniforms: { uSunDir: shared.uSunDir, uSunColor: shared.uSunColor, uSkyAmb: shared.uSkyAmb, uFin: { value: fin } },
      vertexShader: VERT, fragmentShader: FRAG, side: THREE.DoubleSide,
    });
    this.group = new THREE.Group();
    this.group.name = 'Shortboard';
    this.hull = new THREE.Mesh(buildHull(), mk(0));
    this.fins = new THREE.Mesh(buildFins(), mk(1));
    this.hull.frustumCulled = this.fins.frustumCulled = false;
    this.group.add(this.hull, this.fins);
    this.group.matrixAutoUpdate = false;
  }
  /** local bottom height (rocker) at a board-space x (for the contact metrics) */
  static bottomAt(xLocal) {
    const u = (xLocal + BOARD.wideAt * BOARD.length) / BOARD.length;
    return rocker(Math.min(Math.max(u, 0), 1));
  }
  /** place by origin, unit forward (nose) and unit up (deck normal) */
  setPose(p, fwd, up) {
    const z = new THREE.Vector3().crossVectors(fwd, up).normalize();
    const y = new THREE.Vector3().crossVectors(z, fwd).normalize();
    const m = this.group.matrix;
    m.makeBasis(fwd, y, z);
    m.setPosition(p);
    this.group.matrixWorldNeedsUpdate = true;
    this.group.updateMatrixWorld(true);
  }
}
