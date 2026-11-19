// Lab system: the placeholder surfer driven by Rider v0, standing on the board.

import * as THREE from 'three';
import type GUI from 'lil-gui';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Lab, LabSystem } from './app.ts';
import type { BoardSystem } from './boardSystem.ts';
import type { ManeuverKind } from './surfsim/boardMotion.ts';
import { Rig } from './rider/rig.ts';
import { Rider, type StreamPacket } from './rider/rider.ts';

export const CHARACTER_URL = 'assets/characters/rocketbox_male_adult_01.glb';

export class RiderSystem implements LabSystem {
  rider!: Rider;
  rig!: Rig;
  private boardSys: BoardSystem;
  private lab!: Lab;
  private boardWorld = new THREE.Matrix4();
  /** Per-frame CPU ms of the rider (synth + IK + head + write), excluding the metric. */
  lastMs = 0;

  constructor(boardSys: BoardSystem) {
    this.boardSys = boardSys;
  }

  async init(lab: Lab): Promise<void> {
    this.lab = lab;
    const gltf = await new GLTFLoader().loadAsync(`${import.meta.env.BASE_URL}${CHARACTER_URL}`);
    const root = gltf.scene;
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
      }
    });
    this.rig = new Rig(root);
    this.rider = new Rider(this.rig, this.boardSys.board);
    lab.boardRoot.add(root);
    this.boardSys.listeners.push((b) => this.rider.setBoard(b));
    const q = new URLSearchParams(location.search);
    if (q.get('stance') === 'goofy') this.rider.setStance('goofy');
    if (q.has('torture')) this.rider.p.torture = q.get('torture') as Rider['p']['torture'];
    if (q.has('stability')) this.rider.p.stabilityOverride = parseFloat(q.get('stability')!);
    if (q.has('phase')) this.startPhase = q.get('phase') as 'paddle';
    if (q.has('popupAt')) this.popupAt = parseFloat(q.get('popupAt')!);
    this.reset();
  }

  /** Phase to (re)start in after a reset, and the automatic pop-up delay. */
  startPhase: 'ride' | 'paddle' = 'ride';
  popupAt = 3;

  reset(): void {
    if (!this.rider) return;
    this.rider.reset();
    if (this.startPhase === 'paddle') {
      this.rider.autoPopup = this.popupAt;
      this.rider.setPhase('paddle');
      this.rider['blendFromT'] = -1;
    }
  }

  tick(lab: Lab, _t: number, dt: number): void {
    this.rider.tick(dt, lab.motion);
  }

  frame(lab: Lab): void {
    const t0 = performance.now();
    this.rider.update(lab.motion);
    this.lastMs = performance.now() - t0;
    lab.prof.add('rider', this.lastMs);
    // contact metric from three's own matrices (independent check of our FK + IK)
    lab.boardRoot.updateMatrixWorld(true);
    this.boardWorld.copy(lab.boardRoot.matrixWorld);
    this.rider.measureFootError(this.boardWorld);
  }

  onPacket(pk: StreamPacket): void {
    this.rider.onPacket(pk);
  }

  onManeuver(_lab: Lab, kind: ManeuverKind): void {
    this.rider.onManeuver(kind);
  }

  gui(lab: Lab, gui: GUI): void {
    const f = gui.addFolder('Rider');
    const p = this.rider.p;
    const st = { stance: this.rider.stance };
    f.add(st, 'stance', ['regular', 'goofy']).onChange((s: 'regular' | 'goofy') => this.rider.setStance(s));
    f.add(p, 'torture', { off: '', 'deep crouch': 'deepCrouch', '45° twist, arms out': 'twistArmsOut', 'aerial tuck': 'aerialTuck' }).name('pose test');
    f.add(p, 'crouchIntent', 0, 1, 0.01).name('crouch intent');
    f.add(p, 'stabilityOverride', -1, 1, 0.01).name('stability (−1 = stream)');
    f.add(p, 'performanceOverride', -1, 1, 0.01).name('performance (−1 = stream)');
    const sk = f.addFolder('Skill / springs').close();
    sk.add(p, 'leadTime', 0, 0.5, 0.01).name('anticipation lead (s)');
    sk.add(p, 'kappa', 0, 1, 0.01).name('κ apparent-up blend');
    sk.add(p, 'comHz', 0.8, 4, 0.05).name('COM stiffness (Hz)');
    sk.add(p, 'lagGain', 0, 2, 0.01).name('disturbance gain');
    sk.add(p, 'horizonLevel', 0, 1, 0.01).name('head horizon level');
    const ly = f.addFolder('Layers').close();
    ly.add(p, 'ik').name('leg IK');
    ly.add(p, 'balance').name('balance (f_B)');
    ly.add(p, 'head').name('head stabilisation');
    ly.add(p, 'noise').name('stability noise');
    const ph = f.addFolder('Phases (placeholder clips)');
    const pa = {
      paddle: () => {
        this.rider.autoPopup = 0;
        this.rider.setPhase('paddle');
      },
      popup: () => this.rider.setPhase('popup'),
      sequence: () => {
        this.startPhase = 'paddle';
        lab.reset();
      },
      ride: () => {
        this.startPhase = 'ride';
        this.rider.setPhase('ride');
      },
    };
    ph.add(pa, 'paddle').name('paddle');
    ph.add(pa, 'popup').name('pop-up');
    ph.add(pa, 'sequence').name('paddle → pop-up → ride (reset)');
    ph.add(this, 'popupAt', 0.5, 10, 0.1).name('pop-up after (s)');
    ph.add(pa, 'ride').name('ride');
    const act = { bad: () => this.rider.kick(1, 'bad'), fall: () => this.rider.fall() };
    f.add(act, 'bad').name('event: bad moment');
    f.add(act, 'fall').name('event: wipeout');
    void lab;
  }
}
