// App shell: renderer, scene, main camera, sky + environment, ocean, post, fixed-step sim and the
// system wiring defined in contracts.js "app / systems".
//
// Per sim step (t = time after the step):
//   events = input.drainUntil(t) → cfg events applied to app.cfg → swell.step(t, DT, events) → beat.step(t, DT, events)
//   → riders.step(t, DT, swell, beat) → fx.step(t, DT) → cameraRig.step(t, DT)
// Per rendered frame (t = simTime):
//   updateSun(t) (day cycle: app.sun, shared sky/water uniforms, sun light + shadow, env map, post grade)
//   → ocean FFT(t) → spot/waveMesh/fx/riderViews.update(t) → cameraRig.render(app) → hud.update
import * as THREE from 'three';
import { DT } from '../contracts.js';
import { FixedClock } from './clock.js';
import { GpuTimer } from './gpuTimer.js';
import { InputBus } from '../input/input.js';
import { Swell } from '../sim/swell.js';
import { Riders } from '../riders/Riders.js';
import { Beat } from '../beat/beat.js';
import { BeatAudio } from '../beat/BeatAudio.js';
import { GuitarInput } from '../input/guitar.js';
import { Pluck } from '../audio/Pluck.js';
import { Spot } from '../spot/Spot.js';
import { WaveMesh } from '../wave/WaveMesh.js';
import { Fx } from '../fx/Fx.js';
import { RiderViews } from '../riders/RiderViews.js';
import { CameraRig } from '../camera/CameraRig.js';
import { Sky } from '../sky/Sky.js';
import { applySun } from '../sky/skyModel.js';
import { dayPhase, sunAt } from '../sky/dayCycle.js';
import { setRiderRim } from '../riders/models/common.js';
import { Ocean } from '../water/Ocean.js';
import { createWaterUniforms } from '../water/waterShading.glsl.js';
import { Post } from '../post/Post.js';
import { Hud } from '../hud/Hud.js';

export const CAMERA_DEFAULT = { position: [40, 55, 150], lookAt: [250, 0, -30], fov: 50, near: 0.5, far: 20000 };

/** Set obj[a][b][c] = value for key 'a.b.c' (creates plain objects on the way). */
export function setPath(obj, key, value) {
  const parts = String(key).split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (o[parts[i]] == null || typeof o[parts[i]] !== 'object') o[parts[i]] = {};
    o = o[parts[i]];
  }
  o[parts[parts.length - 1]] = value;
}
export function mergeDeep(dst, src) {
  for (const [k, v] of Object.entries(src || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) mergeDeep(dst[k], v);
    else dst[k] = v;
  }
  return dst;
}
export function getPath(obj, key) {
  return String(key).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export class App {
  /** Sun shadow box (see _setupSunShadow): focus (world), radius (m), map size, light distance, caster reach. */
  static SHADOW = { focus: [70, 0, -15], radius: 190, mapSize: 4096, dist: 1000, reach: 450 };

  /**
   * opts: { canvas, cfg, capture, width, height (fixed drawing-buffer size, else window), pixelRatio, hud }
   */
  constructor(opts) {
    this.opts = opts;
    this.capture = !!opts.capture;
    this.cfg = opts.cfg;
    this.baseCfg = structuredClone(opts.cfg);      // cfg at t = 0; replays restore it (state = f(cfg, log))
    this.paused = false;
    this.clock = new FixedClock(DT);
    this.fixedSize = !!(opts.width && opts.height);

    // ---------------------------------------------------------------- renderer / scene / camera
    const canvas = opts.canvas;
    const renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, alpha: false, preserveDrawingBuffer: this.capture,
      powerPreference: 'high-performance', stencil: false,
    });
    renderer.setPixelRatio(this.fixedSize ? 1 : (opts.pixelRatio || 1));
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer = renderer;
    this.gl = renderer.getContext();
    this.gpuTimer = new GpuTimer(this.gl);

    const [w, h] = this._cssSize();
    renderer.setSize(w, h, true);

    this.scene = new THREE.Scene();
    const C = CAMERA_DEFAULT;
    this.camera = new THREE.PerspectiveCamera(C.fov, w / h, C.near, C.far);
    this.camera.position.set(...C.position);
    this.camera.lookAt(new THREE.Vector3(...C.lookAt));
    this.camera.updateMatrixWorld();

    // ---------------------------------------------------------------- light, sky, environment, ocean
    this.waterUniforms = createWaterUniforms();
    this.sunDir = this.waterUniforms.uSunDir.value;       // THREE.Vector3 toward the sun (shared object)
    const a = this.cfg.ambient;
    this.waterUniforms.uAmbient.value.set(a.amp, a.period, a.amp2, a.period2);

    // day cycle state (contracts "day cycle"); filled by updateSun() once per rendered frame
    this.sun = { phase: 0, elevationDeg: 0, azimuthDeg: 0, dir: this.sunDir, color: new THREE.Color(), intensity: 0,
      ambient: new THREE.Color(), state: null };
    this.dayGrade = { exposure: 1, saturation: 1 };   // shared by every Post (main + PiP)

    this.sky = new Sky(this.waterUniforms);
    this.scene.add(this.sky.mesh);
    const ph0 = dayPhase(null, 0, this.cfg);
    this.sky.updateEnv(renderer, ph0);
    this.envMap = this.sky.envMap;                     // same texture object on every (quantised) rebuild
    this.scene.environment = this.envMap;

    this.sunLight = new THREE.DirectionalLight(0xffffff, 1.0);
    this.sunLight.position.copy(this.sunDir).multiplyScalar(1000);
    this.sunLight.target.position.set(0, 0, 0);
    this.scene.add(this.sunLight, this.sunLight.target);

    this.ocean = new Ocean(this.waterUniforms);
    this.scene.add(this.ocean.mesh);

    // ---------------------------------------------------------------- post
    const buf = this._bufferSize();
    this.createPost = (pw, ph) => new Post(renderer, pw, ph, {}, this.dayGrade);
    this.post = this.createPost(buf.x, buf.y);

    // ---------------------------------------------------------------- sim + systems
    this.input = new InputBus(() => this.simTime);
    this.input.bindKeyboard(window);
    this.swell = new Swell(this.cfg);
    this.beat = new Beat(this.cfg);
    this.riders = new Riders(this.cfg);
    this.hud = new Hud(this, { visible: opts.hud !== false && this.cfg.hud !== false });
    this.spot = new Spot(this);
    this.waveMesh = new WaveMesh(this);
    this.fx = new Fx(this);
    this.riderViews = new RiderViews(this);
    this.cameraRig = new CameraRig(this);
    this.beatAudio = new BeatAudio(this);          // output only (live loop); never feeds the sim
    this.guitarInput = new GuitarInput(this);      // sets app.guitar; mic starts on a user gesture
    this.pluck = new Pluck(this);                  // keys 1–8 sound a pluck in the guitar's key/octave (output only)
    this.visuals = [this.spot, this.waveMesh, this.fx, this.riderViews];
    this._setupSunShadow();
    this.updateSun(0);
    // every system, in step order; reset() is called on each that has it whenever the sim is rewound (+ beatAudio)
    this.systems = [this.swell, this.beat, this.riders, this.spot, this.waveMesh, this.fx, this.riderViews, this.cameraRig];

    this._stepFn = (t, dt) => this.step(t, dt);
    this._bindKeys();
    window.addEventListener('pointerdown', () => this.beatAudio?.unlock());
    if (!this.fixedSize) window.addEventListener('resize', () => this.resize());
  }

  get simTime() { return this.clock.t; }

  _cssSize() {
    if (this.fixedSize) return [this.opts.width, this.opts.height];
    return [Math.max(1, window.innerWidth), Math.max(1, window.innerHeight)];
  }
  _bufferSize() { return this.renderer.getDrawingBufferSize(new THREE.Vector2()); }

  resize() {
    const [w, h] = this._cssSize();
    this.renderer.setSize(w, h, true);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const b = this._bufferSize();
    this.post.resize(b.x, b.y);
  }

  _bindKeys() {
    window.addEventListener('keydown', (e) => {
      this.beatAudio?.unlock();                  // any key is a user gesture: resume audio
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.code === 'Space') { this.paused = !this.paused; e.preventDefault(); this.hud.update(this, true); }
      else if (e.code === 'KeyH') { this.hud.toggle(); this.hud.update(this, true); }
    });
  }

  // ---------------------------------------------------------------- simulation
  /** One fixed sim step ending at time t. */
  step(t, dt) {
    const events = this.input.drainUntil(t) || [];
    for (const ev of events) {
      if (ev && ev.type === 'cfg' && ev.key != null) this.applyCfg(ev.key, ev.value);
    }
    this.swell.step(t, dt, events);
    this.beat.step(t, dt, events);
    this.riders.step(t, dt, this.swell, this.beat);
    this.fx.step?.(t, dt);
    this.cameraRig.step?.(t, dt);
  }

  /** Apply a config value to app.cfg in place (dotted keys allowed); keeps derived uniforms in sync. */
  applyCfg(key, value) {
    setPath(this.cfg, key, value);
    if (String(key).startsWith('ambient')) {
      const a = this.cfg.ambient;
      this.waterUniforms.uAmbient.value.set(a.amp, a.period, a.amp2, a.period2);
    }
    if (key === 'hud') this.hud.setVisible(!!value);
  }

  /** Advance the sim by `sec` (fixed steps, sim only). Returns steps run. */
  advanceSim(sec) { return this.clock.advance(sec, this._stepFn); }

  /** Restore app.cfg in place (same object: systems hold references) to the t = 0 config. */
  restoreCfg() {
    for (const k of Object.keys(this.cfg)) delete this.cfg[k];
    Object.assign(this.cfg, structuredClone(this.baseCfg));
    const a = this.cfg.ambient;
    this.waterUniforms.uAmbient.value.set(a.amp, a.period, a.amp2, a.period2);
  }

  /** Rewind to t = 0 with a fresh sim and the t = 0 config (input log kept), then fast-forward sim-only to t0. */
  resetSim(t0 = 0) {
    this.restoreCfg();
    this.clock.reset(0);
    this.input.reset();
    this.resetSystems();
    if (t0 > 0) this.advanceSim(t0);
  }

  /** Call reset() on every system that has one (swell, riders, spot, waveMesh, fx, riderViews, cameraRig). */
  resetSystems() {
    for (const s of this.systems) if (s && typeof s.reset === 'function') s.reset();
    this.beatAudio?.reset();
  }

  /**
   * Load an input log (array) or a demo ({cfg, log}: cfg is merged over the current t = 0 config).
   * reset (default): rewind to t = 0, reset() every system and replay sim-only to t0. reset = false only
   * swaps the log (no rewind, systems keep their state).
   */
  loadInput(log, { reset = true, t0 = 0 } = {}) {
    if (log && !Array.isArray(log) && typeof log === 'object') {
      if (log.cfg) { mergeDeep(this.baseCfg, log.cfg); if (!reset) mergeDeep(this.cfg, log.cfg); }
      log = log.log;
    }
    this.input.load(Array.isArray(log) ? log : []);
    if (reset) this.resetSim(t0);
    return this.simTime;
  }

  // ---------------------------------------------------------------- day cycle (WP14)
  /**
   * Sun shadow: one 4096² map over a fixed-radius disc around the visible spot (lineup view: headland, stacks, point
   * shelf, bay beach), re-aimed every frame along the sun; the ortho box keeps a constant size and its centre is
   * snapped to the shadow texel grid (no crawling edges while the sun moves). Caster range reaches SHADOW.reach m
   * toward the sun (jungle hills / headland at grazing sun).
   */
  _setupSunShadow() {
    const L = this.sunLight, S = App.SHADOW;
    L.castShadow = true;
    L.shadow.mapSize.set(S.mapSize, S.mapSize);
    L.shadow.map?.dispose(); L.shadow.map = null;
    const c = L.shadow.camera;
    c.left = -S.radius; c.right = S.radius; c.top = S.radius; c.bottom = -S.radius;
    c.near = S.dist - S.reach; c.far = S.dist + S.radius + 60;
    c.updateProjectionMatrix();
    L.shadow.bias = -0.0003;
    L.shadow.normalBias = 0.35;
    L.shadow.autoUpdate = true;
    this._shX = new THREE.Vector3(); this._shY = new THREE.Vector3(); this._shF = new THREE.Vector3();
  }

  /** Day phase + every sun-driven quantity for sim time t (pure function of beat state, t and cfg). */
  updateSun(t = this.simTime) {
    const phase = dayPhase(this.beat, t, this.cfg);
    const s = sunAt(phase);
    const sun = this.sun;
    applySun(this.waterUniforms, s);                  // sunDir (shared object), sun colour, sky, water deep colour
    sun.state = s; sun.phase = s.phase; sun.elevationDeg = s.elevationDeg; sun.azimuthDeg = s.azimuthDeg;
    sun.intensity = s.intensity;
    sun.color.setRGB(s.color[0], s.color[1], s.color[2], THREE.LinearSRGBColorSpace);
    sun.ambient.setRGB(s.ambient[0], s.ambient[1], s.ambient[2], THREE.LinearSRGBColorSpace);
    // environment map: quantised phase step only
    if (this.sky.updateEnv(this.renderer, phase)) this.scene.environment = this.envMap = this.sky.envMap;
    // sun light (three: irradiance = color · intensity; Lambert albedo/π, same as the water's uSunColor)
    const L = this.sunLight;
    L.color.copy(sun.color);
    L.intensity = s.intensity;
    this._aimShadow(s);
    // post grade, rider rim
    this.dayGrade.exposure = s.exposure;
    this.dayGrade.saturation = s.saturation;
    setRiderRim(s);
    return sun;
  }

  _aimShadow(s) {
    const L = this.sunLight, S = App.SHADOW, d = this.sunDir;
    L.shadow.intensity = s.shadow;
    L.shadow.autoUpdate = s.shadow > 0.001 && s.intensity > 0.001;   // no shadow pass while the sun is down
    if (!L.shadow.autoUpdate) return;
    // light-space basis exactly as the shadow camera's lookAt(target) builds it (z toward the light, up = +Y)
    const X = this._shX.set(0, 1, 0).cross(d).normalize();
    const Y = this._shY.copy(d).cross(X);
    const F = this._shF.set(...S.focus);
    const texel = (2 * S.radius) / S.mapSize;
    const fx = F.dot(X), fy = F.dot(Y);
    F.addScaledVector(X, Math.round(fx / texel) * texel - fx).addScaledVector(Y, Math.round(fy / texel) * texel - fy);
    L.target.position.copy(F);
    L.position.copy(F).addScaledVector(d, S.dist);
    L.target.updateMatrixWorld();
    L.updateMatrixWorld();
  }

  // ---------------------------------------------------------------- rendering
  render() {
    const t = this.simTime;
    this.updateSun(t);
    this.waterUniforms.uTime.value = t;
    this.ocean.update(this.renderer, t);
    this.sky.update(t);
    for (const s of this.visuals) s.update?.(t);
    this.cameraRig.render(this);
    if (!this.capture) this.beatAudio.update(t);
    this.hud.update(this, this.capture);
  }

  /** Render one frame with a GPU timer query around it (live loop). */
  renderTimed() {
    this.gpuTimer.begin();
    this.render();
    this.gpuTimer.end();
  }

  // ---------------------------------------------------------------- live loop
  start() {
    if (this.capture || this._raf) return;
    let last = performance.now();
    const loop = (now) => {
      this._raf = requestAnimationFrame(loop);
      const wall = Math.min(Math.max((now - last) / 1000, 0), 0.25);
      last = now;
      this.hud.frame(wall);
      if (!this.paused) this.advanceSim(wall);
      this.gpuTimer.poll();
      this.renderTimed();
    };
    this._raf = requestAnimationFrame(loop);
  }
}
