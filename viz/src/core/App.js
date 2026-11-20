// App shell: renderer, scene, main camera, sky + environment, ocean, post, fixed-step sim and the
// system wiring defined in contracts.js "app / systems".
//
// Per sim step (t = time after the step):
//   events = input.drainUntil(t) → cfg events applied to app.cfg → swell.step(t, DT, events) → beat.step(t, DT, events)
//   → riders.step(t, DT, swell, beat) → fx.step(t, DT) → cameraRig.step(t, DT)
// Per rendered frame (t = simTime):
//   ocean FFT(t) → spot/waveMesh/fx/riderViews.update(t) → cameraRig.render(app) → hud.update
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
import { SUN_COLOR } from '../sky/skyModel.js';
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

    this.sky = new Sky(this.waterUniforms);
    this.scene.add(this.sky.mesh);
    this.envMap = this.sky.buildEnvMap(renderer);
    this.scene.environment = this.envMap;

    this.sunLight = new THREE.DirectionalLight(new THREE.Color().setRGB(...SUN_COLOR, THREE.LinearSRGBColorSpace), 1.0);
    this.sunLight.position.copy(this.sunDir).multiplyScalar(1000);
    this.sunLight.target.position.set(0, 0, 0);
    this.scene.add(this.sunLight, this.sunLight.target);

    this.ocean = new Ocean(this.waterUniforms);
    this.scene.add(this.ocean.mesh);

    // ---------------------------------------------------------------- post
    const buf = this._bufferSize();
    this.createPost = (pw, ph) => new Post(renderer, pw, ph);
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

  // ---------------------------------------------------------------- rendering
  render() {
    const t = this.simTime;
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
