// The Surf Lab host: scene, render loop, time control, cameras, lighting, GUI, capture.

import * as THREE from 'three';
import GUI from 'lil-gui';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { SimClock, SIM_DT } from './core/clock.ts';
import { ChaseCamera } from './camera/chase.ts';
import { Lighting, PRESETS, type PresetId } from './look/lighting.ts';
import { Sea, makeStudioFloor } from './stage/sea.ts';
import { WaveFace } from './surfsim/waveFace.ts';
import { BoardMotion, type ManeuverKind } from './surfsim/boardMotion.ts';
import { Hud, Profiler } from './debug/hud.ts';

export type CamMode = 'chase' | 'orbit' | 'side' | 'front' | 'top';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

export class Lab {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly clock = new SimClock();
  readonly wave = new WaveFace();
  readonly motion: BoardMotion;
  readonly chase: ChaseCamera;
  readonly orbitCam: THREE.PerspectiveCamera;
  readonly orbit: OrbitControls;
  readonly lighting: Lighting;
  readonly sea = new Sea();
  readonly floor = makeStudioFloor();
  readonly boardRoot = new THREE.Group();
  readonly prof = new Profiler();
  readonly hud: Hud;
  gui!: GUI;
  camMode: CamMode = 'chase';
  presetId: PresetId = 'B';
  /** Subsystems that tick at the fixed rate and update per frame (added by later steps). */
  readonly systems: LabSystem[] = [];
  private lastReal = performance.now();
  private running = false;
  ready = false;
  private orbitFollow = new THREE.Vector3();
  private chaseSubject = { position: new THREE.Vector3(), heading: new THREE.Vector3(1, 0, 0), roll: 0 };

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(this.renderer.domElement);
    const aspect = container.clientWidth / Math.max(1, container.clientHeight);
    this.chase = new ChaseCamera(aspect);
    this.orbitCam = new THREE.PerspectiveCamera(40, aspect, 0.02, 6000);
    this.orbitCam.position.set(3, 1.8, 3);
    this.orbit = new OrbitControls(this.orbitCam, this.renderer.domElement);
    this.orbit.target.set(0, 0.9, 0);
    this.orbit.enableDamping = true;
    this.lighting = new Lighting(this.renderer, this.scene);
    this.motion = new BoardMotion(this.wave);
    this.hud = new Hud(document.body);
    this.boardRoot.name = 'BOARD_root';
    this.scene.add(this.sea.mesh, this.floor, this.boardRoot);
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('keydown', (e) => this.onKey(e));
  }

  addSystem(s: LabSystem): void {
    this.systems.push(s);
  }

  async start(): Promise<void> {
    await this.lighting.load();
    const q = new URLSearchParams(location.search);
    this.presetId = (q.get('preset') as PresetId) || 'B';
    this.camMode = (q.get('cam') as CamMode) || 'chase';
    this.applyPreset(this.presetId);
    if (q.has('script'))
      this.script = q.get('script')!.split(',').map((e) => {
        const [tt, k] = e.split(':');
        return [parseFloat(tt), k as ManeuverKind] as [number, ManeuverKind];
      });
    for (const s of this.systems) await s.init?.(this);
    this.buildGui();
    if (q.has('capture')) document.body.classList.add('capture');
    if (q.has('seek')) this.seek(parseFloat(q.get('seek')!));
    if (q.has('paused')) this.clock.paused = true;
    this.setCam(this.camMode);
    if (q.has('orbit')) {
      // orbit=azimuthDeg,elevationDeg,distance[,targetHeight] relative to the board, for captures
      const [az, el, d, th] = q.get('orbit')!.split(',').map(Number);
      this.orbitAround(az, el, d, th ?? 0.9);
    }
    this.running = true;
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
    this.ready = true;
  }

  applyPreset(id: PresetId): void {
    this.presetId = id;
    const p = this.lighting.apply(id);
    const sea = p.stage === 'sea';
    this.sea.mesh.visible = sea;
    this.floor.visible = !sea;
    if (!sea) this.motion.mode = 'manual';
  }

  /** Reset and run the simulation deterministically up to time t (no rendering). */
  seek(t: number): void {
    this.reset();
    const n = Math.round(t / SIM_DT);
    for (let i = 0; i < n; i++) this.tick();
    this.chase.reset();
  }

  reset(): void {
    this.scriptIdx = 0;
    this.clock.reset();
    this.motion.reset();
    for (const s of this.systems) s.reset?.(this);
    this.chase.reset();
  }

  commit(kind: ManeuverKind): void {
    const tBoard = this.motion.commit(kind);
    for (const s of this.systems) s.onManeuver?.(this, kind, tBoard);
  }

  /** Advance exactly `frames` render frames of 1/60 s (2 ticks each) without real time; for tests. */
  advanceFrames(frames: number, render = false): void {
    for (let f = 0; f < frames; f++) {
      this.prof.begin('sim');
      this.tick();
      this.tick();
      this.prof.end('sim');
      this.updateFrame(2 * SIM_DT);
      if (render) this.render();
    }
  }

  /** Scripted maneuver commits [time, kind] (URL `script=2:bottomTurn,8:cutback`), replayed on reset. */
  script: Array<[number, ManeuverKind]> = [];
  private scriptIdx = 0;

  private tick(): void {
    const t0 = this.clock.time;
    while (this.scriptIdx < this.script.length && this.script[this.scriptIdx][0] <= t0 + 1e-9) this.commit(this.script[this.scriptIdx++][1]);
    this.clock.onTick();
    const t = this.clock.time;
    this.motion.tick(t);
    for (const s of this.systems) s.tick?.(this, t, SIM_DT);
  }

  private frame(): void {
    if (!this.running) return;
    const now = performance.now();
    const realDt = (now - this.lastReal) / 1000;
    this.lastReal = now;
    this.hud.frame();
    const n = this.clock.advance(realDt);
    this.prof.begin('sim');
    for (let i = 0; i < n; i++) this.tick();
    this.prof.end('sim');
    this.updateFrame(n * SIM_DT);
    this.render();
    this.hud.draw(this.prof, this.renderer, this.clock.time, `${this.motion.state.maneuver}  v ${this.motion.state.speed.toFixed(1)} m/s  x${this.clock.timeScale}${this.clock.paused ? ' (paused)' : ''}`);
  }

  /** Per-frame (render-rate) update after the fixed ticks. simDt = sim time advanced this frame. */
  updateFrame(simDt: number): void {
    const S = this.motion.state;
    this.boardRoot.position.copy(S.position);
    this.boardRoot.quaternion.copy(S.quaternion);
    this.boardRoot.updateMatrixWorld(true);
    this.prof.begin('systems');
    for (const s of this.systems) s.frame?.(this, simDt);
    this.prof.end('systems');
    this.sea.update(this.wave, this.clock.time, S.position, this.lighting.seaEnv);
    this.floor.position.set(S.position.x, S.position.y - 0.16, S.position.z);
    this.lighting.follow(_v.copy(S.position).addScaledVector(_v2.set(0, 1, 0), 0.8));

    // chase subject: heading from the board's horizontal velocity (or its nose when slow)
    const cs = this.chaseSubject;
    cs.position.copy(S.position);
    _v.copy(S.velocity).setY(0);
    if (_v.lengthSq() < 0.25) _v.set(0, 0, 1).applyQuaternion(S.quaternion).setY(0);
    cs.heading.copy(_v.normalize());
    // roll about the heading axis: board up vs world up, signed toward the right of heading
    _v2.set(0, 1, 0).applyQuaternion(S.quaternion);
    const right = _v.set(-cs.heading.z, 0, cs.heading.x); // heading x up = right-hand side
    cs.roll = Math.atan2(_v2.dot(right), _v2.y);
    this.chase.update(cs, simDt > 0 ? simDt : 0);

    if (this.camMode === 'orbit') {
      // orbit follows the board translation
      _v.copy(S.position).sub(this.orbitFollow);
      this.orbitCam.position.add(_v);
      this.orbit.target.add(_v);
      this.orbitFollow.copy(S.position);
      this.orbit.update();
    } else if (this.camMode !== 'chase') {
      this.placeAnalysisCam(this.camMode);
    }
  }

  /** Fixed analysis cameras in the heading frame: side, front, top. */
  private placeAnalysisCam(mode: CamMode): void {
    const S = this.motion.state;
    const h = this.chaseSubject.heading;
    const c = this.orbitCam;
    const center = _v.copy(S.position).add(_v2.set(0, 0.9, 0));
    const right = _v2.set(-h.z, 0, h.x);
    c.up.set(0, 1, 0);
    if (mode === 'side') c.position.copy(center).addScaledVector(right, 4.5);
    else if (mode === 'front') c.position.copy(center).addScaledVector(h, 4.5);
    else {
      c.position.copy(center).add(new THREE.Vector3(0, 5, 0));
      c.up.copy(h);
    }
    c.lookAt(center);
  }

  /** Place the orbit camera around the board: azimuth from the board's tail (deg), elevation, distance. */
  orbitAround(azDeg: number, elDeg: number, dist: number, targetHeight = 0.9): void {
    const S = this.motion.state;
    const t = _v.copy(S.position).add(_v2.set(0, targetHeight, 0));
    this.orbit.target.copy(t);
    const back = new THREE.Vector3(0, 0, -1).applyQuaternion(S.quaternion).setY(0).normalize();
    const az = (azDeg * Math.PI) / 180;
    const el = (elDeg * Math.PI) / 180;
    const dir = back.applyAxisAngle(new THREE.Vector3(0, 1, 0), az);
    this.orbitCam.position.copy(t).addScaledVector(dir, dist * Math.cos(el)).add(_v2.set(0, dist * Math.sin(el), 0));
    this.orbitFollow.copy(S.position);
    this.orbitCam.lookAt(t);
    this.orbit.update();
  }

  get activeCamera(): THREE.PerspectiveCamera {
    return this.camMode === 'chase' ? this.chase.camera : this.orbitCam;
  }

  render(): void {
    this.prof.begin('render');
    this.renderer.render(this.scene, this.activeCamera);
    this.prof.end('render');
  }

  resize(): void {
    const el = this.renderer.domElement.parentElement!;
    const w = el.clientWidth;
    const h = el.clientHeight;
    this.renderer.setSize(w, h);
    for (const c of [this.chase.camera, this.orbitCam]) {
      c.aspect = w / Math.max(1, h);
      c.updateProjectionMatrix();
    }
  }

  /** Render now and return a PNG data URL (optionally at a higher pixel ratio). */
  screenshot(scale = 1): string {
    const pr = this.renderer.getPixelRatio();
    if (scale !== 1) this.renderer.setPixelRatio(pr * scale);
    this.render();
    const url = this.renderer.domElement.toDataURL('image/png');
    if (scale !== 1) this.renderer.setPixelRatio(pr);
    return url;
  }

  downloadScreenshot(scale = 1): void {
    const a = document.createElement('a');
    a.href = this.screenshot(scale);
    a.download = `surflab_${this.presetId}_${this.camMode}_t${this.clock.time.toFixed(2)}.png`;
    a.click();
  }

  private onKey(e: KeyboardEvent): void {
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    if (e.key === ' ') this.clock.paused = !this.clock.paused;
    else if (e.key === '.') this.clock.stepFrames(1);
    else if (e.key === 'p') this.downloadScreenshot(1);
    else if (e.key === 'h') this.hud.el.classList.toggle('hidden');
    else if (e.key === 'c') this.setCam(this.camMode === 'chase' ? 'orbit' : 'chase');
  }

  setCam(m: CamMode): void {
    this.camMode = m;
    if (m === 'orbit') {
      const S = this.motion.state;
      this.orbitFollow.copy(S.position);
      this.orbit.target.copy(S.position).add(_v.set(0, 0.9, 0));
      this.orbitCam.position.copy(this.chase.camera.position);
    }
    this.orbit.enabled = m === 'orbit';
  }

  private buildGui(): void {
    const gui = new GUI({ title: 'Surf Lab', width: 300 });
    this.gui = gui;
    const view = gui.addFolder('View');
    const vs = { cam: this.camMode, preset: this.presetId };
    view.add(vs, 'cam', ['chase', 'orbit', 'side', 'front', 'top']).name('camera').onChange((m: CamMode) => this.setCam(m));
    view
      .add(vs, 'preset', Object.fromEntries(Object.values(PRESETS).map((p) => [p.label, p.id])))
      .name('lighting')
      .onChange((id: PresetId) => this.applyPreset(id));
    const sun = { az: this.lighting.preset.sunAzimuthDeg, el: this.lighting.preset.sunElevationDeg };
    view.add(sun, 'az', -180, 180, 1).name('sun azimuth').onChange(() => this.lighting.setSun(sun.az, sun.el));
    view.add(sun, 'el', 1, 89, 0.5).name('sun elevation').onChange(() => this.lighting.setSun(sun.az, sun.el));
    view.add(this.renderer, 'toneMappingExposure', 0.2, 3, 0.01).name('exposure').listen();
    const cf = view.addFolder('Chase camera').close();
    const cp = this.chase.p;
    cf.add(cp, 'distance', 3, 8, 0.1);
    cf.add(cp, 'height', 1, 3, 0.05);
    cf.add(cp, 'fovDeg', 35, 60, 0.5).name('vertical FOV');
    cf.add(cp, 'yawLag', 0.05, 1, 0.01).name('yaw lag (s)');
    cf.add(cp, 'heightLag', 0.05, 1, 0.01).name('height lag (s)');
    cf.add(cp, 'rollFollow', 0, 0.5, 0.01).name('roll pass-through');
    cf.add(cp, 'aimHeight', 0, 1.8, 0.05);
    cf.add(cp, 'aimAhead', 0, 5, 0.1);

    const time = gui.addFolder('Time');
    time.add(this.clock, 'paused').listen();
    time.add(this.clock, 'timeScale', 0.05, 2, 0.05).name('time scale');
    const ta = {
      step: () => this.clock.stepFrames(1),
      reset: () => this.reset(),
      shot: () => this.downloadScreenshot(1),
      shot2x: () => this.downloadScreenshot(2),
    };
    time.add(ta, 'step').name('step 1 frame (.)');
    time.add(ta, 'reset');
    time.add(ta, 'shot').name('screenshot PNG (p)');
    time.add(ta, 'shot2x').name('screenshot PNG 2x');

    for (const s of this.systems) s.gui?.(this, gui);
  }
}

/** A lab subsystem (board, rider, stream, overlays). All hooks optional. */
export interface LabSystem {
  init?(lab: Lab): void | Promise<void>;
  reset?(lab: Lab): void;
  tick?(lab: Lab, t: number, dt: number): void;
  frame?(lab: Lab, simDt: number): void;
  gui?(lab: Lab, gui: GUI): void;
  onManeuver?(lab: Lab, kind: ManeuverKind, boardStart: number): void;
}
