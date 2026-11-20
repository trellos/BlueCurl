// Standalone spot viewer. URL params:
//   view=default|suggested|top|low|beach    cam=x,y,z,tx,ty,tz,fov (overrides view)
//   lines=1 (zone break lines)  pip=1 (PiP rectangle outline)  water=0 (hide placeholder water)
//   t=<s> (palm sway time)  parity=1 (GPU bcDepth vs JS depthAt check → window.__parity)
import * as THREE from 'three';
import { Spot, defaultSunDir } from '../src/spot/Spot.js';
import { SPOT_CAMERAS } from '../src/spot/layout.js';
import { depthAt, BATHY_GLSL } from '../src/spot/bathymetry.js';
import { ZONES, uToZ } from '../src/contracts.js';

const q = new URLSearchParams(location.search);
const W = innerWidth, H = innerHeight;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(W, H);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const sunDir = defaultSunDir();
const HAZE = new THREE.Color(0xf2c7a4);
scene.fog = new THREE.Fog(HAZE, 1400, 9000);

// --- dawn sky dome (gradient + sun glow)
{
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { uSun: { value: sunDir } },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `varying vec3 vDir; uniform vec3 uSun;
      void main(){ vec3 d = normalize(vDir); float h = d.y;
        vec3 zen = vec3(0.16, 0.30, 0.62), mid = vec3(0.78, 0.62, 0.66), hor = vec3(1.25, 0.78, 0.48);
        vec3 c = mix(hor, mid, smoothstep(0.0, 0.18, h)); c = mix(c, zen, smoothstep(0.12, 0.7, h));
        float s = max(dot(d, normalize(uSun)), 0.0);
        c += vec3(1.4, 0.75, 0.35) * pow(s, 18.0) * 0.9 + vec3(8.0, 5.0, 2.6) * pow(s, 1800.0);
        c = mix(c, vec3(0.55, 0.45, 0.45), smoothstep(0.0, -0.2, h));
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(9000, 48, 24), mat);
  sky.frustumCulled = false;
  scene.add(sky);
}

// --- placeholder water (dev only): depth-tinted translucent plane using BATHY_GLSL
const waterMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, fog: true,
  uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uSun: { value: sunDir }, uCam: { value: new THREE.Vector3() } }]),
  vertexShader: `varying vec3 vW;
    #include <fog_pars_vertex>
    void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; vec4 mvPosition = viewMatrix * w; gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
    }`,
  fragmentShader: `varying vec3 vW; uniform vec3 uSun; uniform vec3 uCam;
    #include <fog_pars_fragment>
    ${BATHY_GLSL}
    void main(){
      float d = bcDepth(vW.xz);
      if (d < -0.05) discard;
      vec3 deep = vec3(0.02, 0.16, 0.20), shallow = vec3(0.10, 0.55, 0.52);
      float k = 1.0 - exp(-max(d, 0.0) / 3.5);
      vec3 V = normalize(uCam - vW);
      float fres = 0.04 + 0.96 * pow(1.0 - max(V.y, 0.0), 5.0);
      vec3 R = reflect(-V, vec3(0.0, 1.0, 0.0));
      float glint = pow(max(dot(R, normalize(uSun)), 0.0), 220.0);
      vec3 sky = vec3(1.0, 0.72, 0.52);
      vec3 c = mix(shallow, deep, k);
      c = mix(c, sky, fres * 0.45) + vec3(4.0, 2.6, 1.4) * glint;
      float a = mix(0.25, 0.97, k);
      a = max(a, fres);
      a *= smoothstep(-0.05, 0.25, d);
      gl_FragColor = vec4(c, a);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      #include <fog_fragment>
    }`,
});
const water = new THREE.Mesh(new THREE.PlaneGeometry(14000, 14000, 1, 1).rotateX(-Math.PI / 2), waterMat);
water.renderOrder = 5;
if (q.get('water') !== '0') scene.add(water);

// --- the spot
const app = { renderer, scene, sunDir };
const spot = new Spot(app);

// --- zone break lines
if (q.get('lines') === '1' || q.get('view') === 'top') {
  const cols = [0xff3b30, 0xffd60a, 0x30d5ff];
  ZONES.forEach((zn, i) => {
    const z0 = uToZ(zn.u0), z1 = uToZ(zn.u1);
    const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(zn.lineX, 0.6, z0), new THREE.Vector3(zn.lineX, 0.6, z1)]);
    const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: cols[i], depthTest: false, fog: false }));
    l.renderOrder = 10; scene.add(l);
    // wide ribbon for visibility
    const rib = new THREE.Mesh(new THREE.PlaneGeometry(3, z1 - z0).rotateX(-Math.PI / 2).translate(zn.lineX, 0.7, (z0 + z1) / 2),
      new THREE.MeshBasicMaterial({ color: cols[i], depthTest: false, fog: false, toneMapped: false }));
    rib.renderOrder = 10; scene.add(rib);
  });
}

// --- cameras
let camera;
const view = q.get('view') || 'default';
const camArg = q.get('cam');
if (view === 'top' && !camArg) {
  const cx = 95, cz = -10, half = 200;
  camera = new THREE.OrthographicCamera(-half * W / H, half * W / H, half, -half, 1, 2000);
  camera.position.set(cx, 900, cz);
  camera.up.set(1, 0, 0);                  // sea (east) at the top, north to the right
  camera.lookAt(cx, 0, cz);
  scene.fog = null;
} else {
  let pose = SPOT_CAMERAS[view] || SPOT_CAMERAS.default;
  if (view === 'low') pose = { pos: [260, 6, 36], target: [36, 8, 36], fov: 50 };
  if (view === 'beach') pose = { pos: [6, 3, -90], target: [84, 7, 36], fov: 55 };
  if (view === 'old') pose = { pos: [40, 55, 150], target: [250, 0, -30], fov: 50 };
  if (camArg) { const a = camArg.split(',').map(Number); pose = { pos: a.slice(0, 3), target: a.slice(3, 6), fov: a[6] || 50 }; }
  camera = new THREE.PerspectiveCamera(pose.fov, W / H, 1, 20000);
  camera.position.fromArray(pose.pos);
  camera.lookAt(new THREE.Vector3().fromArray(pose.target));
}
waterMat.uniforms.uCam.value.copy(camera.position);
if (q.get('pip') === '1') document.getElementById('pip').style.display = 'block';

const t = Number(q.get('t') || 3.0);
function frame(tt) {
  spot.update(tt);
  renderer.render(scene, camera);
}
frame(t);
const info = renderer.info.render;
const tri = spot.triangles;
document.getElementById('info').textContent =
  `view ${camArg ? 'custom' : view}  spot tris ${tri.total} (terrain ${tri.terrain}, palms ${tri.palms}, bushes ${tri.bushes}, rocks ${tri.boulders + tri.stacks})\n` +
  `drawn tris ${info.triangles}  calls ${info.calls}  palms ${spot.layout.palms.length} stacks ${spot.layout.stacks.length} boulders ${spot.layout.rocks.length}`;
window.__info = { triangles: tri, drawn: info.triangles, calls: info.calls, palms: spot.layout.palms.length };

// --- GPU parity of bcDepth vs depthAt
if (q.get('parity') === '1') {
  const N = 256;
  const rt = new THREE.WebGLRenderTarget(N, N, { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  const pts = [];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    // dense over the spot, plus a wide ring
    const wide = (i + j) % 4 === 0;
    const x = wide ? -2000 + 5000 * i / (N - 1) : -150 + 650 * i / (N - 1);
    const z = wide ? -3000 + 5000 * j / (N - 1) : -350 + 700 * j / (N - 1);
    pts.push([x, z]);
  }
  const tex = new THREE.DataTexture(new Float32Array(pts.flatMap((p) => [p[0], p[1], 0, 1])), N, N, THREE.RGBAFormat, THREE.FloatType);
  tex.needsUpdate = true;
  const pm = new THREE.ShaderMaterial({
    uniforms: { uPts: { value: tex } },
    vertexShader: `void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: `precision highp float; uniform sampler2D uPts; ${BATHY_GLSL}
      void main(){ vec2 p = texelFetch(uPts, ivec2(gl_FragCoord.xy), 0).xy; gl_FragColor = vec4(bcDepth(p), 0.0, 0.0, 1.0); }`,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), pm);
  const ps = new THREE.Scene(); ps.add(quad);
  const oc = new THREE.Camera();
  const tm = renderer.toneMapping; renderer.toneMapping = THREE.NoToneMapping;
  renderer.setRenderTarget(rt); renderer.render(ps, oc); renderer.setRenderTarget(null);
  renderer.toneMapping = tm;
  const buf = new Float32Array(N * N * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, N, N, buf);
  let maxErr = 0, at = null, maxRel = 0;
  for (let k = 0; k < N * N; k++) {
    const js = depthAt(pts[k][0], pts[k][1]), gpu = buf[k * 4];
    const e = Math.abs(js - gpu), rel = e / Math.max(1, Math.abs(js));
    if (e > maxErr) { maxErr = e; at = [pts[k][0], pts[k][1], js, gpu]; }
    maxRel = Math.max(maxRel, rel);
  }
  window.__parity = { n: N * N, maxErr, maxRel, at };
  document.getElementById('info').textContent += `\nparity n=${N * N} maxErr=${maxErr.toExponential(2)} m  maxRel=${maxRel.toExponential(2)}`;
  frame(t);
}

window.__ready = Promise.resolve(true);
if (q.get('anim') === '1') {
  const t0 = performance.now();
  renderer.setAnimationLoop(() => frame(t + (performance.now() - t0) / 1000));
}
